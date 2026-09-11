import { createElement, type EffectCallback, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], refs: [] as RefObject<unknown>[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
    useRef: (value: unknown) => { const ref = react.useRef(value); fixture.refs.push(ref); return ref; },
  };
});
import { BrowserViewport } from "./BrowserViewport";

beforeEach(() => {
  fixture.effects = []; fixture.refs = [];
  vi.stubGlobal("window", new EventTarget());
  // Chromium can suspend animation frames in an occluded/hidden window.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it.each([true, false])("ACKs an already decoded static frame without animation frames (decoded=%s)", (decoded) => {
  const acknowledge = vi.fn();
  renderToStaticMarkup(createElement(BrowserViewport, { frame: { seq: 2, data: "same-pixels" }, width: 1280, height: 720,
    driving: false, input: vi.fn(), acknowledge, onDecodeError: vi.fn(), onReturnToToolbar: vi.fn() }));
  fixture.refs[0]!.current = { complete: decoded, naturalWidth: decoded ? 1280 : 0 };
  const cleanups = fixture.effects.map((effect) => effect());
  if (decoded) expect(acknowledge).toHaveBeenCalledWith(2);
  else expect(acknowledge).not.toHaveBeenCalled();
  for (const cleanup of cleanups) cleanup?.();
});
