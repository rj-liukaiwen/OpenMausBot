/* eslint-disable no-control-regex -- Reject control characters at host boundaries. */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, rmdir, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ARTIFACTS, NOTICE, runtimeArtifacts } from './runtime-artifacts.mjs';
import { extractPinnedTarExecutable, nativeExecutable } from './native-format.mjs';

const MAX_BYTES = 160 * 1024 * 1024;
const LICENSES_ROOT = fileURLToPath(new URL('./licenses/', import.meta.url));
const MAX_NOTICE_BYTES = 8 * 1024 * 1024;
const queues = new Map();
const error = (code) => Object.assign(new Error(code), { code });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checkAbort = (signal) => { if (signal?.aborted) throw error('ABORTED'); };

// Windows scanners can briefly hold a freshly verified executable/directory.
// Retry only sharing/access failures, never skip validation, overwrite an
// unowned destination, or turn cancellation into a successful installation.
async function publishVerifiedRuntime(source, destination, signal) {
  for (let attempt = 0; ; attempt += 1) {
    checkAbort(signal);
    try { await rename(source, destination); return; }
    catch (cause) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(cause.code) || attempt >= 5) throw cause;
      try { await delay(50 * 2 ** attempt, undefined, { signal }); }
      catch (waitError) { checkAbort(signal); throw waitError; }
    }
  }
}
const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const safeAbsolute = (value) => typeof value === 'string' && path.isAbsolute(value) &&
  !/[\x00-\x1f\x7f]/.test(value) && path.normalize(value) === value &&
  (process.platform !== 'win32' || (/^[a-z]:\\/i.test(value) &&
    !value.slice(3).split('\\').some((part) => /[:<>"|?*]|[. ]$/.test(part))));

// No symlinks/junctions in any ancestor. The host owns root; this is not a
// sandbox against a concurrent writer running as the same OS user.
async function directories(target, create = false, ownedRoot) {
  const base = path.parse(target).root;
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('UNSAFE_PATH');
    if (ownedRoot && (pathKey(current) === pathKey(ownedRoot) || pathKey(current).startsWith(`${pathKey(ownedRoot)}${path.sep}`)) &&
        process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o022))) {
      throw error('UNSAFE_PATH');
    }
  }
}

async function readRegular(file, maxBytes = MAX_BYTES) {
  await directories(path.dirname(file));
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw error('UNSAFE_PATH');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw error('UNSAFE_PATH');
    }
    if (stat.size > maxBytes) throw error('SIZE_LIMIT');
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maxBytes) throw error('SIZE_LIMIT');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

const RECOVERY_OWNER = 'TuanTuan/feishu/recovery-v1';
async function validateRecoveryContext(root, context) {
  if (!safeAbsolute(context) || path.basename(context) !== 'context') throw error('INVALID_CONFIG_DIR');
  const generation = path.dirname(context);
  if (path.dirname(generation) !== path.join(root, 'recovery') ||
      !/^[a-f0-9-]{36}$/.test(path.basename(generation))) throw error('INVALID_CONFIG_DIR');
  await directories(generation, false, root);
  const expected = JSON.stringify({ owner: RECOVERY_OWNER, id: path.basename(generation) });
  if ((await readRegular(path.join(generation, '.owner'), 1024)).toString() !== expected) throw error('INVALID_CONFIG_DIR');
  await directories(context, false, root);
}

/** Host-only staging for explicitly replacing a deleted app; old context is never moved or removed. */
export async function createRecoveryContext({ root, signal }) {
  if (!safeAbsolute(root) || root !== path.resolve(root) || root === path.parse(root).root) throw error('INVALID_ROOT');
  checkAbort(signal);
  const parent = path.join(root, 'recovery');
  await directories(parent, true, root);
  const id = randomUUID();
  const generation = path.join(parent, id);
  await mkdir(generation, { mode: 0o700 });
  const marker = await open(path.join(generation, '.owner'), 'wx', 0o600);
  try { await marker.writeFile(JSON.stringify({ owner: RECOVERY_OWNER, id })); await marker.sync(); }
  finally { await marker.close(); }
  const context = path.join(generation, 'context');
  await mkdir(context, { mode: 0o700 });
  checkAbort(signal);
  await validateRecoveryContext(root, context);
  return context;
}

async function acquireProvisionLock(runtime, root, signal, processKill) {
  const lock = path.join(runtime, '.provision-lock');
  // Windows/Wine directory creation times can change when children are written
  // or the directory is renamed. File IDs plus the owner nonce identify the
  // generation; timestamps do not. NTFS IDs can exceed Number's exact range.
  // Fail closed if the filesystem has no IDs.
  const same = (a, b) => typeof a.dev === 'bigint' && typeof a.ino === 'bigint' && a.ino > 0n &&
    a.dev === b.dev && a.ino === b.ino;
  const snapshot = async () => {
    await directories(lock, false, root);
    const stat = await lstat(lock, { bigint: true });
    const names = await readdir(lock);
    if (names.length === 0) return { stat };
    if (names.length !== 1 || names[0] !== 'owner.json') throw error('RUNTIME_BUSY');
    const ownerPath = path.join(lock, 'owner.json');
    const ownerStat = await lstat(ownerPath, { bigint: true });
    let owner;
    try { owner = JSON.parse(await readRegular(ownerPath, 1024)); }
    catch (cause) {
      if (cause.code === 'UNSAFE_PATH') throw cause;
      throw error('RUNTIME_BUSY');
    }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || owner.pid > 0x7fffffff ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner.nonce) ||
        !Number.isSafeInteger(owner.createdAt) || owner.createdAt <= 0) throw error('RUNTIME_BUSY');
    if (!same(stat, await lstat(lock, { bigint: true })) ||
        !same(ownerStat, await lstat(ownerPath, { bigint: true }))) throw error('RUNTIME_BUSY');
    return { stat, owner, ownerStat };
  };
  const matches = (a, b) => same(a.stat, b.stat) && a.owner?.nonce === b.owner?.nonce &&
    a.owner?.pid === b.owner?.pid && a.owner?.createdAt === b.owner?.createdAt &&
    (!a.owner && !b.owner || a.ownerStat && b.ownerStat && same(a.ownerStat, b.ownerStat));
  const writeOwner = async (stat) => {
    if (!same(stat, await lstat(lock, { bigint: true }))) throw error('RUNTIME_BUSY');
    const owner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
    const handle = await open(path.join(lock, 'owner.json'), 'wx', 0o600);
    let ownerStat;
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); ownerStat = await handle.stat({ bigint: true }); }
    finally { await handle.close(); }
    const owned = { stat, owner, ownerStat };
    if (!matches(owned, await snapshot())) throw error('RUNTIME_BUSY');
    return owned;
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    checkAbort(signal);
    await directories(runtime, false, root);
    let created = false;
    try { await mkdir(lock, { mode: 0o700 }); created = true; }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    if (created) {
      const owned = await writeOwner(await lstat(lock, { bigint: true }));
      return async () => {
        // A replaced lock belongs to somebody else, even if it has our PID.
        try {
          if (!matches(owned, await snapshot())) return;
          await rm(path.join(lock, 'owner.json'));
          await rmdir(lock);
        } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      };
    }
    try {
      let captured = await snapshot();
      if (!captured.owner) {
        // Covers legacy empty directories and a crash between mkdir and the
        // owner write. An initializer uses wx too, so only one can claim it.
        if (BigInt(Date.now()) - captured.stat.mtimeMs < 10n * 60n * 1000n) throw error('RUNTIME_BUSY');
        captured = await writeOwner(captured.stat);
      } else {
        try { processKill(captured.owner.pid, 0); throw error('RUNTIME_BUSY'); }
        catch (cause) {
          // EPERM, PID reuse, and unknown liveness failures are NOT death.
          if (cause.code !== 'ESRCH') throw error('RUNTIME_BUSY');
        }
      }
      // Once an empty orphan has our owner record, finish retiring it even if
      // cancelled; leaving a record for this still-live PID would strand it.
      if (!matches(captured, await snapshot())) throw error('RUNTIME_BUSY');
      // Keep this nonempty, generation-specific tombstone. A delayed second
      // recoverer cannot rename a new live lock over it (POSIX or Windows).
      // No recovery guard to strand on another crash; no unowned rm -r.
      const retired = path.join(runtime, `.provision-retired-${captured.owner.nonce}`);
      await rename(lock, retired);
      const moved = await lstat(retired, { bigint: true });
      const ownerStat = await lstat(path.join(retired, 'owner.json'), { bigint: true });
      const owner = JSON.parse(await readRegular(path.join(retired, 'owner.json'), 1024));
      if (!matches(captured, { stat: moved, owner, ownerStat })) throw error('RUNTIME_BUSY');
    } catch (cause) {
      if (cause.code === 'ENOENT') continue;
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(cause.code)) throw error('RUNTIME_BUSY');
      throw cause;
    }
  }
  throw error('RUNTIME_BUSY');
}

/** Pure policy/pin validation; approval is for these artifacts, never future versions. */
export function validateApprovedArtifacts(manifest, artifacts = ARTIFACTS, kinds = ['cli', 'node']) {
  const require = (condition) => { if (!condition) throw error('LICENSE_REVIEW_REQUIRED'); };
  require(manifest?.schemaVersion === 1 && manifest.policyException?.approved === true &&
    manifest.releaseApproved === true);
  require(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 128);
  const files = new Map();
  for (const file of manifest.files) {
    require(file && typeof file.path === 'string' && file.path.length <= 240 &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.(txt|json|md|crate)$/.test(file.path) &&
      !file.path.split('/').some((part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) &&
      !files.has(file.path.toLowerCase()) && /^[a-f0-9]{64}$/.test(file.sha256) &&
      Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_NOTICE_BYTES);
    files.set(file.path.toLowerCase(), file);
  }
  const result = {};
  for (const kind of kinds) {
    require(kind === 'cli' || kind === 'node');
    const artifact = artifacts[kind];
    const reviewed = manifest.artifacts?.[kind];
    require(reviewed && reviewed.version === artifact.version &&
      reviewed.platform === (artifact.platform ?? (kind === 'cli' ? 'windows-amd64' : 'win32-x64')) &&
      reviewed.executableSha256 === artifact.executableSha256 &&
      (artifact.member ? reviewed.archiveSha256 === artifact.sha256 : reviewed.executableSha256 === artifact.sha256));
    require(Array.isArray(reviewed.noticeFiles) && reviewed.noticeFiles.length > 0 &&
      new Set(reviewed.noticeFiles).size === reviewed.noticeFiles.length);
    result[kind] = reviewed.noticeFiles.map((name) => {
      require(typeof name === 'string');
      const file = files.get(name.toLowerCase());
      require(file?.path === name);
      return { ...file };
    });
    if (kind === 'node') {
      const exceptions = manifest.policyException.copyleftExceptions;
      require(manifest.policyException.copyleftExceptionGranted === true && Array.isArray(exceptions) && exceptions.length === 2);
      for (const [component, version, license, sourcePath] of [
        ['smartstring', '1.0.1', 'MPL-2.0+', 'sources/smartstring-1.0.1.crate'],
        ['NSS-derived root certificate data', 'Node v24.15.0 tagged certdata and generated header',
          'MPL-2.0', 'sources/node-v24.15.0-certdata.txt'],
      ]) {
        require(exceptions.some((entry) => entry?.artifact === kind && entry.executableSha256 === artifact.executableSha256 &&
          entry.component === component && entry.version === version && entry.license === license && entry.sourcePath === sourcePath));
        require(reviewed.noticeFiles.includes(sourcePath));
      }
      const source = manifest.sourceAvailability;
      require(source && reviewed.noticeFiles.includes(source.instructions) && reviewed.noticeFiles.includes(source.license) &&
        Array.isArray(source.sources) && source.sources.length >= 2);
      for (const entry of source.sources) {
        require(entry && reviewed.noticeFiles.includes(entry.path) && files.get(entry.path.toLowerCase())?.sha256 === entry.sha256);
      }
      require(exceptions.every((entry) => source.sources.some((item) => item.path === entry.sourcePath)));
    }
  }
  return result;
}

/** Read only packaged files. No notice URL is ever fetched at runtime. */
export async function checkApprovedArtifacts(platform = process.platform, arch = process.arch) {
  return approvedNotices(LICENSES_ROOT, runtimeArtifacts(platform, arch), ['cli', 'node']);
}

async function approvedNotices(licensesRoot, artifacts, kinds) {
  try {
    const manifest = JSON.parse(await readRegular(path.join(licensesRoot, 'manifest.json'), 1024 * 1024));
    const review = artifacts.cli.platform?.startsWith('darwin-')
      ? manifest.targets?.[artifacts.node.platform] : manifest;
    const notices = validateApprovedArtifacts(review, artifacts, kinds);
    for (const files of Object.values(notices)) {
      for (const file of files) {
        file.contents = await readRegular(path.join(licensesRoot, file.path), file.bytes);
        if (file.contents.length !== file.bytes || sha256(file.contents) !== file.sha256) {
          throw error('LICENSE_REVIEW_REQUIRED');
        }
      }
    }
    return notices;
  } catch {
    // Filesystem/JSON errors can contain private paths or untrusted text.
    throw error('LICENSE_REVIEW_REQUIRED');
  }
}

const nativeX64 = (bytes) => nativeExecutable(bytes, 'win32', 'x64');

// Read the central directory and local headers, but inflate ONLY the pinned
// member. No archive-provided path is ever passed to filesystem operations.
export function extractPinnedExecutable(zip, member, digest) {
  const zipLimit = 100 * 1024 * 1024;
  const bad = () => { throw error('INVALID_ZIP'); };
  const range = (offset, size, end = zip.length) => {
    if (offset < 0 || size < 0 || offset + size > end) bad();
  };
  let end = zip.length - 22;
  for (; end >= Math.max(0, zip.length - 65557); end--) {
    if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
  }
  if (end < 0 || end < zip.length - 65557) bad();
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const central = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) ||
      count !== zip.readUInt16LE(end + 8) || !count || count === 0xffff ||
      centralSize === 0xffffffff || central === 0xffffffff || central + centralSize !== end) bad();
  const extras = (start, length) => {
    const stop = start + length;
    while (start < stop) {
      range(start, 4, stop);
      const id = zip.readUInt16LE(start);
      const size = zip.readUInt16LE(start + 2);
      if (id === 1) bad(); // ZIP64 is deliberately unsupported.
      start += 4;
      range(start, size, stop);
      start += size;
    }
  };
  const names = new Set();
  const ranges = [];
  let cursor = central;
  let selected;
  for (let i = 0; i < count; i++) {
    range(cursor, 46, end);
    if (zip.readUInt32LE(cursor) !== 0x02014b50) bad();
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const packed = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const attributes = zip.readUInt32LE(cursor + 38);
    const local = zip.readUInt32LE(cursor + 42);
    range(cursor + 46, nameLength + extraLength + commentLength, end);
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    const type = (attributes >>> 16) & 0xf000;
    if (zip.readUInt16LE(cursor + 6) > 20 || flags & ~0x808 || ![0, 8].includes(method) ||
        zip.readUInt16LE(cursor + 34) || packed > zipLimit || size > zipLimit ||
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(name) ||
        name.split('/').some((part) => part === '.' || part === '..') ||
        names.has(name.toLowerCase()) || (type && type !== 0x8000 && type !== 0x4000)) bad();
    names.add(name.toLowerCase());
    extras(cursor + 46 + nameLength, extraLength);
    range(local, 30, central);
    const localNameLength = zip.readUInt16LE(local + 26);
    const localExtraLength = zip.readUInt16LE(local + 28);
    const data = local + 30 + localNameLength + localExtraLength;
    range(local + 30, localNameLength + localExtraLength, central);
    range(data, packed, central);
    if (zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 4) > 20 ||
        zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method ||
        !zip.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) bad();
    extras(local + 30 + localNameLength, localExtraLength);
    let stop = data + packed;
    if (flags & 8) {
      range(stop, 12, central);
      if (zip.readUInt32LE(stop) === 0x08074b50) stop += 4;
      range(stop, 12, central);
      if (zip.readUInt32LE(stop) !== crc || zip.readUInt32LE(stop + 4) !== packed ||
          zip.readUInt32LE(stop + 8) !== size) bad();
      stop += 12;
    } else if (zip.readUInt32LE(local + 14) !== crc || zip.readUInt32LE(local + 18) !== packed ||
        zip.readUInt32LE(local + 22) !== size) bad();
    ranges.push([local, stop]);
    if (name === member) {
      if (type === 0x4000 || (attributes & 0x10) || !size) bad();
      selected = { data, packed, size, method };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || !selected || ranges[0][0] !== 0 ||
      ranges.some(([, stop], i) => stop !== (ranges[i + 1]?.[0] ?? central))) bad();
  const { data, packed, size, method } = selected;
  const compressed = zip.subarray(data, data + packed);
  const bytes = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: size });
  if (bytes.length !== size || sha256(bytes) !== digest) throw error('CHECKSUM_MISMATCH');
  if (!nativeX64(bytes)) throw error('INVALID_EXECUTABLE');
  return bytes;
}

function childEnvironment(env, platform) {
  const result = {};
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE',
    'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);
  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key.toUpperCase()) && typeof value === 'string' && !/[\x00-\x1f]/.test(value)) {
      result[platform === 'win32' ? key.toUpperCase() : key] = value;
    }
  }
  // v1.0.93 registry/loader.go calls cacheWritable even for --version unless
  // registry/remote.go's remoteEnabled is false. Notifier flags alone do not
  // prevent creating native ~/.lark-cli/cache; never inherit this switch.
  return { ...result, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    LARKSUITE_CLI_REMOTE_META: 'off' };
}

function version(executable, kind, spawnImpl, env, signal, timeoutMs, expected) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let child;
    let finished = false;
    let output = '';
    let size = 0;
    const finish = (cause, result, kill = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (kill && child) {
        try { child.kill('SIGKILL'); } catch { /* Already exited or failed to spawn. */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      if (cause) reject(cause); else resolve(result);
    };
    const abort = () => finish(error('ABORTED'), false, true);
    const timer = setTimeout(() => finish(error('VERSION_TIMEOUT'), false, true), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      child = spawnImpl(executable, ['--version'], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.dirname(executable), env: { ...env },
      });
      child.on('error', () => finish(undefined, false, true));
      for (const [stream, stdout] of [[child.stdout, true], [child.stderr, false]]) {
        stream.on('error', () => finish(undefined, false, true));
        stream.on('data', (chunk) => {
          if (finished) return;
          size += Buffer.byteLength(chunk);
          if (size > 4096) { finish(undefined, false, true); return; }
          if (stdout) output += chunk.toString();
        });
      }
      child.on('close', (code) => {
        const match = (kind === 'cli' ? /^lark-cli version (\d+\.\d+\.\d+)\s*$/ :
          /^v(\d+\.\d+\.\d+)\s*$/).exec(output);
        finish(undefined, code === 0 && !!match && (expected ? match[1] === expected :
          kind === 'cli' ? match[1] === ARTIFACTS.cli.version : Number(match[1].split('.')[0]) >= 24));
      });
      if (signal?.aborted) abort();
    } catch { finish(undefined, false, true); }
  });
}

async function download(artifact, destination, fetchImpl, signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(error('ABORTED'));
  const timer = setTimeout(() => controller.abort(error('DOWNLOAD_TIMEOUT')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  let handle;
  let reader;
  let response;
  // Race even injected transports that ignore the supplied signal. The real
  // fetch is aborted too; a stalled response body cannot hold the installer.
  const bounded = (promise) => new Promise((resolve, reject) => {
    const stop = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() =>
      controller.signal.removeEventListener('abort', stop));
    if (controller.signal.aborted) stop();
  });
  try {
    checkAbort(signal);
    let url = new URL(artifact.url);
    for (let redirects = 0; ; redirects++) {
      const official = ['github.com', 'release-assets.githubusercontent.com', 'nodejs.org'].includes(url.hostname);
      const license = url.href === ARTIFACTS.cli.license.url || url.href === ARTIFACTS.node.license.url;
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
          (!official && !license)) throw error('UNSAFE_DOWNLOAD_URL');
      response = await bounded(fetchImpl(url.href, { redirect: 'manual', signal: controller.signal,
        credentials: 'omit', headers: { 'Accept-Encoding': 'identity' } }));
      if (response.redirected || (response.url && response.url !== url.href)) throw error('UNSAFE_REDIRECT');
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await bounded(response.body?.cancel());
      if (redirects >= 3 || !response.headers.get('location')) throw error('REDIRECT_LIMIT');
      url = new URL(response.headers.get('location'), url);
    }
    if (response.status !== 200 || !response.body) throw error('DOWNLOAD_FAILED');
    const length = response.headers.get('content-length');
    const limit = Math.min(artifact.maxBytes, MAX_BYTES);
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw error('SIZE_LIMIT');
    handle = await open(destination, 'wx', 0o600);
    reader = response.body.getReader();
    const hash = createHash('sha256');
    let size = 0;
    while (true) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw error('SIZE_LIMIT');
      hash.update(value);
      await handle.writeFile(value);
    }
    if (length !== null && Number(length) !== size) throw error('DOWNLOAD_TRUNCATED');
    if (hash.digest('hex') !== artifact.sha256) throw error('CHECKSUM_MISMATCH');
    checkAbort(signal);
    await handle.sync();
    if (controller.signal.aborted) throw controller.signal.reason;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (response?.body) void response.body.cancel().catch(() => {});
    await handle?.close();
  }
}

function provisioner({ root, bundledRoot, verifySignedBundle, env = process.env, fetchImpl = fetch, spawnImpl = spawn } = {},
  { platform = process.platform, arch = process.arch, artifacts,
    licensesRoot = LICENSES_ROOT, downloadTimeoutMs = 120000, versionTimeoutMs = 10000,
    processKill = process.kill.bind(process) } = {}) {
  if (!safeAbsolute(root) || root !== path.resolve(root) || root === path.parse(root).root) throw error('INVALID_ROOT');
  if (bundledRoot !== undefined && (!safeAbsolute(bundledRoot) || bundledRoot !== path.resolve(bundledRoot) ||
      bundledRoot === path.parse(bundledRoot).root || pathKey(bundledRoot) === pathKey(root) ||
      pathKey(bundledRoot).startsWith(`${pathKey(root)}${path.sep}`))) throw error('INVALID_BUNDLED_ROOT');
  const context = path.join(root, 'context');
  const runtime = path.join(root, 'runtime');
  const childEnv = childEnvironment(env, platform);

  async function prepare({ existing = {}, signal, onPhase = () => {} } = {}) {
    checkAbort(signal);
    artifacts ??= runtimeArtifacts(platform, arch);
    const native = (bytes) => nativeExecutable(bytes, platform, arch);
    if (!existing || typeof existing !== 'object' || Array.isArray(existing) ||
        (signal !== undefined && !(signal instanceof AbortSignal)) || typeof onPhase !== 'function') {
      throw error('INVALID_ARGUMENTS');
    }
    if (existing.configDir !== undefined && existing.configDir !== context) {
      await validateRecoveryContext(root, existing.configDir);
    }
    const configDir = existing.configDir ?? (existing.appId || existing.cliPath || existing.ownerOpenId ? undefined : context);
    const phase = (name) => { checkAbort(signal); onPhase(name); checkAbort(signal); };
    phase('detecting');
    // Detecting an entirely native runtime does not create or modify root.
    try { await directories(root, false, root); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (configDir) {
      try { await directories(configDir, false, root); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    const candidates = (kind) => {
      const saved = existing[`${kind}Path`];
      const name = artifacts[kind].name;
      const paths = [];
      if (bundledRoot) paths.push(path.join(bundledRoot, artifacts[kind].directory, name));
      paths.push(saved);
      const userPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
      for (const directory of userPath.split(platform === 'win32' ? ';' : ':')) {
        if (!safeAbsolute(directory)) continue;
        paths.push(path.join(directory, name));
        if (kind === 'cli') paths.push(path.join(directory, 'node_modules', '@larksuite', 'cli', 'bin', name));
      }
      return [...new Set(paths)].filter((file) => safeAbsolute(file) &&
        path.basename(file).toLowerCase() === name && pathKey(file) !== pathKey(root) &&
        !pathKey(file).startsWith(`${pathKey(root)}${path.sep}`));
    };
    const detect = async (kind) => {
      for (const file of candidates(kind)) {
        checkAbort(signal);
        const bundled = bundledRoot && pathKey(file) === pathKey(path.join(
          bundledRoot, artifacts[kind].directory, artifacts[kind].name,
        ));
        try {
          const bytes = await readRegular(file);
          const trustedBytes = !bundled || sha256(bytes) === artifacts[kind].executableSha256 ||
            (platform === 'darwin' && typeof verifySignedBundle === 'function' &&
              await verifySignedBundle(file, { signal }));
          // A damaged packaged runtime must not silently select a developer's
          // PATH copy or download replacement bytes after signature failure.
          if (bundled && (!native(bytes) || !trustedBytes)) throw error('CHECKSUM_MISMATCH');
          if (native(bytes) && trustedBytes &&
              await version(file, kind, spawnImpl, childEnv, signal, versionTimeoutMs,
                bundled ? artifacts[kind].version : undefined)) return file;
          if (bundled) throw error('INCOMPATIBLE_RUNTIME');
        } catch (cause) {
          checkAbort(signal);
          if (bundled) throw ['ENOENT', 'ENOTDIR'].includes(cause.code) ? error('BUNDLED_RUNTIME_MISSING') : cause;
          if (!['ENOENT', 'ENOTDIR', 'UNSAFE_PATH', 'SIZE_LIMIT', 'VERSION_TIMEOUT', 'EACCES'].includes(cause.code)) throw cause;
        }
      }
      return undefined;
    };
    let cliPath = await detect('cli');
    let nodePath = await detect('node');
    if (!cliPath || !nodePath) {
      // Gate all needed artifacts before the first network request or managed write.
      const notices = await approvedNotices(licensesRoot, artifacts,
        [!cliPath && 'cli', !nodePath && 'node'].filter(Boolean));
      checkAbort(signal);
      await directories(runtime, true, root);
      const releaseLock = await acquireProvisionLock(runtime, root, signal, processKill);
      try {
        const install = async (kind) => {
          const artifact = artifacts[kind];
          const licenseFiles = notices[kind];
          const managedNames = [artifact.name, 'LICENSE', 'NOTICE',
            ...licenseFiles.map((file) => path.join('licenses', file.path))];
          const destination = path.join(runtime, artifact.directory);
          const executable = path.join(destination, artifact.name);
          const marker = `${JSON.stringify({ owner: 'TuanTuan/feishu/runtime-v1', artifact })}\n`;
          let exists = false;
          try {
            await directories(destination, false, root);
            exists = true;
            if ((await readRegular(path.join(destination, '.owner'), 16384)).toString() !== marker) throw error('UNOWNED_RUNTIME');
          } catch (cause) {
            if (cause.code !== 'ENOENT') throw cause;
            if (exists) throw error('UNOWNED_RUNTIME');
          }
          phase('verifyingRuntime');
          if (exists) {
            try {
              const bytes = await readRegular(executable);
              const license = await readRegular(path.join(destination, 'LICENSE'), artifact.license.maxBytes);
              const notice = await readRegular(path.join(destination, 'NOTICE'), 16384);
              let noticesValid = true;
              for (const file of licenseFiles) {
                const installed = await readRegular(path.join(destination, 'licenses', file.path), file.bytes);
                if (installed.length !== file.bytes || sha256(installed) !== file.sha256) noticesValid = false;
              }
              if (sha256(bytes) === artifact.executableSha256 && native(bytes) &&
                  sha256(license) === artifact.license.sha256 && notice.toString() === NOTICE && noticesValid &&
                  await version(executable, kind, spawnImpl, childEnv, signal, versionTimeoutMs, artifact.version)) {
                checkAbort(signal);
                return executable;
              }
            } catch (cause) {
              checkAbort(signal);
              if (!['ENOENT', 'SIZE_LIMIT', 'VERSION_TIMEOUT'].includes(cause.code)) throw cause;
            }
          }
          phase(kind === 'cli' ? 'downloadingCli' : 'downloadingNode');
          const stage = await mkdtemp(path.join(runtime, '.stage-'));
          try {
            const payload = path.join(stage, 'payload');
            await download(artifact, payload, fetchImpl, signal, downloadTimeoutMs);
            const bytes = await readRegular(payload);
            const exeBytes = artifact.format === 'tar.gz'
              ? extractPinnedTarExecutable(bytes, artifact.member, artifact.executableSha256, platform, arch)
              : artifact.member ? extractPinnedExecutable(bytes, artifact.member, artifact.executableSha256) : bytes;
            if (sha256(exeBytes) !== artifact.executableSha256) throw error('CHECKSUM_MISMATCH');
            if (!native(exeBytes)) throw error('INVALID_EXECUTABLE');
            const stagedExe = path.join(stage, artifact.name);
            const handle = await open(stagedExe, 'wx', 0o700);
            try { await handle.writeFile(exeBytes); await handle.sync(); } finally { await handle.close(); }
            await download(artifact.license, path.join(stage, 'LICENSE'), fetchImpl, signal, downloadTimeoutMs);
            await mkdir(path.join(stage, 'licenses'), { mode: 0o700 });
            for (const notice of licenseFiles) {
              await directories(path.dirname(path.join(stage, 'licenses', notice.path)), true, root);
              const file = await open(path.join(stage, 'licenses', notice.path), 'wx', 0o600);
              try { await file.writeFile(notice.contents); await file.sync(); } finally { await file.close(); }
            }
            for (const [name, text] of [['NOTICE', NOTICE], ['.owner', marker]]) {
              const file = await open(path.join(stage, name), 'wx', 0o600);
              try { await file.writeFile(text); } finally { await file.close(); }
            }
            phase('verifyingRuntime');
            if (!await version(stagedExe, kind, spawnImpl, childEnv, signal, versionTimeoutMs, artifact.version)) {
              throw error('INCOMPATIBLE_RUNTIME');
            }
            checkAbort(signal);
            await rm(payload); // Only our unique staging files are deleted.
            await directories(runtime, false, root);
            if (!exists) await publishVerifiedRuntime(stage, destination, signal);
            else {
              await directories(destination, false, root);
              if ((await readRegular(path.join(destination, '.owner'), 16384)).toString() !== marker) throw error('UNOWNED_RUNTIME');
              // Never recursively delete/replace an existing directory. Repair
              // only our named files, retaining any unrelated files alongside.
              for (const file of licenseFiles) {
                await directories(path.dirname(path.join(destination, 'licenses', file.path)), true, root);
              }
              for (const name of managedNames) {
                const target = path.join(destination, name);
                try { await readRegular(target); }
                catch (cause) { if (!['ENOENT', 'SIZE_LIMIT'].includes(cause.code)) throw cause; }
              }
              for (const name of managedNames) {
                checkAbort(signal);
                await publishVerifiedRuntime(path.join(stage, name), path.join(destination, name), signal);
              }
            }
            checkAbort(signal);
            return executable;
          } finally { await rm(stage, { recursive: true, force: true }); }
        };
        if (!cliPath) cliPath = await install('cli');
        if (!nodePath) nodePath = await install('node');
      } finally { await releaseLock(); }
    }
    phase('verifyingRuntime');
    if (configDir) await directories(configDir, true, root);
    checkAbort(signal);
    return { cliPath, nodePath, ...(configDir ? { configDir } : {}) };
  }

  return async (options) => {
    // Serialize across provisioner instances, but cancellation of a queued
    // caller must not cancel the caller currently installing the same root.
    const signal = options?.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw error('INVALID_ARGUMENTS');
    checkAbort(signal);
    const key = pathKey(root);
    const previous = queues.get(key) ?? Promise.resolve();
    let started = false;
    const pending = previous.catch(() => {}).then(() => { started = true; return prepare(options); });
    queues.set(key, pending);
    const cleanup = () => { if (queues.get(key) === pending) queues.delete(key); };
    void pending.then(cleanup, cleanup);
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => { if (!started) reject(error('ABORTED')); };
      signal.addEventListener('abort', abort, { once: true });
      void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  };
}

/** Host-only Windows x64/macOS arm64/x64; never initializes/authenticates an app. */
export function createRuntimeProvisioner(options) {
  return provisioner(options);
}

// Not a production pin/platform override. Only node:test workers can construct
// fixture provisioners; the host API above always uses official immutable pins.
export function createRuntimeProvisionerForTest(options, fixtures) {
  if (!process.env.NODE_TEST_CONTEXT) throw error('TEST_ONLY');
  return provisioner(options, fixtures);
}
