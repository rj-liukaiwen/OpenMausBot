import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { PluginsPanel } from "../../components/PluginsPanel";
import { t } from "../../lib/i18n";
import { feishuCopy } from "../l10n/feishu";

vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { bots: [], selectedId: "" }, dispatch: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

it("mounts Feishu before Composio has returned any catalog or inventory", () => {
  vi.stubGlobal("window", {});
  const html = renderToStaticMarkup(createElement(PluginsPanel));
  expect(html).toContain(feishuCopy.title);
  expect(html).toContain(feishuCopy.unsupported);
  expect(html).toContain(t("connectors.loadingCatalog"));
  expect(html.match(/role="dialog"/g)).toHaveLength(1);
});

it("does not label a local Mac Feishu bridge unsupported before the cloud catalog loads", () => {
  vi.stubGlobal("window", { ogb: { platform: "darwin", feishu: { state: vi.fn(), invoke: vi.fn() } } });
  const html = renderToStaticMarkup(createElement(PluginsPanel));
  expect(html).toContain(feishuCopy.title);
  expect(html).not.toContain(feishuCopy.unsupported);
  expect(html).toContain(t("connectors.loadingCatalog"));
});
