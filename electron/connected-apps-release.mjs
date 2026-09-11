import { DEFAULT_COMPOSIO_BROKER_URL, normalizeManagedComposioBrokerUrl } from './managed-composio.mjs';

/** Public address only. Project API keys and installation credentials must
 * never enter package metadata. This is shared by packaging and desktop. */
export function releaseBrokerUrl(value = DEFAULT_COMPOSIO_BROKER_URL) {
  const normalized = normalizeManagedComposioBrokerUrl(value);
  if (!normalized || !normalized.startsWith('https://')) throw new Error('The release connected-apps broker requires a valid HTTPS URL without credentials');
  const host = new URL(normalized).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost')) {
    throw new Error('A release connected-apps broker must not point to the build machine');
  }
  return normalized;
}
