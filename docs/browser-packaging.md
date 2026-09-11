# Browser-ready desktop packages

Desktop installers include the pinned `agent-browser` engine and Chromium
Headless Shell. A fresh installation needs no separate browser download.
This is an automation browser, not a headed Google Chrome application.
Global and per-bot browser permissions remain opt-in; bundling executables
does not give a bot permission to use them.

## Package layout and lookup

`pnpm package:prepare` runs `pnpm build:browser`. It downloads verified vendor
archives and stages `dist-native/browser/PLATFORM-ARCH`, copied as
`Resources/browser-engine` on macOS or `resources/browser-engine` elsewhere.
Each package includes only its target architecture: macOS ARM64/x64,
Windows x64, or Linux x64.

The server receives `OMB_RESOURCES_PATH` from Electron. It resolves an explicit
`OMB_AGENT_BROWSER_PATH` override first, then the complete bundled engine and
browser, then a separately installed engine or PATH. An incomplete bundle
fails closed with a reinstall/update message. An explicit
`AGENT_BROWSER_EXECUTABLE_PATH` still overrides the browser executable.
Profiles, cookies and downloads are user data, never packaged resources.

The npm/self-hosted distribution stays small and retains its explicit browser
installation flow. Desktop packaging does not silently enlarge the npm tarball.

## Video recording

The macOS and Linux engine is pinned to agent-browser 0.37.0. Its
[`record start` and `record restart`](https://agent-browser.dev/recording)
commands record the active page at 30 fps by default; `--fps 60` selects 60 fps
(valid range: 1–60). This saves a video file; it does not enable a live view.
Recording requires `ffmpeg` on the server's PATH, with `libvpx` for WebM or
`libx264` for MP4. `agent-browser doctor` reports these optional dependencies.
They are not bundled or required for normal browsing. Higher frame rates use
more CPU and disk space; the actual distinct frames depend on page repaints.
There is no recording control in OMB's browser panel.

## Linux sandbox

Use the `.deb` on Ubuntu 24.04. Its package hooks install a narrowly scoped
AppArmor policy for the root-owned browser executable under `/opt/OpenMausBot`.
They do not disable the browser sandbox or change the global user-namespace
restriction. See [Linux desktop](linux-desktop.md).

The AppImage contains the same binaries, but cannot install a privileged
sandbox policy. Restricted hosts may need the `.deb` rather than the AppImage.

## Release verification and updates

Versions, URLs, sizes and SHA-256 digests live in
`server/browser-bundle-release.ts`; engine pins are shared with
`server/browser-engine-release.ts`. Every cached download is rechecked.
Preparation inventories the entire vendor tree, including licenses. The
`afterPack` gate rejects missing resources, changed bytes or wrong executable
architectures before signing. macOS signing changes native bytes, so signed
packages are subsequently checked using code signatures and runtime tests,
not the original upstream executable hashes.

Run the real browser check against an unpacked app:

```sh
node scripts/smoke-browser-bundle.mjs --resources /absolute/app/resources
```

On macOS, use `/absolute/OpenMausBot.app/Contents/Resources`. On Linux, run as
an unprivileged user against the installed `.deb` at
`/opt/OpenMausBot/resources`. This check creates its own empty home and local
web page, checks automatic discovery, navigation, typing/clicking, screenshot
delivery and two-bot cookie/storage isolation, then removes only its fixture.
No model account or user browser profile is used. Cross-target `--check-only`
checks layout only and is not evidence of successful browser execution.

The release workflows run this check on native macOS, Windows and Linux
runners before publishing. macOS also verifies the browser binaries are signed
with the app's team identity. The browser is updated through a reviewed app
release: review the new vendor target/license contents, update all platform
pins, run preparation/tests and the native package gates, and ship promptly
when browser security updates are needed. There is no independent automatic
browser updater in the desktop bundle.

### Temporary Windows engine backport

Windows uses an explicitly identified OpenMausBot build of agent-browser
0.36.0, with the handle-inheritance fix from
[upstream PR #1781](https://github.com/vercel-labs/agent-browser/pull/1781).
The official 0.37.0 release does not contain this fix, so Windows stays on the
native-tested `0.36.0-omb.2` revision and does not yet get the new recording
options. Do not replace it with the unpatched 0.37.0 Windows binary.
The original binary can hang when a newly started background browser holds
the tool call's output connection open. The backport changes that Windows
startup behavior; it does not include the PR's broader output-reader rewrite
or unrelated changes from upstream main.

The `.2` revision also suppresses console windows in native Chromium, nested
MCP and Git discovery. The exact reviewed binary is currently supplied locally
through `OMB_BROWSER_VENDOR_DIR` (or `dist-native/browser-vendor-candidate-omb2`),
not a fictitious published URL. Preparation rejects absent/mismatching bytes
instead of falling back to `.1`. Full UI/package-combination acceptance remains
pending; the candidate's previous native pass is not a release receipt.

The artifact-only **Windows browser vendor build** workflow builds the pinned
source and checked-in patch, retains the licenses and build provenance, and
tests cold start plus close/reopen through the same MCP connection on Windows.
Its candidate must be reviewed and its exact size and SHA-256 pinned before
the normal application packaging workflow consumes it. Candidate testing does
not replace the packaged-app tests. Published vendor bytes must not be
overwritten; a changed build needs a new revision and reviewed pins.

The Windows revision has a separate managed installation directory so an old
0.36.0 download is not mistaken for the patched engine. Desktop packages use
their bundled engine. Explicit executable overrides remain user-managed.
Remove the backport when an official release includes the fix and passes the
same native cold-start and restart tests.

The vendor builder currently emits an **unreleased `0.36.0-omb.2` candidate**.
It applies `agent-browser-windows-no-console.patch` after the original stdio
patch. Hiding the outer Node child does not hide console-subsystem descendants:
the detached daemon must also request `CREATE_NO_WINDOW` when starting
Chromium Headless Shell, nested MCP commands and its Git probe.
Released application pins remain `.1`; building a candidate alone does not
update installed or development copies. On an idle interactive Windows desktop,
run the original bundled-browser workflow with candidate bytes explicitly:

```powershell
./scripts/verify-browser-no-console.ps1 -Resources 'C:/absolute/app/resources' -EngineCandidate 'D:/absolute/candidate/agent-browser-win32-x64.exe'
```

Require a successful browser workflow and zero new visible console windows,
then repeat and verify the full desktop UI. The 10 ms window poll is conservative
about unrelated terminals and cannot prove the absence of arbitrarily short
flashes. A headless CI run is not equivalent to interactive desktop evidence.
After validation, publish a distinct vendor revision and review its exact pins;
do not fabricate a digest/URL or silently package an unverified override.
The builder creates an isolated Git boundary in its extracted source: a temp
directory inside a user's unrelated Git repository otherwise allows `git apply`
to skip all paths and still exit successfully. It verifies reverse applicability,
the actual source version and no-console call sites before compilation. Hashing
the patch alone does not prove that the resulting executable contains it.

Complete upstream notices and provenance are in
[`third_party/browser`](../third_party/browser/README.md). The full Google
Chrome distribution and its proprietary Widevine component are not bundled.
