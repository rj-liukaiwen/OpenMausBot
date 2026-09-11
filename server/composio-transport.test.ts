import { afterEach, expect, it, vi } from 'vitest';
import { authorizeService, connectedServices, relayMcp, setManagedBrokerAccess, setManagedBrokerFetch } from './composio.ts';

afterEach(() => { setManagedBrokerFetch(undefined); setManagedBrokerAccess(null); vi.unstubAllGlobals(); });

it('routes actual managed inventory AND MCP through the desktop adapter, never direct fetch', async () => {
  setManagedBrokerAccess({ url: 'https://broker.example', token: 'a'.repeat(64) });
  const direct = vi.fn(() => { throw new Error('direct route bypassed system proxy'); });
  vi.stubGlobal('fetch', direct);
  const desktop = vi.fn(async (path: string) => new Response(JSON.stringify(
    path === '/v1/connectors/connected' ? { services: {} } : { jsonrpc: '2.0', id: 1, result: {} }),
  { headers: { 'content-type': 'application/json', 'mcp-session-id': 'fixture' } }));
  setManagedBrokerFetch(desktop);
  await connectedServices({});
  const response = await relayMcp({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(response.status).toBe(200);
  expect(desktop.mock.calls.map(([path]) => path)).toEqual(['/v1/connectors/connected', '/v1/mcp']);
  expect(direct).not.toHaveBeenCalled();
});

it('routes OAuth creation with JSON account aliases through the desktop adapter', async () => {
  setManagedBrokerAccess({ url: 'https://broker.example', token: 'a'.repeat(64) });
  const direct = vi.fn(() => { throw new Error('OAuth bypassed desktop proxy'); });
  vi.stubGlobal('fetch', direct);
  const desktop = vi.fn(async (_path: string, _init?: RequestInit) => new Response(
    JSON.stringify({ url: 'https://connect.composio.dev/fixture' }),
    { headers: { 'content-type': 'application/json' } },
  ));
  setManagedBrokerFetch(desktop);
  await expect(authorizeService({}, 'github', 'work')).resolves.toEqual({
    url: 'https://connect.composio.dev/fixture',
  });
  expect(desktop).toHaveBeenCalledOnce();
  const [path, init] = desktop.mock.calls[0];
  expect(path).toBe('/v1/connectors/github/authorize');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  expect(JSON.parse(String(init?.body))).toEqual({ alias: 'work' });
  expect(direct).not.toHaveBeenCalled();
});
