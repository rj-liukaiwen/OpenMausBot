// Windows host-computer MCP bridge. It keeps the CUA protocol transparent,
// but observes raw screenshots before Harness projects them for a text-only
// model. Controlled apps keep the native desktop's normal foreground behavior.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { augmentedPath } from "./env-path.ts";
import { createControlClient } from "./control-client.ts";
import { MUTATING_COMPUTER_TOOLS } from "./computer-tools.ts";
import { createLineSplitter, createMcpBridgeInterceptor } from "./mcp-bridge.ts";

type Frame = { png: string; mime: "image/png" | "image/jpeg" | "image/webp" };
type Timer = (callback: () => void, delayMs: number) => unknown;

const IMAGE_TYPES = new Set<Frame["mime"]>(["image/png", "image/jpeg", "image/webp"]);
const HARNESS_SCHEMA_ANNOTATIONS = ["description", "title", "default", "examples"] as const;
const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function scalarMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

/** CUA exposes full JSON Schema while Harness deliberately accepts a small,
 * enforced subset. Preserve the model-relevant shape and discard validation
 * hints Harness would reject before it can mount any of the computer tools. */
export function harnessCompatibleJsonSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const annotations = Object.fromEntries(HARNESS_SCHEMA_ANNOTATIONS.flatMap((key) =>
    source[key] === undefined ? [] : [[key, source[key]]]
  ));

  const hasDeclaredShape = source.type !== undefined
    || (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties))
    || (source.items && typeof source.items === "object");
  const rawUnion = !hasDeclaredShape && Array.isArray(source.oneOf)
    ? source.oneOf
    : !hasDeclaredShape && Array.isArray(source.anyOf)
      ? source.anyOf
      : null;
  if (rawUnion) {
    const variants = rawUnion
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map(harnessCompatibleJsonSchema);
    if (variants.length === 1) return { ...variants[0], ...annotations };
    if (variants.length > 1) return { oneOf: variants, ...annotations };
    return annotations;
  }
  if (!hasDeclaredShape && Array.isArray(source.allOf)) {
    const first = source.allOf.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    return first ? { ...harnessCompatibleJsonSchema(first), ...annotations } : annotations;
  }

  let type = source.type;
  if (Array.isArray(type)) {
    const types = type.filter((entry): entry is string => typeof entry === "string" && entry !== "null" && JSON_SCHEMA_TYPES.has(entry));
    if (types.length > 1) return { oneOf: types.map((entry) => ({ type: entry })), ...annotations };
    type = types[0] ?? "null";
  }
  if (typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type)) {
    if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) type = "object";
    else if (source.items && typeof source.items === "object") type = "array";
    else return annotations;
  }
  const schemaType = type as string;

  const result: Record<string, unknown> = { type: schemaType, ...annotations };
  if (schemaType === "object") {
    if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
      result.properties = Object.fromEntries(Object.entries(source.properties as Record<string, unknown>)
        .map(([key, schema]) => [key, harnessCompatibleJsonSchema(schema)]));
      if (Array.isArray(source.required)) {
        const names = source.required.filter((entry): entry is string =>
          typeof entry === "string" && Object.hasOwn(result.properties as object, entry)
        );
        if (names.length) result.required = names;
      }
    }
    if (typeof source.additionalProperties === "boolean") result.additionalProperties = source.additionalProperties;
  } else if (schemaType === "array" && source.items && typeof source.items === "object") {
    result.items = harnessCompatibleJsonSchema(source.items);
  } else if (!["object", "array"].includes(schemaType)) {
    if (Array.isArray(source.enum)) {
      const allowed = source.enum.filter((entry) => scalarMatches(schemaType, entry));
      if (allowed.length) result.enum = allowed;
    }
    if (source.const !== undefined && scalarMatches(schemaType, source.const)) result.const = source.const;
  }
  return result;
}

function rawImage(value: unknown): Frame | null {
  const seen = new Set<object>();
  const visit = (node: unknown, depth: number): Frame | null => {
    if (!node || typeof node !== "object" || depth > 10 || seen.has(node)) return null;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && IMAGE_TYPES.has(record.mimeType as Frame["mime"])) {
      return { png: record.data, mime: record.mimeType as Frame["mime"] };
    }
    for (const child of Array.isArray(node) ? node : Object.values(record)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(value, 0);
}

function launchedTarget(value: unknown): { pid: number; window_id: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, any>;
  const windows = record.windows ?? record.structuredContent?.windows ?? record.result?.windows;
  if (!Array.isArray(windows)) return null;
  for (const window of windows) {
    const pid = Number(window?.pid);
    const windowId = Number(window?.window_id);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(windowId)) return { pid, window_id: windowId };
  }
  return null;
}

export function createLocalComputerProxyInterceptor(options: {
  toDriver: (line: string) => void;
  toClient: (line: string) => void;
  publishFrame: (frame: Frame) => Promise<void>;
  prepareWindow?: (target: { pid: number; window_id: number }) => Promise<void>;
  schedule?: Timer;
}) {
  const pending = new Map<string | number, { name: string; args: Record<string, unknown> }>();
  const synthetic = new Set<string>();
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  let observation = 0;
  let observationGeneration = 0;
  let observationInFlight: string | null = null;
  let observationWanted = false;
  let lastTarget: { pid: number; window_id: number } | null = null;

  const rememberTarget = (args: Record<string, unknown>) => {
    const pid = Number(args.pid);
    const windowId = Number(args.window_id);
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(windowId)) lastTarget = { pid, window_id: windowId };
  };
  const bringTargetToFront = (target: { pid: number; window_id: number }) => {
    const id = `omb-front-${process.pid}-${++observation}`;
    synthetic.add(id);
    options.toDriver(JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "bring_to_front", arguments: target },
    }));
  };
  const requestObservation = (generation: number) => {
    if (!lastTarget || generation !== observationGeneration) return;
    if (observationInFlight) {
      observationWanted = true;
      return;
    }
    const send = () => {
      if (!lastTarget || generation !== observationGeneration || observationInFlight) return;
      const id = `omb-screen-${process.pid}-${++observation}`;
      synthetic.add(id);
      observationInFlight = id;
      options.toDriver(JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: {
          name: "get_window_state",
          // Synthetic observations exist only to refresh the picture. Keep
          // the UIA walk tiny so several paint-boundary frames cannot slow
          // down the agent's semantic snapshot.
          arguments: { ...lastTarget, max_depth: 1, max_elements: 10 },
        },
      }));
    };
    if (options.prepareWindow) return options.prepareWindow(lastTarget).then(send, send);
    send();
  };

  return {
    fromClient(line: string) {
      let message: any;
      try { message = JSON.parse(line); } catch { options.toDriver(line); return; }
      if (message?.method !== "tools/call") { options.toDriver(line); return; }
      // Real work outranks preview refreshes. Any not-yet-dispatched frame
      // from the previous action is stale as soon as the model chooses its
      // next step; keep at most the one already in flight.
      observationGeneration += 1;
      observationWanted = false;
      const id = message.id;
      const name = String(message.params?.name ?? "");
      const args = message.params?.arguments && typeof message.params.arguments === "object"
        ? { ...message.params.arguments }
        : {};
      rememberTarget(args);
      const forward = () => {
        if (typeof id === "string" || typeof id === "number") pending.set(id, { name, args });
        options.toDriver(JSON.stringify({ ...message, params: { ...message.params, arguments: args } }));
      };
      if (name === "get_window_state" && lastTarget && options.prepareWindow) {
        return options.prepareWindow(lastTarget).then(forward, forward);
      }
      forward();
    },

    fromDriver(line: string) {
      let message: any;
      try { message = JSON.parse(line); } catch { options.toClient(line); return; }
      if (Array.isArray(message?.result?.tools)) {
        message.result.tools = message.result.tools.map((tool: unknown) => {
          if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
          const record = tool as Record<string, unknown>;
          return { ...record, inputSchema: harnessCompatibleJsonSchema(record.inputSchema) };
        });
        line = JSON.stringify(message);
      }
      const id = message?.id;
      if (synthetic.has(id)) {
        synthetic.delete(id);
        if (observationInFlight === id) observationInFlight = null;
        const image = rawImage(message?.result);
        if (image) void options.publishFrame(image);
        if (observationWanted) {
          observationWanted = false;
          requestObservation(observationGeneration);
        }
        return;
      }
      const call = pending.get(id);
      if (call) pending.delete(id);
      const opened = call?.name === "launch_app" ? launchedTarget(message?.result) : null;
      if (opened) {
        lastTarget = opened;
        bringTargetToFront(opened);
      }
      const image = rawImage(message?.result);
      if (image) void options.publishFrame(image);
      options.toClient(line);
      if (call && MUTATING_COMPUTER_TOOLS.has(call.name) && lastTarget) {
        // Capture the immediate response plus the two common browser paint
        // boundaries. Newer frames replace older ones in the panel.
        const generation = ++observationGeneration;
        observationWanted = false;
        const start = () => {
          for (const delay of [40, 200, 500, 900, 1_500]) {
            schedule(() => {
              if (generation === observationGeneration) void requestObservation(generation);
            }, delay);
          }
        };
        if (opened && options.prepareWindow) void options.prepareWindow(opened).then(start, start);
        else start();
      }
    },
  };
}

function createBackgroundWindowRestorer(): {
  restore: (target: { window_id: number }) => Promise<void>;
  close: () => void;
} {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OmbBackgroundWindow { [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }'",
    "[Console]::Out.WriteLine('ready')",
    "while (($line = [Console]::In.ReadLine()) -ne $null) {",
    "  try { $h = [IntPtr]([long]$line); if ([OmbBackgroundWindow]::IsIconic($h)) { [void][OmbBackgroundWindow]::ShowWindowAsync($h, 4) }; [Console]::Out.WriteLine('ok') }",
    "  catch { [Console]::Out.WriteLine('error') }",
    "}",
  ].join("; ");
  const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  helper.stdin.on("error", () => undefined);
  const pending: Array<() => void> = [];
  readlineLines(helper.stdout, (line) => {
    if (line === "ready") return;
    pending.shift()?.();
  });
  const finish = () => { while (pending.length) pending.shift()?.(); };
  helper.on("error", finish);
  helper.on("close", finish);
  return {
    restore(target) {
      if (!Number.isSafeInteger(target.window_id) || target.window_id <= 0 || helper.exitCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pending.push(resolve);
        helper.stdin.write(`${target.window_id}\n`);
      });
    },
    close() { helper.stdin.end(); helper.kill(); finish(); },
  };
}

function readlineLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const splitter = createLineSplitter(onLine);
  stream.on("data", (chunk: Buffer) => splitter.push(chunk));
  stream.on("end", () => splitter.flush());
}

async function postFrame(frame: Frame): Promise<void> {
  const url = process.env.OMB_CONTROL_URL;
  const token = process.env.OMB_CONTROL_TOKEN_FILE
    ? (() => { try { return readFileSync(process.env.OMB_CONTROL_TOKEN_FILE!, "utf8").trim(); } catch { return ""; } })()
    : process.env.OMB_CONTROL_TOKEN;
  if (!url || !token) return;
  await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "frame", ...frame }),
    signal: AbortSignal.timeout(4_000),
  }).then(() => undefined, () => undefined);
}

export function runLocalComputerProxy(): void {
  // A hidden Electron Host can pass an already-closed stderr pipe to its MCP
  // child. An update notice from CUA must not turn that optional diagnostic
  // channel's EPIPE into a fatal crash of the working JSON-RPC connection.
  process.stderr.on("error", () => undefined);
  const {
    OMB_CUA_COMMAND: command,
    OMB_CUA_ARGS: encodedArgs,
    OMB_CONTROL_URL: url,
    OMB_CONTROL_TOKEN: token,
    OMB_CONTROL_TOKEN_FILE: tokenFile,
    ...childEnv
  } = process.env;
  let args: string[];
  try {
    const parsed: unknown = JSON.parse(encodedArgs ?? "");
    const endpoint = new URL(url ?? "");
    if (!command?.trim() || command.includes("\0")
      || !Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string" && !arg.includes("\0"))
      || (!token && !tokenFile) || !["http:", "https:"].includes(endpoint.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
      throw new Error("invalid connection");
    }
    args = parsed;
  } catch {
    process.stderr.write("invalid local computer proxy connection\n");
    process.exit(2);
  }
  const child = spawn(command!, args, {
    shell: false,
    windowsHide: true,
    env: { ...childEnv, PATH: augmentedPath() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => undefined);
  child.stderr.on("data", (chunk: Buffer) => {
    // Keep draining CUA even after the parent's diagnostic sink closes.
    if (!process.stderr.destroyed) process.stderr.write(chunk);
  });
  const restorer = process.platform === "win32" ? createBackgroundWindowRestorer() : null;
  const proxy = createLocalComputerProxyInterceptor({
    toDriver: (line) => child.stdin.write(line + "\n"),
    toClient: (line) => process.stdout.write(line + "\n"),
    publishFrame: postFrame,
    prepareWindow: restorer ? (target) => restorer.restore(target) : undefined,
  });
  const client = createControlClient({
    url: url!,
    tokenProvider: () => {
      if (tokenFile) {
        try { return readFileSync(tokenFile, "utf8").trim(); } catch { return ""; }
      }
      return token ?? "";
    },
  });
  let refusalReason: string | undefined;
  const intercept = createMcpBridgeInterceptor({
    answer: (line) => process.stdout.write(line + "\n"),
    forward: proxy.fromClient,
    gate: {
      isHeld: async () => {
        refusalReason = undefined;
        const state = await client.state(true);
        refusalReason = state.blockedReason;
        return state.held;
      },
      getRefusalReason: () => refusalReason,
    },
  });
  let pendingInput = Promise.resolve();
  const inbound = createLineSplitter((line) => {
    const completion = intercept(line);
    if (completion) pendingInput = completion;
  });
  const outbound = createLineSplitter(proxy.fromDriver);
  process.stdin.on("data", (chunk: Buffer) => inbound.push(chunk));
  process.stdin.on("end", () => {
    inbound.flush();
    void pendingInput.finally(() => child.stdin.end());
  });
  child.stdout.on("data", (chunk: Buffer) => outbound.push(chunk));
  child.stdout.on("end", () => outbound.flush());
  child.on("error", (error) => {
    process.stderr.write(`could not start Cua Driver: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("close", (code) => { restorer?.close(); process.exitCode = process.exitCode ?? code ?? 1; });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { restorer?.close(); child.kill(signal); });
}

// Node resolves import.meta.url through symlinks, while argv can retain a path
// such as macOS /var/... (whose real path is /private/var/...). Compare the
// canonical paths or the packaged CLI silently exits without serving requests.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)).toLowerCase() === realpathSync(process.argv[1]).toLowerCase()) {
  runLocalComputerProxy();
}
