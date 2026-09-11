// Run the production mutex/error boundary in real Windows PowerShell, never the user's launcher/app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const source = await readFile(new URL('../scripts/start-local-windows.ps1', import.meta.url), 'utf8');
const boundary = source.slice(source.indexOf('$launcherMutex = [Threading.Mutex]'));
assert(boundary.startsWith('$launcherMutex ='), 'Test must execute the production mutex boundary');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ruijie-launcher-lock-'));
  const events = path.join(directory, 'events.txt');
  const children = [];
  const mutex = `Local\\RuijieBotLauncherTest-${randomUUID()}`;
  const readEvents = () => readFile(events, 'utf8').catch(() => '');
  const start = (body, popupDelay = 0) => {
    // Scale only the old 60-second timeout: contention outlives it, exactly as in the user log.
    const script = `$ErrorActionPreference = 'Stop'
function Record([string]$line) { [IO.File]::AppendAllText(${quote(events)}, $line + [Environment]::NewLine) }
function Invoke-Launcher { ${body} }
function Show-LaunchFailure([string]$message) { Record 'popup'; Start-Sleep -Milliseconds ${popupDelay} }
${boundary.replace('Local\\RuijieBotDevLauncher', mutex).replace('[TimeSpan]::FromSeconds(60)', '[TimeSpan]::FromMilliseconds(100)')}`;
    const executable = path.join(process.env.SYSTEMROOT || process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { output += part; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve({ code, output })); });
    children.push({ child, done }); return done;
  };
  const until = async (line) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await readEvents()).split(/\r?\n/).includes(line)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Fixture did not reach ${line}`);
  };
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(({ done }) => done));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { start, until, readEvents };
}

test('a repeated shortcut click during a slow startup does not show a false error or launch a second app', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const first = f.start("Record 'first-started'; Start-Sleep -Milliseconds 1500; Record 'first-ready'");
  await f.until('first-started');
  const second = await f.start("Record 'duplicate-started'");
  assert.equal(second.code, 0, `A duplicate click is not startup failure: ${second.output}`);
  assert.equal((await first).code, 0);
  assert.equal(await f.readEvents(), 'first-started\r\nfirst-ready\r\n');
});

test('a real startup failure releases its mutex before showing the modal error', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const first = f.start("throw 'fixture startup failure'", 1500);
  await f.until('popup');
  const retry = await f.start("Record 'retry-ready'");
  assert.equal(retry.code, 0, `An old error dialog must not lock out retry: ${retry.output}`);
  assert.equal((await first).code, 1, 'The real startup failure must remain a failure');
  assert.equal(await f.readEvents(), 'popup\r\nretry-ready\r\n');
});
