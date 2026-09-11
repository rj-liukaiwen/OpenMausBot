// Real renderer + native browser against verify-browser-live.ts only.
// Never point this at the user's desktop server or existing browser profiles.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

const url = new URL(process.env.OMB_VERIFY_BROWSER_PREVIEW_URL ?? '');
assert(url.hostname === '127.0.0.1' && url.pathname === '/__browser-preview.html');
assert(!['8799', '18799', '28799', '38799', '5199'].includes(url.port), 'Only an isolated preview is allowed');
const fixture = mkdtempSync(path.join(tmpdir(), 'ruijie-stream-check-'));
app.setPath('userData', fixture);
console.log(JSON.stringify({ phase: 'fixture-start', fixture }));
let window;
const watchdog = setTimeout(() => { console.error('Stream fixture watchdog expired'); app.exit(1); }, 160_000);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
void (async () => {
  try {
    await app.whenReady();
    console.log(JSON.stringify({ phase: 'electron-ready' }));
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await window.loadURL(url.href);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Network.enable');
    window.webContents.debugger.on('message', (_event, method, params) => {
      // This is an isolated fixture only. Observe metadata, never frame bytes.
      if (method === 'Network.eventSourceMessageReceived' && ['tabs', 'error'].includes(params.eventName)) {
        console.log(JSON.stringify({ phase: 'fixture-stream-metadata', type: params.eventName, data: JSON.parse(params.data) }));
      }
    });
    console.log(JSON.stringify({ phase: 'preview-loaded' }));
    const evaluate = (code) => window.webContents.executeJavaScript(code, true);
    const poll = async (expression) => {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await pause(100);
      }
      throw new Error(`Stream state timed out; ${await evaluate('document.body.innerText.slice(0, 800)')}`);
    };
    const image = `document.querySelector('img[alt="Live bot browser"]')`;
    await poll(`${image}?.complete && ${image}?.naturalWidth > 0`);
    console.log(JSON.stringify({ phase: 'initial-frame', ok: true }));
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b => /^(Take control|接管浏览器)$/.test(b.getAttribute('aria-label') || ''))?.click()`);
    await poll(`Boolean(document.querySelector('button[aria-pressed="true"]'))`);
    await poll(`Boolean(document.querySelector('form input:not([readonly])'))`);
    const beforeNavigation = await evaluate(`${image}.src`);
    const testPage = new URL('/__browser-test-page', url).href;
    await evaluate(`(() => {
      const input = document.querySelector('form input:not([readonly])');
      input.focus(); input.select();
    })()`);
    await window.webContents.insertText(testPage);
    await poll(`document.querySelector('form input:not([readonly])')?.getAttribute('value') === ${JSON.stringify(testPage)}`);
    // insertText exercises React's real input path; requestSubmit avoids
    // relying on OS keyboard focus for an intentionally hidden test window.
    await evaluate(`document.querySelector('form input:not([readonly])').closest('form').requestSubmit()`);
    console.log(JSON.stringify({ phase: 'navigation-submitted' }));
    await poll(`${image}?.complete && ${image}?.naturalWidth > 0 && ${image}.src !== ${JSON.stringify(beforeNavigation)} && !document.querySelector('[role="alert"]')`);
    console.log(JSON.stringify({ phase: 'native-navigation', ok: true }));
    for (let seconds = 0; seconds < 60; seconds += 5) {
      await pause(5000);
      const state = await evaluate(`({image: Boolean(${image}?.complete && ${image}?.naturalWidth > 0), error: document.querySelector('[role="alert"]')?.textContent || ''})`);
      assert(state.image && !state.error, `Idle stream disconnected: ${JSON.stringify(state)}`);
    }
    console.log(JSON.stringify({ phase: '60-second-stream', ok: true }));
    await poll(`Boolean(document.querySelector('button[title="OpenMausBot browser test"]'))`);
    console.log(JSON.stringify({ ok: true, checks: ['real renderer initial frame', 'native local-page navigation with changed pixels and actual title', '60-second hidden-window idle stream stays connected'], fixture }));
  } catch (error) {
    console.error(error.message);
    if (window && !window.isDestroyed()) {
      const screenshot = path.join(fixture, 'failure.png');
      writeFileSync(screenshot, (await window.capturePage()).toPNG());
      console.error(`Fixture screenshot: ${screenshot}`);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog); window?.destroy();
    console.log(`Disposable Electron profile: ${fixture}`);
    app.exit(process.exitCode || 0);
  }
})();
