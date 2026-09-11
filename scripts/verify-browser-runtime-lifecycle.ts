// Both startup orders, real MCP + viewer handoff. No model, external site or user profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BrowserRuntime } from '../server/browser-runtime.ts';
import { BrowserLive } from '../server/browser-live.ts';
import { closeBrowserSession } from '../server/browser-engine.ts';
import { openSse, type SseRecorder } from '../server/testing/sse.ts';

const binary = process.env.OMB_VERIFY_BROWSER_BINARY;
const chrome = process.env.OMB_VERIFY_BROWSER_CHROME;
assert(binary && chrome && path.isAbsolute(binary) && path.isAbsolute(chrome));
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ruijie-mcp-stream-')));
const session = `verify-${randomUUID()}`;
const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
  AGENT_BROWSER_SESSION: session, AGENT_BROWSER_EXECUTABLE_PATH: chrome,
  AGENT_BROWSER_HEADLESS: '1', AGENT_BROWSER_NO_WEBMCP: '1', AGENT_BROWSER_RESTORE_SAVE: 'never' };
const runtime = new BrowserRuntime({ idleMs: 2000 });
const reasons: string[] = [];
const live = new BrowserLive({ runtime, log: (line) => { reasons.push(line); console.log(line); } });
const spec = { command: binary, args: ['mcp', '--tools', 'core', '--no-webmcp'], env };
const viewerFirst = process.argv.includes('--viewer-first');
let stream: SseRecorder | undefined;
let ack: NodeJS.Timeout | undefined;
const server = createServer((req, res) => {
  if (req.url === '/live') {
    void live.open({ botId: session, session, spec, owner: 'fixture', isCurrent: () => true, res })
      .catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  } else { res.setHeader('content-type', 'text/html'); res.end('<title>MCP stream fixture</title><h1>Search result fixture</h1>'); }
});
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const navigate = async () => {
    const result = await runtime.agentRpc(session, spec, 'tools/call', { name: 'agent_browser_open', arguments: { url: base } }) as any;
    assert(!result.isError && result.structuredContent?.response?.success === true, 'Native MCP navigation must complete');
  };
  if (!viewerFirst) await navigate();
  console.log(JSON.stringify({ phase: viewerFirst ? 'viewer-first' : 'MCP-first-navigation', ok: true }));
  stream = await openSse(`${base}/live`);
  const { viewerId } = await stream.until((frame) => frame.viewerId);
  let seen = 0;
  ack = setInterval(() => {
    for (const frame of stream!.frames.slice(seen)) if (frame.seq) {
      void live.action({ viewerId, botId: session, owner: 'fixture', body: { type: 'ack', seq: frame.seq } }).catch(() => {});
    }
    seen = stream!.frames.length;
  }, 20);
  await stream.until((frame) => frame.seq, 15_000);
  if (viewerFirst) {
    await navigate();
    assert.equal(reasons.length, 0, 'MCP launch/navigation must not close the existing viewer');
  }
  for (let index = 0; index < 3; index++) {
    await live.action({ viewerId, botId: session, owner: 'fixture', body: { type: 'take' } });
    await live.action({ viewerId, botId: session, owner: 'fixture', body: { type: 'navigate', url: `${base}/human-${index}` } });
    await live.action({ viewerId, botId: session, owner: 'fixture', body: { type: 'release' } });
    await navigate();
    assert.equal(reasons.length, 0, 'Human/agent alternation must preserve the same stream');
  }
  // A heartbeat after expiry proves the original stream remains open, not a
  // successful reconnect to a replacement browser with lost state.
  const before = stream.frames.length;
  await stream.until((frame) => stream!.frames.indexOf(frame) >= before && Object.keys(frame).length === 0, 15_000);
  assert.equal(reasons.length, 0, 'MCP idle cleanup must not close the live browser');
  console.log(JSON.stringify({ ok: true, order: viewerFirst ? 'viewer-first' : 'MCP-first', checks: ['viewer receives real page', 'three real human/MCP handoffs preserve original stream', 'original viewer survives MCP idle cleanup'] }));
} finally {
  clearInterval(ack); stream?.close(); live.closeAll();
  await runtime.closeAll();
  await closeBrowserSession(binary, env);
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
