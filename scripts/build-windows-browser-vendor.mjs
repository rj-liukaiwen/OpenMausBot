// One-off dependency build, not part of normal app packaging. After native
// Windows verification, publish these bytes and pin their digest in the app.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executableTarget } from "./prepare-cloudflared.mjs";

export const WINDOWS_VENDOR_VERSION = "0.36.0-omb.2";
export const WINDOWS_VENDOR_TARGET = "x86_64-pc-windows-gnu";
export const WINDOWS_VENDOR_SOURCE = {
  commit: "eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
  asset: "agent-browser-eb05921bad874cd2a1b4fa5d1149f1ed26576cae.tar.gz",
  url: "https://codeload.github.com/vercel-labs/agent-browser/tar.gz/eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
  bytes: 1904718,
  sha256: "ed24a72a5260d9c1ea454cd849c44159bac570a6939ac645e4c5bdb98a421646",
};
export const WINDOWS_VENDOR_PATCH_SHA256 = "27a268a90de47603a473daefb5679ef9ddde3fad9152d52b04e563b3e192c9a9";
export const WINDOWS_VENDOR_CONSOLE_PATCH_SHA256 = "556eb6d15ae8315572617bcfda76a31ec7570680c6625569be94ba88d90b6c27";
export const WINDOWS_VENDOR_RUST = "1.97.1";
export const WINDOWS_VENDOR_PNPM = "11.1.3";
const repository = fileURLToPath(new URL("../", import.meta.url));
const patchPath = join(repository, "third_party/browser/agent-browser-windows-stdio.patch");
const consolePatchPath = join(repository, "third_party/browser/agent-browser-windows-no-console.patch");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseVendorBuildArgs(args) {
  if (args.length !== 2 || args[0] !== "--output" || !isAbsolute(args[1])) {
    throw new Error("Usage: node scripts/build-windows-browser-vendor.mjs --output ABSOLUTE_NEW_DIRECTORY");
  }
  return resolve(args[1]);
}

export function verifyVendorPatch(bytes) {
  assert.equal(digest(bytes), WINDOWS_VENDOR_PATCH_SHA256, "Windows vendor patch failed pinned SHA-256 verification");
}
export function verifyVendorConsolePatch(bytes) {
  assert.equal(digest(bytes), WINDOWS_VENDOR_CONSOLE_PATCH_SHA256, "Windows console patch failed pinned SHA-256 verification");
}

// Candidate artifacts are tested before their executable digest is committed
// to the normal release resolver. This verifies build identity and transport
// integrity, not publication approval; normal packaging never uses this path.
export function verifyVendorCandidate(provenance, bytes) {
  assert.equal(provenance.version, WINDOWS_VENDOR_VERSION);
  assert.equal(provenance.target, WINDOWS_VENDOR_TARGET);
  assert.deepEqual(provenance.source, WINDOWS_VENDOR_SOURCE);
  assert.equal(provenance.patch.sha256, WINDOWS_VENDOR_PATCH_SHA256);
  assert.equal(provenance.consolePatch.sha256, WINDOWS_VENDOR_CONSOLE_PATCH_SHA256);
  assert.equal(provenance.executable.asset, "agent-browser-win32-x64.exe");
  assert.equal(provenance.executable.bytes, bytes.length, "Candidate executable size differs from build provenance");
  assert.equal(provenance.executable.sha256, digest(bytes), "Candidate executable SHA-256 differs from build provenance");
}

export function applyVendorPatches(source, patches) {
  // A temp folder can itself be inside a user's unrelated repository. In that
  // case `git apply` silently skips every root-relative path yet exits zero.
  // Own a repository boundary before applying anything; never modify a parent.
  assert(!existsSync(join(source, '.git')), 'Vendor source must be a fresh extracted tree');
  command('git', ['init', '--quiet'], source, { capture: true });
  const top = command('git', ['rev-parse', '--show-toplevel'], source, { capture: true });
  assert.equal(resolve(top), resolve(source), 'Git must resolve the extracted source, not an enclosing repository');
  // Source/patch hashes must not depend on a developer's global CRLF policy.
  command('git', ['config', '--local', 'core.autocrlf', 'false'], source, { capture: true });
  command('git', ['config', '--local', 'core.eol', 'lf'], source, { capture: true });
  for (const patch of patches) {
    command("git", ["apply", "--check", "-"], source, { input: patch });
    command("git", ["apply", "--whitespace=error-all", "-"], source, { input: patch });
    command("git", ["apply", "--reverse", "--check", "-"], source, { input: patch });
  }
}

function command(file, args, cwd, { input, capture = false } = {}) {
  const windows = process.platform === 'win32';
  if (windows && file === 'pnpm') {
    assert(isAbsolute(process.env.OMB_VENDOR_PNPM_CLI ?? ''), 'Windows vendor build requires an absolute OMB_VENDOR_PNPM_CLI (pnpm 11.1.3 JS entry)');
    args = [process.env.OMB_VENDOR_PNPM_CLI, ...args]; file = process.execPath;
  }
  if (windows && file === 'tar') file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(file, args, {
    cwd, input, encoding: "utf8", timeout: 30 * 60_000, windowsHide: true,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1",
      // Cargo otherwise inherits Git's global HTTP proxy, even if Windows'
      // proxy is now off. Never alter the developer's global Git config.
      CARGO_HTTP_PROXY: process.env.CARGO_HTTP_PROXY ?? '',
      CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: windows ? 'gcc' : "x86_64-w64-mingw32-gcc" },
  });
  if (result.error || result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

export async function buildWindowsBrowserVendor(output) {
  // Validation is also loaded by prepare-browser's CLI. Import build-only
  // helpers here so that validation cannot await that still-running CLI.
  const { bundleInventory, releaseBytes } = await import('./prepare-browser.mjs');
  assert(['linux', 'win32'].includes(process.platform), 'Build on Linux GNU cross-compiler or native Windows GNU');
  assert.equal(process.arch, "x64", "The reviewed build runner must be x64");
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or later is required");
  assert(isAbsolute(output) && !existsSync(output), "Output must be a new absolute directory; existing artifacts are never overwritten");
  const patch = readFileSync(patchPath);
  verifyVendorPatch(patch);
  const consolePatch = readFileSync(consolePatchPath);
  verifyVendorConsolePatch(consolePatch);
  const rust = command("rustc", ["--version"], repository, { capture: true });
  const cargo = command("cargo", ["--version"], repository, { capture: true });
  const mingw = command(process.platform === 'win32' ? 'gcc' : "x86_64-w64-mingw32-gcc", ["--version"], repository, { capture: true }).split("\n")[0];
  const linker = command(process.platform === 'win32' ? 'ld' : "x86_64-w64-mingw32-ld", ["--version"], repository, { capture: true }).split("\n")[0];
  assert(rust.startsWith(`rustc ${WINDOWS_VENDOR_RUST} `), `Expected Rust ${WINDOWS_VENDOR_RUST}, got ${rust}`);
  assert(cargo.startsWith(`cargo ${WINDOWS_VENDOR_RUST} `), `Expected Cargo ${WINDOWS_VENDOR_RUST}, got ${cargo}`);
  const scratch = mkdtempSync(join(tmpdir(), "omb-browser-vendor-"));
  try {
    const source = join(scratch, "source");
    mkdirSync(source);
    const archive = join(scratch, WINDOWS_VENDOR_SOURCE.asset);
    writeFileSync(archive, await releaseBytes(WINDOWS_VENDOR_SOURCE, process.env.OMB_BROWSER_ARCHIVE_DIR));
    command("tar", ["-xzf", archive, "--strip-components=1", "-C", source], scratch);
    applyVendorPatches(source, [patch, consolePatch]);
    assert(readFileSync(join(source, 'cli/Cargo.toml'), 'utf8').includes(`version = "${WINDOWS_VENDOR_VERSION}"`),
      'Vendor patches did not change the actual source version; refuse an unpatched build');
    for (const file of ['cli/src/native/cdp/chrome.rs', 'cli/src/mcp.rs', 'cli/src/main.rs']) {
      assert(readFileSync(join(source, file), 'utf8').includes('creation_flags(0x08000000)'),
        `Missing no-console patch in ${file}`);
    }
    const pnpm = command("pnpm", ["--version"], source, { capture: true });
    assert.equal(pnpm, WINDOWS_VENDOR_PNPM, `Expected pnpm ${WINDOWS_VENDOR_PNPM}`);
    // Keep the real upstream dashboard: build.rs otherwise silently embeds a
    // placeholder. The frozen pnpm lock and Cargo --locked retain dependencies.
    command("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], source);
    command("pnpm", ["--filter", "dashboard", "build"], source);
    const dashboard = join(source, "packages/dashboard/out");
    assert(!readFileSync(join(dashboard, "index.html"), "utf8").includes("Dashboard not built"));
    command("cargo", ["build", "--locked", "--release", "--manifest-path", "cli/Cargo.toml", "--target", WINDOWS_VENDOR_TARGET], source);
    const binary = join(source, "cli/target", WINDOWS_VENDOR_TARGET, "release/agent-browser.exe");
    const bytes = readFileSync(binary);
    assert.equal(executableTarget(bytes), "win32-x64", "Vendor build did not produce a Windows x64 executable");
    mkdirSync(output, { recursive: true });
    const asset = "agent-browser-win32-x64.exe";
    copyFileSync(binary, join(output, asset));
    for (const [from, to] of [
      ["LICENSE", "agent-browser-LICENSE.txt"],
      ["cli/src/native/a11y/LICENSE-axe-core.txt", "LICENSE-axe-core.txt"],
      ["cli/src/native/a11y/LICENSE-axe-core-THIRD-PARTY.txt", "LICENSE-axe-core-THIRD-PARTY.txt"],
    ]) copyFileSync(join(source, from), join(output, to));
    copyFileSync(patchPath, join(output, "agent-browser-windows-stdio.patch"));
    copyFileSync(consolePatchPath, join(output, "agent-browser-windows-no-console.patch"));
    copyFileSync(join(repository, "third_party/browser/README.md"), join(output, "README.md"));
    const provenance = {
      schemaVersion: 1, version: WINDOWS_VENDOR_VERSION, target: WINDOWS_VENDOR_TARGET,
      source: WINDOWS_VENDOR_SOURCE,
      buildHost: { platform: process.platform, arch: process.arch },
      patch: { upstream: "https://github.com/vercel-labs/agent-browser/pull/1781", commit: "81a98c349d04195396ffae6898bd375ad64280de", sha256: WINDOWS_VENDOR_PATCH_SHA256, scope: "Windows handle inheritance only; no MCP reader rewrite" },
      consolePatch: { sha256: WINDOWS_VENDOR_CONSOLE_PATCH_SHA256, scope: 'CREATE_NO_WINDOW for native Chromium, nested MCP CLI and git discovery' },
      toolchain: { rust, cargo, pnpm, node: process.version, mingw, linker },
      cargoLockSha256: digest(readFileSync(join(source, "cli/Cargo.lock"))),
      pnpmLockSha256: digest(readFileSync(join(source, "pnpm-lock.yaml"))),
      dashboardInventorySha256: digest(JSON.stringify(bundleInventory(dashboard))),
      executable: { asset, bytes: bytes.length, sha256: digest(bytes) },
    };
    writeFileSync(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(JSON.stringify(provenance, null, 2));
    return provenance;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildWindowsBrowserVendor(parseVendorBuildArgs(process.argv.slice(2)));
}
