// Actual browser + actual BrowserPanel, always in a disposable fixture HOME.
import { readFileSync } from "node:fs";
import { browserSessionId, closeBrowserSession } from "../server/browser-engine.ts";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";


const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath) throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to explicit installed binaries.");
const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath, executablePath });
let ui: MountedPreview | undefined;
let botId = "";
let pageVisits = 0;
try {
  await runControlOmb(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
  const { bots } = await (await fetch(`${fixture.info.url}/api/bots`)).json() as any;
  botId = bots[0].id;
  await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ features: { browser: true } }) });
  await fetch(`${fixture.info.url}/api/bots/${bots[0].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: true }) });
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/browser-preview.tsx", route: "/__browser-preview.html", title: "Isolated Browser Preview",
    extraRoutes: [{
      path: "/__browser-test-page",
      handler(_req, res) {
        res.setHeader("content-type", "text/html");
        res.end(readFileSync(new URL("./testing/browser-test-page.html", import.meta.url), "utf8")
          .replace('A browser for your bots.', `A browser for your bots. Visit ${++pageVisits}`));
      },
    }],
  });
  console.log(JSON.stringify({ ...fixture.info, botId: bots[0].id, previewUrl: ui.previewUrl, testPage: new URL("/__browser-test-page", ui.previewUrl).href }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  // Some Windows native builds resolve the OS profile despite HOME overrides.
  // Close only this fixture's UUID session, never an account-wide --all.
  if (botId) await closeBrowserSession(binaryPath, {
    HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir,
    AGENT_BROWSER_SESSION: browserSessionId(botId, ""),
  });
  await fixture.close();
}
