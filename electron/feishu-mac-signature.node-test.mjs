import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createFeishuSignatureVerifier } from './feishu-mac-signature.mjs';

test('changed Mac bytes require an intact app and the exact Developer ID Team, never arbitrary PATH', async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'feishu-signature-test-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const resources = path.join(base, 'Fixture.app', 'Contents', 'Resources');
  const file = path.join(resources, 'tuantuan-feishu-runtime', 'fixture', 'node');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'synthetic Mach-O');
  const calls = [];
  let team = 'ABCDEFGHIJ';
  let rejectSeal = false;
  const verifier = createFeishuSignatureVerifier(resources, 'darwin', async (command, args, options) => {
    calls.push(args); assert.equal(command, '/usr/bin/codesign'); assert.equal(options.shell, false);
    if (rejectSeal) throw new Error('synthetic seal failure');
    return { stdout: '', stderr: args.includes('--display') ? `TeamIdentifier=${team}\n` : '' };
  });
  assert.equal(await verifier(file), true);
  assert.deepEqual(calls[0], ['--verify', '--strict', '--deep', path.join(base, 'Fixture.app')]);
  assert.deepEqual(calls.at(-1), ['--verify', '--strict', '-R',
    'anchor apple generic and certificate leaf[subject.OU] = "ABCDEFGHIJ"', file]);
  team = 'not set'; assert.equal(await verifier(file), false);
  team = 'ABCDEFGHIJ'; rejectSeal = true; assert.equal(await verifier(file), false);
  calls.length = 0;
  assert.equal(await verifier(path.join(base, 'unrelated-node')), false);
  assert.equal(calls.length, 0);
});
