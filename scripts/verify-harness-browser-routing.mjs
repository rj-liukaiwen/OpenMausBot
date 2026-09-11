// Run with the installed Harness Electron-as-Node and explicit resources.
// Pure disposable Cordis scopes + synthetic loopback broker: no live sessions,
// OAuth, model calls, user presets, or real search-provider quota are touched.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const resources = process.env.OMB_VERIFY_HARNESS_RESOURCES;
assert(resources && path.isAbsolute(resources), 'Explicit installed Harness resources required');
const requireHarness = createRequire(path.join(resources, 'app.asar', 'package.json'));
const load = (name) => import(pathToFileURL(requireHarness.resolve(name)).href);
const [{ Context }, { createScope }, { default: SystemPrompt }, { default: ToolRuntime }, aliases] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
  import(pathToFileURL(fileURLToPath(new URL('../dist-server/harness-browser-tools.js', import.meta.url))).href),
]);
const ctx = new Context();
const calls = [];
let unrelatedCalls = 0;
const server = createServer(async (req, res) => {
  assert.equal(req.url, '/api/internal/browser/mcp');
  assert.equal(req.headers.authorization, 'Bearer fixture-only');
  let body = ''; for await (const part of req) body += part;
  const request = JSON.parse(body); calls.push(request);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ result: { structuredContent: { response: { success: true } }, content: [{ type: 'text', text: request.params.name === 'agent_browser_open' ? 'opened fixture search' : 'fixture page text' }] } }));
});
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime);
  const names = ['browser_search', 'browser_open', 'browser_read_current', 'read_page'];
  for (const name of names) ctx.tools.register({ name, description: 'Unrelated Harness sidebar',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { unrelatedCalls++; return 'unrelated'; },
  });
  const agent = { id: 'fixture-bot-session' };
  let scope;
  await ctx.plugin(Object.assign((inner) => { scope = createScope(inner, agent); }, { inject: ['tools', 'systemPrompt'] }));
  agent.ctx = scope.ctx;
  await scope.ctx.plugin(aliases, { url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-only' });
  const inventory = ctx.tools.schemas(agent);
  assert.equal(inventory.filter((tool) => tool.name === 'browser_search').length, 1, 'Duplicate browser tools');
  assert(inventory.find((tool) => tool.name === 'browser_search').description.includes('RuijieBot'));
  const result = await ctx.tools.execute({ name: 'web_search', arguments: { queries: ['fixture AI news'] }, agent,
    callId: 'fixture-call', signal: new AbortController().signal });
  assert(!result.isError, JSON.stringify(result));
  assert(JSON.stringify(result).includes('fixture page text'), 'No real proxy response');
  assert.deepEqual(calls.map((call) => call.params.name), ['agent_browser_open', 'agent_browser_get_text']);
  assert.equal(unrelatedCalls, 0, 'Wrong sidebar was called');
  assert.equal(ctx.tools.schemas().find((tool) => tool.name === 'browser_search').description, 'Unrelated Harness sidebar');
  console.log(JSON.stringify({ ok: true, checks: ['installed Harness real tool registry', 'bundled standalone browser alias module',
    'Bot scope shadows global sidebar without affecting other sessions', 'web_search invokes native browser proxy only', 'synthetic capability remains scoped'],
    limitation: 'No model call, external search, real account, native browser UI, or final installer acceptance in this fixture.' }));
} finally {
  try { await ctx.fiber.dispose(); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
