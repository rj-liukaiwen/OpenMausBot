import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseBrokerUrl } from '../electron/connected-apps-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const REQUIRED_RELEASE_CHECKS = ['desktop-preview-acceptance', 'source-regression', 'reply-language-chinese', 'native-browser', 'browser-control-and-close',
  'browser-search-routing-no-firecrawl', 'browser-stream-background-recovery',
  'connected-apps-proxy-recovery', 'connected-apps-live-authorization-and-read', 'feishu-live', 'fresh-profile-isolation'];

export function releaseSourceFingerprint(directory = root) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: directory, encoding: 'utf8', windowsHide: true }).split('\0').filter((file) =>
      /^(?:electron\/|server\/|shared\/|src\/|scripts\/|connectors\/|third_party\/|companion\/|enterprise\/|public\/|build\/|skills\/|patches\/|发布交付指南\/|\.github\/workflows\/|package\.json$|pnpm-(?:lock|workspace)\.yaml$|tsconfig[^/]*\.json$|vite\.config\.[^/]+$|index\.html$|\.npmrc$|LICENSE$|NOTICE$|electron-builder)/.test(file));
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    const absolute = path.resolve(directory, file);
    assert(absolute.startsWith(path.resolve(directory) + path.sep), 'Source fingerprint escaped repository');
    assert(lstatSync(absolute).isFile(), `Source fingerprint requires a regular file: ${file}`);
    hash.update(file); hash.update('\0'); hash.update(readFileSync(absolute)); hash.update('\0');
  }
  return hash.digest('hex');
}

export function validateReleaseReceipt(receipt, { target, fingerprint, brokerUrl, desktopBuild, now = Date.now() }) {
  assert(['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(target), 'Unsupported branded release target');
  assert(receipt?.schemaVersion === 1 && receipt.target === target, 'Missing or wrong-target native verification receipt');
  assert(receipt.sourceFingerprint === fingerprint, 'Source changed after verification; rerun checks');
  if (desktopBuild) for (const component of ['ui', 'server']) {
    assert(/^[a-f0-9]{64}$/.test(receipt.desktopBuild?.[component] ?? '') && receipt.desktopBuild[component] === desktopBuild[component],
      `RELEASE BLOCKED: ${component} differs from the tested desktop build; accept the rebuilt preview first`);
  }
  if (brokerUrl !== undefined) assert.equal(receipt.connectedAppsBrokerUrl, brokerUrl,
    'Connected-apps release endpoint differs from the live-authorized endpoint in the verification receipt');
  const verifiedAt = Date.parse(receipt.verifiedAt);
  assert(Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= 24 * 60 * 60 * 1000,
    'Verification receipt expired (24 hours), invalid, or from the future');
  const checks = [...REQUIRED_RELEASE_CHECKS, ...(target.startsWith('win32') ? ['no-console-cold-start-and-restart'] : ['mac-native-runtime-and-permissions'])];
  for (const name of checks) {
    const check = receipt.checks?.[name];
    assert(check?.status === 'passed' && typeof check.evidence === 'string' && check.evidence.trim().length > 10 &&
      typeof check.command === 'string' && check.command.trim().length > 5 && /^[a-f0-9]{64}$/.test(check.evidenceSha256 ?? ''),
      `RELEASE BLOCKED: ${name} is not verified (blocked/skipped/not-run never pass)`);
  }
  assert(typeof receipt.runtimeSha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.runtimeSha256), 'Missing tested native runtime SHA-256');
  return true;
}

export async function beforeRuijiePack(context) {
  const { verifyDesktopBuildReceipt } = await import('./desktop-build-receipt.mjs');
  const desktopBuild = verifyDesktopBuildReceipt(root);
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch];
  const target = `${context.electronPlatformName}-${arch}`;
  const file = path.join(root, 'release', 'verification', `${target}.json`);
  let receipt;
  try { receipt = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`RELEASE BLOCKED: no verified ${target} receipt at ${file}. See 发布交付指南/04-通用回归与发布门禁.md`); }
  const brokerUrl = releaseBrokerUrl(context.packager?.config?.extraMetadata?.ruijieConnectedAppsBrokerUrl ?? process.env.RUIJIE_COMPOSIO_BROKER_URL);
  validateReleaseReceipt(receipt, { target, fingerprint: releaseSourceFingerprint(), brokerUrl, desktopBuild });
  const evidenceRoot = path.join(root, 'release', 'verification');
  for (const check of Object.values(receipt.checks)) {
    const evidence = path.resolve(evidenceRoot, check.evidence);
    assert(evidence.startsWith(evidenceRoot + path.sep) && lstatSync(evidence).isFile(), 'Missing regular evidence file under release/verification');
    assert.equal(createHash('sha256').update(readFileSync(evidence)).digest('hex'), check.evidenceSha256,
      'Evidence file changed after native verification');
  }
  const runtime = path.join(root, 'dist-native', 'browser', target, target.startsWith('win32') ? 'agent-browser.exe' : 'agent-browser');
  assert.equal(createHash('sha256').update(readFileSync(runtime)).digest('hex'), receipt.runtimeSha256,
    'Runtime changed after verification; do not package a different executable');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--fingerprint') console.log(releaseSourceFingerprint());
  else {
    const target = process.argv[2];
    assert(['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(target), 'Specify win32-x64, darwin-arm64, darwin-x64 or --fingerprint');
    await beforeRuijiePack({ electronPlatformName: target.split('-')[0], arch: target.endsWith('arm64') ? 3 : 1 });
    console.log(`Native pre-package verification passed: ${target}. Final installer acceptance is still required.`);
  }
}
