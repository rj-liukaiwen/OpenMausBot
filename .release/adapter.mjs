import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const commonEnv = { OMB_EXPECTED_UPDATE_OWNER: 'rj-liukaiwen', OMB_EXPECTED_UPDATE_REPO: 'OpenMausBot', OMB_EXPECTED_DESKTOP_NAME: '锐捷Bot' };
function run(command, args, env = {}) {
  const r = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' && command === 'corepack', windowsHide: true, env: { ...process.env, ...commonEnv, ...env } });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `${command} ${args.join(' ')} failed`);
}
const pnpm = (args, env) => run('corepack', ['pnpm', ...args], env);
const node = (args, env) => run(process.execPath, args, env);
const platform = target => ({ 'windows-x64': 'windows', 'linux-x64': 'linux', 'macos-universal': 'macos' })[target];
export async function preflight() {
  const blockers = [];
  for (const file of ['scripts/fetch-evaluation-browser-vendor.mjs', 'scripts/smoke-feishu-package.mjs', 'scripts/private-macos-sign.mjs', 'electron-builder.testing.mjs', '发布交付指南/05-fork一键测试发布.md']) {
    try { await readFile(file); } catch { blockers.push(`Missing current evaluation integration: ${file}`); }
  }
  const url = 'https://github.com/rj-liukaiwen/OpenMausBot/releases/download/browser-engine-v0.36.0-omb.2/RuijieBot-browser-vendor-0.36.0-omb.2-win-x64.zip';
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  if (!response.ok) blockers.push(`Approved browser vendor unavailable: HTTP ${response.status}`);
  assert.equal(JSON.parse(await readFile('package.json', 'utf8')).packageManager, 'pnpm@10.33.0');
  return { blockers, notes: ['Uses existing fork evaluation policy; production acceptance remains separate.', 'Windows vendor retains pinned archive and executable hashes.', 'macOS Feishu original bytes are preserved; both architecture runtimes are executed.', 'Human account, TCC and upgrade acceptance is not performed by this automation.'] };
}
export async function prepareFiles(ctx) {
  return [{ path: 'build/private-release.json', content: JSON.stringify({ schemaVersion: 1, version: ctx.version, sourceSha: ctx.sourceSha, repository: 'rj-liukaiwen/OpenMausBot', workflowRun: process.env.GITHUB_RUN_ID, signing: { windows: 'unsigned', macos: 'ad-hoc signed, not notarized' }, usage: 'public test candidate; Enterprise redistribution authorized by repository owner', humanAcceptance: 'skipped-by-owner', acceptancePolicy: 'legacy-evaluation', dataDirectory: '~/.ruijiebot' }, null, 2) + '\n' }];
}
export async function install() { pnpm(['install', '--frozen-lockfile']); }
export async function build(ctx) {
  pnpm(['typecheck']);
  node(['--test', '--test-isolation=none', 'electron/private-release.node-test.mjs', 'electron/ruijie-package-config.node-test.mjs', 'electron/desktop-runtime-layout.node-test.mjs']);
  pnpm(['exec', 'vitest', 'run', 'server/browser-engine.test.ts', 'server/browser-navigation.test.ts', 'server/browser-live.test.ts', 'server/browser-runtime.test.ts', 'server/local-computer-proxy-gate.test.ts', 'server/local-computer-proxy.test.ts']);
  pnpm(['test:packaged-server']);
  const env = {};
  if (ctx.target === 'windows-x64') { node(['scripts/fetch-evaluation-browser-vendor.mjs']); env.OMB_BROWSER_VENDOR_DIR = path.join(ctx.root, 'dist-native/browser-vendor'); }
  pnpm(['package:prepare'], env);
  if (ctx.target === 'windows-x64') {
    pnpm(['build:cua:windows']); pnpm(['build:feishu:windows']); node(['scripts/desktop-build-receipt.mjs', '--write']);
    pnpm(['exec', 'electron-builder', '--config', 'electron-builder.testing.mjs', '--win', '--x64', '--publish', 'never']);
  } else if (ctx.target === 'linux-x64') {
    pnpm(['build:cua:linux']); node(['scripts/desktop-build-receipt.mjs', '--write']); pnpm(['smoke:cua-x11-input']);
    pnpm(['exec', 'electron-builder', '--config', 'electron-builder.testing.mjs', '--linux', '--x64', '--publish', 'never']); node(['scripts/verify-linux-package.mjs']);
  } else {
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
    pnpm(['build:speech']); pnpm(['build:cua']); pnpm(['build:feishu:mac']); node(['scripts/desktop-build-receipt.mjs', '--write']);
    pnpm(['exec', 'electron-builder', '--config', 'electron-builder.testing.mjs', '--mac', 'dir', '--arm64', '--x64', '--publish', 'never']);
    node(['scripts/package-private-macos.mjs']);
  }
  node(['scripts/private-release-assets.mjs', platform(ctx.target)]);
}
export async function assets(ctx) {
  const { expectedArtifacts } = await import('../scripts/private-release-assets.mjs');
  const p = platform(ctx.target);
  return [...expectedArtifacts(ctx.version, p), `SHA256SUMS-${p}.txt`, `build-report-${p}.json`].map(file => ({ path: `release/private-artifacts/${file}`, ...(file.startsWith('latest') ? {kind:'update-feed'} : !file.includes(ctx.version) ? {name:`RuijieBot-${ctx.version}-${file}`} : {}) }));
}
async function smoke(resources, arch) {
  node(['scripts/check-private-package.mjs', resources]);
  if (process.platform !== 'linux') node(['scripts/smoke-feishu-package.mjs', resources]);
  node(['scripts/smoke-browser-bundle.mjs', '--resources', resources]);
  node(['scripts/smoke-packaged-server.mjs', '--browser-bundle', path.join(resources, 'browser-engine')], { OMB_SMOKE_DIST: path.join(resources, 'server') });
  if (process.platform === 'darwin') run(path.resolve(resources, '../MacOS/OpenMausBot'), ['-e', `if(process.arch!==${JSON.stringify(arch)})process.exit(1);console.log(process.arch)`], { ELECTRON_RUN_AS_NODE: '1' });
}
export async function verify(ctx) {
  await mkdir(path.join(ctx.out, 'evidence'), {recursive:true});
  if (ctx.target === 'linux-x64') run('bash', ['.release/verify-linux.sh']);
  else {
    await smoke(path.join(ctx.root, ctx.target === 'windows-x64' ? 'release/win-unpacked/resources' : 'release/mac-universal/OpenMausBot.app/Contents/Resources'), 'arm64');
    if (ctx.target === 'windows-x64') run('pwsh', ['-NoProfile', '-File', '.release/verify-windows.ps1', '-Version', ctx.version]);
  }
  for (const file of await readdir('release')) if (/^(?:build-report-|macos.*audit)/.test(file)) await cp(path.join('release',file),path.join(ctx.out,'evidence',file));
}
export async function verifyIntel(ctx) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'x64');
  await mkdir(path.join(ctx.out,'evidence'),{recursive:true});
  const input = path.join(ctx.out, 'intel-input');
  const manifest = JSON.parse(await readFile(path.join(input,'macos-universal.json'),'utf8'));
  assert.equal(manifest.sourceSha,ctx.sourceSha); assert.equal(manifest.version,ctx.version); assert.equal(manifest.toolkitSha,ctx.toolkitSha);
  const name = `RuijieBot-${ctx.version}-mac-universal.dmg`;
  const asset = manifest.assets.find(a=>a.name===name); assert(asset, 'Missing Universal DMG');
  const {createReadStream}=await import('node:fs'); const hash=createHash('sha256');
  for await(const chunk of createReadStream(path.join(input,name)))hash.update(chunk);
  assert.equal(hash.digest('hex'),asset.sha256);
  const temp=await mkdtemp(path.join(tmpdir(),'ruijiebot-intel-'));
  const mount=path.join(temp,'mount'); await mkdir(mount);
  run('hdiutil',['attach',path.join(input,name),'-mountpoint',mount,'-nobrowse','-readonly']);
  try { const app=path.join(mount,'OpenMausBot.app'); node(['scripts/private-macos-sign.mjs',app,path.join(ctx.out,'evidence','mac-intel-signatures.json')]); await smoke(path.join(app,'Contents/Resources'),'x64'); }
  finally {run('hdiutil',['detach',mount]);}
}
