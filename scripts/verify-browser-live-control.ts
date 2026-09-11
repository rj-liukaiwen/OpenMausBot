// Native browser control acceptance, isolated from the operator's app and logins.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname } from 'node:path';
import { bundleInventory } from './prepare-browser.mjs';
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { openSse, type SseRecorder } from "../server/testing/sse.ts";
import { browserSessionId, closeBrowserSession } from "../server/browser-engine.ts";

const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
assert(binaryPath && executablePath, "Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME.");
const shippedChrome = () => bundleInventory(dirname(executablePath)).filter((entry: { path: string }) => entry.path !== 'debug.log');
const originalChrome = shippedChrome();
const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath, executablePath });
let stream: SseRecorder | undefined;
let botId = "";
let acknowledge: NodeJS.Timeout | undefined;
let readyPages = 0;
let observedInput = "";
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "fixture page did not report the expected DOM state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const page = createServer((req, res) => {
  if (req.url === "/slow") return; // deterministic navigation timeout; no external network
  if (req.url === "/ready") { readyPages++; res.end("ok"); return; }
  if (req.url?.startsWith("/observed?")) { observedInput = new URL(req.url, "http://localhost").searchParams.get("value") ?? ""; res.end("ok"); return; }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><title>Browser control fixture</title><body style="background:white;color:black"><h1>Browser control fixture</h1><input autofocus id="input" aria-label="Fixture input"><script>const field=document.getElementById("input");field.focus();field.oninput=()=>fetch("/observed?value="+encodeURIComponent(field.value));fetch("/ready");</script></body>');
});
async function api(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(40_000),
  });
  const result = await response.json();
  assert(response.ok, `${method} ${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
try {
  page.listen(0, "127.0.0.1");
  await once(page, "listening");
  await runControlOmb(["new-bot", "--name", "Browser fixture", "--url", fixture.info.url]);
  const { bots } = await api("/api/bots", undefined, "GET");
  botId = bots[0].id;
  await api("/api/config", { features: { browser: true } }, "PATCH");
  console.log(JSON.stringify({ phase: "connect", ...fixture.info, botId }));
  stream = await openSse(`${fixture.info.url}/api/bots/${botId}/browser/live`);
  const { viewerId } = await stream.until((event) => event.viewerId);
  const action = (body: Record<string, unknown>) => api(`/api/bots/${botId}/browser/action`, { ...body, viewerId });
  let seen = 0;
  acknowledge = setInterval(() => {
    for (const event of stream!.frames.slice(seen)) {
      if (event.seq) void action({ type: "ack", seq: event.seq }).catch(() => {});
    }
    seen = stream!.frames.length;
  }, 20);
  await stream.until((event) => event.seq && event.data, 15_000);
  console.log(JSON.stringify({ phase: "initial-frame", ok: true }));
  await action({ type: "take" });
  await stream.until((event) => event.controlling === true);
  console.log(JSON.stringify({ phase: "first-take", ok: true }));
  const address = page.address();
  assert(address && typeof address === "object");
  await action({ type: "navigate", url: `http://127.0.0.1:${address.port}/` });
  await action({ type: "input_mouse", eventType: "mouseMoved", x: 80, y: 80 });
  await action({ type: "input_keyboard", eventType: "char", text: "Browser works" });
  await assert.rejects(action({ type: "navigate", url: "http://127.0.0.1:1/" }), /page could not be opened/);
  // Speak TLS to our plain HTTP fixture to exercise Chromium SSL diagnostics.
  // Native headless-shell may append debug.log. No shipped bytes may change;
  // preview preparation archives that exact extra file, never rebuilds blindly.
  await assert.rejects(action({ type: 'navigate', url: `https://127.0.0.1:${address.port}/` }), /page could not be opened/);
  assert.deepEqual(shippedChrome(), originalChrome, 'Browser use modified shipped Chrome resources');
  console.log(JSON.stringify({ phase: "offline-navigation-recovered", ok: true }));
  const timeoutStarted = Date.now();
  await assert.rejects(action({ type: "navigate", url: `http://127.0.0.1:${address.port}/slow` }), /page could not be opened/);
  assert(Date.now() - timeoutStarted < 28_000, "navigation must confirm cancellation before the CLI watchdog");
  console.log(JSON.stringify({ phase: "slow-navigation-cancelled", elapsedMs: Date.now() - timeoutStarted, ok: true }));
  await action({ type: "release" });
  await action({ type: "take" });
  const previousReadyPages = readyPages;
  await action({ type: "navigate", url: `http://127.0.0.1:${address.port}/` });
  await until(() => readyPages > previousReadyPages);
  await action({ type: "input_keyboard", eventType: "char", text: "Recovered" });
  await until(() => observedInput === "Recovered");
  await action({ type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter" });
  await action({ type: "release" });
  console.log(JSON.stringify({ ok: true, checks: ["initial frame", "take", "navigate", "pointer input", "text input", "offline and hanging navigation then release and retake", "actual DOM input value after recovery", "Enter"] }));
} finally {
  clearInterval(acknowledge);
  stream?.close();
  if (botId) await closeBrowserSession(binaryPath, {
    HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir,
    AGENT_BROWSER_SESSION: browserSessionId(botId, ""),
  });
  page.closeAllConnections();
  await new Promise<void>((resolve) => page.close(() => resolve()));
  await fixture.close();
}
