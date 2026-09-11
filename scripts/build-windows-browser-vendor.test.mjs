import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_VENDOR_PATCH_SHA256, WINDOWS_VENDOR_CONSOLE_PATCH_SHA256, verifyVendorConsolePatch, WINDOWS_VENDOR_PNPM, WINDOWS_VENDOR_RUST, WINDOWS_VENDOR_SOURCE, WINDOWS_VENDOR_TARGET, WINDOWS_VENDOR_VERSION, parseVendorBuildArgs, verifyVendorCandidate, verifyVendorPatch } from "./build-windows-browser-vendor.mjs";
import { verifyAssetBytes } from "./prepare-browser.mjs";
import { applyVendorPatches } from "./build-windows-browser-vendor.mjs";

describe("reviewed Windows browser dependency build", () => {
  it("really applies patches when the temporary source is nested inside someone else's Git repository", () => {
    const parent = mkdtempSync(join(tmpdir(), 'omb-vendor-patch-test-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: parent, windowsHide: true });
      const source = join(parent, 'scratch', 'source');
      mkdirSync(source, { recursive: true });
      const target = join(source, 'version.txt');
      writeFileSync(target, 'upstream\n');
      const patch = Buffer.from('diff --git a/version.txt b/version.txt\n--- a/version.txt\n+++ b/version.txt\n@@ -1 +1 @@\n-upstream\n+patched\n');
      applyVendorPatches(source, [patch]);
      expect(readFileSync(target, 'utf8')).toBe('patched\n');
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
  it("pins the released base, toolchain, vendor revision and exact patch bytes", () => {
    expect(WINDOWS_VENDOR_SOURCE.commit).toBe("eb05921bad874cd2a1b4fa5d1149f1ed26576cae");
    expect(WINDOWS_VENDOR_SOURCE.url).toContain(WINDOWS_VENDOR_SOURCE.commit);
    expect(WINDOWS_VENDOR_TARGET).toBe("x86_64-pc-windows-gnu");
    expect(WINDOWS_VENDOR_VERSION).toBe("0.36.0-omb.2");
    const consolePatch = readFileSync(new URL('../third_party/browser/agent-browser-windows-no-console.patch', import.meta.url));
    expect(() => verifyVendorConsolePatch(consolePatch)).not.toThrow();
    expect(() => verifyVendorConsolePatch(Buffer.from('changed'))).toThrow(/SHA-256/);
    expect(consolePatch.toString()).toContain('CREATE_NO_WINDOW');
    expect(WINDOWS_VENDOR_RUST).toBe("1.97.1");
    expect(WINDOWS_VENDOR_PNPM).toBe("11.1.3");
    expect(WINDOWS_VENDOR_PATCH_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const patch = readFileSync(new URL("../third_party/browser/agent-browser-windows-stdio.patch", import.meta.url));
    expect(() => verifyVendorPatch(patch)).not.toThrow();
    expect(() => verifyVendorPatch(Buffer.concat([patch, Buffer.from("\n")]))).toThrow(/SHA-256/);
    const changed = [...patch.toString().matchAll(/^diff --git a\/(\S+) /gm)].map((match) => match[1]);
    expect(changed).toEqual(["cli/src/connection.rs", "cli/src/main.rs", "cli/Cargo.toml", "cli/Cargo.lock"]);
    expect(patch.toString()).toContain("SetHandleInformation(handle as isize, HANDLE_FLAG_INHERIT, 0)");
    expect(patch.toString()).not.toContain("run_command_returns_partial_output");
  });

  it("refuses unreviewed source archive bytes", () => {
    expect(() => verifyAssetBytes(Buffer.from("unreviewed source"), WINDOWS_VENDOR_SOURCE)).toThrow(/SHA-256/);
  });

  it("rejects changed candidate bytes or provenance instead of weakening normal release pins", () => {
    const bytes = Buffer.from("synthetic candidate, never executed");
    const provenance = {
      version: WINDOWS_VENDOR_VERSION, target: WINDOWS_VENDOR_TARGET,
      source: WINDOWS_VENDOR_SOURCE, patch: { sha256: WINDOWS_VENDOR_PATCH_SHA256 },
      consolePatch: { sha256: WINDOWS_VENDOR_CONSOLE_PATCH_SHA256 },
      executable: { asset: "agent-browser-win32-x64.exe", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    };
    expect(() => verifyVendorCandidate(provenance, bytes)).not.toThrow();
    expect(() => verifyVendorCandidate(provenance, Buffer.from("wrong"))).toThrow();
    expect(() => verifyVendorCandidate({ ...provenance, version: "0.36.0" }, bytes)).toThrow();
    expect(() => verifyVendorCandidate({ ...provenance, source: { ...WINDOWS_VENDOR_SOURCE, commit: "unreviewed" } }, bytes)).toThrow();
    expect(() => verifyVendorCandidate({ ...provenance, patch: { sha256: "0".repeat(64) } }, bytes)).toThrow();
    expect(() => verifyVendorCandidate({ ...provenance, executable: { ...provenance.executable, sha256: "0".repeat(64) } }, bytes)).toThrow();
  });

  it("requires an explicit absolute output without accepting extra options", () => {
    const output = join(tmpdir(), "omb-vendor-output");
    expect(parseVendorBuildArgs(["--output", output])).toBe(output);
    for (const args of [[], ["--output", "relative"], ["--output", output, "--skip-verify"], ["--source", output]]) {
      expect(() => parseVendorBuildArgs(args)).toThrow(/Usage/);
    }
  });
});
import { spawnSync as probeSpawn } from 'node:child_process';
import { fileURLToPath as probeFilePath } from 'node:url';

it('loading vendor validation does not execute the preparation CLI through an import cycle', () => {
  const result = probeSpawn(process.execPath, ['--input-type=module', '-e',
    `process.argv[1] = ${JSON.stringify(probeFilePath(new URL('./prepare-browser.mjs', import.meta.url)))};
     process.argv[2] = '--invalid-test-argument';
     await import(${JSON.stringify(new URL('./build-windows-browser-vendor.mjs', import.meta.url).href)});
     console.log('validator-ready');`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('validator-ready');
});
