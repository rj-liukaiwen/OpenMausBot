import { describe, expect, it, vi } from "vitest";
import { localFeishuBridge } from "./useFeishu";

describe("Feishu renderer platform boundary", () => {
  const feishu = { state: vi.fn(), invoke: vi.fn() };
  it("uses the supplied local bridge on both Windows and Mac", () => {
    for (const platform of ["win32", "darwin"]) {
      expect(localFeishuBridge({ platform, feishu })).toBe(feishu);
    }
  });
  it("does not invent a bridge or expose host credentials to a remote session", () => {
    expect(localFeishuBridge()).toBeUndefined();
    expect(localFeishuBridge({ platform: "darwin" })).toBeUndefined();
    expect(localFeishuBridge({ platform: "linux", feishu })).toBeUndefined();
    expect(localFeishuBridge({ platform: "darwin", feishu, remoteClient: { active: true } })).toBeUndefined();
  });
});
