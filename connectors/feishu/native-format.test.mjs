import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { extractPinnedTarExecutable, nativeExecutable } from './native-format.mjs';

function binary(arch) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4);
  bytes.writeUInt32LE(2, 12); return bytes;
}
function archive(entries) {
  const parts = [];
  for (const [name, bytes, type = '0'] of entries) {
    const header = Buffer.alloc(512);
    header.write(name); header.write(bytes.length.toString(8).padStart(11, '0'), 124);
    header.write(type, 156); header.fill(32, 148, 156);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
for (const arch of ['arm64', 'x64']) test(`Mac ${arch}: exact regular executable only`, () => {
  const bytes = binary(arch), hash = createHash('sha256').update(bytes).digest('hex');
  const read = (entries) => extractPinnedTarExecutable(archive(entries), 'lark-cli', hash, 'darwin', arch);
  assert.deepEqual(read([['lark-cli', bytes]]), bytes);
  assert.equal(nativeExecutable(bytes, 'darwin', arch === 'arm64' ? 'x64' : 'arm64'), false);
  assert.throws(() => read([['lark-cli', bytes, '2']]), /INVALID_ARCHIVE/);
  assert.throws(() => read([['lark-cli', bytes], ['lark-cli', bytes]]), /INVALID_ARCHIVE/);
  assert.throws(() => read([['../lark-cli', bytes]]), /INVALID_ARCHIVE/);
  assert.throws(() => read([['pax', Buffer.alloc(0), 'x'], ['lark-cli', bytes]]), /INVALID_ARCHIVE/);
  assert.throws(() => read([['lark-cli', Buffer.from('not executable')]]), /CHECKSUM_MISMATCH/);
  const dylib = Buffer.from(bytes); dylib.writeUInt32LE(6, 12);
  assert.equal(nativeExecutable(dylib, 'darwin', arch), false);
});
