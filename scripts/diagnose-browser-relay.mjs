// Read-only live relay diagnostic. Never sends browser actions, ACKs, input or navigation.
// Abort before the normal 20-second ACK deadline. Not an acceptance fixture.
import assert from 'node:assert/strict';
const url = new URL(process.argv[2]);
assert(url.hostname === '127.0.0.1' && url.protocol === 'http:' && /^\/api\/bots\/[\w-]+\/browser\/live$/.test(url.pathname));
const abort = new AbortController();
const started = Date.now();
const timer = setTimeout(() => abort.abort(), 14000);
try {
  const response = await fetch(url, { signal: abort.signal });
  console.log(JSON.stringify({ status: response.status, contentType: response.headers.get('content-type') }));
  assert(response.ok && response.headers.get('content-type')?.includes('text/event-stream'), 'Viewer must receive SSE');
  const decoder = new TextDecoder(); let pending = '';
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    assert(pending.length < 5 * 1024 * 1024);
    let index;
    while ((index = pending.indexOf('\n\n')) >= 0) {
      const event = pending.slice(0, index); pending = pending.slice(index + 2);
      const type = /^event: (.+)$/m.exec(event)?.[1];
      const line = /^data: (.+)$/m.exec(event)?.[1];
      if (!line) continue;
      const value = JSON.parse(line);
      console.log(JSON.stringify({ type, elapsedMs: Date.now() - started,
        ...(type === 'frame' ? { bytes: value.data?.length, seq: value.seq } : {}),
        ...(type === 'error' ? { error: value.message, retryable: value.retryable } : {}),
      }));
    }
  }
  console.log(JSON.stringify({ prematurelyClosed: true, elapsedMs: Date.now() - started }));
  process.exitCode = 1;
} catch (error) {
  if (abort.signal.aborted) console.log(JSON.stringify({ survivedObservation: true, elapsedMs: Date.now() - started }));
  else { console.error(error.message); process.exitCode = 1; }
} finally { clearTimeout(timer); }
