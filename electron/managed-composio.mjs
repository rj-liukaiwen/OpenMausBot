const TOKEN = /^[0-9a-f]{64}$/;
export const DEFAULT_COMPOSIO_BROKER_URL = 'https://openmausbot-composio.milindsoni201.workers.dev';

/** First-launch failures recover in-process. A bounded backoff prevents a
 * disconnected laptop from hammering registration; quit cancels the timer. */
export function createManagedComposioRegistrationLoop({ attempt, hasAccess, delays = [2000, 5000, 15000, 60000] }) {
  let timer;
  let inFlight;
  let closed = false;
  let failures = 0;
  function run() {
    if (closed) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(() => { if (!closed) return attempt(); })
      .catch(() => { /* errors are reported by the registration boundary */ })
      .finally(() => {
        inFlight = undefined;
        if (!closed && !hasAccess()) {
          const delay = delays[Math.min(failures++, delays.length - 1)];
          timer = setTimeout(() => { timer = undefined; void run(); }, delay);
          timer.unref?.();
        }
      });
    return inFlight;
  }
  return {
    start() { if (!timer && !inFlight && !closed) void run(); },
    retry() {
      clearTimeout(timer); timer = undefined; failures = 0;
      return run();
    },
    close() { closed = true; clearTimeout(timer); timer = undefined; },
  };
}

export function normalizeManagedComposioBrokerUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function managedComposioAccess(brokerUrl, credentials) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  const token = credentials?.composioBrokerToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  return { url, token };
}

export function managedComposioChildEnvironment(brokerUrl, credentials, environment) {
  const next = { ...environment };
  delete next.OMB_COMPOSIO_BROKER_URL;
  delete next.OMB_COMPOSIO_BROKER_TOKEN;
  const access = managedComposioAccess(brokerUrl, credentials);
  if (access) {
    next.OMB_COMPOSIO_BROKER_URL = access.url;
    next.OMB_COMPOSIO_BROKER_TOKEN = access.token;
  }
  return next;
}

export async function ensureManagedComposioCredentials({
  brokerUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  existingCredentialTimeoutMs = 8_000,
  registrationTimeoutMs = 15_000,
}) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  if (!url) {
    if (brokerUrl) log("connected-apps broker URL rejected: HTTPS or a loopback HTTP URL is required");
    return credentials;
  }
  if (TOKEN.test(credentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetchImpl(`${url}/v1/me`, {
        headers: { authorization: `Bearer ${credentials.composioBrokerToken}` },
        redirect: "error",
        signal: timeoutSignal(existingCredentialTimeoutMs),
      });
      if (check.ok) return credentials;
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand the
      // user's already-authorized accounts under a new installation.
      if (check.status !== 401) return credentials;
      delete credentials.composioBrokerToken;
      delete credentials.composioInstallationId;
    } catch {
      return credentials;
    }
  }
  try {
    const response = await fetchImpl(`${url}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: timeoutSignal(registrationTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!TOKEN.test(body?.token ?? "") || typeof body?.installationId !== "string") {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    credentials.composioBrokerToken = body.token;
    credentials.composioInstallationId = body.installationId;
    await saveCredentials(credentials);
    log("connected-apps installation registered");
  } catch (error) {
    // This operation always settles locally. The caller runs it after first
    // paint, so an optional hosted integration cannot delay desktop readiness.
    const code = String(error?.cause?.code ?? error?.code ?? '');
    const network = /TIMEOUT|ECONN|ENOTFOUND|EAI_AGAIN/.test(code) || /fetch failed|net::ERR_|timeout/i.test(error?.message ?? '');
    log(network ? 'connected-apps registration failed: NETWORK_UNREACHABLE (check network/system proxy)' :
      'connected-apps registration failed: SERVICE_OR_AUTH_ERROR (no credentials stored)');
  }
  return credentials;
}
