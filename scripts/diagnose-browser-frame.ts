// Subscribe to existing loopback stream only. No CLI launch, navigation, input or file writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBrowserLiveMessage } from '../server/browser-live.ts';
const descriptor = process.argv[2];
const watch = process.argv.includes('--watch');
assert(descriptor?.endsWith('.stream'));
const port = Number(readFileSync(descriptor, 'utf8').trim());
assert(Number.isInteger(port) && port > 0 && port < 65536);
const socket = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=1`);
const timer = setTimeout(() => { console.log(JSON.stringify({ phase: 'timeout' })); socket.close(); }, watch ? 35000 : 8000);
socket.addEventListener('message', ({ data }) => {
  if (typeof data !== 'string') return;
  const message = JSON.parse(data);
  if (message.type !== 'frame') { console.log(JSON.stringify({ type: message.type })); return; }
  console.log(JSON.stringify({ type: 'frame', accepted: !!normalizeBrowserLiveMessage(message), seq: message.seq,
    bytes: message.data?.length, jpeg: message.data?.startsWith('/9j/'), png: message.data?.startsWith('iVBORw0KGgo'),
    metadata: message.metadata }));
  if (watch) socket.send(JSON.stringify({ type: 'ack', seq: message.seq }));
  else { clearTimeout(timer); socket.close(); }
});
socket.addEventListener('error', (event) => { console.log(JSON.stringify({ phase: 'socket-error', reason: (event as ErrorEvent).message })); clearTimeout(timer); });
socket.addEventListener('close', (event) => { console.log(JSON.stringify({ phase: 'socket-close', code: event.code, clean: event.wasClean })); clearTimeout(timer); });
