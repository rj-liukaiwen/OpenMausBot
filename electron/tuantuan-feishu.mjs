/* eslint-disable no-control-regex -- Reject controls at the browser boundary. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFeishuSignatureVerifier } from './feishu-mac-signature.mjs';

function isFeishuAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\#]/.test(value)) return false;
  try {
    const url = new URL(value);
    // Compare the original spelling too: URL parsing normalizes ports and dot paths.
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href !== value ||
        !value.startsWith(`https://${url.hostname}/`)) return false;
    if (['accounts.feishu.cn', 'accounts.larksuite.com'].includes(url.hostname)) return true;
    if (!['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)) return false;
    const params = url.searchParams;
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) return false;
    if (url.hostname === 'open.feishu.cn' && url.pathname === '/page/cli') {
      return keys.length === 4 && keys.every((key) => ['user_code', 'lpv', 'ocv', 'from'].includes(key)) &&
        /^[A-Za-z0-9_+-]{1,256}$/.test(params.get('user_code') ?? '') &&
        params.get('lpv') === '1.0.93' && params.get('ocv') === '1.0.93' && params.get('from') === 'cli';
    }
    const scopes = params.get('scopes')?.split(',');
    return url.pathname === '/page/scope-apply' && keys.every((key) => ['clientID', 'scopes'].includes(key)) &&
      /^cli_[A-Za-z0-9_-]+$/.test(params.get('clientID') ?? '') && params.get('clientID').length <= 256 &&
      (!scopes || (scopes.length <= 1024 && scopes.every((scope) => /^[A-Za-z0-9_:.-]{1,256}$/.test(scope))));
  } catch { return false; }
}

export async function awaitFeishuShutdown(close) {
  let timer;
  // CLI cleanup can take three seconds; kernel config removal may take thirty.
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, 4000); });
  try {
    await Promise.race([close(), deadline]);
  } catch {
    // Shutdown is best-effort; never expose raw connector errors or capabilities.
  } finally {
    clearTimeout(timer);
  }
}

// The owner capability stays in this trusted host; MCP only gets its narrow tool token.
export function registerFeishu({ ipcMain, localOnly, runtime, resources, runtimeRoot, bundledRuntimeRoot, credentials,
  saveCredentials, dialog, openExternal, window: getWindow, load = (url) => import(url) }) {
  let connector;
  let loading;
  let closed = false;
  let starting;
  const unavailable = () => ({ supported: false, cliPath: '', nodePath: '', botId: '',
    im: 'off', toolsEnabled: false, userAuthorized: false, botAuthorized: false });
  const expectedRendererOrigin = (host) => host.rendererOrigin ?? host.baseUrl;
  const supportedHost = (host) => ['win32', 'darwin'].includes(host.platform);
  function trusted(event) {
    const host = runtime();
    const win = getWindow();
    if (closed || !supportedHost(host) || !host.packaged || host.remote || host.stopping ||
        !host.ready || !host.pid || !win || win.isDestroyed() ||
        event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        new URL(win.webContents.getURL()).origin !== expectedRendererOrigin(host)) {
      throw new Error('飞书连接仅可在 Windows 或 macOS 本机客户端管理');
    }
    return host;
  }
  function currentWindow() {
    const host = runtime();
    const win = getWindow();
    if (closed || !supportedHost(host) || !host.packaged || host.remote || host.stopping || !host.ready || !host.pid ||
        !win || win.isDestroyed() || new URL(win.webContents.getURL()).origin !== expectedRendererOrigin(host)) {
      throw new Error('LOCAL_WINDOW_REQUIRED');
    }
    return win;
  }
  async function ensure(host) {
    if (connector) return connector;
    if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot) ||
        runtimeRoot !== path.resolve(runtimeRoot) || runtimeRoot === path.parse(runtimeRoot).root) {
      throw new Error('INVALID_RUNTIME_ROOT');
    }
    loading ??= (async () => {
      const [{ createConnector }, { createKernel }, { createRuntimeProvisioner, createRecoveryContext }] = await Promise.all([
        load(pathToFileURL(path.join(resources, 'index.mjs')).href),
        load(pathToFileURL(path.join(resources, 'kernel.mjs')).href),
        load(pathToFileURL(path.join(resources, 'runtime.mjs')).href),
      ]);
      currentWindow();
      const fresh = runtime();
      if (host.pid !== fresh.pid || host.baseUrl !== fresh.baseUrl || host.token !== fresh.token) throw new Error('KERNEL_CHANGED');
      const prepare = createRuntimeProvisioner({ root: runtimeRoot, bundledRoot: bundledRuntimeRoot,
        ...(host.platform === 'darwin' && bundledRuntimeRoot ? {
          verifySignedBundle: createFeishuSignatureVerifier(path.dirname(bundledRuntimeRoot)),
        } : {}),
      });
      const value = createConnector({
        kernel: createKernel({ baseUrl: host.baseUrl, ownerToken: host.token, expectedPid: host.pid }),
        store: {
          load: async () => structuredClone(credentials().tuantuanFeishu ?? {}),
          save: async (config) => {
            await saveCredentials((document) => ({ ...document, tuantuanFeishu: config }));
          },
        },
        mcpPath: path.join(resources, 'mcp.mjs'),
        createRecoveryContext: async ({ signal }) => {
          currentWindow();
          signal?.throwIfAborted();
          const context = await createRecoveryContext({ root: runtimeRoot, signal });
          currentWindow();
          signal?.throwIfAborted();
          return context;
        },
        prepareRuntime: async (args) => {
          currentWindow();
          args?.signal?.throwIfAborted();
          const result = await prepare(args);
          currentWindow();
          args?.signal?.throwIfAborted();
          return result;
        },
        chooseExecutable: async (kind) => {
          const result = await dialog.showOpenDialog(currentWindow(), {
            title: kind === 'cli' ? '选择官方 lark-cli' : '选择 Node.js 24 或更新版本的 node',
            properties: ['openFile'],
            ...(host.platform === 'win32' ? { filters: [{ name: '可执行程序', extensions: ['exe'] }] } : {}),
          });
          currentWindow();
          return result.canceled ? null : result.filePaths[0];
        },
        confirm: async ({ title, message, detail }) => {
          const result = await dialog.showMessageBox(currentWindow(), {
            type: 'question', title, message, detail,
            buttons: ['\u62d2\u7edd', '\u4ec5\u5141\u8bb8\u672c\u6b21'], defaultId: 0, cancelId: 0, noLink: true,
          });
          currentWindow();
          return result.response === 1;
        },
        // Product policy: connected office tools use the existing OAuth grant.
        // Keep setup recovery dialogs separate and retain the live host boundary.
        authorizeTool: () => {
          currentWindow();
          return true;
        },
        openExternal: async (url) => {
          currentWindow();
          if (!isFeishuAuthorizationUrl(url)) throw new Error('INVALID_AUTH_URL');
          await openExternal(url);
          currentWindow();
        },
      });
      connector = value;
      return value;
    })().finally(() => { loading = undefined; });
    return loading;
  }
  ipcMain.handle('tuantuan-feishu:state', localOnly('tuantuan-feishu:state', async (event) => {
    const host = runtime();
    if (!supportedHost(host) || !host.packaged || host.remote) return unavailable();
    const before = trusted(event);
    const value = await ensure(before);
    const after = trusted(event);
    if (before.pid !== after.pid || before.baseUrl !== after.baseUrl) throw new Error('KERNEL_CHANGED');
    return value.state();
  }));
  ipcMain.handle('tuantuan-feishu:invoke', localOnly('tuantuan-feishu:invoke', async (event, action, input) => {
    const before = trusted(event);
    const value = await ensure(before);
    const after = trusted(event);
    if (before.pid !== after.pid || before.baseUrl !== after.baseUrl) throw new Error('KERNEL_CHANGED');
    return value.invoke(action, input);
  }));
  return {
    start() {
      starting ??= (async () => {
        currentWindow();
        const host = runtime();
        const value = await ensure(host);
        currentWindow();
        const fresh = runtime();
        if (fresh.pid !== host.pid || fresh.baseUrl !== host.baseUrl || fresh.token !== host.token) throw new Error('KERNEL_CHANGED');
        await value.resume();
      })().finally(() => { starting = undefined; });
      return starting;
    },
    async close() {
      closed = true;
      await connector?.close();
    },
  };
}
