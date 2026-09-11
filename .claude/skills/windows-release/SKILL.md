---
name: windows-release
description: Prepare, verify, and explicitly release the RuijieBot Windows installer from WYunS/OpenMausBot. Use for Windows packaging, release readiness, or installed-update failures; macOS uses the separate native signing and acceptance guides.
---

# RuijieBot Windows delivery

## Read the authoritative guides first

Read these files completely before preparing or packaging:

1. `发布交付指南/04-通用回归与发布门禁.md` — recurring regressions, evidence and beforePack gates.
2. `发布交付指南/01-Windows打包指导.md` — Windows preparation, native resources and installation acceptance.

For macOS work, use `02-macOS打包指导.md`, `03-macOS真人验收测试指导.md` and
`macOS代码签名与TCC身份策略.md` in that directory. Windows results do not approve macOS.
The numbered guides are the source of truth; do not maintain a second set of runtime pins here.

## Separate source synchronization, candidate creation and publication

- Source delivery is `https://github.com/WYunS/OpenMausBot`, branch `main`.
  Resolve the actual remote URL and pin one full commit for both platforms.
- A source commit/push does not authorize generating installers or uploading releases.
  Main pushes run checks only. Desktop Release is manually triggered; Docker branch runs cannot publish images.
- The inherited Release workflow still contains upstream feed/mirror assumptions. Review/adapt it under
  separate release authority before running it. Never upload to the author's repositories as part of Ruijie delivery.
- Only change the version when requested for a release; source synchronization does not require a version bump.

## Build and verification boundary

Use Windows x64, Node 24 and the package-manager version locked in `package.json`.
Install with `corepack pnpm install --frozen-lockfile`; follow the numbered guides' exact preparation sequence.
The normal package entry is `pnpm package:win`, using `electron-builder.ruijie.mjs` with its gates intact.

Before creating a candidate, require current-SHA source/native checks and accepted compiled desktop preview:
bundled Feishu CLI/Node, browser no-console/stream/control checks, cloud-app proxy recovery and real authorized
read, Chinese response behavior, and development/installed data isolation. See the common guide for commands.
Missing, skipped or blocked evidence remains a blocker; never fabricate a passing receipt.

After explicitly authorized candidate creation, use an isolated authorized Windows account for installation
acceptance. Verify actual executable/resource paths, taskbar icon, `锐捷Bot` uninstall/shortcut names,
`RuijieBot-<version>-setup.exe` naming, and installed `~/.ruijiebot` versus development `~/.openmausbot`.
The developer's Electron atom icon is not proof that the packaged icon changed.

## Explicit publication only

After final installation acceptance and separate publication approval, deliver to WYunS/OpenMausBot only:
the versioned installer, its blockmap, generated `latest.yml`, and any approved portable/stable-name copies.
Check the exact release SHA, platform scope, final file hashes and feed owner before uploading.
Do not overwrite published bytes or hand-edit updater hashes. A previous installer is not the new source build.

Report source checks, native checks, final installer checks and publication as separate states.
For unsigned Windows builds, report the real signing status; do not invent a publisher name or certificate.
