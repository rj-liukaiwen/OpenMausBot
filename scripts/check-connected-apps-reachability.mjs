// Read-only live probe: no credentials and no POST /v1/installations.
import { app, session } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_COMPOSIO_BROKER_URL, normalizeManagedComposioBrokerUrl } from '../electron/managed-composio.mjs';

const fixture = mkdtempSync(path.join(tmpdir(), 'ruijiebot-reachability-'));
app.setPath('userData', fixture);
const broker = normalizeManagedComposioBrokerUrl(process.env.OMB_COMPOSIO_BROKER_URL || DEFAULT_COMPOSIO_BROKER_URL);
const watchdog = setTimeout(() => { console.log(JSON.stringify({ reachable: false, reason: 'probe-timeout', fixture })); app.exit(1); }, 15000);
void app.whenReady().then(async () => {
  if (!broker) throw new Error('Invalid broker URL');
  const network = session.fromPartition('ruijiebot-reachability');
  const proxy = await network.resolveProxy(broker);
  // Never print system proxy addresses, credentials or PAC contents.
  const route = proxy.split(';').map((part) => part.trim().split(' ')[0]);
  let response;
  try {
    response = await network.fetch(`${broker}/v1/me`, { method: 'GET', credentials: 'omit',
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    console.log(JSON.stringify({ reachable: true, status: response.status, route,
      authorizationVerified: false, note: 'HTTP response is reachability only, not a successful plugin authorization', fixture }));
    app.exit(response.status === 401 ? 0 : 1);
  } catch {
    console.log(JSON.stringify({ reachable: false, route, reason: 'network-or-proxy-unreachable', authorizationVerified: false, fixture }));
    app.exit(1);
  } finally { clearTimeout(watchdog); await response?.body?.cancel().catch(() => {}); }
}).catch(() => { clearTimeout(watchdog); app.exit(1); });
