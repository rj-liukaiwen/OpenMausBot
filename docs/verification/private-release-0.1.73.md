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
- GitHub three-platform packaging/signing/Artifact acceptance: run requested, pending. Workflow commit `6a53a07cce4b9f84c491667a7216f37500b033bf`; run https://github.com/rj-liukaiwen/OpenMausBot/actions/runs/34552303261.
- Physical Intel/Apple Silicon TCC, clean installation and real account/upgrade acceptance: not run.

Do not promote this checkpoint to an accepted installer. Update this record with the real Actions run, candidate SHA, platform results and any required user action.

## First cloud-run findings

- macOS failed before packaging: the local-computer proxy compared a canonical import URL to an aliased argv path (`/var` versus `/private/var`) and exited successfully without serving a discovery response. A directory-alias child-process regression reproduced empty stdout on local Windows before the fix. Canonical path comparison fixes the entry guard; 12 isolated proxy tests and the rebuilt packaged-server smoke pass locally. The next Mac run must confirm the original scenario.
- Windows CUA staging selected Git Bash GNU tar, which interpreted a Windows drive-letter archive path as a remote host. The Windows packaging step now explicitly uses PowerShell, as required by the supplied guide, with native-command failures propagated.
- Universal browser lookup is also used by the packaged-server smoke, so its manifest and executable checks select the host CPU's vendor directory.
