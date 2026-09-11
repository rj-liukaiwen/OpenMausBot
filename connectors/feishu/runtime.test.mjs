import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, link, utimes, rename, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createRuntimeProvisioner, createRuntimeProvisionerForTest, createRecoveryContext } from './runtime.mjs';
import { ARTIFACTS, NOTICE } from './runtime-artifacts.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fileSymlink(t, target, destination) {
  try { await symlink(target, destination, 'file'); return true; }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows file symlink privilege unavailable; native file-link case not verified');
    return false;
  }
}

function pe(label = 'cli', machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(2, 86);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.write(label, 128);
  return bytes;
}

// ZIP fixtures include real CRCs, local headers and central entries. Mutations
// get their own outer pin so rejection exercises archive validation, not SHA.
function zip(entries = [{ name: 'lark-cli.exe', bytes: pe() }]) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const { name, bytes = pe(), flags = 0, mode = 0x81ed, method = 8, extra = Buffer.alloc(0) } = entry;
    const filename = Buffer.from(name);
    const data = method === 0 ? bytes : deflateRawSync(bytes);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(entry.size ?? bytes.length, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(flags & 8 ? 16 : 0);
    if (flags & 8) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(entry.size ?? bytes.length, 12);
    }
    locals.push(local, filename, extra, data, descriptor);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(entry.size ?? bytes.length, 24);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, filename, extra);
    offset += local.length + filename.length + extra.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function fixture(t, overrides = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'feishu-runtime-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'TuanTuan', 'feishu');
  const cli = pe();
  const node = pe('node');
  const cliZip = overrides.cliZip ?? zip();
  const cliLicense = Buffer.from('CLI fixture MIT license\n');
  const nodeLicense = Buffer.from('Node fixture license with third-party notices\n');
  const artifacts = {
    cli: { ...ARTIFACTS.cli, sha256: digest(cliZip), executableSha256: digest(cli),
      license: { ...ARTIFACTS.cli.license, sha256: digest(cliLicense) } },
    node: { ...ARTIFACTS.node, sha256: digest(node), executableSha256: digest(node),
      license: { ...ARTIFACTS.node.license, sha256: digest(nodeLicense) } },
  };
  const bodies = new Map([[artifacts.cli.url, cliZip], [artifacts.node.url, node],
    [artifacts.cli.license.url, cliLicense], [artifacts.node.license.url, nodeLicense]]);
  const licensesRoot = path.join(base, 'licenses');
  await mkdir(licensesRoot);
  const notices = new Map([
    ['NODE_LICENSE.txt', nodeLicense],
    ['CLI_THIRD_PARTY_NOTICES.txt', Buffer.from('Full CLI fixture third-party notices\n')],
    ['SOURCE_AVAILABILITY.txt', Buffer.from('Fixture source availability and MPL terms\n')],
    ['MPL-2.0.txt', Buffer.from('Fixture MPL terms\n')],
    ['sources/smartstring-1.0.1.crate', Buffer.from('Fixture unmodified smartstring sources\n')],
    ['sources/node-v24.15.0-certdata.txt', Buffer.from('Fixture unmodified NSS sources\n')],
  ]);
  const manifest = {
    schemaVersion: 1, policyException: { approved: true, copyleftExceptionGranted: true, copyleftExceptions: [
      { artifact: 'node', executableSha256: artifacts.node.executableSha256, component: 'smartstring',
        version: '1.0.1', license: 'MPL-2.0+', sourcePath: 'sources/smartstring-1.0.1.crate' },
      { artifact: 'node', executableSha256: artifacts.node.executableSha256, component: 'NSS-derived root certificate data',
        version: 'Node v24.15.0 tagged certdata and generated header', license: 'MPL-2.0', sourcePath: 'sources/node-v24.15.0-certdata.txt' },
    ] }, releaseApproved: true,
    sourceAvailability: { instructions: 'SOURCE_AVAILABILITY.txt', license: 'MPL-2.0.txt',
      sources: [...notices].filter(([name]) => name.startsWith('sources/')).map(([name, bytes]) => ({ path: name, sha256: digest(bytes) })) },
    artifacts: {
      cli: { version: artifacts.cli.version, platform: 'windows-amd64',
        archiveSha256: artifacts.cli.sha256, executableSha256: artifacts.cli.executableSha256,
        noticeFiles: ['CLI_THIRD_PARTY_NOTICES.txt'] },
      node: { version: artifacts.node.version, platform: 'win32-x64',
        executableSha256: artifacts.node.executableSha256,
        noticeFiles: [...notices.keys()].filter((name) => name !== 'CLI_THIRD_PARTY_NOTICES.txt') },
    },
    files: [...notices].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: digest(bytes) })),
  };
  const saveManifest = () => writeFile(path.join(licensesRoot, 'manifest.json'), JSON.stringify(manifest));
  await saveManifest();
  for (const [name, bytes] of notices) {
    await mkdir(path.dirname(path.join(licensesRoot, name)), { recursive: true });
    await writeFile(path.join(licensesRoot, name), bytes);
  }
  const requests = [];
  const calls = [];
  const phases = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'manual');
    assert.equal(new URL(url).protocol, 'https:');
    const body = bodies.get(url);
    assert.ok(body, `Unexpected URL ${url}`);
    return new Response(body);
  };
  const spawnImpl = (file, args, options) => {
    assert.deepEqual(args, ['--version']);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.LARKSUITE_CLI_REMOTE_META, 'off');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.kill = (signal) => { child.kills.push(signal); return true; };
    calls.push({ file, args, options, child });
    queueMicrotask(() => {
      if (overrides.behavior) { overrides.behavior(child, file); return; }
      child.stdout.write(path.basename(file) === 'node.exe' ? 'v24.15.0\n' : 'lark-cli version 1.0.93\n');
      child.emit('close', 0);
    });
    return child;
  };
  const options = { root, env: {}, fetchImpl, spawnImpl, ...overrides.options };
  const settings = { platform: 'win32', arch: 'x64', artifacts, licensesRoot, ...overrides.settings };
  const prepare = createRuntimeProvisionerForTest(options, settings);
  return { base, root, artifacts, bodies, requests, calls, phases, options, settings, bytes: { cli, node },
    licensesRoot, manifest, notices, saveManifest,
    prepare: (args = {}) => prepare({ onPhase: (phase) => phases.push(phase), ...args }),
    native: async (kind, directory = path.join(base, 'native')) => {
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, artifacts[kind].name);
      await writeFile(file, kind === 'cli' ? cli : node);
      return file;
    } };
}

async function noStaging(f) {
  let files;
  try { files = await readdir(path.join(f.root, 'runtime')); }
  catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
  assert.ok(files.every((name) => !name.startsWith('.stage-') && name !== '.provision-lock'), files.join(','));
}

test('a packaged runtime is verified and used without network access', async (t) => {
  const f = await fixture(t);
  const bundledRoot = path.join(f.base, 'packaged-runtime');
  for (const kind of ['cli', 'node']) {
    const artifact = f.artifacts[kind];
    const directory = path.join(bundledRoot, artifact.directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, artifact.name), f.bytes[kind]);
  }
  const prepare = createRuntimeProvisionerForTest({ ...f.options, bundledRoot }, f.settings);
  const result = await prepare();
  assert.equal(result.cliPath, path.join(bundledRoot, f.artifacts.cli.directory, f.artifacts.cli.name));
  assert.equal(result.nodePath, path.join(bundledRoot, f.artifacts.node.directory, f.artifacts.node.name));
  assert.equal(f.requests.length, 0);
});

test('replacement context is host-owned, private and reusable without changing old app files', async (t) => {
  const f = await fixture(t);
  const oldContext = path.join(f.root, 'context');
  await mkdir(oldContext, { recursive: true });
  await writeFile(path.join(oldContext, 'config.json'), 'old-app-fixture');
  const candidate = await createRecoveryContext({ root: f.root });
  assert.equal(path.basename(candidate), 'context');
  assert.equal(path.dirname(path.dirname(candidate)), path.join(f.root, 'recovery'));
  assert.deepEqual(await readdir(candidate), []);
  const prepared = await f.prepare({ existing: { configDir: candidate } });
  assert.equal(prepared.configDir, candidate);
  assert.equal(await readFile(path.join(oldContext, 'config.json'), 'utf8'), 'old-app-fixture');
  assert.deepEqual(await f.prepare({ existing: prepared }), prepared);
  await writeFile(path.join(path.dirname(candidate), '.owner'), '{"owner":"foreign"}');
  await assert.rejects(f.prepare({ existing: prepared }), /INVALID_CONFIG_DIR/);
});

test('recovery never accepts an unowned path or junction and pre-cancel does not create state', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createRecoveryContext({ root: f.root, signal: AbortSignal.abort() }), /ABORTED/);
  await assert.rejects(lstat(f.root), { code: 'ENOENT' });
  const candidate = await createRecoveryContext({ root: f.root });
  const outside = path.join(f.base, 'outside');
  await mkdir(outside);
  await rm(candidate, { recursive: true });
  await symlink(outside, candidate, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.prepare({ existing: { configDir: candidate } }), /UNSAFE_PATH/);
  assert.deepEqual(await readdir(outside), []);
});

test('requires an absolute host-owned root', () => {
  assert.throws(() => createRuntimeProvisioner({ root: 'relative' }), /INVALID_ROOT/);
  assert.throws(() => createRuntimeProvisioner({ root: '/' }), /INVALID_ROOT/);
  assert.throws(() => createRuntimeProvisioner({ root: '/safe/../other' }), /INVALID_ROOT/);
  assert.throws(() => createRuntimeProvisioner({ root: '/safe/root/' }), /INVALID_ROOT/);
});

test('unapproved manifest blocks automatic downloads without touching the private root', async (t) => {
  const f = await fixture(t);
  f.manifest.releaseApproved = false;
  await f.saveManifest();
  await assert.rejects(f.prepare(), { code: 'LICENSE_REVIEW_REQUIRED', message: 'LICENSE_REVIEW_REQUIRED' });
  assert.equal(f.requests.length + f.calls.length, 0);
  await assert.rejects(lstat(f.root), { code: 'ENOENT' });
});

test('GPL, AGPL and SSPL review denials use the safe license error and cannot be overridden by prepare options', async (t) => {
  for (const license of ['GPL-3.0', 'AGPL-3.0', 'SSPL-1.0']) {
    const f = await fixture(t);
    f.manifest.releaseApproved = false;
    f.manifest.blockers = [`${license}: private review evidence at ${f.base}`];
    await f.saveManifest();
    await assert.rejects(f.prepare({ releaseApproved: true, skipLicenseCheck: true,
      manifest: { ...f.manifest, releaseApproved: true } }), {
      code: 'LICENSE_REVIEW_REQUIRED', message: 'LICENSE_REVIEW_REQUIRED',
    });
    assert.equal(f.requests.length + f.calls.length, 0);
    await assert.rejects(lstat(f.root), { code: 'ENOENT' });
  }
});

test('new user installs privately, retains licenses, returns context, and verifies caches on every connect', async (t) => {
  const f = await fixture(t);
  const result = await f.prepare();
  assert.deepEqual(result, {
    cliPath: path.join(f.root, 'runtime', f.artifacts.cli.directory, 'lark-cli.exe'),
    nodePath: path.join(f.root, 'runtime', f.artifacts.node.directory, 'node.exe'),
    configDir: path.join(f.root, 'context'),
  });
  assert.equal(f.requests.length, 4);
  assert.deepEqual(await readdir(result.configDir), []);
  for (const kind of ['cli', 'node']) {
    const directory = path.dirname(result[`${kind}Path`]);
    assert.equal(digest(await readFile(result[`${kind}Path`])), f.artifacts[kind].executableSha256);
    assert.equal(digest(await readFile(path.join(directory, 'LICENSE'))), f.artifacts[kind].license.sha256);
    assert.equal(await readFile(path.join(directory, 'NOTICE'), 'utf8'), NOTICE);
    for (const name of f.manifest.artifacts[kind].noticeFiles) {
      const installed = await readFile(path.join(directory, 'licenses', name));
      const expected = f.manifest.files.find((file) => file.path === name);
      assert.equal(installed.length, expected.bytes);
      assert.equal(digest(installed), expected.sha256);
    }
    if (process.platform !== 'win32') assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  }
  assert.ok(f.phases.includes('detecting'));
  assert.ok(f.phases.includes('downloadingCli'));
  assert.ok(f.phases.includes('downloadingNode'));
  assert.equal(f.phases.at(-1), 'verifyingRuntime');
  assert.deepEqual(await f.prepare({ existing: result }), result);
  assert.equal(f.requests.length, 4);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.slice(2).map(({ file }) => file), [result.cliPath, result.nodePath]);
  await noStaging(f);
});

test('saved native runtime preserves native config without even creating root', async (t) => {
  const f = await fixture(t);
  await rm(f.licensesRoot, { recursive: true });
  const cliPath = await f.native('cli');
  const nodePath = await f.native('node');
  const snapshot = await readFile(cliPath);
  const existing = { cliPath, nodePath, appId: 'cli_saved', ownerOpenId: 'ou_saved' };
  assert.deepEqual(await f.prepare({ existing }), { cliPath, nodePath });
  assert.deepEqual(await f.prepare({ existing: { cliPath, nodePath } }), { cliPath, nodePath });
  assert.equal(f.requests.length, 0);
  await assert.rejects(lstat(f.root), { code: 'ENOENT' });
  assert.deepEqual(await readFile(cliPath), snapshot);
});

test('new users with compatible native runtimes still get a dedicated empty context', async (t) => {
  const env = {};
  const f = await fixture(t, { options: { env }, behavior: (child, file) => {
    child.stdout.write(path.basename(file) === 'node.exe' ? 'v25.1.0\n' : 'lark-cli version 1.0.93\n');
    child.emit('close', 0);
  } });
  const cliPath = await f.native('cli');
  const nodePath = await f.native('node');
  env.PATH = path.dirname(cliPath);
  assert.deepEqual(await f.prepare(), { cliPath, nodePath, configDir: path.join(f.root, 'context') });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await readdir(path.join(f.root, 'context')), []);
  await assert.rejects(lstat(path.join(f.root, 'runtime')), { code: 'ENOENT' });
});

test('finds only absolute native PATH entries including npm-adjacent bin, never runs wrappers', async (t) => {
  const env = { PATH: '', NODE_OPTIONS: '--require=bad', NODE_PATH: 'bad', ELECTRON_RUN_AS_NODE: '1',
    LARKSUITE_CLI_CONFIG_DIR: '/other', OPENCLAW_HOME: '/other', LD_PRELOAD: 'bad',
    LARKSUITE_CLI_REMOTE_META: 'on', larksuite_cli_remote_meta: 'on',
    COMSPEC: 'bad', HOME: '/trusted-home', SystemRoot: 'C:\\Windows' };
  const f = await fixture(t, { options: { env } });
  const npm = path.join(f.base, 'npm');
  const cliPath = await f.native('cli', path.join(npm, 'node_modules', '@larksuite', 'cli', 'bin'));
  const nodePath = await f.native('node', npm);
  await writeFile(path.join(npm, 'lark-cli.cmd'), '@evil');
  await writeFile(path.join(npm, 'lark-cli.exe'), '#!/bin/sh\nevil');
  env.PATH = `;relative;${npm}`;
  assert.deepEqual(await f.prepare({ existing: { appId: 'cli_saved' } }), { cliPath, nodePath });
  assert.deepEqual(f.calls.map(({ file }) => file), [cliPath, nodePath]);
  assert.deepEqual(f.calls[0].options.env, { HOME: '/trusted-home', SYSTEMROOT: 'C:\\Windows',
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    LARKSUITE_CLI_REMOTE_META: 'off' });
  assert.equal(env.NODE_OPTIONS, '--require=bad');
  assert.equal(env.LARKSUITE_CLI_REMOTE_META, 'on');
  assert.equal(env.larksuite_cli_remote_meta, 'on');
  assert.equal(f.requests.length, 0);
});

test('saved app stays native when missing or incompatible binaries require private replacements', async (t) => {
  const f = await fixture(t, { behavior: (child, file) => {
    const native = file.includes(`${path.sep}native${path.sep}`);
    child.stdout.write(path.basename(file) === 'node.exe' ? (native ? 'v23.9.0' : 'v24.15.0') :
      native ? 'lark-cli version 1.0.92' : 'lark-cli version 1.0.93');
    child.emit('close', 0);
  } });
  const cliPath = await f.native('cli');
  const nodePath = await f.native('node');
  const result = await f.prepare({ existing: { cliPath, nodePath, appId: 'cli_saved' } });
  assert.equal(result.configDir, undefined);
  assert.notEqual(result.cliPath, cliPath);
  assert.notEqual(result.nodePath, nodePath);
  assert.deepEqual(await readFile(cliPath), pe());
  await assert.rejects(lstat(path.join(f.root, 'context')), { code: 'ENOENT' });
});

test('only exact managed context is accepted and existing contents are not initialized', async (t) => {
  const f = await fixture(t);
  for (const configDir of [null, '', '/native-config', `${f.root}/context/`, `${f.root}/x/../context`]) {
    await assert.rejects(f.prepare({ existing: { configDir } }), /INVALID_CONFIG_DIR/);
  }
  assert.equal(f.calls.length + f.requests.length, 0);
  const context = path.join(f.root, 'context');
  await mkdir(context, { recursive: true, mode: 0o700 });
  await writeFile(path.join(context, 'config.json'), 'untouched credentials');
  const result = await f.prepare({ existing: { configDir: context, appId: 'cli_managed' } });
  assert.equal(result.configDir, context);
  assert.equal(await readFile(path.join(context, 'config.json'), 'utf8'), 'untouched credentials');
});

test('cached corrupt owned binary is repaired, never executed, and unrelated files survive', async (t) => {
  const f = await fixture(t);
  const result = await f.prepare();
  const unrelated = path.join(path.dirname(result.cliPath), 'user-notes.txt');
  await writeFile(unrelated, 'keep me');
  await writeFile(result.cliPath, pe('tampered'));
  f.calls.length = 0;
  assert.deepEqual(await f.prepare({ existing: result }), result);
  assert.equal(f.requests.length, 6);
  assert.ok(f.calls[0].file.includes('.stage-'));
  assert.equal(await readFile(unrelated, 'utf8'), 'keep me');
  assert.equal(digest(await readFile(result.cliPath)), f.artifacts.cli.executableSha256);
  await noStaging(f);
});

test('missing or corrupt cached license is repaired before returning', async (t) => {
  const f = await fixture(t);
  const result = await f.prepare();
  await rm(path.join(path.dirname(result.nodePath), 'LICENSE'));
  assert.deepEqual(await f.prepare({ existing: result }), result);
  assert.equal(f.requests.length, 6);
  assert.equal(digest(await readFile(path.join(path.dirname(result.nodePath), 'LICENSE'))), f.artifacts.node.license.sha256);
});

test('missing and tampered installed notices and source availability are repaired only in owned caches', async (t) => {
  const f = await fixture(t);
  const result = await f.prepare();
  const directory = path.dirname(result.nodePath);
  const unrelated = path.join(directory, 'licenses', 'user-notes.txt');
  await writeFile(unrelated, 'keep');
  for (const name of f.manifest.artifacts.node.noticeFiles) {
    const file = path.join(directory, 'licenses', name);
    for (const tamper of ['missing', 'same-size', 'oversized']) {
      if (tamper === 'missing') await rm(file);
      else await writeFile(file, Buffer.alloc(f.notices.get(name).length + (tamper === 'oversized' ? 1 : 0)));
      f.calls.length = 0;
      const requests = f.requests.length;
      assert.deepEqual(await f.prepare({ existing: result }), result);
      assert.equal(f.requests.length, requests + 2);
      assert.ok(f.calls.filter(({ file }) => path.basename(file) === 'node.exe').every(({ file }) => file.includes('.stage-')));
      assert.equal(digest(await readFile(file)), digest(f.notices.get(name)));
      assert.equal(await readFile(unrelated, 'utf8'), 'keep');
    }
  }
  await writeFile(path.join(directory, '.owner'), 'unowned');
  const source = path.join(directory, 'licenses', 'SOURCE_AVAILABILITY.txt');
  await writeFile(source, 'user file');
  const requests = f.requests.length;
  await assert.rejects(f.prepare({ existing: result }), /UNOWNED_RUNTIME/);
  assert.equal(f.requests.length, requests);
  assert.equal(await readFile(source, 'utf8'), 'user file');
  await noStaging(f);
});

test('unsafe installed notice links fail without overwriting their targets', async (t) => {
  for (const type of ['symlink', 'hardlink', 'directory']) {
    await t.test(type, async (t) => {
      const f = await fixture(t);
      const result = await f.prepare();
      const directory = path.join(path.dirname(result.nodePath), 'licenses');
      const notice = path.join(directory, 'SOURCE_AVAILABILITY.txt');
      const outside = path.join(f.base, 'outside');
      await mkdir(outside);
      const target = path.join(outside, 'source.txt');
      await writeFile(target, 'user file');
      if (type === 'directory') {
        await rm(directory, { recursive: true });
        await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await rm(notice);
        if (type === 'symlink') {
          if (!await fileSymlink(t, target, notice)) return;
        } else await link(target, notice);
      }
      const requests = f.requests.length;
      await assert.rejects(f.prepare({ existing: result }), /UNSAFE_PATH/);
      assert.equal(f.requests.length, requests);
      assert.equal(await readFile(target, 'utf8'), 'user file');
      await noStaging(f);
    });
  }
});

test('every prepare rechecks packaged policy and notice bytes before downloading or executing owned binaries', async (t) => {
  for (const failure of ['approval', 'policy', 'missing', 'corrupt', 'oversized', 'size', 'hash', 'invalid-json', 'manifest-missing']) {
    const f = await fixture(t);
    const result = await f.prepare();
    if (failure === 'approval') f.manifest.releaseApproved = false;
    if (failure === 'policy') f.manifest.policyException.approved = false;
    if (failure === 'size') f.manifest.files[0].bytes++;
    if (failure === 'hash') f.manifest.files[0].sha256 = '0'.repeat(64);
    await f.saveManifest();
    const source = path.join(f.licensesRoot, 'SOURCE_AVAILABILITY.txt');
    if (failure === 'missing') await rm(source);
    if (failure === 'corrupt') await writeFile(source, Buffer.alloc(f.notices.get('SOURCE_AVAILABILITY.txt').length));
    if (failure === 'oversized') await writeFile(source, Buffer.alloc(1024));
    if (failure === 'invalid-json') await writeFile(path.join(f.licensesRoot, 'manifest.json'), 'private invalid JSON');
    if (failure === 'manifest-missing') await rm(path.join(f.licensesRoot, 'manifest.json'));
    f.requests.length = f.calls.length = 0;
    await assert.rejects(f.prepare({ existing: result }), { code: 'LICENSE_REVIEW_REQUIRED', message: 'LICENSE_REVIEW_REQUIRED' });
    assert.equal(f.requests.length + f.calls.length, 0);
    await noStaging(f);
  }
});

test('a bad Node manifest blocks the first CLI download too, but unused native artifacts need no notices', async (t) => {
  const f = await fixture(t);
  f.manifest.artifacts.node.version = '24.99.0';
  await f.saveManifest();
  await assert.rejects(f.prepare(), /LICENSE_REVIEW_REQUIRED/);
  assert.equal(f.requests.length + f.calls.length, 0);
  const nodePath = await f.native('node');
  const result = await f.prepare({ existing: { nodePath } });
  assert.equal(result.nodePath, nodePath);
  assert.equal(f.requests.length, 2);
});

test('unowned install directory is never overwritten or deleted', async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, 'runtime', f.artifacts.cli.directory);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await writeFile(path.join(destination, 'lark-cli.exe'), 'user file');
  await assert.rejects(f.prepare(), /UNOWNED_RUNTIME/);
  assert.equal(await readFile(path.join(destination, 'lark-cli.exe'), 'utf8'), 'user file');
  assert.equal(f.requests.length, 0);
  await noStaging(f);
});

test('bad checksums, truncated streams and missing licenses never produce a ready runtime', async (t) => {
  for (const failure of ['archive', 'member', 'node', 'license', 'truncated']) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      if (failure === 'member') {
        f.settings.artifacts.cli.executableSha256 = '0'.repeat(64);
        f.manifest.artifacts.cli.executableSha256 = '0'.repeat(64);
        await f.saveManifest();
      }
      else if (failure === 'truncated') {
        f.options.fetchImpl = async () => new Response('short', { headers: { 'content-length': '10' } });
      } else {
        const url = failure === 'archive' ? f.artifacts.cli.url : failure === 'node' ? f.artifacts.node.url : f.artifacts.cli.license.url;
        f.bodies.set(url, Buffer.from('corrupt'));
      }
      const prepare = createRuntimeProvisionerForTest(f.options, f.settings);
      await assert.rejects(prepare(), failure === 'truncated' ? /DOWNLOAD_TRUNCATED/ : /CHECKSUM_MISMATCH/);
      await assert.rejects(lstat(path.join(f.root, 'context')), { code: 'ENOENT' });
      assert.ok(f.calls.length <= (failure === 'node' ? 1 : 0));
      await noStaging(f);
    });
  }
});

test('ZIP accepts descriptors but rejects unsafe members and unsupported archive formats', async (t) => {
  await t.test('official-style descriptor ZIP', async (t) => {
    const f = await fixture(t, { cliZip: zip([{ name: 'LICENSE', bytes: Buffer.from('ignored'), flags: 8 },
      { name: 'lark-cli.exe', flags: 8 }]) });
    assert.ok((await f.prepare()).cliPath);
  });
  for (const [name, entries] of [
    ['traversal', [{ name: '../outside.exe' }, { name: 'lark-cli.exe' }]],
    ['absolute', [{ name: '/lark-cli.exe' }]],
    ['backslash', [{ name: 'windows\\lark-cli.exe' }]],
    ['wrong member', [{ name: 'windows/lark-cli.exe' }]],
    ['duplicate', [{ name: 'lark-cli.exe' }, { name: 'lark-cli.exe' }]],
    ['case duplicate', [{ name: 'lark-cli.exe' }, { name: 'LARK-CLI.EXE' }]],
    ['symlink', [{ name: 'lark-cli.exe', mode: 0xa1ff }]],
    ['encrypted', [{ name: 'lark-cli.exe', flags: 1 }]],
    ['zip64', [{ name: 'lark-cli.exe', extra: Buffer.from([1, 0, 0, 0]) }]],
    ['unsupported compression', [{ name: 'lark-cli.exe', method: 12 }]],
    ['oversized output', [{ name: 'lark-cli.exe', size: 100 * 1024 * 1024 + 1 }]],
    ['deflate bomb bound', [{ name: 'lark-cli.exe', size: 1 }]],
    ['wrong arch', [{ name: 'lark-cli.exe', bytes: pe('cli', 0xaa64) }]],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, { cliZip: zip(entries) });
      if (name === 'wrong arch') {
        f.artifacts.cli.executableSha256 = digest(pe('cli', 0xaa64));
        f.manifest.artifacts.cli.executableSha256 = f.artifacts.cli.executableSha256;
        await f.saveManifest();
      }
      await assert.rejects(f.prepare());
      assert.equal(f.calls.length, 0);
      await noStaging(f);
    });
  }
  for (const mutate of [
    (bytes) => bytes.subarray(0, 12),
    (bytes) => { bytes.writeUInt16LE(1, bytes.length - 18); return bytes; },
    (bytes) => { bytes[30] = 120; return bytes; },
    (bytes) => { bytes.writeUInt32LE(0xffffffff, bytes.length - 6); return bytes; },
  ]) {
    const f = await fixture(t, { cliZip: mutate(zip()) });
    await assert.rejects(f.prepare());
    await noStaging(f);
  }
});

test('every redirect is HTTPS and exact-host validated; redirects are bounded', async (t) => {
  for (const target of ['http://github.com/file', 'https://github.com.evil.test/file',
    'https://evil.test/file', 'https://nodejs.org:444/file', 'https://user@nodejs.org/file',
    'https://raw.githubusercontent.com/evil/LICENSE']) {
    const f = await fixture(t);
    let requests = 0;
    f.options.fetchImpl = async () => { requests++; return new Response(null, { status: 302, headers: { location: target } }); };
    await assert.rejects(createRuntimeProvisionerForTest(f.options, f.settings)(), /UNSAFE_DOWNLOAD_URL/);
    assert.equal(requests, 1);
    await noStaging(f);
  }
  const f = await fixture(t);
  let redirects = 0;
  f.options.fetchImpl = async () => { redirects++; return new Response(null, { status: 302,
    headers: { location: 'https://release-assets.githubusercontent.com/loop' } }); };
  await assert.rejects(createRuntimeProvisionerForTest(f.options, f.settings)(), /REDIRECT_LIMIT/);
  assert.equal(redirects, 4);
});

test('official release asset redirect works without leaking environment or credentials', async (t) => {
  const f = await fixture(t);
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => {
    assert.equal(options.credentials, 'omit');
    if (url === f.artifacts.cli.url) return new Response(null, { status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/release?signature=opaque' } });
    if (url.startsWith('https://release-assets.githubusercontent.com/')) return new Response(f.bodies.get(f.artifacts.cli.url));
    return fetchImpl(url, options);
  };
  assert.ok((await createRuntimeProvisionerForTest(f.options, f.settings)()).cliPath);
});

test('oversized Content-Length and streamed payloads are bounded', async (t) => {
  for (const header of [true, false]) {
    const f = await fixture(t);
    f.artifacts.cli.maxBytes = 20;
    f.options.fetchImpl = async () => new Response(new Uint8Array(21), {
      headers: header ? { 'content-length': '104857601' } : {},
    });
    await assert.rejects(createRuntimeProvisionerForTest(f.options, f.settings)(), /SIZE_LIMIT/);
    assert.equal(f.calls.length, 0);
    await noStaging(f);
  }
});

test('pre-cancellation has no side effects and download/body stalls time out', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.prepare({ signal: AbortSignal.abort() }), /ABORTED/);
  assert.equal(f.phases.length + f.requests.length + f.calls.length, 0);
  for (const body of [false, true]) {
    f.options.fetchImpl = body ? async () => new Response(new ReadableStream({ start() {} })) : () => new Promise(() => {});
    await assert.rejects(createRuntimeProvisionerForTest(f.options, { ...f.settings, downloadTimeoutMs: 15 })(), /DOWNLOAD_TIMEOUT/);
    await noStaging(f);
  }
});

test('cancelling in-flight download removes staging and retry succeeds', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const prepare = createRuntimeProvisionerForTest({ ...f.options, fetchImpl: () => {
    entered(); return new Promise(() => {});
  } }, f.settings);
  const pending = prepare({ signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, /ABORTED/);
  await noStaging(f);
  assert.ok((await f.prepare()).cliPath);
});

test('cancel after a verified CLI cache never returns ready and retry reuses only verified cache', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(f.prepare({ signal: controller.signal, onPhase: (phase) => {
    if (phase === 'downloadingNode') controller.abort();
  } }), /ABORTED/);
  assert.equal(f.requests.length, 2);
  await assert.rejects(lstat(path.join(f.root, 'context')), { code: 'ENOENT' });
  await noStaging(f);
  assert.ok((await f.prepare()).nodePath);
  assert.equal(f.requests.length, 4);
});

test('hanging version probes are killed on timeout or cancellation with bounded output', async (t) => {
  for (const mode of ['timeout', 'abort', 'overflow', 'wrong-version', 'nonzero']) {
    await t.test(mode, async (t) => {
      const controller = new AbortController();
      const f = await fixture(t, { settings: { versionTimeoutMs: 15 }, behavior: (child) => {
        if (mode === 'abort') controller.abort();
        if (mode === 'overflow') child.stdout.write('x'.repeat(4097));
        if (mode === 'wrong-version' || mode === 'nonzero') {
          child.stdout.write(mode === 'wrong-version' ? 'lark-cli version 9.0.0' : 'lark-cli version 1.0.93');
          child.emit('close', mode === 'nonzero' ? 1 : 0);
        }
      } });
      await assert.rejects(f.prepare({ signal: controller.signal }),
        mode === 'timeout' ? /VERSION_TIMEOUT/ : mode === 'abort' ? /ABORTED/ : /INCOMPATIBLE_RUNTIME/);
      if (['timeout', 'abort', 'overflow'].includes(mode)) assert.deepEqual(f.calls[0].child.kills, ['SIGKILL']);
      await noStaging(f);
    });
  }
});

test('root, managed binaries and their ancestors cannot be symlinks or hardlinks', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await mkdir(outside);
  await mkdir(path.dirname(f.root));
  await symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.prepare(), /UNSAFE_PATH/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(f.requests.length, 0);
  await rm(f.root);
  const result = await f.prepare();
  const saved = await readFile(result.cliPath);
  const target = path.join(outside, 'unrelated.exe');
  await writeFile(target, saved);
  await rm(result.cliPath);
  await link(target, result.cliPath);
  await assert.rejects(f.prepare({ existing: result }), /UNSAFE_PATH/);
  assert.deepEqual(await readFile(target), saved);
  await noStaging(f);
});

test('native symlinks, hardlinks, scripts and wrong-architecture executables are not run', async (t) => {
  const f = await fixture(t);
  const native = await f.native('cli');
  const real = path.join(f.base, 'source.exe');
  await writeFile(real, pe());
  for (const mode of ['symlink', 'hardlink', 'script', 'arm64']) {
    await t.test(mode, async (t) => {
      await rm(native, { force: true });
      if (mode === 'symlink' && !await fileSymlink(t, real, native)) return;
      if (mode === 'hardlink') await link(real, native);
      if (mode === 'script') await writeFile(native, '#!/bin/sh\nexit 0');
      if (mode === 'arm64') await writeFile(native, pe('cli', 0xaa64));
      const result = await f.prepare({ existing: { cliPath: native } });
      assert.notEqual(result.cliPath, native);
    });
  }
  assert.ok(f.calls.every(({ file }) => file !== native));
});

test('concurrent provisioner instances serialize the same root and reuse verified artifacts', async (t) => {
  const f = await fixture(t);
  const other = createRuntimeProvisionerForTest(f.options, f.settings);
  const [first, second] = await Promise.all([f.prepare(), other()]);
  assert.deepEqual(first, second);
  assert.equal(f.requests.length, 4);
  assert.equal(f.calls.length, 4);
  await noStaging(f);
});

test('queued cancellation settles immediately without cancelling the active installer', async (t) => {
  const f = await fixture(t);
  let enter;
  let resume;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { resume = resolve; });
  const fetchImpl = f.options.fetchImpl;
  let first = true;
  const prepare = createRuntimeProvisionerForTest({ ...f.options, fetchImpl: async (...args) => {
    if (first) { first = false; enter(); await blocked; }
    return fetchImpl(...args);
  } }, f.settings);
  const active = prepare();
  await entered;
  const controller = new AbortController();
  const queued = prepare({ signal: controller.signal });
  controller.abort();
  let timer;
  try {
    await Promise.race([assert.rejects(queued, /ABORTED/), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('queued cancellation did not settle')), 100);
    })]);
  } finally { clearTimeout(timer); resume(); await active; }
  assert.equal(f.requests.length, 4);
  await noStaging(f);
});

test('official local artifact smoke: real pinned ZIP and Node bytes, mocked executable probes', {
  skip: !process.env.FEISHU_RUNTIME_ARTIFACT_FIXTURE,
}, async (t) => {
  const directory = process.env.FEISHU_RUNTIME_ARTIFACT_FIXTURE;
  const cliZip = await readFile(path.join(directory, 'lark-cli-1.0.93-windows-amd64.zip'));
  const node = await readFile(path.join(directory, 'node.exe'));
  const cliLicense = await readFile(path.join(directory, 'windows', 'LICENSE'));
  assert.equal(digest(cliZip), ARTIFACTS.cli.sha256);
  assert.equal(digest(node), ARTIFACTS.node.sha256);
  assert.equal(digest(cliLicense), ARTIFACTS.cli.license.sha256);
  const f = await fixture(t, { cliZip });
  const nodeLicense = await readFile(new URL('./licenses/NODE_LICENSE.txt', import.meta.url));
  assert.equal(digest(nodeLicense), ARTIFACTS.node.license.sha256);
  f.bodies.set(ARTIFACTS.node.url, node);
  f.bodies.set(ARTIFACTS.cli.license.url, cliLicense);
  f.bodies.set(ARTIFACTS.node.license.url, nodeLicense);
  const prepare = createRuntimeProvisionerForTest(f.options, { ...f.settings, artifacts: ARTIFACTS,
    licensesRoot: fileURLToPath(new URL('./licenses/', import.meta.url)) });
  const result = await prepare();
  assert.equal(digest(await readFile(result.cliPath)), ARTIFACTS.cli.executableSha256);
  assert.equal(digest(await readFile(result.nodePath)), ARTIFACTS.node.executableSha256);
  const manifest = JSON.parse(await readFile(new URL('./licenses/manifest.json', import.meta.url)));
  for (const kind of ['cli', 'node']) {
    for (const name of manifest.artifacts[kind].noticeFiles) {
      const installed = await readFile(path.join(path.dirname(result[`${kind}Path`]), 'licenses', name));
      const reviewed = manifest.files.find((file) => file.path === name);
      assert.equal(installed.length, reviewed.bytes);
      assert.equal(digest(installed), reviewed.sha256);
    }
  }
  assert.deepEqual(await prepare({ existing: result }), result);
  assert.equal(f.requests.length, 4);
  assert.equal(f.calls.length, 4);
  for (const { options } of f.calls) {
    assert.equal(options.env.LARKSUITE_CLI_REMOTE_META, 'off');
    assert.equal(options.env.LARKSUITE_CLI_CONFIG_DIR, undefined);
  }
  assert.deepEqual(await readdir(result.configDir), []);
});

test('an external install lock is not deleted and no native/global files are touched', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lock, 'other-process'), 'keep');
  await assert.rejects(f.prepare(), /RUNTIME_BUSY/);
  assert.equal(await readFile(path.join(lock, 'other-process'), 'utf8'), 'keep');
  assert.equal(f.requests.length + f.calls.length, 0);
});

test('a crashed process-owned provision lock is recovered automatically', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const owner = { pid: child.pid, nonce: randomUUID(), createdAt: Date.now() };
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  assert.ok((await f.prepare()).cliPath);
  await noStaging(f);
  const quarantine = path.join(f.root, 'runtime', `.provision-retired-${owner.nonce}`);
  assert.deepEqual(JSON.parse(await readFile(path.join(quarantine, 'owner.json'), 'utf8')), owner);
});

test('directory birthtime changes during owner creation and quarantine rename do not change lock identity', async (t) => {
  const f = await fixture(t);
  const realLstat = fsPromises.lstat;
  let birthtime = 1000;
  const stats = [];
  t.mock.method(fsPromises, 'lstat', async (...args) => {
    const stat = await realLstat(...args);
    if (stat.isDirectory() && path.basename(String(args[0])).startsWith('.provision-')) {
      stat.birthtimeMs = ++birthtime;
      stats.push({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
    }
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = await f.prepare();
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, nonce: randomUUID(), createdAt: Date.now() }));
  assert.deepEqual(await f.prepare(), first);
  assert.ok(stats.some((a, i) => stats.slice(i + 1).some((b) =>
    a.dev === b.dev && a.ino === b.ino && a.birthtimeMs !== b.birthtimeMs)));
  await noStaging(f);
});

test('a replaced directory with copied owner nonce still fails directory identity verification', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const owner = { pid: 123456, nonce: randomUUID(), createdAt: Date.now() };
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  const before = await lstat(lock);
  const prepare = createRuntimeProvisionerForTest(f.options, { ...f.settings, processKill: () => {
    renameSync(lock, `${lock}-old`);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  } });
  await assert.rejects(prepare(), /RUNTIME_BUSY/);
  const after = await lstat(lock);
  assert.ok(before.dev !== after.dev || before.ino !== after.ino);
  assert.deepEqual(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')), owner);
  assert.equal(f.requests.length, 0);
});

test('large NTFS file IDs allow fresh installation without rounding lock identity', async (t) => {
  const f = await fixture(t);
  const realLstat = fsPromises.lstat;
  const inode = 2n ** 60n + 1n;
  t.mock.method(fsPromises, 'lstat', async (...args) => {
    const stat = await realLstat(...args);
    if (path.basename(String(args[0])) === '.provision-lock') {
      stat.ino = args[1]?.bigint ? inode : Number(inode);
    }
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.ok((await f.prepare()).cliPath);
  await noStaging(f);
});

test('Windows transient sharing violations do not discard a verified runtime', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const realRename = fsPromises.rename;
  let failures = 0;
  t.mock.method(fsPromises, 'rename', async (...args) => {
    if (path.basename(String(args[0])).startsWith('.stage-') && failures < 2) {
      failures += 1;
      throw Object.assign(new Error('temporary Windows sharing violation'), { code: 'EPERM' });
    }
    return realRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.ok((await f.prepare()).cliPath);
  assert.equal(failures, 2);
  await noStaging(f);
});

test('Windows publish retries remain bounded and leave no staging on persistent failure', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const realRename = fsPromises.rename;
  let failures = 0;
  t.mock.method(fsPromises, 'rename', async (...args) => {
    if (path.basename(String(args[0])).startsWith('.stage-')) {
      failures += 1;
      throw Object.assign(new Error('persistent sharing violation'), { code: 'EBUSY' });
    }
    return realRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.prepare(), { code: 'EBUSY' });
  assert.equal(failures, 6);
  await noStaging(f);
});

test('cancelling a Windows publish backoff preserves the ABORTED contract', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const realRename = fsPromises.rename;
  let failures = 0;
  t.mock.method(fsPromises, 'rename', async (...args) => {
    if (path.basename(String(args[0])).startsWith('.stage-')) {
      failures += 1;
      setTimeout(() => controller.abort(), 10);
      throw Object.assign(new Error('temporary sharing violation'), { code: 'EPERM' });
    }
    return realRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.prepare({ signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(failures, 1);
  await noStaging(f);
});

test('adjacent large NTFS file IDs cannot hide a replaced lock with the same owner', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const owner = { pid: 123456, nonce: randomUUID(), createdAt: Date.now() };
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  const realLstat = fsPromises.lstat;
  let inode = 2n ** 60n;
  let checkedLiveness = false;
  t.mock.method(fsPromises, 'lstat', async (...args) => {
    const stat = await realLstat(...args);
    if (String(args[0]) === lock) stat.ino = args[1]?.bigint ? inode : Number(inode);
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const prepare = createRuntimeProvisionerForTest(f.options, { ...f.settings, processKill: () => {
    checkedLiveness = true;
    inode += 1n;
    throw Object.assign(new Error('dead fixture process'), { code: 'ESRCH' });
  } });
  await assert.rejects(prepare(), /RUNTIME_BUSY/);
  assert.equal(checkedLiveness, true);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')), owner);
});

test('filesystems without usable lock inode IDs fail closed before downloading', async (t) => {
  const f = await fixture(t);
  const realLstat = fsPromises.lstat;
  t.mock.method(fsPromises, 'lstat', async (...args) => {
    const stat = await realLstat(...args);
    if (path.basename(String(args[0])) === '.provision-lock') stat.ino = 0;
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.prepare(), /RUNTIME_BUSY/);
  assert.equal(f.requests.length, 0);
});

test('owner file replacement with identical JSON cannot pass recovery identity checks', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const owner = { pid: 123456, nonce: randomUUID(), createdAt: Date.now() };
  const ownerPath = path.join(lock, 'owner.json');
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(ownerPath, JSON.stringify(owner));
  const prepare = createRuntimeProvisionerForTest(f.options, { ...f.settings, processKill: () => {
    renameSync(ownerPath, path.join(f.base, 'old-owner.json'));
    writeFileSync(ownerPath, JSON.stringify(owner));
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  } });
  await assert.rejects(prepare(), /RUNTIME_BUSY/);
  assert.deepEqual(JSON.parse(await readFile(ownerPath, 'utf8')), owner);
  assert.equal(f.requests.length, 0);
});

test('killing an isolated installer after lock acquisition allows a clean reconnect', async (t) => {
  const f = await fixture(t);
  const code = `
    import { createRuntimeProvisionerForTest } from ${JSON.stringify(new URL('./runtime.mjs', import.meta.url).href)};
    const prepare = createRuntimeProvisionerForTest({
      root: ${JSON.stringify(f.root)}, env: {},
      fetchImpl: () => { process.send('locked'); return new Promise(() => {}); },
      spawnImpl: () => { throw new Error('unexpected execution'); },
    }, ${JSON.stringify(f.settings)});
    await prepare();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, NODE_TEST_CONTEXT: 'child' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = once(child, 'exit');
  const ready = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error(stderr); })]);
  assert.equal(ready[0], 'locked');
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, child.pid);
  child.kill('SIGKILL');
  await exit;
  const leftovers = await readdir(path.join(f.root, 'runtime'));
  const abandoned = leftovers.filter((name) => name.startsWith('.stage-'));
  assert.equal(abandoned.length, 1);
  assert.ok((await f.prepare()).nodePath);
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
  // Recovery does not remove another process's staging or user files.
  assert.ok((await lstat(path.join(f.root, 'runtime', abandoned[0]))).isDirectory());
});

test('lock symlinks and hardlinked ownership records cannot be reclaimed', async (t) => {
  const f = await fixture(t);
  const runtime = path.join(f.root, 'runtime');
  const lock = path.join(runtime, '.provision-lock');
  const outside = path.join(f.base, 'outside');
  await mkdir(outside);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await symlink(outside, lock, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.prepare(), /UNSAFE_PATH/);
  await rm(lock);
  await mkdir(lock, { mode: 0o700 });
  const contents = JSON.stringify({ pid: 123456, nonce: randomUUID(), createdAt: Date.now() });
  await writeFile(path.join(outside, 'owner.json'), contents);
  await link(path.join(outside, 'owner.json'), path.join(lock, 'owner.json'));
  await assert.rejects(f.prepare(), /UNSAFE_PATH/);
  assert.equal(await readFile(path.join(outside, 'owner.json'), 'utf8'), contents);
  assert.equal(f.requests.length, 0);
});

test('live owners, EPERM and uncertain liveness never allow recovery or send a termination signal', async (t) => {
  for (const code of [undefined, 'EPERM', 'EACCES']) {
    const f = await fixture(t);
    const lock = path.join(f.root, 'runtime', '.provision-lock');
    const owner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() - 86400000 };
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
    const probes = [];
    const prepare = createRuntimeProvisionerForTest(f.options, { ...f.settings, processKill: (pid, signal) => {
      probes.push([pid, signal]);
      if (code) throw Object.assign(new Error(code), { code });
      return process.kill(pid, signal);
    } });
    await assert.rejects(prepare(), /RUNTIME_BUSY/);
    assert.deepEqual(probes, [[process.pid, 0]]);
    assert.deepEqual(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')), owner);
    assert.equal(f.requests.length, 0);
  }
});

test('fresh empty and malformed locks fail closed; old empty initialization crashes recover', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await assert.rejects(f.prepare(), /RUNTIME_BUSY/);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(lock, old, old);
  await writeFile(path.join(lock, 'owner.json'), '{partial');
  await assert.rejects(f.prepare(), /RUNTIME_BUSY/);
  assert.equal(await readFile(path.join(lock, 'owner.json'), 'utf8'), '{partial');
  await rm(path.join(lock, 'owner.json'));
  await utimes(lock, old, old);
  assert.ok((await f.prepare()).cliPath);
  await noStaging(f);
});

test('two independent recoverers cannot both install and keep a nonempty nonce tombstone', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const owner = { pid: 123456, nonce: randomUUID(), createdAt: Date.now() };
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
  // Separate module instances bypass the process-local queue, just as two
  // host processes do. Their filesystem arbitration remains real.
  const other = await import(`./runtime.mjs?lock-test=${randomUUID()}`);
  let active = 0;
  let maximum = 0;
  const options = { ...f.options, fetchImpl: async (...args) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await f.options.fetchImpl(...args);
    } finally { active--; }
  } };
  const settings = { ...f.settings, processKill: (pid, signal) => {
    assert.equal(signal, 0);
    if (pid === owner.pid) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    return process.kill(pid, signal);
  } };
  const outcomes = await Promise.allSettled([
    createRuntimeProvisionerForTest(options, settings)(),
    other.createRuntimeProvisionerForTest(options, settings)(),
  ]);
  assert.ok(outcomes.some((result) => result.status === 'fulfilled'));
  for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.code, 'RUNTIME_BUSY');
  assert.equal(maximum, 1);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(await readdir(path.join(f.root, 'runtime', `.provision-retired-${owner.nonce}`)), ['owner.json']);
  await noStaging(f);
});

test('recovery rechecks captured ownership and never moves a replaced live lock', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const old = { pid: 123456, nonce: randomUUID(), createdAt: Date.now() };
  const live = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(old));
  const prepare = createRuntimeProvisionerForTest(f.options, { ...f.settings, processKill: () => {
    renameSync(lock, `${lock}-old`);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(live));
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  } });
  await assert.rejects(prepare(), /RUNTIME_BUSY/);
  assert.deepEqual(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')), live);
  assert.equal(f.requests.length, 0);
});

test('a delayed recoverer cannot rename a replacement over an existing nonce tombstone', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const old = { pid: 123456, nonce: randomUUID(), createdAt: Date.now() };
  const live = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
  const retired = path.join(f.root, 'runtime', `.provision-retired-${old.nonce}`);
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(old));
  const prepare = createRuntimeProvisionerForTest(f.options, { ...f.settings, processKill: () => {
    renameSync(lock, retired);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(live));
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  } });
  await assert.rejects(prepare(), /RUNTIME_BUSY/);
  // Even after the last snapshot, the atomic rename itself must reject the
  // replacement. Retaining a nonempty tombstone makes that portable.
  await assert.rejects(rename(lock, retired));
  assert.deepEqual(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')), live);
  assert.deepEqual(JSON.parse(await readFile(path.join(retired, 'owner.json'), 'utf8')), old);
  assert.equal(f.requests.length, 0);
});

test('releasing a replaced lock preserves the replacement owner and unrelated files', async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.root, 'runtime', '.provision-lock');
  const replacement = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
  let captured;
  const prepare = createRuntimeProvisionerForTest({ ...f.options, fetchImpl: async () => {
    captured = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
    await rename(lock, `${lock}-old`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify(replacement));
    throw new Error('fixture download failure');
  } }, f.settings);
  await assert.rejects(prepare(), /fixture download failure/);
  assert.equal(captured.pid, process.pid);
  assert.notEqual(captured.nonce, replacement.nonce);
  assert.deepEqual(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')), replacement);
});

test('production refuses unsupported platforms rather than running downloaded Windows bytes', async () => {
  if (process.platform === 'win32' && process.arch === 'x64') return;
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) return;
  const prepare = createRuntimeProvisioner({ root: path.join(os.tmpdir(), 'unused-feishu-root') });
  await assert.rejects(prepare(), /UNSUPPORTED_PLATFORM/);
});
