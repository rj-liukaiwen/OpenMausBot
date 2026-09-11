import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRuntimeProvisionerForTest, validateApprovedArtifacts } from './runtime.mjs';
import { runtimeArtifacts } from './runtime-artifacts.mjs';
import { readFile } from 'node:fs/promises';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const arch of ['arm64', 'x64']) test(`Mac ${arch} uses its own bundled binaries without PATH or downloads`, async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'feishu-mac-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const artifacts = structuredClone(runtimeArtifacts('darwin', arch));
  const bundledRoot = path.join(base, 'bundle');
  for (const kind of ['cli', 'node']) {
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'arm64' ? 0x100000c : 0x1000007, 4);
    bytes.writeUInt32LE(2, 12);
    artifacts[kind].executableSha256 = hash(bytes);
    const directory = path.join(bundledRoot, artifacts[kind].directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, artifacts[kind].name), bytes, { mode: 0o755 });
  }
  const calls = [];
  const options = { root: path.join(base, 'private'), bundledRoot, env: {},
    fetchImpl: () => assert.fail('Packaged first connection must not download'),
    spawnImpl(file, args, spawnOptions) {
      calls.push(file); assert.deepEqual(args, ['--version']); assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.windowsHide, true);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      queueMicrotask(() => { child.stdout.end(path.basename(file) === 'node' ? 'v24.15.0\n' : 'lark-cli version 1.0.93\n'); child.emit('close', 0); });
      return child;
    },
  };
  const fixture = { platform: 'darwin', arch, artifacts };
  const prepared = await createRuntimeProvisionerForTest(options, fixture)();
  assert.equal(prepared.nodePath, path.join(bundledRoot, artifacts.node.directory, 'node'));
  assert.equal(prepared.cliPath, path.join(bundledRoot, artifacts.cli.directory, 'lark-cli'));
  assert.equal(prepared.configDir, path.join(base, 'private', 'context'));
  const cliPath = prepared.cliPath;
  await writeFile(cliPath, Buffer.from('corrupt'));
  await assert.rejects(createRuntimeProvisionerForTest(options, fixture)(), /CHECKSUM_MISMATCH/);
  assert.equal(calls.length, 2, 'Corrupted packaged bytes must never spawn or fall back');
  await rm(cliPath);
  await assert.rejects(createRuntimeProvisionerForTest(options, fixture)(), /BUNDLED_RUNTIME_MISSING/);
});

test('Windows exact-artifact licensing cannot silently approve either Mac artifact set', async () => {
  const windows = JSON.parse(await readFile(new URL('./licenses/manifest.json', import.meta.url), 'utf8'));
  for (const arch of ['arm64', 'x64']) {
    assert.throws(() => validateApprovedArtifacts(windows, runtimeArtifacts('darwin', arch)), /LICENSE_REVIEW_REQUIRED/);
  }
});
