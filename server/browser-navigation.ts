import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CompletedBrowserActionError } from "./browser-runtime.ts";

const execute = promisify(execFile);
const pageFailure = () => new CompletedBrowserActionError("The page could not be opened. Check the address or network connection, or open another page.");

/** Cancelable navigation on the native session's exact active target. Nothing
 * from the renderer supplies a CDP address or target; neither is returned to it.
 * The native CLI waits inside Page.navigate before its own load timeout starts.
 * A separate CDP connection lets us acknowledge Page.stopLoading at our deadline
 * rather than killing the CLI and leaving an unknown action behind. */
export async function navigateBrowserPage(binary: string, env: NodeJS.ProcessEnv, url: string): Promise<Record<string, unknown>> {
  const query = async (args: string[]) => {
    const { stdout } = await execute(binary, [...args, "--json", "--no-webmcp"], {
      env, timeout: 8_000, windowsHide: true, maxBuffer: 262144, encoding: "utf8",
    });
    const result = JSON.parse(stdout);
    if (result?.success !== true || !result.data) throw new Error("Browser navigation metadata unavailable");
    return result.data;
  };
  const endpoint = new URL((await query(["get", "cdp-url"])).cdpUrl);
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || !endpoint.port || endpoint.username || endpoint.password) throw new Error("Invalid native browser endpoint");
  const { tabs } = await query(["tab", "list"]);
  const active = Array.isArray(tabs) ? tabs.filter((tab) => tab.active === true) : [];
  if (active.length !== 1 || typeof active[0].targetId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(active[0].targetId)
      || typeof active[0].tabId !== 'string' || !/^t[1-9]\d{0,8}$/.test(active[0].tabId)) throw new Error("No unique active browser target");
  const socket = new WebSocket(endpoint);
  let nextId = 0;
  let pageSession = '';
  const loaded = new Set<string>();
  let documentWait: { loaderId: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const fail = () => {
    if (documentWait) { clearTimeout(documentWait.timer); documentWait.reject(new Error('Browser navigation connection ended')); documentWait = undefined; }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser navigation connection ended")); }
    pending.clear();
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data.length > 262144) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.method === 'Page.lifecycleEvent' && message.sessionId === pageSession
        && ['DOMContentLoaded', 'load'].includes(message.params?.name) && typeof message.params?.loaderId === 'string') {
      const loaderId = message.params.loaderId;
      if (loaded.size < 32) loaded.add(loaderId);
      const waiting = documentWait;
      if (waiting && waiting.loaderId === loaderId) {
        clearTimeout(waiting.timer); waiting.resolve(); documentWait = undefined;
      }
    }
    if (!Number.isInteger(message.id)) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error("Browser rejected navigation control"));
    else item.resolve(message.result);
  });
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);
  const rpc = (method: string, params: Record<string, unknown>, sessionId?: string, timeout = 3_000): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser navigation control timed out")); }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch { pending.delete(id); clearTimeout(timer); reject(new Error("Browser navigation connection failed")); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser navigation connection timed out")), 3_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser navigation connection failed")); }, { once: true });
    });
    const { sessionId } = await rpc("Target.attachToTarget", { targetId: active[0].targetId, flatten: true });
    if (typeof sessionId !== "string") throw new Error("Browser target attachment failed");
    pageSession = sessionId;
    await rpc('Page.enable', {}, sessionId);
    await rpc('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
    await rpc("Page.stopLoading", {}, sessionId);
    let result: { loaderId?: string; errorText?: string };
    const deadline = Date.now() + 15_000;
    try {
      result = await rpc("Page.navigate", { url }, sessionId, 15_000);
      // Page.navigate acknowledges the request before the new document is
      // usable. Match its loader, never a late event from the previous page.
      if (!result?.errorText && typeof result?.loaderId === 'string' && !loaded.has(result.loaderId)) {
        const loaderId = result.loaderId;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { documentWait = undefined; reject(new Error('Browser document load timed out')); }, Math.max(1, deadline - Date.now()));
          documentWait = { loaderId, resolve, reject, timer };
        });
      }
    }
    catch {
      // Only a confirmed browser-side stop makes this a completed failure.
      await rpc("Page.stopLoading", {}, sessionId);
      throw pageFailure();
    }
    if (result?.errorText) throw pageFailure();
    // tab list returns cached metadata. Re-select the SAME trusted native tab
    // to read its actual document title/URL into the daemon and broadcast it.
    // This does not navigate twice or create a tab; the human-action lease
    // prevents another caller switching the active target during this action.
    await query(['tab', active[0].tabId]);
    return { url };
  } finally {
    fail(); socket.close();
  }
}
