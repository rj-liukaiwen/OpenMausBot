import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerActionRequested,
  computerMutationRequested,
  compatibleHarnessEffort,
  parseLaunchArguments,
  RuijieHarnessDriver,
  defaultRuijieBridgePath,
  toolResultImageAttachment,
} from "./ruijie-harness.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { computerPrompt } from "../system-prompt.ts";
import { ruijieHarnessLocator, RuijieHarnessDormantError } from "./ruijie-harness-local.ts";

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;

  constructor(readonly url: URL) {
    super();
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  frame(payload: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "server-request", rpcId: crypto.randomUUID(), method: "events.mux", payload,
    }) }));
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

describe("Ruijie Harness driver", () => {
  const calls: Array<{ method: string; payload: any }> = [];
  let sessionCreateFailuresRemaining = 0;

  beforeEach(() => {
    FakeSocket.instances = [];
    sessionCreateFailuresRemaining = 0;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/__dsh_desktop/ruijie-account")) {
        return Response.json({
          authentication: "sso",
          account: { id: "608", name: "王允尚", email: "wangyunshang@ruijie.com.cn" },
          billing: { currency: "CNY", total: 100, used: 25, remaining: 75, usedPercent: 25 },
          fetchedAt: "2026-09-03T00:00:00.000Z",
        });
      }
      const body = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: any };
      calls.push({ method: body.method, payload: body.payload });
      if (url.pathname.endsWith("session.create") && sessionCreateFailuresRemaining > 0) {
        sessionCreateFailuresRemaining -= 1;
        return Response.json({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: false, error: { message: "preset failed to mount" } },
        });
      }
      if (url.pathname.endsWith("session.selectModel")
        && body.payload.provider === "deepseek-vision"
        && body.payload.reasoningEffort === "medium") {
        return Response.json({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: false, error: { code: "model-unavailable", message: "unsupported reasoning effort" } },
        });
      }
      let value: unknown = {};
      if (url.pathname.endsWith("host.describe")) value = { version: "0.0.1" };
      if (url.pathname.endsWith("llm.models")) value = {
        groups: [
          { id: "deepseek-official", name: "DeepSeek", models: [
            { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
            { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
          ] },
          { id: "anthropic", name: "Claude", models: [
            { id: "claude-fable-5", name: "Claude Fable 5" },
            { id: "claude-opus-5", name: "Claude Opus 5" },
            { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
          ] },
          { id: "openai", name: "GPT", models: [
            { id: "gpt-6-astra", name: "gpt-6-astra" },
            { id: "gpt-5.6-sol", name: "gpt-5.6-sol 旗舰模型" },
            { id: "gpt-5.6-terra", name: "gpt-5.6-terra 均衡模型" },
            { id: "gpt-5.6-luna", name: "gpt-5.6-luna 经济模型" },
            { id: "gpt-5.5", name: "gpt-5.5" },
          ] },
          { id: "deepseek-vision", name: "DeepSeek Vision", models: [
            { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", reasoning: {
              efforts: ["off", "low", "high", "max"].map((id) => ({ id, name: id })),
              defaultEffort: "low",
            } },
            { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", reasoning: {
              efforts: ["off", "low", "high", "max"].map((id) => ({ id, name: id })),
              defaultEffort: "low",
            } },
          ] },
        ],
        failures: [],
      };
      if (url.pathname.endsWith("agentPreset.list")) value = {
        presets: [{ id: "standard", trust: "system", isDefault: true }],
        authorable: true,
        hasDocument: true,
      };
      if (url.pathname.endsWith("agentPreset.read")) value = {
        agentPreset: "standard",
        trust: "system",
        content: "- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'\n- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  config:\n    fetch: false\n    searchTimeoutMs: 60000\n",
      };
      if (url.pathname.endsWith("session.create")) value = { sessionId: "session-fixture" };
      if (url.pathname.endsWith("session.selectModel")) value = { selected: body.payload };
      if (url.pathname.endsWith("session.history")) value = {
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: 42,
          values: {
            tokenUsage: {
              uncachedInputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 70,
              cacheWriteTokens: 30,
            },
          },
        },
      };
      if (url.pathname.endsWith("session.attachment")) value = {
        attachment: { mediaType: "image/png" },
        data: "cG5nLWZyYW1l",
      };
      if (url.pathname.endsWith("session.prompt") || url.pathname.endsWith("session.cancel")) value = { accepted: true };
      return Response.json({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } });
    }));
  });

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it("only requires computer evidence for action requests", () => {
    expect(computerActionRequested("打开浏览器并搜索今天的 AI 新闻")).toBe(true);
    expect(computerActionRequested("Search the web for today's AI news")).toBe(true);
    expect(computerActionRequested("解释量子纠缠的基本原理")).toBe(false);
    expect(computerActionRequested("What is open source software?")).toBe(false);
  });

  it("distinguishes state inspection from requests that must change the computer", () => {
    expect(computerMutationRequested("打开浏览器并搜索今天的 AI 新闻")).toBe(true);
    expect(computerMutationRequested("查看桌面")).toBe(false);
    expect(computerMutationRequested("take a screenshot")).toBe(false);
  });

  it("uses the shared app-data discovery location on Windows", () => {
    expect(defaultRuijieBridgePath("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "C:\\Users\\test"))
      .toBe("C:\\Users\\test\\AppData\\Roaming\\锐捷 Harness\\openmaus-bridge.json");
  });

  it("accepts only a JSON string array for development CLI arguments", () => {
    expect(parseLaunchArguments('["D:\\\\Harness\\\\lib\\\\main.js","--openmaus-server"]')).toEqual([
      "D:\\Harness\\lib\\main.js",
      "--openmaus-server",
    ]);
    expect(parseLaunchArguments('{"unsafe":true}')).toEqual([]);
    expect(parseLaunchArguments('not-json')).toEqual([]);
  });

  it("binds the Bot effort scale to each Harness model without invalid values", () => {
    const deepseek = ["off", "low", "high", "max"] as const;
    const gpt = ["off", "low", "medium", "high", "xhigh", "max"] as const;
    expect(compatibleHarnessEffort("none", deepseek)).toBe("off");
    expect(compatibleHarnessEffort("medium", deepseek)).toBe("high");
    expect(compatibleHarnessEffort("xhigh", deepseek)).toBe("max");
    expect(compatibleHarnessEffort("medium", gpt)).toBe("medium");
    expect(compatibleHarnessEffort("high", [])).toBeUndefined();
  });

  it("lets an explicit catalog refresh launch Harness on demand", async () => {
    const source = await readFile(new URL("./ruijie-harness.ts", import.meta.url), "utf8");
    const refreshModels = source.match(/const refreshModels = async \(\) => \{[\s\S]*?\n    \};/u)?.[0];
    expect(refreshModels).toContain("resolveEndpoint(input.config, true)");
  });

  it("keeps the installed dormant catalog selectable without inventing authentication", async () => {
    const probe = vi.spyOn(ruijieHarnessLocator, "ensureEndpoint").mockRejectedValue(new RuijieHarnessDormantError());
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {}, config: {},
      });
      const snapshot = await instance.snapshot();
      expect(snapshot.state).toBe("available");
      expect(snapshot.authenticated).toBeUndefined();
      expect(snapshot.sso).toBeUndefined();
      expect(instance.models.options.length).toBe(10);
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ autoLaunch: false }));
    } finally { probe.mockRestore(); }
  });

  it("reports the same SSO identity and wallet as the running Harness", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });

    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      authenticated: true,
      sso: {
        authentication: "sso",
        account: { id: "608", name: "王允尚", email: "wangyunshang@ruijie.com.cn" },
        billing: { currency: "CNY", remaining: 75 },
      },
    });
  });

  it("synchronizes the model catalog while reporting an available Harness", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });

    await expect(instance.snapshot()).resolves.toMatchObject({ state: "available" });
    expect(instance.models).toEqual({
      default: "deepseek-vision::deepseek-v4-flash",
      options: [
        { id: "anthropic::claude-fable-5", label: "Claude Fable 5", provider: "anthropic" },
        { id: "anthropic::claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
        { id: "anthropic::claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
        { id: "openai::gpt-6-astra", label: "gpt-6-astra", provider: "openai" },
        { id: "openai::gpt-5.6-sol", label: "gpt-5.6-sol 旗舰模型", provider: "openai" },
        { id: "openai::gpt-5.6-terra", label: "gpt-5.6-terra 均衡模型", provider: "openai" },
        { id: "openai::gpt-5.6-luna", label: "gpt-5.6-luna 经济模型", provider: "openai" },
        { id: "openai::gpt-5.5", label: "gpt-5.5", provider: "openai" },
        { id: "deepseek-vision::deepseek-v4-flash", label: "DeepSeek-V4-Flash", provider: "deepseek-vision" },
        { id: "deepseek-vision::deepseek-v4-pro", label: "DeepSeek-V4-Pro", provider: "deepseek-vision" },
      ],
    });
    expect(calls.map((call) => call.method)).toContain("llm.models");
  });

  it("reads authoritative cumulative usage from a Harness session projection", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });

    await expect(instance.readSessionUsage?.("session-history")).resolves.toEqual({
      input: 200,
      output: 20,
      cachedInput: 70,
    });
    expect(calls.at(-1)).toEqual({ method: "session.history", payload: { sessionId: "session-history", maxMessages: 1 } });
  });

  it("forwards a turn through the live Harness session API and maps its result", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    await instance.refreshModels?.();
    const started = await instance.adapter.sendTurn({ threadId: "thread-1", text: "你好", model: "gpt::gpt-5.6-luna", cwd: "C:\\work" });

    const socket = FakeSocket.instances[0]!;
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/start", data: { turn: 1 } } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "assistant/chunk", data: { turn: 1, chunk: { type: "text-delta", text: "完成" } } } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "完成" }] } } } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });

    expect(calls.map((call) => call.method)).toEqual([
      "llm.models", "session.create", "session.selectModel", "session.prompt",
    ]);
    expect(calls.find((call) => call.method === "session.create")?.payload).toEqual({ cwd: "C:\\work" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.started", sessionId: "session-fixture", turnId: started.turnId }),
      expect.objectContaining({ type: "content.delta", delta: "完成" }),
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "完成" }),
      expect.objectContaining({ type: "turn.completed", ok: true, stopReason: "completed" }),
    ]));
  });

  it("sends GPT images as native Harness prompt parts and maps None reasoning to off", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmaus-rjh-image-"));
    const imagePath = join(root, "fixture.png");
    await writeFile(imagePath, Buffer.from("fixture-image"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
      });
      await instance.adapter.sendTurn({
        threadId: "thread-image",
        text: "识别图片",
        model: "openai::gpt-5.6-sol",
        effort: "none",
        images: [{ path: imagePath, mime: "image/png", bytes: 13 }],
      });
      expect(calls.find((call) => call.method === "session.selectModel")?.payload).toMatchObject({
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "off",
      });
      expect(calls.find((call) => call.method === "session.prompt")?.payload.content).toEqual([
        { type: "text", text: "识别图片" },
        { type: "image", mediaType: "image/png", data: Buffer.from("fixture-image").toString("base64") },
      ]);
      expect(instance.adapter.capabilities).toMatchObject({
        images: true,
        nativeImageInput: true,
        effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not forward an unsupported effort to a Harness model", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });
    await instance.refreshModels?.();

    await expect(instance.adapter.sendTurn({
      threadId: "thread-effort-fallback",
      text: "你好",
      model: "deepseek-vision::deepseek-v4-flash",
      effort: "medium",
    })).resolves.toBeDefined();

    expect(calls.findLast((call) => call.method === "session.selectModel")?.payload)
      .toMatchObject({ reasoningEffort: "high" });
  });

  it("does not report success when a selected computer turn never calls a computer tool", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn", dshHome },
      });
      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((event) => events.push(event));
      const started = await instance.adapter.sendTurn({
        threadId: "thread-computer-claim",
        text: "打开浏览器并搜索今天的 AI 新闻",
        system: computerPrompt("vm-shared"),
        integrations: {
          localComputer: {
            command: "C:\\OpenMaus\\cua-driver.exe",
            args: ["mcp", "--direct"],
            env: { OMB_CONTROL_TOKEN: "secret" },
            scope: "local-computer",
          },
        },
      });

      const socket = FakeSocket.instances[0]!;
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/start", data: { turn: 1 } } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "已经在浏览器中搜索完成。" }] } },
      } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "turn/end", data: { turn: 1, reason: { kind: "completed" } },
      } });

      await vi.waitFor(() => expect(calls.filter((call) => call.method === "session.prompt")).toHaveLength(2));
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/start", data: { turn: 2 } } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "确实已经完成。" }] } },
      } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "turn/end", data: { turn: 2, reason: { kind: "completed" } },
      } });

      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        threadId: "thread-computer-claim",
        turnId: started.turnId,
        ok: false,
        stopReason: "computer_not_used",
      })));
      expect(events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("does not count a read-only observation or nested MCP error as performing the requested action", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn", dshHome },
      });
      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((event) => events.push(event));
      const started = await instance.adapter.sendTurn({
        threadId: "thread-computer-read-only",
        text: "打开浏览器并搜索今天的 AI 新闻",
        system: computerPrompt("vm-shared"),
        integrations: {
          localComputer: {
            command: "C:\\OpenMaus\\cua-driver.exe",
            args: ["mcp", "--direct"],
            env: { OMB_CONTROL_TOKEN: "secret" },
            scope: "local-computer",
          },
        },
      });

      const socket = FakeSocket.instances[0]!;
      for (const turn of [1, 2]) {
        const callId = `call-read-only-${turn}`;
        const failedMutation = turn === 2;
        socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
          type: "turn/start", data: { turn },
        } });
        socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
          type: "tool/call", data: {
            turn,
            callId,
            name: failedMutation
              ? "mcp__openmaus_fixture__launch_app"
              : "mcp__openmaus_fixture__get_accessibility_tree",
          },
        } });
        socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
          type: "tool/result", data: {
            turn,
            callId,
            message: failedMutation
              ? {
                  toolCallId: callId,
                  content: [{
                    type: "tool-result",
                    toolCallId: callId,
                    isError: true,
                    content: [{ type: "text", text: "Error: MCP error -32000: Connection closed" }],
                  }],
                }
              : { toolCallId: callId, content: [] },
          },
        } });
        socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
          type: "assistant/message", data: { turn, message: { content: [{ type: "text", text: "已经打开并搜索完成。" }] } },
        } });
        socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
          type: "turn/end", data: { turn, reason: { kind: "completed" } },
        } });
        if (turn === 1) {
          await vi.waitFor(() => expect(calls.filter((call) => call.method === "session.prompt")).toHaveLength(2));
        }
      }

      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "turn.completed",
        threadId: "thread-computer-read-only",
        turnId: started.turnId,
        ok: false,
        stopReason: "computer_not_used",
      })));
      expect(events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("retries a computer action once and only publishes the tool-backed answer", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn", dshHome },
      });
      const events: RuntimeEvent[] = [];
      instance.adapter.onEvent((event) => events.push(event));
      const started = await instance.adapter.sendTurn({
        threadId: "thread-computer-retry-action",
        text: "打开浏览器并搜索今天的 AI 新闻",
        system: computerPrompt("vm-shared"),
        integrations: {
          localComputer: {
            command: "C:\\OpenMaus\\cua-driver.exe",
            args: ["mcp", "--direct"],
            env: { OMB_CONTROL_TOKEN: "secret" },
            scope: "local-computer",
          },
        },
      });

      const socket = FakeSocket.instances[0]!;
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/start", data: { turn: 1 } } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "假的完成说明" }] } },
      } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
      await vi.waitFor(() => expect(calls.filter((call) => call.method === "session.prompt")).toHaveLength(2));

      const callId = "call-computer";
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/start", data: { turn: 2 } } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "tool/call", data: { turn: 2, callId, name: "mcp__openmaus_fixture__launch_app" },
      } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "tool/result", data: { turn: 2, callId, message: { toolCallId: callId, content: [] } },
      } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "真实工具执行后的结果" }] } },
      } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } } });

      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: "turn.completed", threadId: "thread-computer-retry-action", turnId: started.turnId, ok: true,
      })));
      expect(events).toContainEqual(expect.objectContaining({
        type: "item.completed", itemType: "assistant_text", text: "真实工具执行后的结果",
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        type: "item.completed", itemType: "assistant_text", text: "假的完成说明",
      }));
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("reports each Harness turn's provider token usage without double-counting streamed samples", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({ threadId: "thread-usage", text: "统计", cwd: "C:\\work" });

    const socket = FakeSocket.instances[0]!;
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
      type: "turn/start", data: { turn: 1 },
    } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
      type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "usage", usage: {
        inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2,
      } } },
    } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
      type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [] }, usage: {
        inputTokens: 11, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 2,
      } },
    } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
      type: "assistant/message", data: { turn: 1, step: 2, message: { role: "assistant", content: [] }, usage: {
        inputTokens: 20, outputTokens: 5, cacheReadTokens: 7,
      } },
    } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
      type: "turn/end", data: { turn: 1, reason: { kind: "completed" } },
    } });

    expect(events).toContainEqual(expect.objectContaining({
      type: "turn.completed",
      usage: { input: 45, output: 9, cachedInput: 12 },
    }));
  });

  it("emits the target-window screenshot returned by a CUA observation", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    const started = await instance.adapter.sendTurn({ threadId: "thread-screen", text: "演示", cwd: "C:\\work" });
    const socket = FakeSocket.instances[0]!;
    const callId = "call-screen";
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
      type: "tool/call", data: { turn: 1, callId, name: "mcp__computer__get_window_state" },
    } });
    socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
      type: "tool/result", data: { turn: 1, message: {
        source: { kind: "tool", callId },
        content: [{ type: "tool-result", toolCallId: callId, content: [{
          type: "image",
          attachment: { attachmentId: `sha256:${"b".repeat(64)}`, mediaType: "image/png" },
        }] }],
      } },
    } });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "screen.frame",
      threadId: "thread-screen",
      turnId: started.turnId,
      png: "cG5nLWZyYW1l",
      mime: "image/png",
    })));
    expect(calls).toContainEqual({
      method: "session.attachment",
      payload: { sessionId: "session-fixture", attachmentId: `sha256:${"b".repeat(64)}` },
    });
  });

  it("mounts OpenMaus computer MCP through a managed Harness user preset", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });

      expect(instance.adapter.capabilities).toMatchObject({ computerMcp: true, localComputerMcp: true });
      await instance.adapter.sendTurn({
        threadId: "thread-computer",
        text: "查看桌面",
        cwd: "C:\\work",
        integrations: {
          localComputer: {
            command: "C:\\OpenMaus\\cua-driver.exe",
            args: ["mcp", "--socket", "C:\\Temp\\cua.sock"],
            env: { OMB_CONTROL_TOKEN: "secret" },
            scope: "local-computer",
          },
        },
      });

      const create = calls.find((call) => call.method === "session.create");
      expect(create?.payload).toMatchObject({ cwd: "C:\\work", agentPreset: expect.stringMatching(/^openmaus-computer-/) });
      const preset = await readFile(join(dshHome, ".agent-presets", create!.payload.agentPreset, "agent.cordis.yml"), "utf8");
      expect(preset).toContain("@deepseek-ai/dsh-mcp-client");
      expect(preset).toContain('command: "C:\\\\OpenMaus\\\\cua-driver.exe"');
      expect(preset).toContain('"OMB_CONTROL_TOKEN":"secret"');
      expect(preset).toContain("failOnStartupError: true");
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("mounts connected apps through a managed Harness user preset", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });

      expect(instance.adapter.capabilities).toMatchObject({ composioMcp: true });
      await instance.adapter.sendTurn({
        threadId: "thread-composio",
        text: "读取 Gmail",
        cwd: "C:\\work",
        integrations: {
          composio: {
            command: "C:\\OpenMaus\\electron.exe",
            args: ["connector-proxy.js"],
            env: { OMB_CONNECTOR_TOKEN: "secret" },
          },
        },
      });

      const create = calls.find((call) => call.method === "session.create");
      expect(create?.payload).toMatchObject({ cwd: "C:\\work", agentPreset: expect.stringMatching(/^openmaus-composio-/) });
      const preset = await readFile(join(dshHome, ".agent-presets", create!.payload.agentPreset, "agent.cordis.yml"), "utf8");
      expect(preset).toMatch(/serverName: omb_[a-f0-9]{24}/);
      const serverName = preset.match(/serverName: (\S+)/)?.[1];
      expect(serverName).toBeTruthy();
      expect(serverName!.length).toBeLessThanOrEqual(32);
      expect(preset).toContain('command: "C:\\\\OpenMaus\\\\electron.exe"');
      expect(preset).toContain('"OMB_CONNECTOR_TOKEN":"secret"');
      expect(preset).toContain("failOnStartupError: false");
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("mounts the built-in browser through a managed Harness user preset", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });

      expect(instance.adapter.capabilities).toMatchObject({ browserMcp: true });
      await instance.adapter.sendTurn({
        threadId: "thread-browser",
        text: "打开网页",
        cwd: "C:\\work",
        integrations: {
          browser: {
            command: "C:\\OpenMaus\\electron.exe",
            args: ["browser-proxy.js"],
            env: { OMB_BROWSER_TOKEN: "secret" },
          },
        },
      });

      const create = calls.find((call) => call.method === "session.create");
      expect(create?.payload).toMatchObject({ cwd: "C:\\work", agentPreset: expect.stringMatching(/^openmaus-browser-/) });
      const preset = await readFile(join(dshHome, ".agent-presets", create!.payload.agentPreset, "agent.cordis.yml"), "utf8");
      expect(preset).toContain('command: "C:\\\\OpenMaus\\\\electron.exe"');
      expect(preset).toContain('"OMB_BROWSER_TOKEN":"secret"');
      expect(preset).toContain("failOnStartupError: false");
      // The standard search defaults to the host provider (which can fall
      // back to anonymous Firecrawl). This bot owns a different browser.
      expect(preset).toContain("search: false");
      expect(preset).toContain("harness-browser-tools");
      expect(preset).toContain("!!js process.platform !== 'win32'");
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("restores bounded conversation context on a fresh browser capability session, but not a reused one", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'openmaus-rjh-test-'));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: 'ruijieHarness', displayName: '锐捷 Harness', enabled: true, environment: {},
        config: { endpoint: 'http://127.0.0.1:49724', expectedAccountEmail: 'wangyunshang@ruijie.com.cn', dshHome },
      });
      const threadId = 'thread-browser-recovery';
      const browser = { command: 'node', args: ['browser-proxy.js'], env: { OMB_BROWSER_TOKEN: 'synthetic-first' } };
      const first = await instance.adapter.sendTurn({ threadId, text: '继续',
        integrations: { browser }, resumeCursor: 'session-before-restart', recoveryText: 'Prior task: read page A. Current request: 继续' });
      expect(calls.filter((call) => call.method === 'session.prompt').at(-1)?.payload.content[0].text).toContain('Prior task: read page A');
      await instance.adapter.interruptTurn(threadId, first.turnId);
      const second = await instance.adapter.sendTurn({ threadId, text: '继续', integrations: { browser },
        resumeCursor: 'session-fixture', recoveryText: 'DO NOT REPLAY IN A LIVE SESSION' });
      expect(calls.filter((call) => call.method === 'session.prompt').at(-1)?.payload.content[0].text).toBe('继续');
      await instance.adapter.interruptTurn(threadId, second.turnId);
      const third = await instance.adapter.sendTurn({ threadId, text: '继续',
        integrations: { browser: { ...browser, env: { OMB_BROWSER_TOKEN: 'synthetic-rotated' } } },
        resumeCursor: 'session-fixture', recoveryText: 'Recovered task after token rotation' });
      expect(calls.filter((call) => call.method === 'session.create')).toHaveLength(2);
      expect(calls.filter((call) => call.method === 'session.prompt').at(-1)?.payload.content[0].text).toBe('Recovered task after token rotation');
      await instance.adapter.interruptTurn(threadId, third.turnId);
    } finally { await rm(dshHome, { recursive: true, force: true }); }
  });

  it("uses a distinct computer MCP preset for each Harness session", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });
      const localComputer = {
        command: "C:\\OpenMaus\\cua-driver.exe",
        args: ["mcp", "--direct"],
        env: { OMB_CONTROL_TOKEN: "secret" },
        scope: "local-computer" as const,
      };

      await instance.adapter.sendTurn({
        threadId: "thread-computer-a", text: "查看桌面", cwd: "C:\\work",
        integrations: { localComputer },
      });
      await instance.adapter.sendTurn({
        threadId: "thread-computer-b", text: "查看桌面", cwd: "C:\\work",
        integrations: { localComputer },
      });

      const creates = calls.filter((call) => call.method === "session.create");
      expect(creates).toHaveLength(2);
      expect(creates[0]?.payload.agentPreset).not.toBe(creates[1]?.payload.agentPreset);
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("reuses one Harness session when a turn capability rotates through a stable file", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });
      const integration = {
        command: "C:\\OpenMaus\\electron.exe",
        args: ["local-computer-proxy.js"],
        env: { OMB_CONTROL_TOKEN_FILE: "C:\\OpenMaus\\runtime\\thread.token" },
        scope: "local-computer" as const,
      };

      const first = await instance.adapter.sendTurn({
        threadId: "thread-stable-computer", text: "你好", cwd: "C:\\work",
        integrations: { localComputer: integration },
      });
      const socket = FakeSocket.instances[0]!;
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "turn/start", data: { turn: 1 },
      } });
      socket.frame({ type: "session/event", sessionId: "session-fixture", event: {
        type: "turn/end", data: { turn: 1, reason: { kind: "completed" } },
      } });
      await vi.waitFor(() => expect(calls.some((call) => (
        call.method === "session.prompt" && call.payload.sessionId === "session-fixture"
      ))).toBe(true));

      await instance.adapter.sendTurn({
        threadId: "thread-stable-computer", text: "继续", cwd: "C:\\work",
        integrations: { localComputer: integration },
      });

      expect(first.turnId).toBeTruthy();
      expect(calls.filter((call) => call.method === "session.create")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "session.prompt")).toHaveLength(2);
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("does not reuse a mounted computer MCP name after the driver restarts", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const createInstance = () => RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });
      const localComputer = {
        command: "C:\\OpenMaus\\cua-driver.exe",
        args: ["mcp", "--direct"],
        env: { OMB_CONTROL_TOKEN: "secret" },
        scope: "local-computer" as const,
      };

      const first = await createInstance();
      await first.adapter.sendTurn({
        threadId: "thread-computer-retry", text: "查看桌面", cwd: "C:\\work",
        integrations: { localComputer },
      });
      const firstPreset = calls.filter((call) => call.method === "session.create").at(-1)!.payload.agentPreset;

      const restarted = await createInstance();
      await restarted.adapter.sendTurn({
        threadId: "thread-computer-retry", text: "重试", cwd: "C:\\work",
        integrations: { localComputer },
      });
      const secondPreset = calls.filter((call) => call.method === "session.create").at(-1)!.payload.agentPreset;

      expect(firstPreset).not.toBe(secondPreset);
      const firstDocument = await readFile(join(dshHome, ".agent-presets", firstPreset, "agent.cordis.yml"), "utf8");
      const secondDocument = await readFile(join(dshHome, ".agent-presets", secondPreset, "agent.cordis.yml"), "utf8");
      const serverName = (document: string) => document.match(/serverName: (\S+)/)?.[1];
      expect(serverName(firstDocument)).toBeTruthy();
      expect(serverName(firstDocument)).not.toBe(serverName(secondDocument));
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("retries one failed computer MCP mount with a fresh name before sending the turn", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });
      const turn = {
        threadId: "thread-computer-retry", text: "重试", cwd: "C:\\work",
        integrations: {
          localComputer: {
            command: "C:\\OpenMaus\\cua-driver.exe",
            args: ["mcp", "--direct"],
            env: { OMB_CONTROL_TOKEN: "secret" },
            scope: "local-computer" as const,
          },
        },
      };

      sessionCreateFailuresRemaining = 1;
      await instance.adapter.sendTurn(turn);

      const presets = calls
        .filter((call) => call.method === "session.create")
        .map((call) => call.payload.agentPreset);
      expect(presets).toHaveLength(2);
      expect(presets[0]).not.toBe(presets[1]);
      expect(calls.map((call) => call.method)).toEqual([
        "agentPreset.read", "session.create",
        "agentPreset.read", "session.create",
        "session.selectModel", "session.prompt",
      ]);
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("does not prompt the model when every computer MCP mount fails", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "openmaus-rjh-test-"));
    try {
      const instance = await RuijieHarnessDriver.create({
        instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
        config: {
          endpoint: "http://127.0.0.1:49724",
          expectedAccountEmail: "wangyunshang@ruijie.com.cn",
          dshHome,
        },
      });

      sessionCreateFailuresRemaining = 2;
      await expect(instance.adapter.sendTurn({
        threadId: "thread-computer-unavailable", text: "查看桌面", cwd: "C:\\work",
        integrations: {
          localComputer: {
            command: "C:\\OpenMaus\\cua-driver.exe",
            args: ["mcp", "--direct"],
            env: { OMB_CONTROL_TOKEN: "secret" },
            scope: "local-computer",
          },
        },
      })).rejects.toThrow("preset failed to mount");

      expect(calls.filter((call) => call.method === "session.create")).toHaveLength(2);
      expect(calls.some((call) => call.method === "session.prompt")).toBe(false);
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  });

  it("treats Stop as an interruption and emits no red runtime error", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "wangyunshang@ruijie.com.cn" },
    });
    const events: RuntimeEvent[] = [];
    instance.adapter.onEvent((event) => events.push(event));
    const started = await instance.adapter.sendTurn({ threadId: "thread-stop", text: "等待" });
    await instance.adapter.interruptTurn("thread-stop", started.turnId);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "session.cancel")).toBe(true));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn.completed", ok: false, stopReason: "interrupted" }),
    ]));
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("disables Harness when its SSO identity does not match OpenMaus", async () => {
    const instance = await RuijieHarnessDriver.create({
      instanceId: "ruijieHarness", displayName: "锐捷 Harness", enabled: true, environment: {},
      config: { endpoint: "http://127.0.0.1:49724", expectedAccountEmail: "someone.else@ruijie.com.cn" },
    });
    expect(await instance.snapshot()).toMatchObject({
      state: "unavailable",
      authenticated: false,
      reason: expect.stringContaining("账号与 OpenMaus 不一致"),
    });
  });
});

describe("Ruijie Harness computer frames", () => {
  it("finds a CUA screenshot attachment inside a nested tool result", () => {
    expect(toolResultImageAttachment({
      message: {
        content: [{
          type: "tool-result",
          content: [{
            type: "image",
            attachment: {
              attachmentId: `sha256:${"a".repeat(64)}`,
              mediaType: "image/png",
            },
          }],
        }],
      },
    })).toEqual({
      attachmentId: `sha256:${"a".repeat(64)}`,
      mime: "image/png",
    });
  });
});
