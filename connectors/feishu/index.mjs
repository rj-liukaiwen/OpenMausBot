/* eslint-disable no-control-regex -- Reject controls at executable and message boundaries. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { createCli } from './cli.mjs';
import { TOOL_SCOPES } from './onboarding.mjs';
import { validateTool } from './tools.mjs';
import { isLegacyFeishuEntry } from './mcp-ownership.mjs';

const MCP = '/api/mcp/servers/tuantuan-feishu';
const NAME = 'tuantuan-feishu';
const ERROR = '\u64cd\u4f5c\u672a\u5b8c\u6210\uff0c\u8bf7\u68c0\u67e5\u914d\u7f6e\u548c\u6388\u6743\u540e\u91cd\u8bd5\u3002';
const ERRORS = {
  UNSAFE_PATH: '飞书组件或配置路径未通过安全检查，连接已停止；请使用修正后的客户端，不要清除已有授权。',
  UNSUPPORTED_PLATFORM: '当前系统或处理器架构尚不支持本机飞书连接。',
  BUNDLED_RUNTIME_MISSING: '安装包缺少飞书运行组件，请使用补齐运行时的新安装包；不会借用本机开发环境或下载其他版本。',
  INVALID_ARCHIVE: '飞书运行组件归档无效，已停止准备。',
  APP_UNAVAILABLE: '原飞书应用已删除或未启用。可重新创建并授权；旧配置和任务将保留，网络故障不会触发应用替换。',
  AUTH_DENIED: '\u98de\u4e66\u6388\u6743\u5df2\u62d2\u7edd\uff0c\u8bf7\u91cd\u8bd5\u8fde\u63a5\u5e76\u5728\u6d4f\u89c8\u5668\u4e2d\u786e\u8ba4\u3002',
  AUTH_EXPIRED: '\u98de\u4e66\u6388\u6743\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u8bd5\u8fde\u63a5\u3002',
  DOWNLOAD_FAILED: '\u7ec4\u4ef6\u4e0b\u8f7d\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u3002',
  DOWNLOAD_TIMEOUT: '\u7ec4\u4ef6\u4e0b\u8f7d\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5\u3002',
  DOWNLOAD_TRUNCATED: '\u7ec4\u4ef6\u4e0b\u8f7d\u4e0d\u5b8c\u6574\uff0c\u672a\u5b89\u88c5\uff0c\u8bf7\u91cd\u8bd5\u3002',
  CHECKSUM_MISMATCH: '\u7ec4\u4ef6\u5b8c\u6574\u6027\u6821\u9a8c\u5931\u8d25\uff0c\u5df2\u505c\u6b62\u5b89\u88c5\u3002',
  INVALID_ZIP: '\u7ec4\u4ef6\u5b89\u88c5\u5305\u65e0\u6548\uff0c\u8bf7\u91cd\u8bd5\u3002',
  SIZE_LIMIT: '\u7ec4\u4ef6\u5927\u5c0f\u8d85\u51fa\u5b89\u5168\u9650\u5236\u3002',
  UNSAFE_DOWNLOAD_URL: '\u7ec4\u4ef6\u4e0b\u8f7d\u5730\u5740\u672a\u901a\u8fc7\u5b89\u5168\u68c0\u67e5\u3002',
  UNSAFE_REDIRECT: '\u7ec4\u4ef6\u4e0b\u8f7d\u8df3\u8f6c\u672a\u901a\u8fc7\u5b89\u5168\u68c0\u67e5\u3002',
  REDIRECT_LIMIT: '\u7ec4\u4ef6\u4e0b\u8f7d\u8df3\u8f6c\u8fc7\u591a\u3002',
  INCOMPATIBLE_RUNTIME: '\u8fd0\u884c\u7ec4\u4ef6\u7248\u672c\u4e0d\u517c\u5bb9\u3002',
  VERSION_TIMEOUT: '\u8fd0\u884c\u7ec4\u4ef6\u9a8c\u8bc1\u8d85\u65f6\u3002',
  RUNTIME_BUSY: '\u8fd0\u884c\u7ec4\u4ef6\u6b63\u5728\u51c6\u5907\u4e2d\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
  SCOPE_REQUIRED: '\u98de\u4e66\u5e94\u7528\u6743\u9650\u5c1a\u672a\u5b8c\u6210\u5ba1\u6279\u3002\u8bf7\u5728\u6d4f\u89c8\u5668\u4e2d\u7533\u8bf7\u6240\u9700\u6743\u9650\uff0c\u7b49\u5f85\u7ba1\u7406\u5458\u6279\u51c6\u540e\u91cd\u8bd5\u8fde\u63a5\u3002\u539f\u5e94\u7528\u548c\u7ed1\u5b9a\u5df2\u4fdd\u7559\u3002',
  INITIALIZATION_UNCERTAIN: '\u4e0a\u6b21\u5e94\u7528\u914d\u7f6e\u5df2\u4e2d\u65ad\uff0c\u65e0\u6cd5\u786e\u8ba4\u662f\u5426\u5df2\u521b\u5efa\u5e94\u7528\u3002\u8bf7\u5148\u5728\u6d4f\u89c8\u5668\u4e2d\u68c0\u67e5\u5df2\u6709\u5e94\u7528\uff0c\u907f\u514d\u91cd\u590d\u521b\u5efa\u3002',
  LICENSE_REVIEW_REQUIRED: '\u98de\u4e66\u8fd0\u884c\u73af\u5883\u7684\u8bb8\u53ef\u5ba1\u6838\u5c1a\u672a\u5b8c\u6210\uff0c\u6682\u4e0d\u80fd\u81ea\u52a8\u5b89\u88c5\u3002\u8bf7\u7b49\u5f85\u8bb8\u53ef\u5ba1\u6838\u901a\u8fc7\u540e\u91cd\u8bd5\u3002',
  CONFIG_EXISTS: '\u5df2\u6709\u98de\u4e66\u5e94\u7528\u914d\u7f6e\u5df2\u4fdd\u7559\uff0c\u4e0d\u4f1a\u8986\u76d6\u3002\u8bf7\u68c0\u67e5\u539f\u5e94\u7528\u914d\u7f6e\u540e\u91cd\u8bd5\u8fde\u63a5\u3002',
  CONFIG_NOT_EMPTY: '\u98de\u4e66\u914d\u7f6e\u76ee\u5f55\u5df2\u6709\u5185\u5bb9\uff0c\u4e0d\u4f1a\u8986\u76d6\u3002\u8bf7\u68c0\u67e5\u672c\u673a\u914d\u7f6e\u540e\u91cd\u8bd5\u3002',
  CONFIG_IO_ERROR: '\u65e0\u6cd5\u8bfb\u5199\u98de\u4e66\u914d\u7f6e\u3002\u8bf7\u68c0\u67e5\u78c1\u76d8\u7a7a\u95f4\u548c\u6587\u4ef6\u6743\u9650\u540e\u91cd\u8bd5\u3002',
  BOT_REQUIRED: '\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u53ef\u7528\u7684 bot\uff0c\u518d\u8fde\u63a5\u98de\u4e66\u3002',
  IDENTITY_CONFLICT: '\u5f53\u524d\u98de\u4e66\u5e94\u7528\u6216\u7528\u6237\u4e0e\u5df2\u4fdd\u5b58\u7684\u7ed1\u5b9a\u4e0d\u4e00\u81f4\u3002\u5df2\u4fdd\u7559\u539f\u7528\u6237\u548c\u4efb\u52a1\uff0c\u8bf7\u6062\u590d\u539f\u5e94\u7528\u5e76\u4f7f\u7528\u539f\u8d26\u53f7\u91cd\u8bd5\u3002',
  LEGACY_NOT_CONFIGURED: '\u5df2\u4fdd\u5b58\u7684\u672c\u673a CLI \u5e94\u7528\u914d\u7f6e\u7f3a\u5931\u3002\u4e3a\u4fdd\u62a4\u539f\u7ed1\u5b9a\uff0c\u4e0d\u4f1a\u81ea\u52a8\u8986\u76d6\u914d\u7f6e\u3002\u8bf7\u5728\u672c\u673a\u6062\u590d\u539f CLI \u5e94\u7528\u914d\u7f6e\u540e\u91cd\u8bd5\u8fde\u63a5\u3002',
  CLI_REQUIRED: '\u8bf7\u5148\u9009\u62e9\u98de\u4e66 CLI \u53ef\u6267\u884c\u6587\u4ef6\u3002',
  CLI_NOT_CONFIGURED: '\u98de\u4e66 CLI \u5c1a\u672a\u914d\u7f6e\u5e94\u7528\u3002\u8bf7\u5728\u98de\u4e66\u5f00\u653e\u5e73\u53f0\u521b\u5efa\u81ea\u5efa\u5e94\u7528\uff0c\u83b7\u53d6 App ID \u548c App Secret\uff0c\u6309 CLI \u5b98\u65b9\u914d\u7f6e\u5411\u5bfc\u5728\u672c\u673a\u5b8c\u6210\u914d\u7f6e\u540e\u91cd\u65b0\u68c0\u6d4b\u3002\u8bf7\u52ff\u5728\u804a\u5929\u4e2d\u53d1\u9001 App Secret\u3002',
  CLI_VERSION: '\u4ec5\u652f\u6301\u98de\u4e66 CLI 1.0.93\uff0c\u8bf7\u9009\u62e9\u6b64\u7248\u672c\u540e\u91cd\u65b0\u68c0\u6d4b\u3002',
  NODE_VERSION: '\u8bf7\u9009\u62e9 Node.js 24 \u6216\u66f4\u9ad8\u7248\u672c\u7684 node \u53ef\u6267\u884c\u6587\u4ef6\u3002',
  INVALID_EXECUTABLE: '\u53ef\u6267\u884c\u6587\u4ef6\u65e0\u6548\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u3002',
  SPAWN_FAILED: '\u65e0\u6cd5\u542f\u52a8 CLI\uff0c\u8bf7\u68c0\u67e5\u6587\u4ef6\u548c\u6267\u884c\u6743\u9650\u3002',
  AUTH_REQUIRED: '\u7528\u6237\u6388\u6743\u6682\u4e0d\u53ef\u7528\uff0c\u914d\u5bf9\u4f1a\u4fdd\u7559\u3002\u8bf7\u91cd\u65b0\u767b\u5f55\u6216\u91cd\u8bd5\u68c0\u6d4b\u3002',
  BOT_AUTH_REQUIRED: '\u673a\u5668\u4eba\u6388\u6743\u672a\u9a8c\u8bc1\uff0c\u8bf7\u5728 CLI \u914d\u7f6e\u5e94\u7528\u540e\u91cd\u65b0\u68c0\u6d4b\u3002',
  CLI_NETWORK_ERROR: '\u98de\u4e66\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u68c0\u6d4b\u3002',
  TIMEOUT: '\u68c0\u6d4b\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u3002',
  APPROVAL_DENIED: '\u5df2\u53d6\u6d88\u64cd\u4f5c\uff0c\u9700\u8981\u65f6\u53ef\u91cd\u65b0\u53d1\u8d77\u3002',
  APPROVAL_TIMEOUT: '\u786e\u8ba4\u5df2\u8d85\u65f6\uff0c\u8bf7\u91cd\u65b0\u53d1\u8d77\u64cd\u4f5c\u3002',
  MCP_CONFLICT: '\u5df2\u5b58\u5728\u540c\u540d\u7684\u81ea\u5b9a\u4e49 MCP\uff0c\u672a\u8986\u76d6\u3002\u8bf7\u5148\u5728 MCP \u8bbe\u7f6e\u4e2d\u5904\u7406\u540d\u79f0\u51b2\u7a81\u3002',
};
const localized = (error) => Object.hasOwn(ERRORS, error?.code) ? ERRORS[error.code] : ERROR;
const GLOBAL_TOOLS = '\u98de\u4e66 MCP \u5de5\u5177\u5bf9\u6574\u4e2a\u5de5\u4f5c\u533a\u751f\u6548\uff0c\u6240\u6709 bot \u5747\u53ef\u8bf7\u6c42\u8c03\u7528\uff0c\u4e0d\u4ec5\u9650\u4e8e\u5f53\u524d\u9009\u4e2d\u7684 bot\u3002\u6bcf\u6b21\u8c03\u7528\uff08\u5305\u62ec\u8bfb\u53d6\uff09\u4ecd\u9700\u672c\u673a\u786e\u8ba4\u3002';
const UNCERTAIN = '\u672a\u80fd\u786e\u8ba4\u672c\u6b21\u5904\u7406\u7ed3\u679c\uff0c\u4e0d\u4f1a\u81ea\u52a8\u91cd\u8bd5\uff0c\u4e5f\u4e0d\u4fdd\u8bc1\u7a0d\u540e\u56de\u590d\u3002\u65ad\u5f00\u53ea\u505c\u6b62\u672c\u5730\u7b49\u5f85\uff0c\u4e0d\u4f1a\u53d6\u6d88\u5df2\u63d0\u4ea4\u7684\u4efb\u52a1\u3002';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v, prefix = '') => typeof v === 'string' && v.length <= 256 &&
  new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(v);
const executablePath = (v) => typeof v === 'string' && v.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(v) && path.isAbsolute(v);
const nodePath = (v) => executablePath(v) &&
  (process.platform === 'win32' ? path.basename(v).toLowerCase() === 'node.exe' : path.basename(v) === 'node');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const failure = (code = 'FORBIDDEN') => Object.assign(new Error(code), { code });
const userId = (info) => info?.user?.available === true && ['ready', 'needs_refresh'].includes(info.user.status) &&
  info.user.verified === true && id(info.user.openId, 'ou_') ? info.user.openId : undefined;

// Host-only default: no shell, inherited NODE_OPTIONS, stdin, or unbounded output.
function probeNode(executable, { signal } = {}) {
  return new Promise((resolve) => {
    let child;
    let output = '';
    let done = false;
    let timer;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child?.kill('SIGKILL');
      resolve(ok);
    };
    const abort = () => finish(false);
    if (signal?.aborted) { finish(false); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'TMP', 'TEMP'].includes(key.toUpperCase())));
    try {
      child = spawn(executable, ['--version'], { shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env });
      timer = setTimeout(() => finish(false), 5000);
      child.on('error', () => finish(false));
      child.stdout.on('error', () => finish(false));
      child.stderr.on('error', () => finish(false));
      child.stderr.on('data', () => finish(false));
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.length > 128) finish(false);
      });
      child.on('close', (code) => {
        const match = /^v(\d+)\.\d+\.\d+\s*$/.exec(output);
        finish(code === 0 && !!match && Number(match[1]) >= 24);
      });
    } catch { finish(false); }
  });
}

/** Host callbacks only. clock optionally supplies now/setTimeout/clearTimeout.
 * validateNode(path, {signal}) must resolve true only after verifying Node >=24.
 * prepareRuntime({existing, signal, onPhase}) returns verified cliPath/nodePath
 * and optionally configDir, exclusively owned and validated by the trusted host.
 * authorizeTool is a host-only policy for validated office calls. Without one,
 * native confirmation remains the conservative fallback. No policy, paths or
 * setup flags come from the renderer.
 * Persist only connection intent, never live enabled state, tokens or message bodies.
 */
export function createConnector({ kernel, store, chooseExecutable, confirm, authorizeTool = confirm, openExternal, createRecoveryContext,
  mcpPath, prepareRuntime, createCliImpl = createCli, validateNode = probeNode, clock = {} }) {
  const now = typeof clock === 'function' ? clock : () => clock.now?.() ?? Date.now();
  const later = (fn, ms) => (clock.setTimeout ?? setTimeout)(fn, ms);
  const clear = (timer) => (clock.clearTimeout ?? clearTimeout)(timer);
  let config = { cliPath: '', nodePath: '', botId: '', records: [] };
  const view = { supported: true, cliPath: '', nodePath: '', botId: '', im: 'off',
    toolsEnabled: false, userAuthorized: false, botAuthorized: false, pending: false };
  let loaded;
  let loadFailed = false;
  let closed = false;
  let epoch = 0;
  let cli;
  let identity;
  let lastUser;
  let login;
  let im;
  let tools;
  let operation;
  let saves = Promise.resolve();
  let registry = Promise.resolve();
  let inspections = Promise.resolve();
  const consumerStops = new Set();
  let closing;
  let replacementBase;
  let resuming;
  let resumeAttempted = false;

  function snapshot() {
    return Object.freeze({ ...view, ...(view.login ? { login: Object.freeze({ ...view.login }) } : {}) });
  }
  function persist() {
    const value = structuredClone(replacementBase ? {
      ...replacementBase,
      recovery: { configDir: config.configDir, ...(config.appId ? { appId: config.appId } : {}) },
    } : config);
    const work = saves.then(() => store.save(value));
    saves = work.catch(() => {});
    return work;
  }
  function init() {
    loaded ??= Promise.resolve().then(() => store.load()).then((value) => {
      if (!object(value)) throw failure();
      // Never fall back to the native context when a saved managed path is corrupt.
      if (value.configDir !== undefined && !executablePath(value.configDir)) throw failure();
      if (value.recovery !== undefined && (!object(value.recovery) || !executablePath(value.recovery.configDir)
        || (value.recovery.appId !== undefined && !id(value.recovery.appId, 'cli_')))) throw failure();
      config = { cliPath: executablePath(value.cliPath) ? value.cliPath : '',
        nodePath: nodePath(value.nodePath) ? value.nodePath : '',
        botId: id(value.botId) ? value.botId : '',
        ...(value.schemaVersion === 2 ? { schemaVersion: 2 } : {}),
        ...(typeof value.reconnect === 'boolean' ? { reconnect: value.reconnect } : {}),
        ...(value.configDir !== undefined ? { configDir: value.configDir } : {}),
        ...(value.recovery ? { recovery: { configDir: value.recovery.configDir,
          ...(value.recovery.appId ? { appId: value.recovery.appId } : {}) } } : {}),
        ...(id(value.ownerOpenId, 'ou_') ? { ownerOpenId: value.ownerOpenId } : {}),
        ...(id(value.appId, 'cli_') ? { appId: value.appId } : {}),
        ...(id(value.threadId) ? { threadId: value.threadId } : {}),
        records: [...new Set(Array.isArray(value.records) ? value.records.filter((v) => id(v, 'om_')) : [])].slice(-1000) };
      Object.assign(view, { cliPath: config.cliPath, nodePath: config.nodePath,
        botId: config.botId, ownerOpenId: config.ownerOpenId, reconnect: config.reconnect === true });
      if (config.recovery) view.recoveryPending = true;
    }).catch(() => { loadFailed = true; view.error = ERROR; });
    return loaded;
  }
  function guard(signal) {
    if (closed || signal?.aborted) throw failure('NOT_CONNECTED');
  }
  async function bounded(work, signal, ms = 120000) {
    guard(signal);
    let timer;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(failure('NOT_CONNECTED'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = later(() => reject(failure('APPROVAL_TIMEOUT')), ms);
    });
    try { return await Promise.race([Promise.resolve().then(() => { guard(signal); return work(); }), cancelled]); }
    finally { clear(timer); signal?.removeEventListener('abort', abort); }
  }
  async function approve(title, message, detail, signal, decide = confirm) {
    const accepted = await bounded(() => decide({ title, message, detail }), signal);
    guard(signal);
    if (accepted !== true) throw failure('APPROVAL_DENIED');
  }
  function stopIm() {
    const old = im;
    im = undefined;
    delete view.pairingCode;
    view.im = 'off';
    if (!old) return;
    old.abort.abort();
    old.ready?.(false);
    clear(old.timer);
    clear(old.reconnect);
    old.queue.length = 0;
    stopConsumer(old.consumer);
  }
  function stopConsumer(consumer) {
    if (!consumer) return;
    try {
      const pending = Promise.resolve(consumer.stop()).catch(() => { view.error = ERROR; });
      consumerStops.add(pending);
      void pending.then(() => consumerStops.delete(pending));
    } catch { view.error = ERROR; }
  }
  function stopTools() {
    const old = tools;
    tools = undefined;
    view.toolsEnabled = false;
    if (!old) return;
    old.abort.abort();
    old.token = '';
    old.server.close();
    old.server.closeAllConnections();
  }
  function owned(entry) {
    return entry?.name === NAME && nodePath(entry.command) && executablePath(mcpPath) &&
      Array.isArray(entry.args) && entry.args.length === 1 && entry.args[0] === mcpPath;
  }
  function sameRegistration(left, right) {
    return left?.command === right?.command && JSON.stringify(left?.args) === JSON.stringify(right?.args) &&
      JSON.stringify(left?.envKeys) === JSON.stringify(right?.envKeys);
  }
  async function entry(signal) {
    const value = await kernel.request('/api/mcp/servers', { signal });
    if (!Array.isArray(value?.servers)) throw failure();
    return value.servers.find((v) => v.name === NAME);
  }
  function registryWork(work) {
    const pending = registry.then(work);
    registry = pending.catch(() => {});
    return pending;
  }
  function disableConfig() {
    const expected = tools;
    return registryWork(async () => {
      if (tools && tools !== expected) return;
      const existing = await entry();
      if (tools && tools !== expected) return;
      const ours = owned(existing) || await isLegacyFeishuEntry(existing, mcpPath);
      if (tools && tools !== expected) return;
      if (ours && sameRegistration(existing, await entry())) {
        if (tools && tools !== expected) return;
        await kernel.request(MCP, { method: 'PATCH', body: { enabled: false } });
      }
    });
  }
  function revoke() {
    if (view.phase) view.phase = 'error';
    stopIm();
    stopTools();
    login = undefined;
    delete view.login;
    void disableConfig().catch(() => { view.error = ERROR; });
  }

  function inspect(signal) {
    const work = inspections.then(async () => {
      guard(signal);
      try { return await inspectCurrent(signal); }
      catch (error) {
        if (!closed && !signal?.aborted) {
          view.error = localized(error);
          revoke();
          view.userAuthorized = view.botAuthorized = false;
        }
        throw error;
      }
    });
    inspections = work.catch(() => {});
    return work;
  }
  async function verifyCli(signal) {
    guard(signal);
    if (!config.cliPath) throw failure('CLI_REQUIRED');
    cli ??= createCliImpl({ executable: config.cliPath, configDir: config.configDir });
    const currentCli = cli;
    const version = await bounded(() => currentCli.version({ signal }), signal);
    guard(signal);
    if (version?.version !== '1.0.93' || version.supported !== true) {
      view.error = localized(failure(version?.error?.code ?? 'CLI_VERSION'));
      revoke();
      view.userAuthorized = view.botAuthorized = false;
      delete view.version;
      throw failure(version?.error?.code ?? 'CLI_VERSION');
    }
    view.version = version.version;
    return currentCli;
  }
  async function inspectCurrent(signal) {
    const currentCli = await verifyCli(signal);
    const info = await bounded(() => currentCli.inspect({ signal }), signal);
    guard(signal);
    if (!id(info?.appId, 'cli_') || info.ok === false) {
      const code = info?.error?.code ?? (info?.bot?.status === 'not_configured' ? 'CLI_NOT_CONFIGURED' : 'AUTH_REQUIRED');
      view.error = localized(failure(code));
      revoke();
      view.userAuthorized = view.botAuthorized = false;
      throw failure(code);
    }
    const user = userId(info);
    const changed = (config.appId && config.appId !== info.appId) ||
      (user && lastUser && lastUser !== user) || (user && config.ownerOpenId && config.ownerOpenId !== user);
    if (changed) {
      revoke();
      throw failure('IDENTITY_CONFLICT');
    }
    identity = info;
    if (user) lastUser = user;
    view.userAuthorized = !!user;
    view.botAuthorized = info.botReady === true && info.bot?.available === true &&
      info.bot.status === 'ready' && info.bot.verified === true;
    if (!view.botAuthorized) stopIm();
    if (!user && (lastUser || tools || !['missing', 'not_configured'].includes(info.user?.status))) {
      revoke();
      view.error = ERRORS.AUTH_REQUIRED;
    }
    config.appId = info.appId;
    await persist();
    guard(signal);
    return info;
  }

  async function target(input, signal, { update = true, switching = false } = {}) {
    const botId = input?.botId ?? config.botId;
    if (!id(botId)) throw failure('BOT_REQUIRED');
    const bots = await bounded(() => kernel.bots({ signal }), signal);
    guard(signal);
    const bot = bots.find((v) => v.id === botId && !v.hidden && !v.archived);
    if (!bot) throw failure('BOT_REQUIRED');
    if (update && config.botId !== botId) {
      if (im && !switching) throw failure();
      if (switching) {
        operation.runtimeChanged = true;
        stopIm();
      }
      config.botId = botId;
      delete config.threadId;
      view.botId = botId;
      await persist();
      guard(signal);
    }
    return bot;
  }

  function live(session) { return !closed && im === session && !session.abort.signal.aborted; }
  function receive(session, message) {
    if (!live(session) || message?.type !== 'im.message.receive_v1' || message.chat_type !== 'p2p' ||
        message.sender_type !== 'user' || message.message_type !== 'text' ||
        !id(message.sender_id, 'ou_') || !id(message.message_id, 'om_') || !id(message.chat_id, 'oc_')) return;
    const text = message.content;
    if (typeof text !== 'string' || !text.trim() || text.length > 12000 || !text.isWellFormed() ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return;
    if (session.pairing) {
      if (session.busy || now() >= session.expires || text !== session.code ||
          (session.pairUser && message.sender_id !== session.pairUser) ||
          (userId(identity) && message.sender_id !== userId(identity))) return;
      session.busy = true;
      void (async () => {
        try {
          await approve('\u914d\u5bf9\u98de\u4e66', '\u662f\u5426\u5141\u8bb8\u6b64\u7528\u6237\u5411\u56e2\u56e2\u53d1\u9001\u4efb\u52a1\uff1f',
            `\u53d1\u9001\u8005 Open ID: ${message.sender_id}`, session.abort.signal);
          if (!live(session) || now() >= session.expires) return;
          await inspect(session.abort.signal);
          if (!live(session) || now() >= session.expires || !view.botAuthorized ||
              (session.pairUser && (userId(identity) !== session.pairUser || identity.appId !== session.pairApp)) ||
              (tools && (tools.user !== message.sender_id || tools.appId !== identity.appId)) ||
              (userId(identity) && userId(identity) !== message.sender_id)) return;
          config.ownerOpenId = message.sender_id;
          await persist();
          if (!live(session)) return;
          view.ownerOpenId = message.sender_id;
          stopIm();
        } catch { if (live(session)) view.error = ERROR; }
        finally { session.busy = false; }
      })();
      return;
    }
    if (message.sender_id !== session.owner || config.ownerOpenId !== session.owner ||
        config.records.includes(message.message_id) || session.ids.has(message.message_id)) return;
    if (session.queue.length >= 16) { view.error = '\u6d88\u606f\u8fc7\u591a\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002'; return; }
    session.ids.add(message.message_id);
    session.queue.push({ messageId: message.message_id, text });
    if (!session.busy) void deliver(session);
  }

  async function reply(session, messageId, text) {
    if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > 12000 * 16 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw failure();
    let offset = 0;
    let part = 0;
    while (offset < text.length) {
      await inspect(session.abort.signal);
      if (!live(session) || config.ownerOpenId !== session.owner) return;
      let end = Math.min(offset + 12000, text.length);
      if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
      const chunk = text.slice(offset, end);
      const digest = hash(`${messageId}:${part++}`);
      const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      offset = end;
      if (!chunk.trim()) continue;
      const signal = session.abort.signal;
      const result = await bounded(() => session.cli.sendReply(messageId, chunk, uuid, { signal }), signal);
      if (result?.ok === false) throw failure();
    }
  }
  async function deliver(session) {
    session.busy = true;
    try {
      while (live(session) && session.queue.length) {
        const item = session.queue.shift();
        try {
          await inspect(session.abort.signal);
          if (!live(session) || !view.botAuthorized || config.ownerOpenId !== session.owner) break;
          // Attempted IDs commit BEFORE kernel delivery. Restart never replays uncertain writes.
          config.records = [...config.records, item.messageId].slice(-1000);
          await persist();
          if (!live(session)) break;
          const result = await bounded(() => kernel.sendAndWait({ botId: session.botId,
            threadId: session.threadId, text: item.text, sendId: hash(item.messageId),
            signal: session.abort.signal }), session.abort.signal, 125000);
          if (live(session)) await reply(session, item.messageId, result.text);
        } catch {
          if (live(session)) view.error = UNCERTAIN;
        } finally { session.ids.delete(item.messageId); }
      }
    } finally { session.busy = false; }
  }
  function startConsumer(session) {
    if (!live(session)) return;
    const attempt = ++session.attempt;
    let exited = false;
    const current = () => live(session) && session.attempt === attempt && !exited;
    try {
      const consumer = session.cli.consume({
        onReady() {
          if (!current()) return;
          view.im = 'ready';
          session.ready?.(true);
          if (view.phase && !operation && view.toolsEnabled) view.phase = 'ready';
        },
        onMessage(message) { if (current()) receive(session, message); },
        onExit() {
          if (!current()) return;
          exited = true;
          if (++session.failures > 5) {
            stopIm(); view.im = 'error'; view.error = ERROR;
            if (view.phase) view.phase = 'error';
            return;
          }
          view.im = 'reconnecting';
          if (view.phase === 'ready') view.phase = 'starting';
          session.reconnect = later(() => startConsumer(session), Math.min(1000 * 2 ** (session.failures - 1), 16000));
        },
      });
      if (current()) session.consumer = consumer;
      else stopConsumer(consumer);
    } catch { stopIm(); view.im = 'error'; view.error = ERROR; if (view.phase) view.phase = 'error'; }
  }
  function startIm(pairing, ready) {
    stopIm();
    const session = { pairing, abort: new AbortController(), cli, owner: config.ownerOpenId,
      botId: config.botId, threadId: config.threadId, queue: [], ids: new Set(), busy: false,
      failures: 0, attempt: 0, ready };
    im = session;
    view.im = 'starting';
    if (pairing) {
      session.pairUser = userId(identity);
      session.pairApp = identity.appId;
      session.code = randomBytes(16).toString('hex');
      session.expires = now() + 300000;
      view.pairingCode = session.code;
      session.timer = later(() => { if (live(session)) { stopIm(); view.error = '\u914d\u5bf9\u7801\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u914d\u5bf9\u3002'; } }, 300000);
    }
    startConsumer(session);
  }

  async function toolCall(session, body, signal) {
    const valid = () => { guard(signal); if (tools !== session || !view.toolsEnabled) throw failure('NOT_CONNECTED'); };
    valid();
    if (!object(body) || Object.keys(body).some((k) => !['name', 'arguments'].includes(k))) throw failure('INVALID_ARGUMENTS');
    const command = validateTool(body.name, body.arguments);
    const info = await inspect(signal);
    valid();
    if (userId(info) !== session.user || info.appId !== session.appId ||
        (config.ownerOpenId && config.ownerOpenId !== session.user)) throw failure('AUTH_REQUIRED');
    await approve('\u98de\u4e66\u5de5\u5177\u8c03\u7528', command.summary,
      `${GLOBAL_TOOLS}\n\u5f53\u524d\u7528\u6237 Open ID: ${session.user}\n\u5e94\u7528: ${session.appId}\n${JSON.stringify({ name: body.name, arguments: body.arguments }, null, 2)}`, signal, authorizeTool);
    valid();
    const fresh = await inspect(signal);
    valid();
    if (userId(fresh) !== session.user || fresh.appId !== session.appId ||
        (config.ownerOpenId && config.ownerOpenId !== session.user)) throw failure('AUTH_REQUIRED');
    const result = await bounded(() => session.cli.run(command.args, { signal }), signal);
    valid();
    if (result?.ok === false) throw failure();
    return result;
  }
  async function startTools(signal, { setupApproved = false } = {}) {
    if (tools || !executablePath(mcpPath)) throw failure();
    if (!view.userAuthorized) throw failure('AUTH_REQUIRED');
    if (!nodePath(config.nodePath) ||
        await bounded(() => validateNode(config.nodePath, { signal }), signal) !== true) throw failure('NODE_VERSION');
    guard(signal);
    const pinnedUser = userId(identity);
    const pinnedApp = identity.appId;
    if (!setupApproved) await approve('\u542f\u7528\u98de\u4e66\u5de5\u5177', GLOBAL_TOOLS,
      `\u5f53\u524d\u7528\u6237 Open ID: ${pinnedUser}\n\u5e94\u7528: ${pinnedApp}`, signal);
    const info = await inspect(signal);
    if (userId(info) !== pinnedUser || info.appId !== pinnedApp) throw failure('AUTH_REQUIRED');
    const session = { abort: new AbortController(), token: randomBytes(32).toString('hex'),
      user: userId(identity), appId: identity.appId, cli, busy: false };
    session.server = createServer((req, res) => {
      const send = (status, value) => {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
          res.end(JSON.stringify(value));
        }
      };
      const reject = (status, code) => send(status, { ok: false, error: { code } });
      const expected = Buffer.from(`Bearer ${session.token}`);
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (tools !== session || !view.toolsEnabled || req.headers.host !== `127.0.0.1:${session.server.address()?.port}` ||
          Object.keys(req.headers).some((k) => k === 'origin' || k === 'referer' || k.startsWith('sec-fetch-')) ||
          actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reject(401, 'FORBIDDEN'); return; }
      if (req.method !== 'POST' || req.url !== '/tools' ||
          req.headers['content-type']?.toLowerCase() !== 'application/json' || req.headers['content-encoding']) {
        reject(400, 'INVALID_ARGUMENTS'); return;
      }
      if (session.busy) { reject(429, 'FORBIDDEN'); return; }
      session.busy = true;
      const call = new AbortController();
      const abort = () => call.abort();
      session.abort.signal.addEventListener('abort', abort, { once: true });
      res.on('close', abort);
      void (async () => {
        try {
          const body = await bounded(async () => {
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 65536) throw failure('INVALID_ARGUMENTS');
              chunks.push(chunk);
            }
            try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw failure('INVALID_ARGUMENTS'); }
          }, call.signal, 10000);
          const result = await toolCall(session, body, call.signal);
          send(200, { ok: true, result });
        } catch (error) {
          const code = ['APPROVAL_DENIED', 'APPROVAL_TIMEOUT', 'AUTH_REQUIRED', 'UNKNOWN_TOOL',
            'INVALID_ARGUMENTS', 'NOT_CONNECTED'].includes(error.code) ? error.code : 'FORBIDDEN';
          reject(200, code);
        } finally {
          session.busy = false;
          session.abort.signal.removeEventListener('abort', abort);
          res.off('close', abort);
          if (!req.complete) req.destroy();
        }
      })();
    });
    session.server.requestTimeout = 10000;
    session.server.headersTimeout = 10000;
    session.server.maxHeadersCount = 32;
    tools = session;
    try {
      await new Promise((resolve, reject) => {
        session.server.once('error', reject);
        session.server.listen(0, '127.0.0.1', resolve);
      });
      guard(signal);
      await registryWork(async () => {
        guard(signal);
        const existing = await entry(signal);
        guard(signal);
        if (existing && !owned(existing) && !await isLegacyFeishuEntry(existing, mcpPath)) throw failure('MCP_CONFLICT');
        if (existing && !sameRegistration(existing, await entry(signal))) throw failure('MCP_CONFLICT');
        guard(signal);
        const body = { command: config.nodePath, args: [mcpPath], enabled: false,
          env: { TT_FEISHU_BRIDGE_URL: `http://127.0.0.1:${session.server.address().port}`,
            TT_FEISHU_BRIDGE_TOKEN: session.token } };
        await kernel.request(existing ? MCP : '/api/mcp/servers', {
          method: existing ? 'PUT' : 'POST', body: existing ? body : { name: NAME, ...body }, signal });
        guard(signal);
        if (!owned(await entry(signal))) throw failure();
        guard(signal);
        const test = await kernel.request(`${MCP}/test`, { method: 'POST', signal });
        guard(signal);
        if (test?.ok !== true || !owned(await entry(signal))) throw failure();
        guard(signal);
        await kernel.request(MCP, { method: 'PATCH', body: { enabled: true }, signal });
        guard(signal);
        if (tools !== session) throw failure();
        view.toolsEnabled = true;
      });
    } catch (error) {
      if (tools === session) stopTools();
      else { session.server.close(); session.server.closeAllConnections(); }
      await disableConfig().catch(() => {});
      throw error;
    }
  }

  async function prepareSession(bot, signal, { setupApproved = false } = {}) {
    if (!config.threadId || !bot.tasks?.some((v) => v.threadId === config.threadId) || bot.threadId !== config.threadId) {
      if (!setupApproved) await approve('\u521b\u5efa\u98de\u4e66\u4efb\u52a1',
        '\u521b\u5efa\u5e76\u6fc0\u6d3b\u98de\u4e66\u4efb\u52a1\uff1f', `bot: ${config.botId}\n\u6b64\u64cd\u4f5c\u4f1a\u5207\u6362\u5f53\u524d\u4efb\u52a1\u3002`, signal);
      const result = await bounded(() => kernel.createSession({ botId: config.botId,
        title: '\u98de\u4e66\u4efb\u52a1', signal }), signal);
      guard(signal);
      if (!id(result?.threadId)) throw failure();
      config.threadId = result.threadId;
      await persist();
    }
    guard(signal);
  }

  async function startReady(signal) {
    const ready = await bounded(() => new Promise((resolve) => startIm(false, resolve)), signal);
    guard(signal);
    if (!ready || view.im !== 'ready') throw failure();
  }

  async function act(action, input, signal) {
    if (action === 'recreateApp' || (action === 'oneClickConnect' && config.recovery)) {
      await target(input, signal, { update: false });
      guard(signal);
      stopIm();
      stopTools();
      await bounded(() => disableConfig(), signal);
      let candidate = config.recovery;
      if (!candidate) {
        // Recheck on each explicit replace request, never trust a stale renderer error.
        try { await inspect(signal); throw failure('FORBIDDEN'); }
        catch (cause) { if (!['APP_UNAVAILABLE', 'CLI_NOT_CONFIGURED'].includes(cause.code)) throw cause; }
        if (typeof createRecoveryContext !== 'function') throw failure('APP_UNAVAILABLE');
        const directory = await bounded(() => createRecoveryContext({ signal }), signal);
        guard(signal);
        if (!executablePath(directory) || directory === config.configDir) throw failure('INVALID_EXECUTABLE');
        candidate = { configDir: directory };
        config.recovery = candidate;
        await persist();
      }
      guard(signal);
      const original = structuredClone(config);
      replacementBase = original;
      config = { ...original, configDir: candidate.configDir };
      delete config.recovery;
      delete config.appId;
      delete config.ownerOpenId;
      if (candidate.appId) config.appId = candidate.appId;
      cli = identity = undefined;
      lastUser = undefined;
      view.recoveryPending = true;
      let committed = false;
      try {
        await act('oneClickConnect', input, signal);
        guard(signal);
        replacementBase = undefined;
        await persist();
        guard(signal);
        committed = true;
        delete view.recoveryPending;
      } finally {
        if (!committed) {
          const pending = { configDir: config.configDir, ...(config.appId ? { appId: config.appId } : {}) };
          config = { ...original, recovery: pending };
          replacementBase = undefined;
          cli = identity = undefined;
          lastUser = config.ownerOpenId;
          Object.assign(view, { cliPath: config.cliPath, nodePath: config.nodePath,
            botId: config.botId, ownerOpenId: config.ownerOpenId,
            userAuthorized: false, botAuthorized: false });
          await persist();
        }
      }
      return;
    }
    if (action === 'oneClickConnect') {
      await target(input, signal, { update: false });
      guard(signal);
      stopIm();
      stopTools();
      login = undefined;
      delete view.login;
      await bounded(() => disableConfig(), signal);
      guard(signal);
      const phase = (value) => {
        if (!closed && !signal.aborted && operation?.signal === signal) view.phase = value;
      };
      phase('detecting');
      const runtime = await bounded(() => prepareRuntime({ existing: structuredClone(config), signal,
        onPhase: (value) => {
          if (['detecting', 'downloadingCli', 'downloadingNode', 'verifyingRuntime'].includes(value)) phase(value);
        } }), signal, 900000);
      guard(signal);
      if (!executablePath(runtime?.cliPath) || !nodePath(runtime?.nodePath) ||
          (runtime.configDir !== undefined && !executablePath(runtime.configDir))) throw failure('INVALID_EXECUTABLE');
      if ((config.appId || config.configDir) && config.configDir !== runtime.configDir) throw failure('IDENTITY_CONFLICT');
      config.cliPath = view.cliPath = runtime.cliPath;
      config.nodePath = view.nodePath = runtime.nodePath;
      if (runtime.configDir !== undefined) config.configDir = runtime.configDir;
      config.schemaVersion = 2;
      cli = undefined;
      await persist();
      guard(signal);
      phase('verifyingRuntime');
      try { await inspect(signal); }
      catch (error) {
        guard(signal);
        if (error.code !== 'CLI_NOT_CONFIGURED') throw error;
        if (operation?.automatic) throw failure('AUTH_REQUIRED');
        if (!config.configDir) throw failure('LEGACY_NOT_CONFIGURED');
        if (config.appId && !replacementBase) throw failure('CONFIG_EXISTS');
        delete view.error;
        delete view.errorCode;
        phase('openingApp');
        const currentCli = cli;
        const options = { signal,
          // The provisioner asserted ownership; initialize checks the real
          // directory, permits only known cache files and never replaces config.
          isManagedEmpty: (directory) => {
            guard(signal);
            return directory === runtime.configDir && directory === config.configDir;
          },
          onAuthorization: (url) => bounded(async () => {
            await openExternal(url);
            phase('creatingApp');
          }, signal) };
        let result = await bounded(() => currentCli.initialize(options), signal, 900000);
        guard(signal);
        if (result?.ok === false && result.error?.code === 'INITIALIZATION_UNCERTAIN' && !result.app) {
          try {
            await approve('\u6062\u590d\u98de\u4e66\u5e94\u7528\u914d\u7f6e',
              '\u4e0a\u6b21\u5e94\u7528\u914d\u7f6e\u5df2\u4e2d\u65ad\u3002\u786e\u8ba4\u91cd\u65b0\u6253\u5f00\u6d4f\u89c8\u5668\u914d\u7f6e\u5411\u5bfc\uff1f',
              `${ERRORS.INITIALIZATION_UNCERTAIN}\n\u91cd\u8bd5\u53ef\u80fd\u91cd\u590d\u521b\u5efa\u5e94\u7528\u3002\u8bf7\u5148\u68c0\u67e5\u5df2\u6709\u5e94\u7528\uff1b\u5982\u5411\u5bfc\u63d0\u4f9b\u9009\u62e9\u5df2\u6709\u5e94\u7528\uff0c\u8bf7\u9009\u62e9\u539f\u5e94\u7528\u3002\u4ec5\u5728\u786e\u8ba4\u540e\u91cd\u8bd5\u4e00\u6b21\uff0c\u4e0d\u4f1a\u6e05\u9664\u539f\u7ed1\u5b9a\u3002`, signal);
          } catch (error) {
            guard(signal);
            if (['APPROVAL_DENIED', 'APPROVAL_TIMEOUT'].includes(error.code)) throw failure('INITIALIZATION_UNCERTAIN');
            throw error;
          }
          guard(signal);
          result = await bounded(() => currentCli.initialize({ ...options, retryUncertain: true }), signal, 900000);
        }
        guard(signal);
        const appId = result?.ok === false ? result.app?.appId : result?.appId;
        if (id(appId, 'cli_')) {
          if (config.appId && config.appId !== appId) throw failure('IDENTITY_CONFLICT');
          config.appId = appId;
          await persist();
        }
        guard(signal);
        if (result?.ok === false || !id(appId, 'cli_')) throw failure(result?.error?.code);
        phase('checkingApp');
        await inspect(signal);
      }
      guard(signal);
      const currentCli = cli;
      if (!view.botAuthorized) throw failure('BOT_AUTH_REQUIRED');
      phase('openingAuthorization');
      // A cached bot token can outlive deletion of its application. Check the
      // live app before starting OAuth instead of looping on a generic exit 3.
      if (typeof currentCli.permissions === 'function') {
        // inspect may have just fetched this same live preflight for a missing user.
        const app = identity?.appPermissions ?? await bounded(() => currentCli.permissions({ signal }), signal);
        guard(signal);
        if (app?.ok === false) throw failure(app.error?.code === 'AUTH_REQUIRED' ? 'BOT_AUTH_REQUIRED' : app.error?.code);
        if (app?.appId !== identity?.appId) throw failure('IDENTITY_CONFLICT');
      }
      const requiredScopes = TOOL_SCOPES.split(' ');
      const existingUser = userId(identity);
      const reuseConsent = existingUser && view.botAuthorized &&
        Array.isArray(identity.grants?.granted) && Array.isArray(identity.grants?.missing) &&
        identity.grants.missing.length === 0 && requiredScopes.every((scope) => identity.grants.granted.includes(scope));
      if (operation?.automatic && !reuseConsent) throw failure('AUTH_REQUIRED');
      const authorized = reuseConsent ? { complete: true, user: { openId: existingUser } }
        : await bounded(() => currentCli.authorize({ signal,
          onAuthorization: (url) => bounded(async () => {
            await openExternal(url);
            phase('authorizing');
          }, signal) }), signal, 900000);
      guard(signal);
      if (authorized?.ok === false || authorized?.complete !== true || !id(authorized.user?.openId, 'ou_')) {
        if (authorized?.error?.code === 'SCOPE_REQUIRED') {
          // This is a sanitized CLI recovery field, never a renderer URL. The
          // host independently allowlists browser destinations before opening.
          let raw = authorized.error.consoleUrl;
          const missing = authorized.error.missing;
          const knownScopes = TOOL_SCOPES.split(' ');
          if (raw === undefined && id(config.appId, 'cli_') && identity?.appId === config.appId &&
              ['feishu', 'lark'].includes(identity.brand) && Array.isArray(missing) &&
              missing.length > 0 && missing.length <= knownScopes.length &&
              missing.every((scope) => knownScopes.includes(scope))) {
            const host = identity.brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
            raw = `https://${host}/page/scope-apply?clientID=${config.appId}&scopes=${[...new Set(missing)].join(',')}`;
          }
          try {
            const url = new URL(raw);
            const keys = [...url.searchParams.keys()];
            const scopes = url.searchParams.get('scopes')?.split(',');
            if (typeof raw === 'string' && raw.length <= 4096 && !/[\x00-\x20\x7f\\#]/.test(raw) &&
                url.href === raw && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
                ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) &&
                raw.startsWith(`https://${url.hostname}/page/scope-apply?`) && url.pathname === '/page/scope-apply' &&
                new Set(keys).size === keys.length && keys.every((key) => ['clientID', 'scopes'].includes(key)) &&
                url.searchParams.get('clientID') === config.appId &&
                (!scopes || (scopes.length <= 1024 && scopes.every((scope) => /^[A-Za-z0-9_:.-]{1,256}$/.test(scope))))) {
              await bounded(() => openExternal(raw), signal);
            }
          } catch { /* A blocked browser must not hide the actionable scope error. */ }
          guard(signal);
        }
        throw failure(authorized?.error?.code ?? 'AUTH_REQUIRED');
      }
      if (config.ownerOpenId && config.ownerOpenId !== authorized.user.openId) throw failure('IDENTITY_CONFLICT');
      phase('verifyingIdentity');
      const info = await inspect(signal);
      guard(signal);
      if (userId(info) !== authorized.user.openId ||
          (authorized.app?.appId !== undefined && authorized.app.appId !== info.appId)) throw failure('IDENTITY_CONFLICT');
      if (!view.botAuthorized) throw failure('BOT_AUTH_REQUIRED');
      // Explicit recreation plus verified browser consent authorizes this binding.
      // Office calls remain subject to the host policy, identity and tool allowlist.
      config.ownerOpenId = view.ownerOpenId = authorized.user.openId;
      await persist();
      guard(signal);
      const bot = await target(input, signal);
      guard(signal);
      phase('preparingSession');
      await prepareSession(bot, signal, { setupApproved: true });
      guard(signal);
      phase('starting');
      await startReady(signal);
      guard(signal);
      await startTools(signal, { setupApproved: true });
      guard(signal);
      if (view.im !== 'ready' || !view.toolsEnabled) throw failure();
      config.reconnect = view.reconnect = true;
      await persist();
      guard(signal);
      delete view.error;
      delete view.errorCode;
      phase('ready');
      return;
    }
    if (action === 'selectBot') {
      if (!input?.botId) throw failure('BOT_REQUIRED');
      const connected = !!im && !im.pairing;
      await target(input, signal, { update: false });
      guard(signal);
      if (config.botId === input.botId) return;
      if (connected) {
        await inspect(signal);
        guard(signal);
        if (!view.botAuthorized || !config.ownerOpenId || userId(identity) !== config.ownerOpenId) throw failure('AUTH_REQUIRED');
      }
      const bot = await target(input, signal, { switching: true });
      guard(signal);
      if (!connected) return;
      view.phase = 'preparingSession';
      await prepareSession(bot, signal, { setupApproved: true });
      guard(signal);
      view.phase = 'starting';
      await startReady(signal);
      guard(signal);
      if (view.toolsEnabled) view.phase = 'ready';
      else delete view.phase;
      return;
    }
    if (action === 'chooseCli' || action === 'chooseNode') {
      const kind = action === 'chooseCli' ? 'cli' : 'node';
      const selected = await bounded(() => chooseExecutable(kind), signal);
      guard(signal);
      if (selected === null) return;
      if (!executablePath(selected)) throw failure('INVALID_EXECUTABLE');
      if (kind === 'node') {
        if (!nodePath(selected) || await bounded(() => validateNode(selected, { signal }), signal) !== true) throw failure('NODE_VERSION');
        guard(signal);
        stopTools();
        await disableConfig();
        guard(signal);
        config.nodePath = view.nodePath = selected;
      } else {
        const selectedCli = createCliImpl({ executable: selected, configDir: config.configDir });
        const version = await bounded(() => selectedCli.version({ signal }), signal);
        if (version?.version !== '1.0.93' || version.supported !== true) throw failure(version?.error?.code ?? 'CLI_VERSION');
        guard(signal);
        revoke();
        config.cliPath = view.cliPath = selected;
        cli = selectedCli;
        view.botAuthorized = view.userAuthorized = false;
        view.version = version.version;
      }
      await persist();
      if (kind === 'cli') await inspect(signal);
      return;
    }
    // OAuth may have completed externally already; consume the in-memory device
    // code before inspect() invalidates the previous account's login state.
    if (!['completeLogin', 'login'].includes(action)) await inspect(signal);
    if (action === 'probe') return;
    if (action === 'login') {
      revoke();
      await verifyCli(signal);
      const result = await bounded(() => cli.login({ signal }), signal);
      guard(signal);
      if (result?.ok === false) throw failure(result.error?.code);
      const raw = result?.verificationUrl;
      const url = new URL(raw);
      if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x20\x7f\\]/.test(raw) ||
          url.protocol !== 'https:' || !['accounts.feishu.cn', 'accounts.larksuite.com'].includes(url.hostname) ||
          url.username || url.password || url.port || url.hash || !id(result.deviceCode) ||
          !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > 86400) throw failure();
      login = { deviceCode: result.deviceCode, expires: now() + result.expiresIn * 1000 };
      view.login = { url: raw };
      await bounded(() => openExternal(raw), signal);
      return;
    }
    if (action === 'completeLogin') {
      const pending = login;
      if (!pending || now() >= pending.expires) { login = undefined; delete view.login; throw failure(); }
      const result = await bounded(() => cli.completeLogin(pending.deviceCode, { signal }), signal, 300000);
      guard(signal);
      login = undefined;
      delete view.login;
      if (result?.complete !== true) throw failure(result?.error?.code);
      const info = await inspect(signal);
      if (!userId(info) || result.user?.openId !== userId(info)) throw failure();
      return;
    }
    if (action === 'enableTools') {
      await startTools(signal);
      return;
    }
    const bot = await target(input, signal);
    if (!view.botAuthorized) throw failure('BOT_AUTH_REQUIRED');
    if (!userId(identity) && (lastUser || !['missing', 'not_configured'].includes(identity.user?.status))) throw failure('AUTH_REQUIRED');
    if (action === 'pair') {
      if (im) throw failure();
      if (tools && (!view.toolsEnabled || tools.user !== userId(identity) || tools.appId !== identity.appId)) {
        throw failure('AUTH_REQUIRED');
      }
      startIm(true);
      return;
    }
    if (action === 'connect') {
      if (!config.ownerOpenId || im?.pairing || (userId(identity) && userId(identity) !== config.ownerOpenId)) throw failure();
      stopIm();
      await prepareSession(bot, signal);
      guard(signal);
      startIm(false);
    }
  }
  async function invoke(action, input, automatic = false) {
    const started = epoch;
    if (action === 'disconnect' || action === 'disableTools') {
      epoch++;
      if ((action === 'disconnect' && im?.busy && !im.pairing) || tools?.busy) view.error = UNCERTAIN;
      const stopping = operation;
      stopping?.abort();
      operation = undefined;
      view.pending = false;
      delete view.phase;
      if (action === 'disconnect') { stopIm(); login = undefined; delete view.login; }
      stopTools();
      await init();
      if (replacementBase) await stopping?.work?.catch(() => {});
      if (!closed && !loadFailed) {
        config.reconnect = view.reconnect = false;
        try { await persist(); } catch { view.error = ERROR; }
      }
      await Promise.all([disableConfig().catch(() => { view.error = ERROR; }), ...consumerStops]);
      return snapshot();
    }
    await init();
    if (closed || loadFailed || started !== epoch) return snapshot();
    if (!['oneClickConnect', 'recreateApp', 'selectBot', 'chooseCli', 'chooseNode', 'probe', 'login', 'completeLogin', 'pair', 'connect', 'enableTools'].includes(action) ||
        (input !== undefined && (!object(input) || Object.keys(input).some((k) => k !== 'botId') ||
          (input.botId !== undefined && !id(input.botId))))) { view.error = ERROR; return snapshot(); }
    if (operation || replacementBase) return snapshot();
    const active = new AbortController();
    active.automatic = automatic;
    operation = active;
    view.pending = true;
    if (['oneClickConnect', 'recreateApp'].includes(action)) view.phase = 'detecting';
    delete view.error;
    delete view.errorCode;
    try { await bounded(() => {
      active.work = act(action, input, active.signal);
      return active.work;
    }, active.signal, ['oneClickConnect', 'recreateApp'].includes(action) ? 900000 : 360000); }
    catch (error) {
      const current = operation === active && !closed;
      if (!active.signal.aborted && current) {
        view.error = localized(error);
        if (Object.hasOwn(ERRORS, error?.code)) view.errorCode = error.code;
      }
      active.abort();
      if (replacementBase) await active.work?.catch(() => {});
      if (current && (['oneClickConnect', 'recreateApp'].includes(action) || (action === 'selectBot' && active.runtimeChanged))) {
        view.phase = 'error';
        stopIm();
        stopTools();
        await Promise.all([disableConfig().catch(() => {}), ...consumerStops]);
      }
    }
    finally { if (operation === active) { operation = undefined; view.pending = false; } }
    return snapshot();
  }
  function close() {
    if (closed) return closing;
    closed = true;
    epoch++;
    const stopping = operation;
    stopping?.abort();
    operation = undefined;
    view.pending = false;
    delete view.phase;
    view.userAuthorized = view.botAuthorized = false;
    stopIm();
    stopTools();
    login = undefined;
    delete view.login;
    closing = Promise.all([saves, disableConfig().catch(() => { view.error = ERROR; }), ...consumerStops,
      ...(replacementBase ? [stopping?.work?.catch(() => {})] : [])]).then(() => undefined);
    return closing;
  }
  function resume() {
    resuming ??= (async () => {
      const started = epoch;
      await init();
      if (closed || loadFailed || started !== epoch || resumeAttempted || operation) return snapshot();
      resumeAttempted = true;
      if (config.reconnect !== true || config.recovery || !config.ownerOpenId || !config.appId || !config.botId) return snapshot();
      return invoke('oneClickConnect', undefined, true);
    })().finally(() => { resuming = undefined; });
    return resuming;
  }
  return { state: async () => { await init(); return snapshot(); },
    invoke: (action, input) => invoke(action, input), resume, close };
}
