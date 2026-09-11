import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const MAX_EXECUTABLE = 160 * 1024 * 1024;

/** Reject scripts, dylibs, fat/wrong-arch binaries before spawning anything. */
export function nativeExecutable(bytes, platform, arch) {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    return bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (arch === 'arm64' ? 0x100000c : 0x1000007) &&
      bytes.readUInt32LE(12) === 2; // MH_EXECUTE, not a library/bundle
  }
  if (platform !== 'win32' || arch !== 'x64' || bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const pe = bytes.readUInt32LE(0x3c);
  return pe >= 64 && pe + 26 <= bytes.length && bytes.readUInt32LE(pe) === 0x4550 &&
    bytes.readUInt16LE(pe + 4) === 0x8664 && (bytes.readUInt16LE(pe + 22) & 2) !== 0 &&
    (bytes.readUInt16LE(pe + 22) & 0x2000) === 0 && bytes.readUInt16LE(pe + 24) === 0x20b;
}

/** Only return the fixed regular member in memory. Never extract archive paths
 * or follow archive symlinks (Node's archive includes npm/npx symlinks). */
export function readPinnedTarMember(archive, member, digest) {
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: 300 * 1024 * 1024 }); }
  catch { fail('INVALID_ARCHIVE'); }
  const field = (header, from, length) => header.subarray(from, from + length).toString('utf8').split('\0')[0];
  const octal = (header, from, length) => {
    const value = field(header, from, length).trim();
    if (!/^[0-7]+$/.test(value)) fail('INVALID_ARCHIVE');
    const result = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(result)) fail('INVALID_ARCHIVE');
    return result;
  };
  let selected;
  let terminated = false;
  let nextName;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0)) fail('INVALID_ARCHIVE');
      terminated = true;
      break;
    }
    const checksum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (octal(header, 148, 8) !== checksum) fail('INVALID_ARCHIVE');
    const prefix = field(header, 345, 155);
    const rawName = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
    const type = header[156];
    const size = octal(header, 124, 12);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) fail('INVALID_ARCHIVE');
    const contents = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 76 || type === 120) { // GNU long name / per-member PAX
      if (nextName !== undefined || size > 16 * 1024) fail('INVALID_ARCHIVE');
      if (type === 76) nextName = contents.toString('utf8').replace(/\0$/, '');
      else {
        const seen = new Set();
        for (let cursor = 0; cursor < contents.length;) {
          const space = contents.indexOf(32, cursor);
          const digits = contents.subarray(cursor, space).toString('ascii');
          if (space < cursor || !/^[1-9][0-9]*$/.test(digits)) fail('INVALID_ARCHIVE');
          const length = Number(digits);
          if (length <= space - cursor + 2 || cursor + length > contents.length || contents[cursor + length - 1] !== 10) fail('INVALID_ARCHIVE');
          const line = contents.subarray(space + 1, cursor + length - 1).toString('utf8');
          const equal = line.indexOf('=');
          const key = line.slice(0, equal), value = line.slice(equal + 1);
          // Never ignore a size/sparse override and parse the wrong payload.
          if (equal <= 0 || seen.has(key) || !['path', 'linkpath', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)) fail('INVALID_ARCHIVE');
          seen.add(key); if (key === 'path') nextName = value;
          cursor += length;
        }
        if (!seen.size) fail('INVALID_ARCHIVE');
      }
      offset = next; continue;
    }
    if (![0, 48, 49, 50, 53].includes(type)) fail('INVALID_ARCHIVE');
    const name = nextName ?? rawName;
    nextName = undefined;
    if (!name || name.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(name) ||
        name.split('/').some((part) => part === '.' || part === '..')) fail('INVALID_ARCHIVE');
    if (name === member) {
      if (selected || ![0, 48].includes(type) || size > MAX_EXECUTABLE) fail('INVALID_ARCHIVE');
      selected = contents;
    }
    offset = next;
  }
  if (!terminated || !selected || nextName !== undefined) fail('INVALID_ARCHIVE');
  if (createHash('sha256').update(selected).digest('hex') !== digest) fail('CHECKSUM_MISMATCH');
  return selected;
}

export function extractPinnedTarExecutable(archive, member, digest, platform, arch) {
  const bytes = readPinnedTarMember(archive, member, digest);
  if (!nativeExecutable(bytes, platform, arch)) fail('INVALID_EXECUTABLE');
  return bytes;
}
