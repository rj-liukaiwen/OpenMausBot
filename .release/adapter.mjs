import { readFile } from 'node:fs/promises';
// Onboarding is fail-closed until the current project's native dependencies and
// receipts can be built reproducibly. The historical private-release workflow
// is not compatible with this public, renamed, Feishu-enabled source version.
export async function preflight() {
  const engine = await readFile('server/browser-engine-release.ts', 'utf8');
  const blockers = [];
  if (engine.includes('local:ruijiebot/browser-engine-v0.36.0-omb.2')) blockers.push(
    'Windows vendor 0.36.0-omb.2 has only a local: placeholder. Supply the approved agent-browser-win32-x64.exe (13,850,624 bytes; SHA256 775127b9d77326acf80478b484c0d9ce587bd47ae9390339c25f7e629bb05857) and provenance.json, or a stable URL.');
  blockers.push('macOS Universal adapter must include both Feishu runtime architectures and preserve the signed/hash-verified runtime contract. The new verifier does not permit modified ad-hoc binaries as Developer ID replacements.');
  blockers.push('Current pre-package gate requires actual, source/build-bound Windows and ARM/Intel verification receipts under release/verification (valid for 24 hours), including live OAuth, Feishu and Mac permissions.');
  blockers.push('Linux needs an explicit branded release gate: the current beforePack verifier supports only win32-x64, darwin-arm64 and darwin-x64.');
  return { blockers, notes: ['Enterprise public redistribution authorization already confirmed by the owner.', 'Target: v0.1.74, public repository, Windows unsigned, macOS Universal ad-hoc testing.', 'No build is started and no old v0.1.73 assets are relabeled as v0.1.74.'] };
}
