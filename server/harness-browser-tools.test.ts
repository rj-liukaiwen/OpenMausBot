import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "./harness-browser-tools.ts";
import { withoutHarnessWebSearch } from "./drivers/ruijie-harness-preset.ts";

function fixture() {
  const tools: any[] = [];
  const section = vi.fn();
  apply({ tools: { register: (tool) => tools.push(tool) }, systemPrompt: { section } }, { url: "http://127.0.0.1:12345", token: "fixture-only" });
  const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    expect(String(url)).toBe("http://127.0.0.1:12345/api/internal/browser/mcp");
    expect(init.headers.authorization).toBe("Bearer fixture-only");
    calls.push(JSON.parse(init.body));
    return Response.json({ result: { structuredContent: { response: { success: true } }, content: [{ type: "text", text: "native fixture page" }] } });
  }));
  return { calls, tools, run: (name: string, args: any, signal = new AbortController().signal) => tools.find((tool) => tool.name === name).execute(args, { signal }) };
}
afterEach(() => vi.unstubAllGlobals());

describe("Bot-owned Harness browser aliases", () => {
  it("routes both search spellings through the scoped native browser, never an external search provider", async () => {
    const f = fixture();
    expect(await f.run("browser_search", { query: "AI 新闻" })).toContain("native fixture page");
    expect(await f.run("web_search", { queries: ["second", "third"] })).toContain("native fixture page");
    expect(f.calls.map((call) => call.params.name)).toEqual(Array(3).fill(["agent_browser_open", "agent_browser_get_text"]).flat());
    expect(f.calls[0].params.arguments.url).toBe("https://cn.bing.com/search?q=AI%20%E6%96%B0%E9%97%BB");
    expect(f.tools.every((tool) => tool.isConcurrencySafe() === false)).toBe(true);
  });
  it("reads the current Bot page without navigating, and routes page aliases to the same browser", async () => {
    const f = fixture();
    await f.run("browser_read_current", {});
    expect(f.calls.map((call) => call.params.name)).toEqual(["agent_browser_get_text"]);
    for (const name of ["browser_open", "read_page", "web_fetch"]) await f.run(name, { url: "https://example.test/article" });
    expect(f.calls).toHaveLength(7);
  });
  it("does not fall back or continue reading after native refusal, takeover or cancellation", async () => {
    const f = fixture();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ result: { isError: true, content: [{ type: "text", text: "Human controls this browser" }] } }));
    await expect(f.run("web_search", { queries: ["one", "two"] })).rejects.toThrow("Human controls");
    expect(fetch).toHaveBeenCalledTimes(1);
    const abort = new AbortController(); abort.abort();
    await expect(f.run("browser_search", { query: "one" }, abort.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid input before issuing any native action", async () => {
    const f = fixture();
    for (const url of ["file:///secret", "https://user:password@example.test"]) {
      await expect(async () => f.run("read_page", { url })).rejects.toThrow();
    }
    await expect(f.run("web_search", { queries: ["valid", ""] })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires native success, not just a nonempty message such as Queued", async () => {
    const f = fixture();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ result: { structuredContent: { response: { success: false } }, content: [{ type: "text", text: "Queued" }] } }));
    await expect(f.run("browser_search", { query: "one" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps script tags and unrelated nested settings, disabling search and fetch only in the Bot preset", () => {
    const base = "- name: cordis:group\n  config:\n    - name: '@deepseek-ai/dsh-tool-web'\n      config:\n        searchTimeoutMs: 60000\n- name: shell\n  disabled: !!js process.platform !== 'win32'\n";
    const result = withoutHarnessWebSearch(base);
    expect(result).toContain("search: false"); expect(result).toContain("fetch: false");
    expect(result).toContain("searchTimeoutMs: 60000"); expect(result).toContain("!!js process.platform !== 'win32'");
    expect(base).not.toContain("search: false");
    expect(() => withoutHarnessWebSearch("{}" )).toThrow("plugin list");
  });
});
