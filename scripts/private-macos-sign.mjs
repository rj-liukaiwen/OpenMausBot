import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyFeishuRuntimeBundle } from "./prepare-feishu-runtime.mjs";

const feishuSlice = (app, file) => relative(app, file).replaceAll("\\", "/").match(/^Contents\/Resources\/tuantuan-feishu-runtime\/darwin-(arm64|x64)\//)?.[1];

export function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? `${result.stdout}\n${result.stderr}`}`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function isMachO(file) {
  const header = Buffer.alloc(4);
  const descriptor = openSync(file, "r");
  let size;
  try { size = readSync(descriptor, header, 0, 4, 0); } finally { closeSync(descriptor); }
  if (size !== 4 || ![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE())) return false;
  return run("/usr/bin/file", ["--brief", file]).includes("Mach-O");
}

export function nativeInventory(appPath) {
  const app = resolve(appPath);
  const binaries = [];
  const bundles = [];
  function visit(directory) {
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry);
      const details = lstatSync(file);
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) {
        visit(file);
        if (/\.(app|framework|xpc|bundle)$/.test(entry) && binaries.some(binary => binary.startsWith(`${file}/`))) bundles.push(file);
      } else if (details.isFile() && isMachO(file)) binaries.push(file);
    }
  }
  visit(app);
  if (!binaries.length) throw new Error(`No native code found in ${app}`);
  return { app, binaries, bundles: bundles.sort((a, b) => b.split("/").length - a.split("/").length) };
}

export function signAdHoc(appPath) {
  const { app, binaries, bundles } = nativeInventory(appPath);
  const entitlements = resolve("build/entitlements.mac.plist");
  for (const file of binaries) {
    // These approved third-party bytes already carry their vendor signatures
    // (or the vendor's unsigned status). Preserve their exact pinned hashes.
    if (feishuSlice(app, file)) continue;
    const executable = run("/usr/bin/file", ["--brief", file]).includes("executable");
    run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", ...(executable ? ["--entitlements", entitlements] : []), file]);
  }
  for (const bundle of [...bundles, app]) {
    run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--options", "runtime", "--entitlements", entitlements, bundle]);
  }
}

export async function verifyAdHocUniversal(appPath, reportPath) {
  const { app, binaries, bundles } = nativeInventory(appPath);
  const identifier = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(app, "Contents/Info.plist")]);
  if (identifier !== "com.openmausbot.app") throw new Error(`Unexpected app identity: ${identifier}`);
  const report = { schemaVersion: 1, bundleId: identifier, signing: "ad-hoc signed, not notarized", notarized: false, components: [], humanTccAcceptance: "not-run" };
  for (const arch of ["arm64", "x64"]) {
    await verifyFeishuRuntimeBundle(join(app, "Contents/Resources/tuantuan-feishu-runtime", `darwin-${arch}`), `darwin-${arch}`);
  }
  for (const file of [...binaries, ...bundles, app]) {
    const pinnedFeishu = feishuSlice(app, file);
    if (pinnedFeishu) {
      const architectures = run("/usr/bin/lipo", ["-archs", file]).split(/\s+/);
      const expected = pinnedFeishu === "x64" ? "x86_64" : "arm64";
      if (architectures.length !== 1 || architectures[0] !== expected) throw new Error(`Wrong Feishu architecture: ${file}`);
      report.components.push({ path: relative(app, file), architectures, signature: "vendor bytes preserved; exact approved SHA256 verified" });
      continue;
    }
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", file]);
    const signature = run("/usr/bin/codesign", ["--display", "--verbose=4", file]);
    if (!signature.includes("Signature=adhoc")) throw new Error(`Expected ad-hoc signature: ${file}`);
    const requirement = run("/usr/bin/codesign", ["-dr", "-", file]);
    if (!requirement.includes("designated =>")) throw new Error(`Missing designated requirement: ${file}`);
    let architectures;
    if (binaries.includes(file)) {
      architectures = run("/usr/bin/lipo", ["-archs", file]).split(/\s+/);
      const rel = relative(app, file).replaceAll("\\", "/");
      const vendor = rel.match(/^Contents\/Resources\/browser-engine\/darwin-(arm64|x64)\//);
      const expected = vendor ? [vendor[1] === "x64" ? "x86_64" : "arm64"] : ["arm64", "x86_64"];
      for (const arch of expected) {
        if (!architectures.includes(arch)) throw new Error(`Missing ${arch} slice: ${rel} (${architectures.join(", ")})`);
      }
    }
    report.components.push({ path: relative(app, file) || ".", architectures, signature, requirement });
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Verified ${binaries.length} Mach-O files and ${bundles.length + 1} bundles: ${reportPath}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== "darwin") throw new Error("macOS is required.");
  const [app, report] = process.argv.slice(2);
  if (!app || !report) throw new Error("Usage: node scripts/private-macos-sign.mjs <app> <report.json>");
  await verifyAdHocUniversal(app, report);
}
