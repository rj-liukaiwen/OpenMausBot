# Live browser and profiles

Use installed native engine and Chrome binaries explicitly; the fixture never
uses the operator's browser profiles, OMB home, provider logins, or API keys.

```sh
OMB_VERIFY_BROWSER_BINARY=/absolute/path/to/agent-browser \
OMB_VERIFY_BROWSER_CHROME=/absolute/path/to/chrome-headless-shell \
node --experimental-strip-types scripts/verify-browser-live.ts
```

The launcher uses `launchVerificationServer` with a temporary home and fake
model CLI, creates Pepper, and prints the backend, preview, and local test-page
URLs. Open **only** the printed preview URL. Ctrl-C closes its native browsers,
UI and harness, then removes its temporary data; the server log remains.

1. The panel contains two browser-chrome rows and a live blank page. There is
   no “coming next” card. Navigation/input are disabled while just watching.
2. Click **Take control**, enter the printed test-page URL, and press Enter.
   In the name field, type `AdaX`, press Backspace, then Enter. The streamed
   page must show `Hello, Ada`. Check arrows and Delete, Tab into the notes
   field and enter multiple lines, then open the dialog and close it with
   Escape. These must affect the remote page, not only the surrounding UI.
   Shift+Escape returns focus to the address field without sending Escape to
   the page; keyboard-only users must still be able to reach the toolbar.
3. Return to bot. Reconnect the view, then leave it connected for at least
   30 seconds on the same static image. It must not stall waiting for an ACK.
   The page remains intact and watch-only; take control again and confirm
   editing and Enter still work after reconnecting.
4. The single profile button opens the switcher. Create a shared profile,
   switch to it (a clean browser), then back to Own browser. The previous page
   remains. Rename a shared profile without changing its identity. Confirmed
   deletion clears its bot references without deleting another profile's data.
5. Open a second isolated browser tab on the preview. Take control in one;
   the other must not receive new page frames or accept input. Hand-back and
   disconnect must never release another viewer's control lease.
6. Test narrow (390 px) and desktop widths, fullscreen, tabs, overflow typing,
   and explicit browser restart. No horizontal document overflow or permanent
   settings panels should appear. Profile changes are disabled during control.

Focused automated coverage:

```sh
pnpm exec vitest run server/browser-engine.test.ts server/browser-runtime.test.ts server/browser-navigation.test.ts \
  server/browser-proxy.test.ts server/browser-live.test.ts \
  server/browser-live-routes.test.ts server/browser-codex-path.integration.test.ts \
  src/lib/browser-input-queue.test.ts src/lib/browser-profiles.test.ts \
  src/components/BrowserProfilesManager.test.ts src/components/BrowserViewport.test.ts \
  src/components/BrowserPanel.test.ts
```

Those tests cover native transport lifecycle, owner/session scoping, gate races,
stale list/stream events, native key routing, bounded input/backpressure,
revoked capabilities, and exact saved-state cleanup. Native workflow testing
is still required: a green mocked
frame test alone does not prove browser input or restoration works.

## Network failure and fullscreen regression checks

With the same two explicit binary variables as above:

```sh
node --experimental-strip-types scripts/verify-browser-live-control.ts
```

This creates a disposable bot and local HTTP server. It checks a refused URL,
then a server that accepts TCP but never returns headers. Navigation must confirm
browser-side cancellation at about 15 seconds, after which release, retake, normal
navigation, and keyboard input must still work. The fixture webpage reports its
actual input value to the fixture HTTP server; a successful action response alone
does not pass the check. Neither Google availability nor model credentials matter.

While the UI fixture above is running, test actual Electron DOM fullscreen:

```sh
OMB_VERIFY_BROWSER_PREVIEW_URL=http://127.0.0.1:5173/__browser-preview.html \
node node_modules/electron/cli.js scripts/verify-browser-fullscreen.mjs
```

Use the exact printed preview port. The hidden Electron window uses a disposable
profile and must enter/exit fullscreen with the same toolbar button, without Esc.
On PowerShell set `$env:OMB_VERIFY_BROWSER_PREVIEW_URL` before the Node command.
Fixture cleanup must address its exact UUID session, never `close --all`: some
Windows native builds resolve the OS profile even when HOME is overridden.

See [the September 10 regression evidence](ruijie-browser-delete-2026-09-10.md).

## Viewer / agent handoff without daemon restarts

Run both orders with the explicit native binary and Chrome variables above:

```sh
node --experimental-strip-types scripts/verify-browser-runtime-lifecycle.ts --viewer-first
node --experimental-strip-types scripts/verify-browser-runtime-lifecycle.ts
```

Each isolated fixture watches real page frames, performs three human-navigation /
MCP handoffs, and waits for a heartbeat after MCP idle cleanup. The **original**
stream must remain open. Native daemon configuration includes
`AGENT_BROWSER_DEFAULT_TIMEOUT`; viewer-only overrides restart the shared daemon
when tools next run. Keep launch configuration identical and enforce operation
deadlines outside it. Do not add an override to the test's agent environment that
the production agent does not receive.

On Windows, also run the compiled desktop fixture (no installer is generated):

```sh
node node_modules/electron/cli.js scripts/verify-desktop-browser.mjs
```

It copies `dist` / `dist-server` outside the checkout, starts Electron's real
utility server in a disposable home, opens the real BrowserPanel, and searches
through native MCP. Three toolbar take/reload/return cycles must allow the agent
to read the page again, then the same SSE connection must survive 60 seconds.
Network instrumentation rejects silent reconnections and requires multiple
frames; an opening screenshot alone cannot pass. Evidence lives in the printed
fixture directory (`server.log`, `verification.json`, and a failure screenshot
when applicable). `OMB_VERIFY_SERVER_ENTRY` can explicitly substitute an isolated
candidate bundle for diagnosis, but that is not acceptance of the running
desktop build or the final installer. This fixture does not call a live model,
use real accounts, or prove macOS signing/installation behavior.
