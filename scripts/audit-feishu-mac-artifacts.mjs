// Read-only release/license evidence collection. Never executes downloaded
// code, installs a runtime, creates credentials, or approves a release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runtimeArtifacts } from '../connectors/feishu/runtime-artifacts.mjs';
import { extractPinnedTarExecutable, readPinnedTarMember } from '../connectors/feishu/native-format.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function readUrl(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  assert(response.ok, `Official artifact unavailable: HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; assert(size <= maxBytes, 'Artifact size limit'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function goBuildInfo(bytes) {
  const at = bytes.indexOf(Buffer.from('\xff Go buildinf:', 'latin1'));
  assert(at >= 0 && (bytes[at + 15] & 2), 'Expected inline Go build information');
  const str = (offset) => {
    let size = 0, shift = 0, value;
    do { value = bytes[offset++]; assert(shift <= 28 && value !== undefined); size += (value & 127) * 2 ** shift; shift += 7; } while (value & 128);
    assert(size <= 1024 * 1024 && offset + size <= bytes.length);
    return { value: bytes.subarray(offset, offset + size), next: offset + size };
  };
  const version = str(at + 32), info = str(version.next).value;
  return { compiler: version.value.toString(), lines: info.subarray(16, info.length - 16).toString().split('\n') };
}
function libraries(bytes) {
  const result = [];
  const commands = bytes.readUInt32LE(16);
  let offset = 32;
  for (let i = 0; i < commands; i++) {
    const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    assert(size >= 8 && offset + size <= bytes.length);
    if ([12, 0x80000018, 0x8000001f, 0x80000023].includes(command)) {
      const name = bytes.readUInt32LE(offset + 8);
      assert(name >= 12 && name < size);
      result.push(bytes.subarray(offset + name, offset + size).toString().split('\0')[0]);
    }
    offset += size;
  }
  return result;
}
const components = JSON.parse(await readFile(new URL('../connectors/feishu/licenses/components.json', import.meta.url), 'utf8'));
const known = new Map(components.goModules.map((entry) => [entry.module, entry]));
const amaro = await readUrl('https://raw.githubusercontent.com/nodejs/node/v24.15.0/deps/amaro/dist/index.js', 8 * 1024 * 1024);
const wasm = [...amaro.toString().matchAll(/[A-Za-z0-9+/]{10000,}={0,2}/g)]
  .map(([value]) => ({ text: value, bytes: Buffer.from(value, 'base64') }))
  .find((entry) => entry.bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
assert(wasm && hash(wasm.bytes) === '2c8132e2c965a6a10024bf83dcee287fe15a0cb90f987394d1f9f3d68053a851');
console.log(JSON.stringify({ source: 'Node v24.15.0 Amaro', wasmSha256: hash(wasm.bytes), bytes: wasm.bytes.length }));
for (const arch of ['arm64', 'x64']) {
  const artifacts = runtimeArtifacts('darwin', arch);
  for (const kind of ['cli', 'node']) {
    const artifact = artifacts[kind];
    const archive = await readUrl(artifact.url, artifact.maxBytes);
    assert.equal(hash(archive), artifact.sha256);
    const bytes = extractPinnedTarExecutable(archive, artifact.member, artifact.executableSha256, 'darwin', arch);
    const linked = libraries(bytes);
    const report = { target: `darwin-${arch}`, kind, archiveSha256: hash(archive), executableSha256: hash(bytes), executableBytes: bytes.length,
      dylibs: linked, onlySystemDylibs: linked.every((name) => name.startsWith('/usr/lib/') || name.startsWith('/System/Library/')) };
    if (kind === 'cli') {
      const info = goBuildInfo(bytes);
      const modules = info.lines.filter((line) => line.startsWith('dep\t')).map((line) => {
        const [, module, version, sum] = line.split('\t'); return { module, version, sum };
      });
      Object.assign(report, { compiler: info.compiler, modules: modules.length,
        build: info.lines.filter((line) => line.startsWith('build\t')),
        unreviewedModules: modules.filter((entry) => known.get(entry.module)?.version !== entry.version || known.get(entry.module)?.sum !== entry.sum),
        rootLicenseSha256: hash(readPinnedTarMember(archive, 'LICENSE', artifact.license.sha256)) });
    } else {
      const license = readPinnedTarMember(archive, `node-v24.15.0-darwin-${arch}/LICENSE`, artifact.license.sha256);
      Object.assign(report, { rootLicenseSha256: hash(license), wasmBase64VisibleInBinary: bytes.includes(Buffer.from(wasm.text)),
        wasmBytesVisibleInBinary: bytes.includes(wasm.bytes) });
    }
    console.log(JSON.stringify(report));
  }
}
