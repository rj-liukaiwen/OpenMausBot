import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { StoreProvider } from "@/state/store";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { botSettingsSections } from "./bot-settings/sections";

afterEach(() => setLocale("en"));

const bot = {
  id: "bot-1",
  name: "Plum",
  color: "green",
  modelSelection: { instanceId: "fixture", model: "fixture" },
  messages: [],
} as never as Bot;

describe("Bot settings localization", () => {
  it("keeps the close control in a non-shrinking hit area", () => {
    const source = readFileSync(new URL("./BotSettingsDialog.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/className="relative z-10 flex shrink-0 items-center justify-between bg-panel px-5 py-3"/);
    expect(source).toMatch(/className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md/);
    expect(source).toMatch(/onMouseDown=\{\(event\) => \{[\s\S]*?toggleSettings", open: false/);
    expect(source).toMatch(/<X size=\{18\} className="pointer-events-none"/);
  });
  it("translates every first-level section into Chinese", () => {
    setLocale("zh");
    expect(botSettingsSections().map(({ label }) => label)).toEqual([
      "概览", "身份", "角色设定", "技能", "记忆", "计划", "访问", "模型", "权限", "语音与提醒", "历史", "用量",
    ]);
  });

  it("translates the visible avatar editor into Chinese", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(BotProfileAvatarCard, {
        bot,
        activeState: "idle",
        mascotMotion: null,
        onPatch: () => {},
      }),
    ));
    expect(html).toContain("头像");
    expect(html).toContain("重置吉祥物");
    expect(html).toContain("上传图片");
    expect(html).toContain("形状");
    expect(html).not.toContain(">Avatar<");
  });

  it("renders the dialog rail and search controls in Chinese", async () => {
    (globalThis as { window?: unknown }).window ??= {};
    const { BotSettingsDialog } = await import("./BotSettingsDialog");
    setLocale("zh");
    const html = renderToStaticMarkup(createElement(
      StoreProvider,
      null,
      createElement(BotSettingsDialog, { bot }),
    ));
    expect(html).toContain("概览");
    expect(html).toContain("角色设定");
    expect(html).toContain('placeholder="搜索"');
    expect(html).toContain('aria-label="关闭机器人设置"');
    expect(html).toContain('style="top:env(titlebar-area-height, 0px)"');
    expect(html).not.toContain(">Overview<");
  });

  it("translates the nested cloud backend card into Chinese", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(createElement(CloudBackendPicker, {
      value: "box",
      vpsSupported: false,
      onChange: () => {},
    }));
    expect(html).toContain("云端后端");
    expect(html).toContain("自托管 VPS");
    expect(html).toContain("锐捷沙箱 · 暂时不可用");
    expect(html).not.toContain("Cloud backend");
  });
});
