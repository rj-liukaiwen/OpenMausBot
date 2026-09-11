import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Hashes are checked before signing. Only Developer-ID-signed bytes under
 * the sealed main app may differ afterwards. No ad-hoc/PATH/renderer override. */
export function createFeishuSignatureVerifier(resources, platform = process.platform, run = execute) {
  const appRoot = path.resolve(resources, '..', '..');
  const root = path.join(resources, 'tuantuan-feishu-runtime');
  const codesign = (args, signal) => run('/usr/bin/codesign', args, {
    shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' }, signal,
  });
  return async (file, { signal } = {}) => {
    if (platform !== 'darwin' || !appRoot.endsWith('.app')) return false;
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try {
      signal?.throwIfAborted();
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) return false;
      await codesign(['--verify', '--strict', '--deep', appRoot], signal);
      const identity = await codesign(['--display', '--verbose=4', appRoot], signal);
      const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(identity.stderr)?.[1];
      if (!team) return false;
      await codesign(['--verify', '--strict', '-R',
        `anchor apple generic and certificate leaf[subject.OU] = "${team}"`, file], signal);
      return true;
    } catch { signal?.throwIfAborted(); return false; }
  };
}
