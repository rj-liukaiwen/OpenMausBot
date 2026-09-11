import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { navigateBrowserPage } from "./browser-navigation.ts";
import { CompletedBrowserActionError } from "./browser-runtime.ts";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
let requests: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }>;
let mode: "ok" | "network" | "hang" | "unconfirmed" | "send-failure" | "document-loading";
let socket: Socket;
class Socket extends EventTarget {
  constructor(readonly url: string) { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(raw: string) {
    if (mode === "send-failure") throw new Error("closed");
    const message = JSON.parse(raw); requests.push(message);
    if (message.method === "Page.navigate" && ["hang", "unconfirmed"].includes(mode)) return;
    if (message.method === "Page.stopLoading" && mode === "unconfirmed" && requests.some((r) => r.method === "Page.navigate")) return;
    const result = message.method === "Target.attachToTarget" ? { sessionId: "exact-session" }
      : message.method === "Page.navigate" && mode === "network" ? { errorText: "private network detail" }
      : message.method === "Page.navigate" && mode === "document-loading" ? { loaderId: 'new-document' } : {};
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: message.id, result }) })));
  }
  close() { this.dispatchEvent(new Event("close")); }
}
const output = (data: unknown) => ({ stdout: JSON.stringify({ success: true, data }) });
beforeEach(() => {
  requests = []; mode = "ok"; vi.useFakeTimers(); vi.stubGlobal("WebSocket", Socket);
  execute.mockReset().mockResolvedValueOnce(output({ cdpUrl: "ws://127.0.0.1:9222/devtools/browser/fixture" }))
    .mockResolvedValueOnce(output({ tabs: [{ active: false, targetId: "other", tabId: 't2' }, { active: true, targetId: "selected", tabId: 't1' }] }))
    .mockResolvedValue(output({ tabs: [{ tabId: 't1', active: true, title: 'Loaded document', url: 'http://localhost/fixture' }] }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const run = () => navigateBrowserPage("fixture-native", { AGENT_BROWSER_SESSION: "fixture" }, "http://localhost/fixture");
it('waits for the exact new document, then refreshes native tab metadata for the live viewer', async () => {
  mode = 'document-loading';
  let completed = false;
  const navigation = run().then((result) => { completed = true; return result; });
  await vi.advanceTimersByTimeAsync(100);
  expect(completed).toBe(false);
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Page.lifecycleEvent', sessionId: 'exact-session', params: { name: 'DOMContentLoaded', loaderId: 'old-document' } }) }));
  await vi.advanceTimersByTimeAsync(100);
  expect(completed).toBe(false);
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Page.lifecycleEvent', sessionId: 'exact-session', params: { name: 'DOMContentLoaded', loaderId: 'new-document' } }) }));
  await vi.advanceTimersByTimeAsync(100);
  await navigation;
  expect(execute.mock.calls.at(-1)?.[1]).toEqual(['tab', 't1', '--json', '--no-webmcp']);
  expect(execute).toHaveBeenCalledTimes(3);
});
it("attaches only the native session's active target and stops any old load before navigating", async () => {
  await expect(run()).resolves.toEqual({ url: "http://localhost/fixture" });
  expect(requests.map((r) => r.method)).toEqual(["Target.attachToTarget", 'Page.enable', 'Page.setLifecycleEventsEnabled', "Page.stopLoading", "Page.navigate"]);
  expect(requests[0]?.params).toEqual({ targetId: "selected", flatten: true });
  expect(requests[4]?.sessionId).toBe("exact-session");
  expect(execute.mock.calls.map((r) => r[1])).toEqual([["get", "cdp-url", "--json", "--no-webmcp"], ["tab", "list", "--json", "--no-webmcp"], ["tab", "t1", "--json", "--no-webmcp"]]);
});
it("returns a completed error for an acknowledged network failure without leaking details", async () => {
  mode = "network";
  await expect(run()).rejects.toThrow(CompletedBrowserActionError);
});
it("releases a hanging navigation only after the browser confirms stopLoading", async () => {
  mode = "hang";
  const check = expect(run()).rejects.toThrow(CompletedBrowserActionError);
  await vi.advanceTimersByTimeAsync(15_001); await check;
  expect(requests.map((r) => r.method)).toEqual(["Target.attachToTarget", 'Page.enable', 'Page.setLifecycleEventsEnabled', "Page.stopLoading", "Page.navigate", "Page.stopLoading"]);
});
it("does not claim completion if cancellation is unacknowledged", async () => {
  mode = "unconfirmed";
  const check = expect(run()).rejects.not.toBeInstanceOf(CompletedBrowserActionError);
  await vi.advanceTimersByTimeAsync(18_001); await check;
});
it("cleans pending timers after a synchronous socket send failure", async () => {
  mode = "send-failure";
  await expect(run()).rejects.toThrow("connection failed");
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["ws://external.example:9222/", "wss://127.0.0.1:9222/", "ws://user:pass@127.0.0.1:9222/"])("rejects an unsafe native endpoint: %s", async (cdpUrl) => {
  execute.mockReset().mockResolvedValueOnce(output({ cdpUrl }));
  await expect(run()).rejects.toThrow("Invalid native browser endpoint"); expect(requests).toEqual([]);
});
it.each([[{ active: true, targetId: "a" }, { active: true, targetId: "b" }], [{ active: true }]])("rejects ambiguous or missing active target identifiers: %j", async (...tabs) => {
  execute.mockReset().mockResolvedValueOnce(output({ cdpUrl: "ws://127.0.0.1:9222/" }))
    .mockResolvedValueOnce(output({ tabs }));
  await expect(run()).rejects.toThrow("No unique active"); expect(requests).toEqual([]);
});
