// Windows read-only inspection of the selected Feishu runtime, not credential contents.
import { app, safeStorage } from 'electron';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const fixture = mkdtempSync(path.join(tmpdir(), 'ruijie-feishu-host-diag-'));
app.setPath('userData', fixture);
void (async () => {
  try {
    const state = JSON.parse(readFileSync(path.join(path.dirname(process.argv[2]), 'Local State'), 'utf8'));
    writeFileSync(path.join(fixture, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }));
    await app.whenReady();
    const result = await safeStorage.decryptStringAsync(readFileSync(process.argv[2]));
    const selected = JSON.parse(typeof result === 'string' ? result : result.result).tuantuanFeishu ?? {};
    console.log(JSON.stringify({ cliPath: selected.cliPath, nodePath: selected.nodePath, configDir: selected.configDir,
      reconnect: selected.reconnect, recoveryPending: !!selected.recovery, boundApp: !!selected.appId, boundUser: !!selected.ownerOpenId }));
    if (process.argv[3]) {
      const context = path.join(fixture, 'context'); mkdirSync(context);
      cpSync(path.join(selected.configDir, 'config.json'), path.join(context, 'config.json'));
      const variants = [['current', new URL('../connectors/feishu/', import.meta.url)], ['installer', pathToFileURL(path.resolve(process.argv[3]) + path.sep)]];
      for (const [label, base] of variants) {
        const { createConnector } = await import(new URL('index.mjs', base));
        const { createCli } = await import(new URL('cli.mjs', base));
        const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local') };
        const connector = createConnector({ kernel: { request: async () => ({ servers: [] }) },
          store: { load: async () => ({ ...selected, configDir: context }), save: async () => {} },
          createCliImpl: (options) => createCli({ ...options, env }),
          mcpPath: path.join(path.dirname(new URL('index.mjs', base).pathname), 'mcp.mjs'),
        });
        try {
          const result = await connector.invoke('probe');
          console.log(JSON.stringify({ phase: 'same-configuration-probe', variant: label, botAuthorized: result.botAuthorized, userAuthorized: result.userAuthorized, errorCode: result.errorCode }));
        } finally { await connector.close(); }
      }
      rmSync(context, { recursive: true, force: true });
    }
  } catch (error) { console.error(JSON.stringify({ phase: 'read-failed', name: error.name, code: error.code, message: String(error.message).slice(0, 200) })); }
  finally { rmSync(path.join(fixture, 'Local State'), { force: true }); app.exit(); }
})();
