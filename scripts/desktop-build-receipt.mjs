import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseSourceFingerprint } from './check-ruijie-release-readiness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function treeDigest(directory) {
  const hash = createHash('sha256');
  function visit(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const file = path.join(folder, name), relative = `${prefix}${name}`;
      const stat = lstatSync(file);
      assert(!stat.isSymbolicLink(), `Build output must not be a symlink: ${relative}`);
      if (stat.isDirectory()) visit(file, `${relative}/`);
      else {
        assert(stat.isFile(), `Invalid build output: ${relative}`);
        hash.update(relative); hash.update('\0'); hash.update(readFileSync(file)); hash.update('\0');
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}
export function writeDesktopBuildReceipt(directory = root) {
  const receipt = { schemaVersion: 1, sourceFingerprint: releaseSourceFingerprint(directory),
    builtAt: new Date().toISOString(),
    ui: treeDigest(path.join(directory, 'dist')), server: treeDigest(path.join(directory, 'dist-server')) };
  writeFileSync(path.join(directory, 'dist-native', 'desktop-build.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
export function verifyDesktopBuildReceipt(directory = root, outputs = {}) {
  const receipt = JSON.parse(readFileSync(path.join(directory, 'dist-native', 'desktop-build.json'), 'utf8'));
  assert.equal(receipt.schemaVersion, 1, 'Missing desktop build provenance');
  assert.equal(receipt.sourceFingerprint, releaseSourceFingerprint(directory), 'Source changed: rebuild the desktop preview before packaging');
  assert.equal(receipt.ui, treeDigest(outputs.ui ?? path.join(directory, 'dist')), 'UI differs from the current-source build');
  assert.equal(receipt.server, treeDigest(outputs.server ?? path.join(directory, 'dist-server')), 'Server differs from the current-source build');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--write') writeDesktopBuildReceipt();
  else verifyDesktopBuildReceipt();
}
