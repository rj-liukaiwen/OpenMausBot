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
- Packaging/browser-path checks: 5 passed. The Node runner encountered an IPC serialization issue; the same checks run with `--test-isolation=none`. A shared-config mutation exposed by this mode was fixed with an independent cloned testing configuration.
- Type checks and browser regressions: in progress at this checkpoint.
- GitHub three-platform packaging/signing/Artifact acceptance: not run at this checkpoint.
- Physical Intel/Apple Silicon TCC, clean installation and real account/upgrade acceptance: not run.

Do not promote this checkpoint to an accepted installer. Update this record with the real Actions run, candidate SHA, platform results and any required user action.
