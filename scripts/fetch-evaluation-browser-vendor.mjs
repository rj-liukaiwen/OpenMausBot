import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

assert.equal(process.platform, 'win32');
const name = 'RuijieBot-browser-vendor-0.36.0-omb.2-win-x64.zip';
const url = `https://github.com/rj-liukaiwen/OpenMausBot/releases/download/browser-engine-v0.36.0-omb.2/${name}`;
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Browser vendor download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(bytes.length, 6039074);
assert.equal(createHash('sha256').update(bytes).digest('hex'), '2b1640d48881b98d4a97f674b8ec9618fb26abf07097d69ce5735d2022639db7');
const directory = path.resolve('dist-native/browser-vendor');
mkdirSync(directory, { recursive: true });
const archive = path.resolve('dist-native', name);
writeFileSync(archive, bytes);
// Expand only the exact, owner-provided and hash-pinned archive.
execFileSync('tar.exe', ['-xf', archive, '-C', directory], { stdio: 'inherit', windowsHide: true });
console.log('Verified and extracted pinned Windows browser vendor. Build preparation also validates provenance and patches.');
