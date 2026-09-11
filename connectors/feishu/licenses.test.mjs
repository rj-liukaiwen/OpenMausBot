import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ARTIFACTS, ARTIFACTS_BY_TARGET } from './runtime-artifacts.mjs';
import { checkApprovedArtifacts, validateApprovedArtifacts } from './runtime.mjs';

const bundledManifest = async () => JSON.parse(await readFile(new URL('./licenses/manifest.json', import.meta.url)));

test('bundled license review approves the exact production artifacts and all applicable notice bytes', async () => {
  for (const target of Object.keys(ARTIFACTS_BY_TARGET)) {
    const [platform, arch] = target.split('-');
    const notices = await checkApprovedArtifacts(platform, arch);
    for (const kind of ['cli', 'node']) assert.ok(notices[kind].length > 0, target);
  }
});

test('Mac licenses are explicit per artifact; Windows or cross-architecture approvals fail closed', async () => {
  const manifest = await bundledManifest();
  for (const target of ['darwin-arm64', 'darwin-x64']) {
    const artifacts = ARTIFACTS_BY_TARGET[target];
    const review = manifest.targets[target];
    const notices = validateApprovedArtifacts(review, artifacts);
    assert.ok(notices.cli.some((file) => file.path === 'MAC_CLI_ADDITIONAL_NOTICES.txt'));
    assert.ok(notices.node.some((file) => file.path === 'MAC_SOURCE_AVAILABILITY.md'));
    assert.throws(() => validateApprovedArtifacts(manifest, artifacts), /LICENSE_REVIEW_REQUIRED/);
    const other = target === 'darwin-arm64' ? 'darwin-x64' : 'darwin-arm64';
    assert.throws(() => validateApprovedArtifacts(manifest.targets[other], artifacts), /LICENSE_REVIEW_REQUIRED/);
  }
});

test('every bundled audit file matches its declared byte count and SHA-256', async () => {
  const manifest = await bundledManifest();
  for (const file of [manifest, ...Object.values(manifest.targets ?? {})].flatMap((review) => review.files)) {
    assert.match(file.path, /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.(txt|json|md|crate)$/);
    const bytes = await readFile(new URL(`./licenses/${file.path}`, import.meta.url));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
  }
  const nodeLicense = manifest.files.find((file) => file.path === 'NODE_LICENSE.txt');
  assert.equal(nodeLicense.sha256, ARTIFACTS.node.license.sha256);
});

test('policy validator fails closed on missing approval, changed pins and malformed notice references', async () => {
  // Fake approval is confined to this pure-validator fixture, not production loading.
  const approved = await bundledManifest();
  approved.policyException.approved = true;
  approved.releaseApproved = true;
  assert.ok(validateApprovedArtifacts(approved));
  for (const mutate of [
    (m) => { m.schemaVersion = 2; },
    (m) => { delete m.policyException; },
    (m) => { m.policyException.approved = false; },
    (m) => { m.policyException.approved = 'true'; },
    (m) => { delete m.releaseApproved; },
    (m) => { m.releaseApproved = false; },
    (m) => { m.releaseApproved = 'true'; },
    (m) => { m.policyException.copyleftExceptionGranted = false; },
    (m) => { delete m.policyException.copyleftExceptions; },
    (m) => { m.policyException.copyleftExceptions.pop(); },
    (m) => { m.policyException.copyleftExceptions[0].license = 'GPL-3.0'; },
    (m) => { m.policyException.copyleftExceptions[0].component = 'other MPL library'; },
    (m) => { m.policyException.copyleftExceptions[0].version = '1.0.2'; },
    (m) => { m.policyException.copyleftExceptions[0].executableSha256 = '0'.repeat(64); },
    (m) => { delete m.sourceAvailability; },
    (m) => { m.sourceAvailability.sources = []; },
    (m) => { m.sourceAvailability.instructions = 'missing.md'; },
    (m) => { m.sourceAvailability.sources[0].sha256 = '0'.repeat(64); },
    (m) => { m.artifacts.cli.version = '1.0.94'; },
    (m) => { m.artifacts.node.version = '24.16.0'; },
    (m) => { m.artifacts.cli.platform = 'linux-amd64'; },
    (m) => { m.artifacts.node.platform = 'win32-arm64'; },
    (m) => { m.artifacts.cli.archiveSha256 = '0'.repeat(64); },
    (m) => { m.artifacts.cli.executableSha256 = '0'.repeat(64); },
    (m) => { m.artifacts.node.executableSha256 = '0'.repeat(64); },
    (m) => { delete m.artifacts; },
    (m) => { m.artifacts.cli.noticeFiles = []; },
    (m) => { m.artifacts.node.noticeFiles.push('missing.txt'); },
    (m) => { m.artifacts.node.noticeFiles.push(m.artifacts.node.noticeFiles[0]); },
    (m) => { m.artifacts.node.noticeFiles.push(null); },
    (m) => { m.files = []; },
    (m) => { m.files.push({ ...m.files[0] }); },
    (m) => { m.files[0].path = '../outside.txt'; },
    (m) => { m.files[0].path = 'sources/../outside.txt'; },
    (m) => { m.files[0].path = 'sources/CON.txt'; },
    (m) => { m.files[0].path = 'sources./outside.txt'; },
    (m) => { m.files[0].path = 'C:\\outside.txt'; },
    (m) => { m.files[0].path = 'https://example.org/notice.txt'; },
    (m) => { m.files[0].bytes = 0; },
    (m) => { m.files[0].bytes = 0.5; },
    (m) => { m.files[0].bytes = 8 * 1024 * 1024 + 1; },
    (m) => { m.files[0].sha256 = 'not-a-hash'; },
  ]) {
    const manifest = structuredClone(approved);
    mutate(manifest);
    assert.throws(() => validateApprovedArtifacts(manifest), { code: 'LICENSE_REVIEW_REQUIRED', message: 'LICENSE_REVIEW_REQUIRED' });
  }
  assert.throws(() => validateApprovedArtifacts(null), /LICENSE_REVIEW_REQUIRED/);
});
