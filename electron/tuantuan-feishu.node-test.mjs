import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import { registerFeishu, awaitFeishuShutdown } from "./tuantuan-feishu.mjs";
import { createConnector } from "../connectors/feishu/index.mjs";

const ORIGIN = "http://127.0.0.1:43123";
const TOKEN = "synthetic-owner-capability-not-a-secret";
const RESOURCES = path.resolve("/fixture/resources/tuantuan-feishu");
const RUNTIME_ROOT = path.resolve("/fixture/appData/TuanTuan/feishu");
const PREPARED = { cliPath: path.join(RUNTIME_ROOT, "runtime", "lark-cli.exe"),
  nodePath: path.join(RUNTIME_ROOT, "runtime", "node.exe"), configDir: path.join(RUNTIME_ROOT, "context") };
const STATE = { supported: true, botId: "bot-test", im: "off", toolsEnabled: false };
const UNAVAILABLE = { supported: false, cliPath: "", nodePath: "", botId: "",
  im: "off", toolsEnabled: false, userAuthorized: false, botAuthorized: false };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Privileged dependencies are fakes; no runtime downloads or CLI launches, and
// credentials stay in RAM. Cancellation tests can use the real controller.
function fixture(t, options = {}) {
  const { loadGate, closeGate, realConnector = false } = options;
  const host = { platform: "win32", packaged: true, remote: false, stopping: false,
    ready: true, pid: 4242, baseUrl: ORIGIN, token: TOKEN,
    ...(options.rendererOrigin ? { rendererOrigin: options.rendererOrigin } : {}) };
  const mainFrame = { url: `${options.rendererOrigin ?? ORIGIN}/settings` };
  const win = { destroyed: false, isDestroyed() { return this.destroyed; },
    webContents: { mainFrame, getURL: () => mainFrame.url } };
  const calls = { wrappers: [], gates: [], loads: [], kernels: [], connectors: [],
    states: [], invokes: [], saves: [], dialogs: [], external: [], closes: [], provisioners: [], preparations: [] };
  const kernel = Object.freeze({ fixtureKernel: true,
    bots: async () => [{ id: "bot-test" }], request: async () => ({ servers: [] }) });
  const h = { host, win, calls, kernel, currentWindow: win,
    event: { sender: win.webContents, senderFrame: mainFrame },
    document: { unrelated: { value: "synthetic-credential" }, tuantuanFeishu: { botId: "old" } },
    prepare: async () => structuredClone(PREPARED),
    dialog: {
      async showOpenDialog(parent, options) {
        calls.dialogs.push({ kind: "choose", parent, options });
        return { canceled: true, filePaths: [] };
      },
      async showMessageBox(parent, options) {
        calls.dialogs.push({ kind: "confirm", parent, options });
        return { response: 0 };
      },
    },
  };
  const handlers = new Map();
  const connector = {
    async resume() { calls.invokes.push(["host-resume"]); },
    async state(...args) { calls.states.push(args); return structuredClone(STATE); },
    async invoke(...args) { calls.invokes.push(args); return structuredClone(STATE); },
    async close() { calls.closes.push(true); await closeGate?.promise; },
  };
  h.registration = registerFeishu({
    ipcMain: { handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    } },
    localOnly(channel, handler) {
      calls.wrappers.push(channel);
      return (event, ...args) => {
        calls.gates.push(channel);
        if (new URL(event.senderFrame.url).origin !== (host.rendererOrigin ?? ORIGIN)) throw new Error("LOCAL_ONLY");
        return handler(event, ...args);
      };
    },
    runtime: () => ({ ...host }), resources: RESOURCES,
    runtimeRoot: Object.hasOwn(options, "runtimeRoot") ? options.runtimeRoot : RUNTIME_ROOT,
    window: () => h.currentWindow, dialog: h.dialog,
    credentials: () => {
      if (h.credentialError) throw h.credentialError;
      return h.document;
    },
    async saveCredentials(derive) {
      calls.saves.push(derive);
      if (h.credentialError) throw h.credentialError;
      h.document = derive(h.document);
    },
    openExternal: async (url) => { calls.external.push(url); },
    async load(url) {
      calls.loads.push(url);
      await loadGate?.promise;
      if (url === pathToFileURL(path.join(RESOURCES, "index.mjs")).href) {
        return { createConnector(options) {
          calls.connectors.push(options);
          return realConnector ? createConnector({ ...options,
            createCliImpl(...args) {
              if (h.createCli) return h.createCli(...args);
              assert.fail("cancelled provisioning must never launch a CLI");
            },
          }) : connector;
        } };
      }
      if (url === pathToFileURL(path.join(RESOURCES, "runtime.mjs")).href) {
        return { createRecoveryContext: async (options) => {
          calls.preparations.push({ recovery: options });
          return h.recovery ? h.recovery(options) : path.join(RUNTIME_ROOT, "recovery", "fixture", "context");
        }, createRuntimeProvisioner(options) {
          calls.provisioners.push(options);
          return (args) => { calls.preparations.push(args); return h.prepare(args); };
        } };
      }
      assert.equal(url, pathToFileURL(path.join(RESOURCES, "kernel.mjs")).href);
      return { createKernel(options) { calls.kernels.push(options); return kernel; } };
    },
  });
  h.request = (channel, ...args) => Promise.resolve().then(() =>
    handlers.get(`tuantuan-feishu:${channel}`)(h.event, ...args));
  h.callbacks = async () => { await h.request("state"); return calls.connectors[0]; };
  t.after(async () => {
    loadGate?.resolve();
    closeGate?.resolve();
    await h.registration.close();
  });
  return h;
}

test("registers only gated state/invoke IPC and lazily shares one host connector", async (t) => {
  const h = fixture(t);
  assert.deepEqual(h.calls.wrappers.sort(), ["tuantuan-feishu:invoke", "tuantuan-feishu:state"]);
  assert.deepEqual(h.calls.loads, []);
  const input = { botId: "bot-test" };
  const replies = await Promise.all([h.request("state"), h.request("invoke", "connect", input)]);
  assert.deepEqual(replies, [STATE, STATE]);
  assert.equal(h.calls.gates.length, 2);
  assert.equal(h.calls.loads.length, 3);
  assert.deepEqual(h.calls.loads.map((url) => new URL(url).pathname.split("/").at(-1)).sort(),
    ["index.mjs", "kernel.mjs", "runtime.mjs"]);
  assert.deepEqual(h.calls.provisioners, [{ root: RUNTIME_ROOT, bundledRoot: undefined }]);
  assert.equal(h.calls.connectors.length, 1);
  assert.deepEqual(h.calls.states, [[]]);
  assert.deepEqual(h.calls.invokes, [["connect", input]]);
  assert.deepEqual(h.calls.kernels, [{ baseUrl: ORIGIN, ownerToken: TOKEN, expectedPid: 4242 }]);
  const options = h.calls.connectors[0];
  assert.equal(options.kernel, h.kernel);
  assert.equal(options.mcpPath, path.join(RESOURCES, "mcp.mjs"));
  assert.equal(JSON.stringify({ options, replies, calls: h.calls.invokes, provisioners: h.calls.provisioners }).includes(TOKEN), false);
  assert.equal(Object.hasOwn(options, "ownerToken"), false);
  assert.equal(Object.hasOwn(options, "token"), false);
});

test("Mac host uses the same private connector without an exe-only picker", async (t) => {
  const h = fixture(t); h.host.platform = 'darwin';
  assert.deepEqual(await h.request('state'), STATE);
  await h.registration.start();
  const callbacks = await h.callbacks();
  await callbacks.chooseExecutable('cli');
  assert.equal(h.calls.dialogs[0].options.filters, undefined);
  assert.equal(callbacks.authorizeTool({}), true);
  h.host.remote = true;
  assert.deepEqual(await h.request('state'), UNAVAILABLE);
  await assert.rejects(h.request('invoke', 'connect', {}));
});

test("recovery context uses the host private root and rechecks trust around asynchronous creation", async (t) => {
  const h = fixture(t);
  const callbacks = await h.callbacks();
  const controller = new AbortController();
  const result = await callbacks.createRecoveryContext({ signal: controller.signal, root: "/renderer-input" });
  assert.equal(result, path.join(RUNTIME_ROOT, "recovery", "fixture", "context"));
  assert.equal(h.calls.preparations[0].recovery.root, RUNTIME_ROOT);
  assert.equal(h.calls.preparations[0].recovery.signal, controller.signal);
  h.recovery = async () => { h.host.remote = true; return "not-trusted"; };
  await assert.rejects(callbacks.createRecoveryContext({ signal: controller.signal }), /LOCAL_WINDOW_REQUIRED/);
});

test("Windows host authorizes office tools without a dialog but still requires a trusted local window", async (t) => {
  const h = fixture(t);
  const callbacks = await h.callbacks();
  assert.equal(typeof callbacks.authorizeTool, "function");
  for (let i = 0; i < 3; i++) assert.equal(await callbacks.authorizeTool({ title: "tool" }), true);
  assert.equal(h.calls.dialogs.length, 0);
  h.host.remote = true;
  await assert.rejects(async () => callbacks.authorizeTool({}), /LOCAL_WINDOW_REQUIRED/);
  assert.equal(h.calls.dialogs.length, 0);
});

const deniedContexts = [
  ["remote runtime", (h) => { h.host.remote = true; }, true],
  ["unpackaged app", (h) => { h.host.packaged = false; }, true],
  ["Linux", (h) => { h.host.platform = "linux"; }, true],
  ["Linux", (h) => { h.host.platform = "linux"; }, true],
  ["unknown PID", (h) => { h.host.pid = undefined; }],
  ["zero PID", (h) => { h.host.pid = 0; }],
  ["not ready", (h) => { h.host.ready = false; }],
  ["stopping", (h) => { h.host.stopping = true; }],
  ["missing window", (h) => { h.currentWindow = null; }],
  ["destroyed window", (h) => { h.win.destroyed = true; }],
  ["wrong window", (h) => { h.event.sender = { mainFrame: h.event.senderFrame }; }],
  ["same-origin subframe", (h) => { h.event.senderFrame = { url: `${ORIGIN}/frame` }; }],
  ["remote page", (h) => { h.win.webContents.mainFrame.url = "https://remote.invalid/"; }],
];

for (const [name, change] of deniedContexts.filter(([name]) => !["wrong window", "same-origin subframe"].includes(name))) {
  test(`automatic office policy rejects ${name} without opening a native dialog`, async (t) => {
    const h = fixture(t);
    const callbacks = await h.callbacks();
    change(h);
    await assert.rejects(async () => callbacks.authorizeTool({}), /LOCAL_WINDOW_REQUIRED/);
    assert.equal(h.calls.dialogs.length, 0);
  });
}
for (const [name, change, unavailable] of deniedContexts) {
  test(`${name} cannot load or execute Feishu operations`, async (t) => {
    const h = fixture(t);
    change(h);
    await assert.rejects(h.request("invoke", "chooseCli"));
    if (unavailable) assert.deepEqual(await h.request("state"), UNAVAILABLE);
    else await assert.rejects(h.request("state"));
    assert.deepEqual(h.calls.loads, []);
    assert.deepEqual(h.calls.connectors, []);
    assert.deepEqual(h.calls.invokes, []);
    assert.deepEqual(h.calls.dialogs, []);
    assert.deepEqual(h.calls.external, []);
  });
}

test("a cached connector does not bypass runtime or sender guards", async (t) => {
  for (const [name, change, unavailable] of deniedContexts) {
    await t.test(name, async (t) => {
      const h = fixture(t);
      await h.callbacks();
      change(h);
      await assert.rejects(h.request("invoke", "connect"));
      if (unavailable) assert.deepEqual(await h.request("state"), UNAVAILABLE);
      else await assert.rejects(h.request("state"));
      assert.equal(h.calls.states.length, 1);
      assert.deepEqual(h.calls.invokes, []);
    });
  }
});

test("credential store clones reads and merges via the encrypted document updater", async (t) => {
  const h = fixture(t);
  const { store } = await h.callbacks();
  const loaded = await store.load();
  loaded.botId = "mutated-copy";
  assert.equal(h.document.tuantuanFeishu.botId, "old");
  const config = { botId: "bot-test", records: ["om_test"] };
  // A different credential writer may have updated the document since load().
  h.document = { ...h.document, unrelated: { value: "updated" }, newlyAdded: { keep: true } };
  await store.save(config);
  assert.equal(h.calls.saves.length, 1);
  assert.equal(typeof h.calls.saves[0], "function");
  assert.deepEqual(h.document, { unrelated: { value: "updated" }, newlyAdded: { keep: true },
    tuantuanFeishu: config });
  h.document = { unrelated: { keep: true } };
  assert.deepEqual(await store.load(), {});
  h.credentialError = new Error("CREDENTIAL_STORE_UNAVAILABLE");
  await assert.rejects(store.load(), /CREDENTIAL_STORE_UNAVAILABLE/);
  await assert.rejects(store.save(config), /CREDENTIAL_STORE_UNAVAILABLE/);
  assert.deepEqual(h.document, { unrelated: { keep: true } });
});

test("native executable chooser returns null on cancel and only the selected path", async (t) => {
  const h = fixture(t);
  const { chooseExecutable } = await h.callbacks();
  assert.equal(await chooseExecutable("cli"), null);
  const { parent, options } = h.calls.dialogs[0];
  assert.equal(parent, h.win);
  assert.deepEqual(options.properties, ["openFile"]);
  assert.deepEqual(options.filters[0].extensions, ["exe"]);
  h.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: ["C:\\unapproved.exe"] });
  assert.equal(await chooseExecutable("cli"), null);
  h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ["C:\\node.exe"] });
  assert.equal(await chooseExecutable("node"), "C:\\node.exe");
});

test("native approval defaults and cancels to deny; only response 1 approves", async (t) => {
  const h = fixture(t);
  const { confirm } = await h.callbacks();
  const prompt = { title: "Fixture approval", message: "Fixture action", detail: "bot-test" };
  assert.equal(await confirm(prompt), false);
  const { parent, options } = h.calls.dialogs[0];
  assert.equal(parent, h.win);
  assert.deepEqual({ title: options.title, message: options.message, detail: options.detail }, prompt);
  assert.equal(options.type, "question");
  assert.equal(options.buttons.length, 2);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(options.noLink, true);
  for (const response of [undefined, -1, 0, 2, "1", 1]) {
    h.dialog.showMessageBox = async () => ({ response });
    assert.equal(await confirm(prompt), response === 1);
  }
});

for (const kind of ["chooseExecutable", "confirm"]) {
  test(`${kind} rechecks trust after awaiting the native dialog`, async (t) => {
    for (const [name, change] of deniedContexts.filter(([name]) =>
      ["remote runtime", "remote page", "unknown PID", "stopping", "destroyed window"].includes(name))) {
      await t.test(name, async (t) => {
        const h = fixture(t);
        const callbacks = await h.callbacks();
        const shown = deferred();
        const answer = deferred();
        const method = kind === "confirm" ? "showMessageBox" : "showOpenDialog";
        h.dialog[method] = () => { shown.resolve(); return answer.promise; };
        const pending = callbacks[kind](kind === "confirm" ? {} : "cli");
        await shown.promise;
        change(h);
        answer.resolve(kind === "confirm" ? { response: 1 } : { canceled: false, filePaths: ["C:\\cli.exe"] });
        await assert.rejects(pending);
      });
    }
  });
}

test("external auth permits official init, scope-apply, and account OAuth URLs only", async (t) => {
  const h = fixture(t);
  const { openExternal } = await h.callbacks();
  const approved = ["https://accounts.feishu.cn/oauth/authorize?fixture=1",
    "https://accounts.larksuite.com/device",
    "https://open.feishu.cn/page/cli?user_code=fixture-123&lpv=1.0.93&ocv=1.0.93&from=cli",
    "https://open.feishu.cn/page/cli?from=cli&ocv=1.0.93&lpv=1.0.93&user_code=fixture%2B123",
    "https://open.feishu.cn/page/scope-apply?clientID=cli_fixture&scopes=docx%3Adocument%3Areadonly,im%3Amessage",
    "https://open.larksuite.com/page/scope-apply?clientID=cli_fixture"];
  for (const url of approved) await openExternal(url);
  assert.deepEqual(h.calls.external, approved);
  for (const url of ["http://accounts.feishu.cn/device", "file:///fixture/cli.exe",
    "javascript:alert(1)", "https://evil.invalid/", "https://accounts.feishu.cn.evil.invalid/",
    "https://sub.accounts.feishu.cn/", "https://accounts.feishu.cn@evil.invalid/",
    "https://user@accounts.feishu.cn/", "https://user:pass@accounts.larksuite.com/",
    "https://accounts.feishu.cn:444/", "https://accounts.feishu.cn:443/", "not a URL",
    "https://accounts.feishu.cn/#", "https://accounts.feishu.cn/device#fragment",
    " https://accounts.feishu.cn/device", "https://accounts.feishu.cn/\ndevice",
    "https://accounts.feishu.cn\\@evil.invalid/", "https://accounts.feishu.cn/../device",
    "https://open.feishu.cn/", "https://open.feishu.cn/page/cli",
    "https://open.feishu.cn/page/scope-apply?clientID=evil&scopes=im:message",
    "https://open.feishu.cn/page/scope-apply?clientID=cli_fixture&scopes=",
    "https://open.feishu.cn/page/scope-apply?clientID=cli_fixture&scopes=im:message%20evil",
    "https://open.feishu.cn/page/scope-apply?clientID=cli_fixture&clientID=cli_other",
    "https://open.feishu.cn/page/scope-apply?clientID=cli_fixture&redirect_uri=https://evil.invalid/"]) {
    await assert.rejects(openExternal(url), undefined, url);
  }
  const init = approved[2];
  for (const url of [init.replace("open.feishu.cn", "open.larksuite.com"),
    init.replace("open.feishu.cn", "open.feishu.cn.evil.invalid"),
    init.replace("/page/cli", "/other/../page/cli"),
    init.replace("/page/cli", "/other/%2e%2e/page/cli"),
    init.replace("/page/cli", "/page/%63li"),
    init.replace("/page/cli", "/page/cli/"),
    init.replace("lpv=1.0.93", "lpv=1.0.94"), init.replace("ocv=1.0.93", "ocv=1.0.94"),
    init.replace("from=cli", "from=evil"), init.replace("user_code=fixture-123", "user_code="),
    init.replace("&ocv=1.0.93", ""), `${init}&user_code=other`, `${init}&redirect=https://evil.invalid/`,
    `${init}#`, `${init}#fragment`]) await assert.rejects(openExternal(url), /INVALID_AUTH_URL/, url);
  h.host.remote = true;
  await assert.rejects(openExternal(approved[0]));
  assert.deepEqual(h.calls.external, approved);
});

test("every browser callback checks the current window before and after opening", async (t) => {
  for (const [name, change] of deniedContexts.filter(([name]) =>
    !["wrong window", "same-origin subframe"].includes(name))) {
    await t.test(name, async (t) => {
      const h = fixture(t);
      const { openExternal } = await h.callbacks();
      await openExternal("https://accounts.feishu.cn/device");
      change(h);
      await assert.rejects(openExternal("https://accounts.feishu.cn/device"));
      assert.equal(h.calls.external.length, 1);
    });
  }
  const h = fixture(t);
  const { openExternal } = await h.callbacks();
  const pending = openExternal("https://accounts.feishu.cn/device");
  h.host.remote = true;
  await assert.rejects(pending, /LOCAL_WINDOW_REQUIRED/);
});

test("missing or non-absolute host roots fail closed without loading any module", async (t) => {
  for (const runtimeRoot of [undefined, null, "", "relative/feishu", "/", "/fixture/../feishu"]) {
    const h = fixture(t, { runtimeRoot });
    await assert.rejects(h.request("state"), /INVALID_RUNTIME_ROOT/);
    await assert.rejects(h.request("invoke", "oneClickConnect", { botId: "bot-test" }), /INVALID_RUNTIME_ROOT/);
    assert.deepEqual(h.calls.loads, []);
    assert.deepEqual(h.calls.provisioners, []);
  }
});

test("prepare preserves private paths, cancellation, and phases without exposing the owner token", async (t) => {
  const h = fixture(t);
  const { prepareRuntime, store } = await h.callbacks();
  const phases = [];
  const args = { existing: { botId: "bot-test" }, signal: new AbortController().signal,
    onPhase: (phase) => phases.push(phase) };
  h.prepare = async (received) => {
    assert.equal(received, args);
    received.onPhase("downloadingCli");
    return structuredClone(PREPARED);
  };
  assert.deepEqual(await prepareRuntime(args), PREPARED);
  assert.deepEqual(phases, ["downloadingCli"]);
  assert.deepEqual(h.calls.preparations, [args]);
  assert.deepEqual(h.calls.dialogs, []);
  await store.save({ ...args.existing, ...PREPARED });
  assert.equal((await store.load()).configDir, path.join(RUNTIME_ROOT, "context"));
  const state = await h.request("state");
  assert.equal(Object.hasOwn(state, "configDir"), false);
  assert.equal(JSON.stringify({ state, document: h.document, args, provisioners: h.calls.provisioners }).includes(TOKEN), false);
});

test("prepare rechecks trust before and after provisioning and preserves abort reasons", async (t) => {
  for (const [name, change] of deniedContexts.filter(([name]) =>
    !["wrong window", "same-origin subframe"].includes(name))) {
    await t.test(name, async (t) => {
      const h = fixture(t);
      const { prepareRuntime } = await h.callbacks();
      const gate = deferred();
      h.prepare = () => gate.promise;
      const pending = prepareRuntime({ signal: new AbortController().signal });
      change(h);
      gate.resolve(PREPARED);
      await assert.rejects(pending, /LOCAL_WINDOW_REQUIRED/);
      await assert.rejects(prepareRuntime({}));
      assert.equal(h.calls.preparations.length, 1);
    });
  }
  const h = fixture(t);
  const { prepareRuntime } = await h.callbacks();
  const abort = new AbortController();
  const reason = new Error("FIXTURE_CANCELLED");
  h.prepare = async ({ signal }) => {
    assert.equal(signal, abort.signal);
    abort.abort(reason);
    return PREPARED;
  };
  await assert.rejects(prepareRuntime({ signal: abort.signal }), (error) => error === reason);
  await assert.rejects(prepareRuntime({ signal: abort.signal }), (error) => error === reason);
  assert.equal(h.calls.preparations.length, 1);
});

test("real controller persists the provisioned context privately and passes it only to the CLI", async (t) => {
  const h = fixture(t, { realConnector: true });
  const cliOptions = [];
  h.createCli = (options) => {
    cliOptions.push(options);
    // Stop before authorization; only verify the host-to-controller path boundary.
    return { version: async () => ({ supported: false }) };
  };
  const state = await h.request("invoke", "oneClickConnect", { botId: "bot-test" });
  assert.deepEqual(cliOptions, [{ executable: PREPARED.cliPath, configDir: PREPARED.configDir }]);
  assert.equal(h.document.tuantuanFeishu.configDir, PREPARED.configDir);
  assert.equal(h.document.tuantuanFeishu.schemaVersion, 2);
  assert.equal(state.cliPath, PREPARED.cliPath);
  assert.equal(state.nodePath, PREPARED.nodePath);
  assert.equal(Object.hasOwn(state, "configDir"), false);
  assert.equal(JSON.stringify({ state, cliOptions, document: h.document }).includes(TOKEN), false);
  assert.deepEqual(h.calls.dialogs, []);
  assert.deepEqual(h.calls.external, []);
});

for (const action of ["disconnect", "close"]) {
  test(`${action} during download aborts the real controller and ignores late phases/results`, async (t) => {
    const h = fixture(t, { realConnector: true });
    const started = deferred();
    const download = deferred();
    t.after(() => download.resolve(PREPARED));
    let args;
    h.prepare = (value) => {
      args = value;
      value.onPhase("downloadingCli");
      started.resolve();
      return download.promise;
    };
    const pending = h.request("invoke", "oneClickConnect", { botId: "bot-test" });
    await started.promise;
    assert.equal((await h.request("state")).phase, "downloadingCli");
    assert.equal(args.signal.aborted, false);
    if (action === "close") await h.registration.close();
    else await h.request("invoke", "disconnect");
    assert.equal(args.signal.aborted, true);
    const cancelled = await pending;
    assert.equal(cancelled.pending, false);
    assert.equal(Object.hasOwn(cancelled, "phase"), false);
    args.onPhase("verifyingRuntime");
    download.resolve(PREPARED);
    await new Promise((resolve) => setImmediate(resolve));
    if (action === "disconnect") assert.deepEqual(await h.request("state"), cancelled);
    if (action === "disconnect") {
      assert.equal(h.calls.saves.length, 1);
      assert.equal(h.document.tuantuanFeishu.reconnect, false);
    } else assert.deepEqual(h.calls.saves, []);
    assert.deepEqual(h.calls.dialogs, []);
    assert.deepEqual(h.calls.external, []);
  });
}

test("close during module loading prevents construction and execution", async (t) => {
  const loadGate = deferred();
  const h = fixture(t, { loadGate });
  const pending = h.request("invoke", "connect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.loads.length, 3);
  await h.registration.close();
  loadGate.resolve();
  await assert.rejects(pending);
  assert.deepEqual(h.calls.kernels, []);
  assert.deepEqual(h.calls.connectors, []);
  assert.deepEqual(h.calls.invokes, []);
  await assert.rejects(h.request("state"));
  await assert.rejects(h.request("invoke", "connect"));
});

test("host startup restores without opening the plugin page and rejects untrusted startup", async (t) => {
  const h = fixture(t);
  await Promise.all([h.registration.start(), h.registration.start()]);
  assert.deepEqual(h.calls.invokes, [["host-resume"]]);
  assert.equal(h.calls.states.length, 0);
  h.host.remote = true;
  await assert.rejects(h.registration.start(), /LOCAL_WINDOW_REQUIRED/);
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /on\("did-finish-load", \(\) => \{\s*void desktopFeishu\?\.start\(\)/);
});

test("source desktop accepts its explicit renderer origin when the kernel uses another port", async (t) => {
  const h = fixture(t, { rendererOrigin: "http://127.0.0.1:5199" });
  await h.registration.start();
  assert.deepEqual(h.calls.invokes, [["host-resume"]]);
  assert.deepEqual(await h.request("state"), STATE);
});

test("failed module loading can be retried without a half-created connector", async (t) => {
  const gate = deferred();
  const failed = fixture(t, { loadGate: gate });
  const pending = failed.request("state");
  await new Promise((resolve) => setImmediate(resolve));
  gate.reject(new Error("FIXTURE_LOAD_FAILURE"));
  await assert.rejects(pending, /FIXTURE_LOAD_FAILURE/);
  assert.deepEqual(failed.calls.connectors, []);
  gate.promise = Promise.resolve();
  assert.deepEqual(await failed.request("state"), STATE);
  assert.equal(failed.calls.connectors.length, 1);
});

test("kernel identity changes while modules load cannot construct a stale connector", async (t) => {
  for (const key of ["pid", "baseUrl", "token"]) {
    await t.test(key, async (t) => {
      const loadGate = deferred();
      const h = fixture(t, { loadGate });
      const pending = h.request("invoke", "oneClickConnect", { botId: "bot-test" });
      await new Promise((resolve) => setImmediate(resolve));
      const old = h.host[key];
      h.host[key] = key === "pid" ? 4343 : key === "baseUrl" ? "http://127.0.0.1:43124" : "rotated-owner-token";
      if (key === "baseUrl") h.win.webContents.mainFrame.url = `${h.host.baseUrl}/settings`;
      loadGate.resolve();
      await assert.rejects(pending, /KERNEL_CHANGED/);
      assert.deepEqual(h.calls.provisioners, []);
      assert.deepEqual(h.calls.kernels, []);
      assert.deepEqual(h.calls.connectors, []);
      h.host[key] = old;
      h.win.webContents.mainFrame.url = `${ORIGIN}/settings`;
      assert.deepEqual(await h.request("state"), STATE);
    });
  }
});

test("kernel-gone close awaits cleanup and permanently revokes the registration", async (t) => {
  const closeGate = deferred();
  const h = fixture(t, { closeGate });
  const callbacks = await h.callbacks();
  h.host.pid = undefined;
  let settled = false;
  const closing = h.registration.close().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(h.calls.closes.length, 1);
  assert.equal(settled, false);
  // A replacement child must not revive the old owner's connector or callbacks.
  h.host.pid = 4343;
  await assert.rejects(h.request("state"));
  await assert.rejects(h.request("invoke", "connect"));
  await assert.rejects(callbacks.chooseExecutable("cli"));
  await assert.rejects(callbacks.confirm({}));
  await assert.rejects(callbacks.openExternal("https://accounts.feishu.cn/device"));
  assert.deepEqual(h.calls.invokes, []);
  assert.deepEqual(h.calls.dialogs, []);
  assert.deepEqual(h.calls.external, []);
  closeGate.resolve();
  await closing;
  assert.equal(settled, true);
  assert.equal(h.calls.connectors.length, 1);
});

for (const delay of [3000, Infinity]) {
  test(`remote relaunch waits for Feishu cleanup bounded at four seconds (${delay} ms close)`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const closeGate = deferred();
    const h = fixture(t, { closeGate });
    const callbacks = await h.callbacks();
    const calls = [];
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const source = main.match(/function relaunchAfterDesktopRemoteChange\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    assert.ok(source);
    const relaunch = new Function("desktopFeishu", "app", "awaitFeishuShutdown", "setTimeout",
      `${source}; return relaunchAfterDesktopRemoteChange;`)(h.registration, {
      relaunch: () => calls.push("relaunch"), exit: (code) => calls.push(["exit", code]),
    }, awaitFeishuShutdown, setTimeout);
    relaunch();
    assert.equal(h.calls.closes.length, 1, "cleanup must start synchronously");
    await assert.rejects(h.request("invoke", "connect"));
    await assert.rejects(callbacks.confirm({}));
    if (Number.isFinite(delay)) setTimeout(() => { calls.push("child closed"); closeGate.resolve(); }, delay);
    for (const elapsed of [250, 2250, 499]) {
      t.mock.timers.tick(elapsed);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, [], "forced exit must not cut off child cleanup before three seconds");
    }
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    if (Number.isFinite(delay)) {
      assert.deepEqual(calls, ["child closed", "relaunch", ["exit", 0]]);
    } else {
      assert.deepEqual(calls, []);
      t.mock.timers.tick(999);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, []);
      t.mock.timers.tick(1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["relaunch", ["exit", 0]]);
    }
    t.mock.timers.tick(30000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((call) => call === "relaunch").length, 1);
  });
}

test("bounded Feishu shutdown handles absent, throwing, rejected, and late-rejected cleanup without exposing errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const close of [() => undefined, () => { throw new Error(TOKEN); }, () => Promise.reject(new Error(TOKEN))]) {
    assert.equal(await awaitFeishuShutdown(close), undefined);
  }
  const gate = deferred();
  const shutdown = awaitFeishuShutdown(() => gate.promise);
  t.mock.timers.tick(4000);
  assert.equal(await shutdown, undefined);
  gate.reject(new Error(TOKEN));
  await new Promise((resolve) => setImmediate(resolve));
});

for (const delay of [3000, Infinity]) {
  test(`before-quit gives Feishu its own deadline outside the CUA cap (${delay} ms close)`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const closeGate = deferred();
    const h = fixture(t, { closeGate });
    await h.callbacks();
    const calls = [];
    let beforeQuit;
    let registrationClosed = false;
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const source = main.match(/app\.on\("before-quit",[\s\S]*?\n\}\);/)?.[0];
    assert.ok(source);
    runInNewContext(source, {
      app: { on: (_event, handler) => { beforeQuit = handler; }, quit: () => calls.push("quit") },
      desktopShutdownStarted: false, cuaCleanedUp: false, serverProc: null,
      composioRegistrationLoop: { close: () => { registrationClosed = true; } },
      browserDescriptorRefreshTimer: null, clearInterval,
      syncCompanionKeepAwake() {}, desktopCompanionRelay: null, nativeActions: {},
      stopRecorder() {}, browserSurface: null, browserHost: null,
      stopCua: () => new Promise(() => {}), stopDesktopCompanion: async () => {},
      stopUtilityServer: async () => true, CUA_STOP_TIMEOUT_MS: 2500,
      desktopFeishu: h.registration, awaitFeishuShutdown, setTimeout,
    });
    beforeQuit({ preventDefault: () => calls.push("prevented") });
    assert.equal(registrationClosed, true, "quitting stops cloud registration without delaying Feishu cleanup");
    assert.equal(h.calls.closes.length, 1);
    await assert.rejects(h.request("invoke", "connect"));
    if (Number.isFinite(delay)) setTimeout(() => closeGate.resolve(), delay);
    for (const elapsed of [2500, 499]) {
      t.mock.timers.tick(elapsed);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["prevented"], "CUA timeout must not bypass Feishu cleanup");
    }
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    if (!Number.isFinite(delay)) {
      assert.deepEqual(calls, ["prevented"]);
      t.mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(calls, ["prevented", "quit"]);
  });
}

for (const channel of ["state", "invoke"]) {
  test(`${channel} rechecks caller and runtime after asynchronous module loading`, async (t) => {
    for (const [name, change] of deniedContexts.filter(([name]) =>
      ["remote runtime", "unknown PID", "not ready", "stopping", "destroyed window", "remote page"].includes(name))) {
      await t.test(name, async (t) => {
        const loadGate = deferred();
        const h = fixture(t, { loadGate });
        const pending = h.request(channel, "connect");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(h.calls.loads.length, 3);
        change(h);
        loadGate.resolve();
        // Either a rejection or an unavailable state is safe, but no connector
        // operation may run using the trust snapshot from before the await.
        await pending.catch(() => {});
        assert.deepEqual(h.calls.provisioners, [], "provisioner constructed after trust was revoked");
        assert.deepEqual(h.calls.connectors, [], "connector constructed after trust was revoked");
        assert.deepEqual(h.calls.states, [], "state executed after trust was revoked");
        assert.deepEqual(h.calls.invokes, [], "invoke executed after trust was revoked");
      });
    }
  });
}

test("main wires private runtime, encrypted credential updates, and native dependencies", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /import\s*\{\s*registerFeishu,\s*awaitFeishuShutdown\s*\}\s*from\s*["']\.\/tuantuan-feishu\.mjs["']/);
  const registration = main.match(/desktopFeishu\s*=\s*registerFeishu\(\{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(registration, "main must register the Feishu host");
  for (const pattern of [/ipcMain,\s*localOnly/, /platform:\s*process\.platform/, /packaged:\s*app\.isPackaged\s*\|\|\s*OWNS_LOCAL_SERVER/,
    /remote:\s*!!desktopRemoteAccess/, /stopping:\s*desktopShutdownStarted/, /ready:\s*serverReady/,
    /pid:\s*serverProc\?\.pid/, /rendererOrigin:\s*desktopLayout\.built\s*\?\s*`http:\/\/127\.0\.0\.1:\$\{SERVER_PORT\}`\s*:\s*new URL\(DEV_URL\)\.origin/,
    /token:\s*desktopMutationToken/, /process\.resourcesPath,\s*"tuantuan-feishu"/,
    /runtimeRoot:\s*path\.join\(app\.getPath\("userData"\),\s*"feishu"\)/,
    /bundledRuntimeRoot:\s*desktopLayout\.feishu/,
    /credentialStoreUnavailable/, /secureCredentialState\.read\(\)/,
    /saveCredentials:\s*updateSecureCredentialDocument/, /dialog,\s*openExternal:.*shell\.openExternal\(url\)/,
    /window:\s*\(\)\s*=>\s*mainWindow/]) assert.match(registration, pattern);
  assert.match(main, /async function updateSecureCredentialDocument\(derive, afterPersist\)\s*\{[\s\S]*?secureCredentialState\.update\(derive, afterPersist\)/);
});

test("main closes Feishu on the owning kernel exit, remote switch, and app quit", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /proc\.once\("exit",[\s\S]*?if \(proc === serverProc\) void desktopFeishu\?\.close\(\)/);
  assert.match(main, /function relaunchAfterDesktopRemoteChange\(\)\s*\{\s*const cleanup = awaitFeishuShutdown\(\(\) => desktopFeishu\?\.close\(\)\)/);
  const quit = main.slice(main.indexOf('app.on("before-quit",'));
  const owned = quit.slice(quit.indexOf("const ownedHelperCleanup"), quit.indexOf("const cleanup"));
  assert.doesNotMatch(owned, /[Ff]eishu/);
  assert.match(quit, /const cleanup = Promise\.all\(\[\s*(?:\/\/[^\n]*\n\s*)?awaitFeishuShutdown\(\(\) => desktopFeishu\?\.close\(\)\),\s*ownedHelperCleanup,/);
});

test("preload exposes only state/invoke on local Windows/macOS, never an owner capability", () => {
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /\["win32", "darwin"\]\.includes\(process\.platform\) && !desktopRemoteClient\s*\?\s*\{\s*feishu:/);
  const feishu = preload.match(/feishu:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  assert.ok(feishu);
  assert.match(feishu, /state:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("tuantuan-feishu:state"\)/);
  assert.match(feishu, /invoke:\s*\(action, input\)\s*=>\s*ipcRenderer\.invoke\("tuantuan-feishu:invoke", action, input\)/);
  assert.doesNotMatch(preload, /desktopMutationToken|ownerToken/);
  assert.doesNotMatch(preload.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]/)?.[1] ?? "", /feishu/);
  assert.match(preload, /isLocalPage[\s\S]*?REMOTE_SAFE\.has/);
});
