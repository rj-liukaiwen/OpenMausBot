import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { writeDesktopBuildReceipt, verifyDesktopBuildReceipt } from './desktop-build-receipt.mjs';

test('preview/package provenance rejects stale source and altered compiled resources', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ruijie-build-receipt-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    for (const directory of ['src', 'dist', 'dist-server', 'dist-native']) mkdirSync(path.join(root, directory));
    writeFileSync(path.join(root, 'src/app.ts'), 'new source');
    writeFileSync(path.join(root, 'dist/index.html'), 'new UI');
    writeFileSync(path.join(root, 'dist-server/index.js'), 'new server');
    writeDesktopBuildReceipt(root);
    assert.ok(verifyDesktopBuildReceipt(root));
    cpSync(path.join(root, 'dist'), path.join(root, 'copied-ui'), { recursive: true });
    assert.ok(verifyDesktopBuildReceipt(root, { ui: path.join(root, 'copied-ui') }));
    writeFileSync(path.join(root, 'copied-ui/index.html'), 'old UI');
    assert.throws(() => verifyDesktopBuildReceipt(root, { ui: path.join(root, 'copied-ui') }), /UI differs/);
    writeFileSync(path.join(root, 'src/app.ts'), 'changed source');
    assert.throws(() => verifyDesktopBuildReceipt(root), /Source changed/);
    writeFileSync(path.join(root, 'src/app.ts'), 'new source');
    writeFileSync(path.join(root, 'dist-server/index.js'), 'old server');
    assert.throws(() => verifyDesktopBuildReceipt(root), /Server differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
