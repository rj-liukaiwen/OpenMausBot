import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createBrokerHostTransport, createBrokerClientTransport } from './managed-composio-transport.mjs';

test('manual registration retry is host-owned, local-only, and exposes no bearer or URL parameter', async () => {
  const preload = await readFile(new URL('./preload.cjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(preload, /retryConnectedAppsService: \(\) => ipcRenderer.invoke\("connected-apps:retry"\)/);
  assert.doesNotMatch(preload.match(/const REMOTE_SAFE = new Set\(\[([^\]]*)\]/)?.[1] ?? '', /retryConnectedAppsService/);
  assert.match(main, /ipcMain.handle\("connected-apps:retry", localOnly\("connected-apps:retry", async \(\) =>/);
});

function ports() {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  parent.postMessage = (data) => queueMicrotask(() => child.emit('message', { data }));
  child.postMessage = (data) => queueMicrotask(() => parent.emit('message', data));
  return { parent, child };
}

test('catalog and MCP use the same private desktop transport; redirects and cookies stay disabled', async () => {
  const { parent, child } = ports();
  const calls = [];
  const host = createBrokerHostTransport({ port: parent,
    access: () => ({ url: 'https://broker.example', token: 'a'.repeat(64) }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { headers: { 'mcp-session-id': 'fixture-session' } });
    } });
  const client = createBrokerClientTransport(child);
  try {
    assert.deepEqual(await (await client.fetch('/v1/catalog')).json(), { ok: true });
    const reply = await client.fetch('/v1/mcp', { method: 'POST', body: '{}', headers: { accept: 'application/json' } });
    assert.equal(reply.headers.get('mcp-session-id'), 'fixture-session');
    assert.equal(calls[1].url, 'https://broker.example/v1/mcp');
    assert.equal(calls[1].init.headers.get('authorization'), `Bearer ${'a'.repeat(64)}`);
    assert.equal(calls[1].init.redirect, 'error');
    assert.equal(calls[1].init.credentials, 'omit');
    await assert.rejects(client.fetch('//other.example/v1/me'));
    await assert.rejects(client.fetch('/v1/../secret'));
    await assert.rejects(client.fetch('/v1/installations', { method: 'POST' }));
    assert.equal(calls.length, 2);
  } finally { client.close(); host.close(); }
});

test('outage is safe, then a later request recovers without a process restart', async () => {
  const { parent, child } = ports();
  let online = false;
  const host = createBrokerHostTransport({ port: parent,
    access: () => ({ url: 'https://broker.example', token: 'a'.repeat(64) }),
    fetchImpl: async () => {
      if (!online) throw Object.assign(new Error('contains private URL and credentials'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      return new Response('[]');
    } });
  const client = createBrokerClientTransport(child);
  try {
    await assert.rejects(client.fetch('/v1/catalog'), (e) => e.message === 'CONNECTED_APPS_NETWORK_UNREACHABLE');
    online = true;
    assert.deepEqual(await (await client.fetch('/v1/catalog')).json(), []);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.fetch('/v1/catalog', { signal: controller.signal }));
  } finally { client.close(); host.close(); }
});

test('closing the utility transport cancels in-flight work and bounded capacity rejects excess requests', async () => {
  const { parent, child } = ports();
  let started = 0;
  let aborted = 0;
  const host = createBrokerHostTransport({ port: parent,
    access: () => ({ url: 'https://broker.example', token: 'a'.repeat(64) }),
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      started++;
      signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
    }) });
  const client = createBrokerClientTransport(child);
  try {
    const requests = Array.from({ length: 16 }, () =>
      assert.rejects(client.fetch('/v1/catalog'), /CONNECTED_APPS_TRANSPORT_CLOSED/));
    await assert.rejects(client.fetch('/v1/catalog'), /CONNECTED_APPS_BUSY/);
    assert.equal(started, 16);
    client.close();
    await Promise.all(requests);
    assert.equal(aborted, 16);
    await assert.rejects(client.fetch('/v1/catalog'), /CONNECTED_APPS_TRANSPORT_CLOSED/);
  } finally { client.close(); host.close(); }
  assert.equal(parent.listenerCount('message'), 0);
  assert.equal(child.listenerCount('message'), 0);
});

test('the parent rejects oversized requests and responses and strips caller credentials', async () => {
  const { parent, child } = ports();
  let calls = 0;
  const host = createBrokerHostTransport({ port: parent,
    access: () => ({ url: 'https://broker.example', token: 'a'.repeat(64) }),
    fetchImpl: async (_url, { headers }) => {
      calls++;
      assert.equal(headers.get('authorization'), `Bearer ${'a'.repeat(64)}`);
      assert.equal(headers.get('cookie'), null);
      assert.equal(headers.get('proxy-authorization'), null);
      return new Response('too large', { headers: { 'content-length': String(21 * 1024 * 1024) } });
    } });
  const client = createBrokerClientTransport(child);
  try {
    await assert.rejects(client.fetch('/v1/mcp', { method: 'POST', body: 'x'.repeat(20 * 1024 * 1024 + 1) }),
      /CONNECTED_APPS_INVALID_REQUEST/);
    assert.equal(calls, 0);
    await assert.rejects(client.fetch('/v1/catalog', { headers: {
      authorization: 'Bearer untrusted', cookie: 'fixture=private', 'proxy-authorization': 'untrusted',
    } }), /CONNECTED_APPS_RESPONSE_TOO_LARGE/);
    assert.equal(calls, 1);
  } finally { client.close(); host.close(); }
});
