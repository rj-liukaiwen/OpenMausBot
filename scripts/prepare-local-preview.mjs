// The named development shortcut previews the very same compiled UI/server
// and pinned native resources as packaging, with a separate development identity.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveBrowserRuntimeLog, verifyBrowserBundle, stageBrowserTarget } from './prepare-browser.mjs';
import { verifyFeishuRuntimeBundle, prepareFeishuRuntime } from './prepare-feishu-runtime.mjs';
import { verifyDesktopBuildReceipt, writeDesktopBuildReceipt } from './desktop-build-receipt.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = `${process.platform}-${process.arch}`;
mkdirSync(path.join(root, 'dist-native'), { recursive: true });
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Preview preparation failed: ${args[0]} (${result.status})`);
}
try { verifyBrowserBundle(path.join(root, 'dist-native/browser', target), target); }
catch {
  const directory = path.join(root, 'dist-native/browser', target);
  let files;
  try { files = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')).files; } catch { /* Missing stage needs preparation. */ }
  const archived = files && target === 'win32-x64'
    ? archiveBrowserRuntimeLog(directory, files, path.join(root, 'dist-native/browser-runtime-logs')) : null;
  if (archived) {
    verifyBrowserBundle(directory, target);
    console.log(`Archived native runtime log without replacing verified components: ${archived}`);
  } else await stageBrowserTarget(root, target);
}
try { await verifyFeishuRuntimeBundle(path.join(root, 'dist-native/feishu-runtime', target), target); }
catch { await prepareFeishuRuntime({ root, target, cache: path.join(root, 'dist-native/feishu-runtime') }); }
try { verifyDesktopBuildReceipt(root); console.log('Preview already matches current source and built outputs.'); }
catch {
  run(['node_modules/typescript/bin/tsc', '-b']);
  run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json']);
  run(['node_modules/vite/bin/vite.js', 'build']);
  run(['scripts/bundle-server.mjs']);
  writeDesktopBuildReceipt(root);
  console.log('Current-source desktop preview ready; no installer created.');
}
