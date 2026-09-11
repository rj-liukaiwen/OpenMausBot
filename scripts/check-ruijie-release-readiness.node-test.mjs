import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REQUIRED_RELEASE_CHECKS, releaseSourceFingerprint, validateReleaseReceipt } from './check-ruijie-release-readiness.mjs';

test('source receipts become stale when uncommitted assets or build inputs change', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ruijie-fingerprint-test-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    for (const file of ['src/app.ts', 'public/icon.svg', 'build/entitlements.mac.plist',
      'companion/src/index.ts', 'skills/example/SKILL.md', 'tsconfig.server.json', 'vite.config.ts']) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, 'before');
      const before = releaseSourceFingerprint(root);
      writeFileSync(target, 'after');
      assert.notEqual(releaseSourceFingerprint(root), before, `Fingerprint missed ${file}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('release gate rejects skips, stale code, wrong architecture, expiry and missing runtime evidence', () => {
  const fingerprint = 'a'.repeat(64);
  const now = Date.now();
  const options = { target: 'win32-x64', fingerprint, now };
  const receipt = { schemaVersion: 1, target: options.target, sourceFingerprint: fingerprint,
    verifiedAt: new Date(now).toISOString(), runtimeSha256: 'b'.repeat(64),
    checks: Object.fromEntries([...REQUIRED_RELEASE_CHECKS, 'no-console-cold-start-and-restart']
      .map((key) => [key, { status: 'passed', evidence: 'fixture-test-log-with-runtime-and-command',
        command: 'fixture-test-command', evidenceSha256: 'c'.repeat(64) }])) };
  assert.equal(validateReleaseReceipt(receipt, options), true);
  assert.throws(() => validateReleaseReceipt(receipt, { ...options, brokerUrl: 'https://broker.example' }));
  assert.equal(validateReleaseReceipt({ ...receipt, connectedAppsBrokerUrl: 'https://broker.example' },
    { ...options, brokerUrl: 'https://broker.example' }), true);
  assert.throws(() => validateReleaseReceipt({ ...receipt, connectedAppsBrokerUrl: 'https://old.example' },
    { ...options, brokerUrl: 'https://broker.example' }));
  for (const status of ['skipped', 'blocked', 'not-run', 'failed']) {
    const changed = structuredClone(receipt); changed.checks['feishu-live'].status = status;
    assert.throws(() => validateReleaseReceipt(changed, options), /feishu-live/);
  }
  assert.throws(() => validateReleaseReceipt(receipt, { ...options, fingerprint: 'c'.repeat(64) }));
  assert.throws(() => validateReleaseReceipt(receipt, { ...options, target: 'darwin-arm64' }));
  assert.throws(() => validateReleaseReceipt(receipt, { ...options, now: now + 86400001 }));
  assert.throws(() => validateReleaseReceipt({ ...receipt, runtimeSha256: '' }, options));
  const desktopBuild = { ui: 'd'.repeat(64), server: 'e'.repeat(64) };
  assert.throws(() => validateReleaseReceipt(receipt, { ...options, desktopBuild }), /tested desktop build/);
  const tested = { ...receipt, desktopBuild };
  assert.equal(validateReleaseReceipt(tested, { ...options, desktopBuild }), true);
  for (const component of ['ui', 'server']) {
    assert.throws(() => validateReleaseReceipt(tested, { ...options, desktopBuild: { ...desktopBuild, [component]: 'f'.repeat(64) } }), /tested desktop build/);
  }
});
