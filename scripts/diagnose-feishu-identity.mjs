// Read-only provider diagnostics in a disposable copy, never refreshing the live profile.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCli } from '../connectors/feishu/cli.mjs';
const [binary, context, mode = 'direct'] = process.argv.slice(2);
assert(['direct', 'shell-proxy', 'unavailable-proxy'].includes(mode));
assert(binary && context && path.isAbsolute(binary) && path.isAbsolute(context));
const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'ruijie-feishu-diag-')));
const config = path.join(fixture, 'context');
mkdirSync(config);
const safeMessage = (value) => typeof value === 'string' ? value
  .replace(/https?:\/\/\S+/g, '[URL]')
  .replace(/(?:cli_|ou_|u-|t-)[A-Za-z0-9_-]+/g, '[IDENTITY]')
  .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]').slice(0, 500) : undefined;
try {
  cpSync(path.join(context, 'config.json'), path.join(config, 'config.json'));
  const env = { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    HOME: fixture, USERPROFILE: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
    TEMP: fixture, TMP: fixture, LARKSUITE_CLI_CONFIG_DIR: config,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1', LARKSUITE_CLI_REMOTE_META: 'off' };
  if (mode === 'shell-proxy') for (const [key, value] of Object.entries(process.env)) {
    if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].includes(key.toUpperCase())) env[key.toUpperCase()] = value;
  }
  if (mode === 'unavailable-proxy') Object.assign(env, { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' });
  const { stdout } = await promisify(execFile)(binary, ['auth', 'status', '--json', '--verify'], {
    env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(stdout);
  console.log(JSON.stringify({ mode, proxyVariables: Object.keys(env).filter((key) => key.endsWith('_PROXY')), brand: value.brand, identities: Object.fromEntries(['bot', 'user'].map((key) => {
    const item = value.identities?.[key] ?? {};
    return [key, { status: item.status, available: item.available, verified: item.verified, message: safeMessage(item.message) }];
  })) }, null, 2));
  const inspected = await createCli({ executable: binary, configDir: config, env }).inspect();
  console.log(JSON.stringify({ phase: 'production-adapter', ok: inspected.ok, error: inspected.error?.code, botReady: inspected.botReady, userAvailable: inspected.user?.available }));
} catch (error) {
  console.error(JSON.stringify({ code: error.code, signal: error.signal, diagnosticFailed: true }));
  process.exitCode = 1;
} finally {
  // Exact mkdtemp-owned directory, not a caller-supplied cleanup target.
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
