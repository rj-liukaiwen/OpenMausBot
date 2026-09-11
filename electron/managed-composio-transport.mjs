import { randomUUID } from 'node:crypto';

const REQUEST = 'openmausbot:broker-request';
const RESULT = 'openmausbot:broker-result';
const CANCEL = 'openmausbot:broker-cancel';
const MAX_BYTES = 20 * 1024 * 1024;
const allowedHeaders = new Set(['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version']);

function requestPath(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\\\s#]/.test(value)) return false;
  const pathname = value.split('?')[0];
  if (new URL(value, 'https://broker.invalid').pathname !== pathname) return false;
  return /^\/v1\/(?:me|catalog|mcp|connectors(?:\/[A-Za-z0-9_%.-]+)*)$/.test(pathname);
}

function headersOnly(input) {
  const headers = new Headers(input);
  const remove = [];
  for (const key of headers.keys()) if (!allowedHeaders.has(key)) remove.push(key);
  for (const key of remove) headers.delete(key);
  return headers;
}

/** Only the owned utility child can reach this port. It chooses a broker path,
 * never a host, credential, cookie, proxy, redirect policy, or arbitrary URL. */
export function createBrokerHostTransport({ port, access, fetchImpl }) {
  const pending = new Map();
  let closed = false;
  const send = (message) => { if (!closed) { try { port.postMessage(message); } catch {} } };
  const receive = (message) => {
    if (message?.type === CANCEL) { pending.get(message.id)?.abort(); return; }
    if (message?.type !== REQUEST) return;
    const { id, path, method, body } = message;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || pending.has(id)) return;
    const fail = (error) => send({ type: RESULT, id, error });
    if (!requestPath(path) || !['GET', 'POST', 'DELETE'].includes(method) ||
        (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES)) ||
        (method === 'GET' && body !== undefined)) { fail('CONNECTED_APPS_INVALID_REQUEST'); return; }
    if (pending.size >= 16) { fail('CONNECTED_APPS_BUSY'); return; }
    const broker = access();
    if (!broker) { fail('CONNECTED_APPS_NOT_CONFIGURED'); return; }
    const controller = new AbortController();
    pending.set(id, controller);
    const timer = setTimeout(() => controller.abort(), path === '/v1/mcp' ? 600_000 : 30_000);
    timer.unref?.();
    void (async () => {
      let response;
      try {
        const headers = headersOnly(message.headers);
        headers.set('authorization', `Bearer ${broker.token}`);
        response = await fetchImpl(`${broker.url}${path}`, {
          method, body, headers, signal: controller.signal, redirect: 'error', credentials: 'omit',
        });
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('SIZE_LIMIT');
        const chunks = [];
        let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength;
              if (size > MAX_BYTES) throw new Error('SIZE_LIMIT');
              chunks.push(Buffer.from(part.value));
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
        send({ type: RESULT, id, status: response.status,
          headers: Object.fromEntries([...response.headers].filter(([key]) =>
            ['content-type', 'mcp-session-id', 'retry-after'].includes(key))),
          bytes: new Uint8Array(Buffer.concat(chunks, size)) });
      } catch (error) {
        // Never forward a URL, token, upstream body or raw network exception.
        fail(error?.message === 'SIZE_LIMIT' ? 'CONNECTED_APPS_RESPONSE_TOO_LARGE' :
          controller.signal.aborted ? 'CONNECTED_APPS_REQUEST_ABORTED' : 'CONNECTED_APPS_NETWORK_UNREACHABLE');
      } finally {
        controller.abort(); clearTimeout(timer); pending.delete(id);
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    })();
  };
  port.on('message', receive);
  return { close() {
    closed = true; port.off('message', receive);
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  } };
}

/** The server's managed catalog, OAuth and MCP traffic all use this transport.
 * There is deliberately no direct-network fallback when the desktop fails. */
export function createBrokerClientTransport(port) {
  const pending = new Map();
  let closed = false;
  const receive = ({ data }) => {
    if (data?.type !== RESULT) return;
    const request = pending.get(data.id);
    if (!request) return;
    if (data.error) request.finish(new Error(data.error));
    else {
      try {
        request.finish(null, new Response([204, 205, 304].includes(data.status) ? null : data.bytes,
          { status: data.status, headers: data.headers }));
      } catch { request.finish(new Error('CONNECTED_APPS_INVALID_RESPONSE')); }
    }
  };
  port.on('message', receive);
  return {
    fetch(path, init = {}) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error('CONNECTED_APPS_TRANSPORT_CLOSED')); return; }
        if (init.signal?.aborted) { reject(init.signal.reason); return; }
        if (pending.size >= 16) { reject(new Error('CONNECTED_APPS_BUSY')); return; }
        const id = randomUUID();
        const finish = (error, response) => {
          clearTimeout(timer); init.signal?.removeEventListener('abort', abort); pending.delete(id);
          if (error) reject(error); else resolve(response);
        };
        const cancel = () => { try { port.postMessage({ type: CANCEL, id }); } catch {} };
        const abort = () => { cancel(); finish(init.signal.reason); };
        const timer = setTimeout(() => { cancel(); finish(new Error('CONNECTED_APPS_REQUEST_TIMEOUT')); },
          path === '/v1/mcp' ? 605_000 : 35_000);
        timer.unref?.();
        pending.set(id, { finish });
        init.signal?.addEventListener('abort', abort, { once: true });
        try {
          port.postMessage({ type: REQUEST, id, path, method: init.method ?? 'GET', body: init.body,
            headers: Object.fromEntries(headersOnly(init.headers)) });
        } catch { finish(new Error('CONNECTED_APPS_TRANSPORT_CLOSED')); }
      });
    },
    close() {
      closed = true; port.off?.('message', receive);
      for (const [id, request] of pending) {
        try { port.postMessage({ type: CANCEL, id }); } catch {}
        request.finish(new Error('CONNECTED_APPS_TRANSPORT_CLOSED'));
      }
    },
  };
}
