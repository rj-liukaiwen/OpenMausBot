// Offline, real Electron/utility-process transport. No external account, key,
// user proxy setting, renderer, or installation registration is touched.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrokerClientTransport, createBrokerHostTransport } from '../electron/managed-composio-transport.mjs';
import { createManagedComposioRegistrationLoop, ensureManagedComposioCredentials,
  managedComposioAccess } from '../electron/managed-composio.mjs';

if (process.parentPort) {
  const client = createBrokerClientTransport(process.parentPort);
  process.parentPort.on('message', async ({ data }) => {
    if (data?.type !== 'fixture-probe') return;
    try {
      const catalog = await (await client.fetch('/v1/catalog')).json();
      const authorization = await (await client.fetch('/v1/connectors/github/authorize', {
        method: 'POST', body: JSON.stringify({ alias: 'fixture-only' }), headers: { 'content-type': 'application/json' },
      })).json();
      const mcp = await client.fetch('/v1/mcp', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      assert.deepEqual(catalog, { cards: ['fixture'] });
      assert.deepEqual(authorization, { url: 'https://connect.composio.dev/fixture-only' });
      assert.equal(mcp.headers.get('mcp-session-id'), 'fixture-session');
      assert.deepEqual(await mcp.json(), { result: 'fixture' });
      process.parentPort.postMessage({ type: 'fixture-result', ok: true });
    } catch (error) { process.parentPort.postMessage({ type: 'fixture-result', error: error.message }); }
  });
  process.parentPort.postMessage({ type: 'fixture-ready' });
} else {
  const { app, session, utilityProcess } = await import('electron');
  void (async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'ruijiebot-network-smoke-'));
  app.setPath('userData', fixture);
  const proxy = createServer(async (req, res) => {
    const url = new URL(req.url);
    assert.equal(url.origin, 'http://127.0.0.1:65534');
    assert.equal(req.headers.cookie, undefined);
    if (url.pathname === '/v1/installations') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ token: 'a'.repeat(64), installationId: 'fixture-only' }));
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${'a'.repeat(64)}`);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v1/connectors/github/authorize') {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/json');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { alias: 'fixture-only' });
      res.end(JSON.stringify({ url: 'https://connect.composio.dev/fixture-only' }));
      return;
    }
    res.setHeader('mcp-session-id', 'fixture-session');
    res.end(JSON.stringify(url.pathname === '/v1/catalog' ? { cards: ['fixture'] } : { result: 'fixture' }));
  });
  let proc, host, loop;
  let failure;
  const watchdog = setTimeout(() => { console.error('Network fixture timed out'); app.exit(1); }, 25_000);
  try {
    await app.whenReady();
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const network = session.fromPartition('ruijiebot-network-fixture');
    const brokerUrl = 'http://127.0.0.1:65534';
    const credentials = {};
    const proxyConfig = (port) => ({ proxyRules: `http=127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
    await network.setProxy(proxyConfig(1));
    let attempts = 0;
    let saves = 0;
    loop = createManagedComposioRegistrationLoop({ delays: [100],
      hasAccess: () => !!managedComposioAccess(brokerUrl, credentials),
      attempt: async () => {
        attempts += 1;
        await ensureManagedComposioCredentials({ brokerUrl, credentials,
          fetchImpl: (url, init) => network.fetch(url, { ...init, credentials: 'omit' }),
          registrationTimeoutMs: 2000,
          saveCredentials: async () => { saves += 1; },
          log: (message) => console.log(`[network-smoke] ${message}`),
        });
        if (attempts === 1) {
          assert.equal(saves, 0, 'Broken proxy unexpectedly registered an installation');
          await network.setProxy(proxyConfig(proxy.address().port));
          await network.closeAllConnections();
        }
      },
    });
    loop.start();
    while (!managedComposioAccess(brokerUrl, credentials)) await new Promise((done) => setTimeout(done, 25));
    assert.equal(attempts, 2); assert.equal(saves, 1);
    proc = utilityProcess.fork(fileURLToPath(import.meta.url), [], {
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
        HOME: fixture, USERPROFILE: fixture, OMB_DATA_DIR: fixture }, stdio: 'pipe',
    });
    proc.stdout?.on('data', (data) => process.stdout.write(data));
    proc.stderr?.on('data', (data) => process.stderr.write(data));
    host = createBrokerHostTransport({ port: proc, access: () => managedComposioAccess(brokerUrl, credentials),
      fetchImpl: (url, init) => network.fetch(url, init) });
    const messages = (type) => new Promise((resolve) => {
      const receive = (message) => { if (message?.type === type) { proc.off('message', receive); resolve(message); } };
      proc.on('message', receive);
    });
    await messages('fixture-ready');
    let result = messages('fixture-result'); proc.postMessage({ type: 'fixture-probe' });
    assert.equal((await result).ok, true);
    await network.setProxy(proxyConfig(1)); await network.closeAllConnections();
    result = messages('fixture-result'); proc.postMessage({ type: 'fixture-probe' });
    assert.equal((await result).error, 'CONNECTED_APPS_NETWORK_UNREACHABLE');
    await network.setProxy(proxyConfig(proxy.address().port)); await network.closeAllConnections();
    result = messages('fixture-result'); proc.postMessage({ type: 'fixture-probe' });
    assert.equal((await result).ok, true);
    assert.equal(saves, 1, 'Recovery replaced installation identity');
    console.log(JSON.stringify({ ok: true, platform: process.platform, checks: [
      'first-launch offline retry', 'real Electron session proxy', 'real utility-process IPC',
      'catalog, OAuth and MCP share proxy', 'proxy changes recover without restart', 'stable installation identity',
    ] }));
  } catch (error) { failure = error; console.error(error); }
  finally {
    loop?.close(); host?.close();
    if (proc) { const exited = once(proc, 'exit'); proc.kill(); await exited; }
    proxy.closeAllConnections(); await new Promise((done) => proxy.close(done));
    clearTimeout(watchdog);
    // Electron may retain the profile until exit on Windows. Keep only this
    // disposable directory if locked; never reach into the user's app data.
    await rm(fixture, { recursive: true, force: true }).catch(() => console.log(`Fixture retained (locked): ${fixture}`));
    app.exit(failure ? 1 : 0);
  }
  })().catch((error) => { console.error(error); app.exit(1); });
}
