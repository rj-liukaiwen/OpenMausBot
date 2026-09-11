# Private evaluation release v0.1.73

Date: 2026-09-11. Upstream: `WYunS/OpenMausBot`, branch `codex/openmaus-upgrade-0.1.71-ready`, commit `a9c8187712e6f99c8a63dadec2835c43dd982446`.

Destination: `rj-liukaiwen/OpenMausBot`, verified private, independent repository with preserved upstream history. Intended use: development, test and evaluation under the existing Enterprise license. Windows unsigned; macOS ad-hoc signed, not notarized.

## Implementation

- Manual workflow creates a versioned candidate commit shared by all platforms; existing tags/releases are not overwritten.
- Windows x64 EXE/ZIP, Linux x64 DEB/AppImage, macOS Universal DMG/ZIP.
- Mac browser trees remain architecture-specific inside a universal app; missing selected slices fail closed.
- Individual Mach-O and nested-bundle signatures, designated requirements and CPU slices are audited. Final DMG is independently mounted and verified. Intel CI executes the same ZIP.
- Artifact allowlists, per-platform reports, SHA-256 checksums and update-feed verification precede private draft/prerelease creation.
- Original upstream workflows archived outside the active workflows directory.

## Validation status

- GitHub existing account authentication: passed; repo/workflow permissions available. No personal credentials written to repository or app.
- Private destination creation and privacy check: passed.
- pnpm 10.33.0 frozen-lockfile installation: passed, Node 24.19.0 on local Windows.
- Actionlint 1.7.12: passed for the new workflow.
- Packaging/browser-path/feed-integrity checks: 6 passed. The Node runner encountered an IPC serialization issue; the same checks run with `--test-isolation=none`. A shared-config mutation exposed by this mode was fixed with an independent cloned testing configuration.
- Type checks: passed. Browser regressions: 141 tests in 4 files passed.
- Packaged server: passed in an isolated temporary home without reachable node_modules; 13 proxy paths, MCP shutdown frames, closed-parent-stderr recovery and connector catalog checks passed.
- Local nested pnpm initially selected a global pnpm 11. The validation shell now uses task-local Corepack shims and pnpm 10.33.0; global configuration was not changed.
- GitHub three-platform packaging/signing/Artifact acceptance: passed. Accepted run https://github.com/rj-liukaiwen/OpenMausBot/actions/runs/34554472677, workflow commit `e21bd772821cdfcb98f1007ef49f23cc143d4bf0`, shared candidate SHA `585534fdd382b9470a77bcdd9c3c410cc21bb38a`.
- Physical Intel/Apple Silicon TCC, clean installation and real account/upgrade acceptance: not run.

The automated package gates passed; these remain private evaluation candidates pending physical-machine acceptance. The earlier failed-run findings below are retained as diagnosis history.

## Accepted cloud run and downloads

- All six jobs succeeded: prepare, Windows, Linux, macOS Universal ARM, macOS Intel verification, private release assembly.
- Release draft: https://github.com/rj-liukaiwen/OpenMausBot/releases/tag/untagged-bbbc55a55c3d583dd24b (release ID `386750961`, tag name `v0.1.73`, private repository). All 21 assets are uploaded and have GitHub SHA-256 digests; the publisher checked exact file sizes, hashes, update feeds and a common candidate SHA.
- Windows Artifact `10182319694`: EXE, ZIP, update feed, blockmap, checksum and report. Authenticode `NotSigned`, real bundled browser and isolated packaged-server checks passed.
- Linux Artifact `10182255085`: DEB, AppImage, update feed, checksum and report. Native X11 input, package structure, DEB install/legacy-mode upgrade, browser/server checks, unpacked/AppImage/installed-DEB launches, SIGTERM cleanup, hard-kill restart, X11 crash/retry and Wayland fail-closed lanes passed.
- macOS Artifact `10182218969`: Universal DMG/ZIP, feeds, blockmaps, reports and checksums. Final app and mounted DMG each passed 41 Mach-O and 10 bundle audits. Native Electron, browser and packaged-server checks passed on both ARM and Intel using the same Universal ZIP.
- Release remains a draft/pre-release candidate for personal testing. No Developer ID, notarization, physical TCC persistence, real account onboarding or real-machine upgrade acceptance is claimed. Windows installation/upgrade was not interactively tested on a physical Windows machine.
- Documentation-only commits after the accepted workflow commit do not change the candidate SHA or uploaded package bytes.

## First cloud-run findings

- macOS failed before packaging: the local-computer proxy compared a canonical import URL to an aliased argv path (`/var` versus `/private/var`) and exited successfully without serving a discovery response. A directory-alias child-process regression reproduced empty stdout on local Windows before the fix. Canonical path comparison fixes the entry guard; 12 isolated proxy tests and the rebuilt packaged-server smoke pass locally. The next Mac run must confirm the original scenario.
- Windows CUA staging selected Git Bash GNU tar, which interpreted a Windows drive-letter archive path as a remote host. The Windows packaging step now explicitly uses PowerShell, as required by the supplied guide, with native-command failures propagated.
- Universal browser lookup is also used by the packaged-server smoke, so its manifest and executable checks select the host CPU's vendor directory.

## Second cloud-run findings

Run: https://github.com/rj-liukaiwen/OpenMausBot/actions/runs/34552772665, workflow commit `8948fa60c5e1eaacb8d502274a64bc3d04d89e32`.

- macOS passed the proxy regression and built both Universal containers. The app and mounted DMG each passed audits of 41 Mach-O files and 10 bundles. Resource validation then correctly rejected missing `app-update.yml`: electron-builder's `dir` target does not generate it. The custom merge now writes the private feed and updater cache metadata before signing, then validates all package resources before packaging.
- Linux passed native X11 input, package content, DEB installation/upgrade, browser, and packaged-server checks. The renderer smoke still expected the upstream title although this branch's UI is named 锐捷Bot. It now checks the exact title from this branch's source UI, retaining the remaining lifecycle and native-runtime checks.
- Packaged Electron itself is now launched in Node mode on both Apple Silicon and Intel, checking the native architecture in addition to static signatures and the real browser/server smokes.
- Acceptance of the replacement run remains pending; the successful checks above do not constitute a completed release.

## Third cloud-run findings

Run: https://github.com/rj-liukaiwen/OpenMausBot/actions/runs/34553618000. Candidate SHA: `01ba384b79a6a8beb58512c8e4e39f97e8c15d18`.

- Universal macOS packaging, pre-sign resource validation, app and mounted-DMG signature audits, native ARM Electron launch, browser/server smokes, hashes and Artifact upload passed.
- Linux's real renderer exposed another stale upstream fixture assumption: the packaged app uses `锐捷Bot Installed` but the smoke seeded only the former `openmausbot` / `OpenMausBot` directories, so opt-in was correctly absent. The fixture now seeds the actual installed profile and its server-data inside its disposable XDG directory, and reads lifecycle descriptors there. The production permission policy and real user data remain untouched.
- Restart checks also retain the original isolated keyring arguments to avoid a headless keyring prompt on the second launch.
- A replacement run must exercise every Linux lifecycle lane before accepting the release.
