// Compiled UI + compiled server under Electron utilityProcess, in an owned fixture.
import assert from 'node:assert/strict';
import { app, BrowserWindow, utilityProcess, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const root = fileURLToPath(new URL('../', import.meta.url));
assert(process.platform === 'win32', 'This desktop diagnostic currently covers Windows only; it is not macOS acceptance.');
const fixture = mkdtempSync(path.join(tmpdir(), 'ruijie-desktop-browser-'));
const home = path.join(fixture, 'home');
mkdirSync(home);
app.setPath('userData', path.join(fixture, 'electron'));
const token = randomBytes(32).toString('base64url');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, win, botId, mcp, output = '', failed = false;
const streamEvidence = { connections: 0, frames: 0, maxFrameBytes: 0, errors: [] };
const nativeBinary = path.join(root, 'dist-native/browser', `${process.platform}-${process.arch}`, 'agent-browser.exe');
const nativeEnv = () => ({ SYSTEMROOT: process.env.SYSTEMROOT, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), AGENT_BROWSER_SESSION: `bot-${botId}`,
  AGENT_BROWSER_CONFIG: path.join(home, '.agent-browser/omb-managed-config.json') });
const watchdog = setTimeout(() => { console.error('fixture watchdog'); mcp?.kill(); child?.kill(); app.exit(1); }, 240000);
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
void (async () => {
 try {
  await app.whenReady();
  cpSync(path.join(root, 'dist-server'), path.join(fixture, 'server'), { recursive: true });
  if (process.env.OMB_VERIFY_SERVER_ENTRY) {
    assert(path.isAbsolute(process.env.OMB_VERIFY_SERVER_ENTRY));
    cpSync(process.env.OMB_VERIFY_SERVER_ENTRY, path.join(fixture, 'server/index.js'));
  }
  cpSync(path.join(root, 'dist'), path.join(fixture, 'ui'), { recursive: true });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ features: { browser: true }, instances: {
    verification: { driver: 'claudeAgent', displayName: 'Verification fixture', enabled: true, config: { cli: path.join(root, 'server/testing/fake-claude-cli.ts') } },
  } }));
  const port = await freePort(); const url = `http://127.0.0.1:${port}`;
  console.log(JSON.stringify({ phase: 'fixture', fixture, url, electron: process.versions.electron, node: process.versions.node }));
  child = utilityProcess.fork(path.join(fixture, 'server/index.js'), [], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe'], env: {
    SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
    TEMP: home, TMP: home, PATH: path.join(process.env.SYSTEMROOT, 'System32'),
    OMB_DATA_DIR: home, OMB_USER_DATA: path.join(fixture, 'electron'), OMB_DESKTOP_PARENT: '1',
    OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(await freePort()),
    OMB_STATIC_DIR: path.join(fixture, 'ui'), OMB_BROWSER_DEFAULT_ENABLED: '1',
    OMB_BROWSER_BUNDLE_DIR: path.join(root, 'dist-native/browser', `${process.platform}-${process.arch}`),
    RUIJIE_HARNESS_EXECUTABLE: path.join(fixture, 'missing-harness'),
  } });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code) => console.log(JSON.stringify({ phase: 'utility-exit', code })));
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch {}
    assert(i < 200, 'utility server startup timed out'); await delay(100);
  }
  child.postMessage({ type: 'openmausbot:desktop-mutation-token', token });
  await delay(100);
  const api = async (route, method = 'GET', body) => {
    const res = await fetch(url + route, { method, headers: { 'content-type': 'application/json', 'x-openmausbot-desktop-owner': token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json(); assert(res.ok, `${route}: ${res.status} ${JSON.stringify(data)}`); return data;
  };
  const bot = await api('/api/bots', 'POST', { name: 'Desktop browser fixture', instanceId: 'verification', browser: true });
  botId = bot.bot.id;
  console.log(JSON.stringify({ phase: 'bot-created', keys: Object.keys(bot) }));
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: {
    ...details.requestHeaders, ...(details.url.startsWith(url + '/') ? { 'x-openmausbot-desktop-owner': token } : {}),
  } }));
  win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL(url);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Network.enable');
  const streamRequests = new Set();
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Network.requestWillBeSent' && /\/browser\/live$/.test(params.request.url)) {
      streamRequests.add(params.requestId); streamEvidence.connections++;
    }
    if (!streamRequests.has(params.requestId)) return;
    if (method === 'Network.loadingFailed') streamEvidence.errors.push(params.errorText);
    if (method === 'Network.eventSourceMessageReceived') {
      if (params.eventName === 'frame') {
        streamEvidence.frames++; streamEvidence.maxFrameBytes = Math.max(streamEvidence.maxFrameBytes, params.data.length);
      }
      if (params.eventName === 'error') streamEvidence.errors.push('stream-error-event');
    }
  });
  const evaluate = (code) => win.webContents.executeJavaScript(code, true);
  await delay(2500);
  console.log(JSON.stringify({ phase: 'ui', text: await evaluate('document.body.innerText.slice(0,1800)') }));
  const click = (label) => evaluate(`Array.from(document.querySelectorAll('button,a')).find(e => (e.textContent?.trim() === ${JSON.stringify(label)}) || e.getAttribute('aria-label') === ${JSON.stringify(label)})?.click()`);
  await evaluate(`document.querySelector('button[title="机器人的电脑"]')?.click()`); await delay(1000);
  await click('Browser'); await click('浏览器');
  await delay(1000);
  console.log(JSON.stringify({ phase: 'browser-ui', text: await evaluate('document.body.innerText.slice(-2200)') }));
  const image = `document.querySelector('img[alt="Live bot browser"]')`;
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`Boolean(${image}?.complete && ${image}?.naturalWidth > 0)`)) break;
    assert(i < 79, 'no real browser picture'); await delay(250);
  }
  console.log(JSON.stringify({ phase: 'first-frame', ok: true }));
  // An agent navigates while the renderer watches; no takeover shortcut.
  const target = process.env.OMB_VERIFY_PAGE_URL || 'https://cn.bing.com/search?q=RuijieBot';
  const navigationEnv = { ...nativeEnv(), AGENT_BROWSER_HEADLESS: '1', AGENT_BROWSER_NO_WEBMCP: '1',
    AGENT_BROWSER_EXECUTABLE_PATH: path.join(root, 'dist-native/browser/win32-x64/chrome/chrome-headless-shell-win64/chrome-headless-shell.exe'),
  };
  // Use the real MCP-to-nested-CLI path, not a handwritten direct CLI call
  // carrying the viewer's old timeout override (which masked daemon restarts).
  mcp = spawn(nativeBinary, ['mcp', '--tools', 'core', '--no-webmcp'], { env: navigationEnv, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  mcp.stderr.resume();
  let nextId = 0, buffer = ''; const pending = new Map();
  const mcpFailed = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Fixture MCP closed')); } pending.clear(); };
  mcp.on('error', mcpFailed); mcp.on('close', mcpFailed); mcp.stdin.on('error', mcpFailed);
  mcp.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end+1); if (!line.trim()) continue;
      const response = JSON.parse(line); const item = pending.get(response.id);
      if (item) { pending.delete(response.id); clearTimeout(item.timer); response.error ? item.reject(new Error(response.error.message)) : item.resolve(response.result); }
    }
  });
  const rpc = (method, params) => new Promise((resolve,reject) => {
    const id = ++nextId;
    const timer = setTimeout(()=>{pending.delete(id);reject(new Error(`MCP ${method} timeout`))},30000);
    pending.set(id,{resolve,reject,timer}); mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-desktop-verification',version:'1'}});
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const navigated = await rpc('tools/call',{name:'agent_browser_open',arguments:{url:target}});
  console.log(JSON.stringify({ phase: 'agent-navigation', success: navigated.structuredContent?.response?.success === true }));
  assert(!navigated.isError && navigated.structuredContent?.response?.success === true, 'Native MCP navigation must succeed before a green stream result is possible');
  const poll = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('Desktop handoff did not settle');
  };
  // ComputerPanel's selected Browser tab also has aria-pressed=true. Scope
  // control checks to its accessible name, never any pressed button in the app.
  const controlButton = `Array.from(document.querySelectorAll('button')).find(b=>/^(Take control|接管浏览器|Return to bot|交还机器人)$/.test(b.getAttribute('aria-label')||''))`;
  for (let handoff = 1; handoff <= 3; handoff++) {
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>/^(Take control|接管浏览器)$/.test(b.getAttribute('aria-label')||''))?.click()`);
    await poll(`(${controlButton})?.getAttribute('aria-pressed') === 'true' && !(${controlButton}).disabled`);
    await evaluate(`(()=>{const button=Array.from(document.querySelectorAll('button')).find(b=>/^(Reload|Reload page|重新加载页面)$/.test(b.getAttribute('aria-label')||''));if(!button||button.disabled)throw new Error('No enabled browser reload button');button.click()})()`);
    await delay(100); // Let React render the in-flight command before testing its completion.
    await poll(`(${controlButton})?.getAttribute('aria-pressed') === 'true' && !(${controlButton}).disabled`);
    await evaluate(`(${controlButton}).click()`);
    await poll(`(${controlButton})?.getAttribute('aria-pressed') === 'false' && !(${controlButton}).disabled`);
    const read = await rpc('tools/call',{name:'agent_browser_get_text',arguments:{selector:'body'}});
    assert(!read.isError && read.structuredContent?.response?.success === true, 'Agent must read the same page after human hand-back');
    assert(streamEvidence.connections === 1 && streamEvidence.errors.length === 0, 'Handoff restarted the original stream');
    console.log(JSON.stringify({phase:'desktop-handoff',handoff,ok:true}));
  }
  for (let i = 0; i < 12; i++) {
    await delay(5000);
    const state = await evaluate(`({ picture: Boolean(${image}?.complete && ${image}?.naturalWidth > 0), alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(e=>e.textContent) })`);
    console.log(JSON.stringify({ phase: 'stream', seconds: (i+1)*5, ...state }));
    assert(state.picture && !state.alerts.length, 'actual desktop browser stream disconnected');
    assert(streamEvidence.connections === 1 && streamEvidence.errors.length === 0, 'The original stream must survive, not silently reconnect');
  }
  console.log(JSON.stringify({ phase: 'original-stream-evidence', ...streamEvidence }));
  assert(streamEvidence.frames >= 3, 'A cached opening screenshot is not a live stream');
 } catch (error) {
  failed = true; console.error(error.message);
  if (win) { writeFileSync(path.join(fixture, 'failure.png'), (await win.capturePage()).toPNG()); console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(-2000)')); }
 } finally {
  writeFileSync(path.join(fixture, 'server.log'), output);
  writeFileSync(path.join(fixture, 'verification.json'), JSON.stringify({ ok: !failed, ...streamEvidence }, null, 2));
  console.log(JSON.stringify({ ok: !failed, evidence: fixture }));
  win?.destroy();
  mcp?.stdin.end();
  if (botId) await promisify(execFile)(nativeBinary, ['close', '--json'], { env: nativeEnv(), timeout: 15000, windowsHide: true }).catch(() => {});
  child?.kill(); clearTimeout(watchdog); await delay(500); app.exit(failed ? 1 : 0);
 }
})();
