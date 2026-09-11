import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { signAdHoc, verifyAdHocUniversal, run } from "./private-macos-sign.mjs";
import privateConfig from "../electron-builder.testing.mjs";

if (process.platform !== "darwin") throw new Error("Build the universal Mac package on macOS.");
const root = resolve(".");
const release = join(root, "release");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const slices = { x64: join(release, "mac/OpenMausBot.app"), arm64: join(release, "mac-arm64/OpenMausBot.app") };
const outputApp = join(release, "mac-universal/OpenMausBot.app");
if (existsSync(outputApp)) throw new Error("Universal output already exists. Use a fresh build checkout.");

// Each original slice has already passed the unmodified afterPack provenance
// checks. Chromium has architecture-specific data files; retain both complete
// vendor trees instead of merging or changing their release manifests.
const vendor = join(release, "universal-browser-inputs");
mkdirSync(vendor, { recursive: true });
const feishuVendor = join(release, "universal-feishu-inputs");
mkdirSync(feishuVendor, { recursive: true });
function removeIntermediateSeals(directory) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const details = lstatSync(file);
    if (name === "_CodeSignature" || (name === "CodeResources" && details.isSymbolicLink())) {
      if (!file.startsWith(`${release}/`)) throw new Error("Intermediate seal is outside the build output.");
      rmSync(file, { recursive: details.isDirectory(), force: true });
    } else if (details.isDirectory() && !details.isSymbolicLink()) removeIntermediateSeals(file);
  }
}
for (const [arch, app] of Object.entries(slices)) {
  const browser = join(app, "Contents/Resources/browser-engine");
  if (!existsSync(join(browser, "manifest.json"))) throw new Error(`Missing ${arch} browser stage`);
  renameSync(browser, join(vendor, `darwin-${arch}`));
  const feishu = join(app, "Contents/Resources/tuantuan-feishu-runtime");
  if (!existsSync(join(feishu, "manifest.json"))) throw new Error(`Missing ${arch} Feishu stage`);
  renameSync(feishu, join(feishuVendor, `darwin-${arch}`));
  // Thin-app resource seals describe different binaries. They are intermediate
  // build data; recreate every signature after merging, before any packaging.
  removeIntermediateSeals(app);
}

const requireBuilder = createRequire(import.meta.resolve("electron-builder"));
const requireAppBuilder = createRequire(requireBuilder.resolve("app-builder-lib/package.json"));
const { makeUniversalApp } = requireAppBuilder("@electron/universal");
await makeUniversalApp({
  x64AppPath: slices.x64,
  arm64AppPath: slices.arm64,
  outAppPath: outputApp,
  mergeASARs: true,
  // These resources are intentionally identical in the two input apps. The
  // final audit below separately requires both CPU slices for every one.
  x64ArchFiles: "Contents/Resources/{cua-driver,OpenMausBot Speech.app/**,android-platform-tools/**}",
});
const browserRoot = join(outputApp, "Contents/Resources/browser-engine");
mkdirSync(browserRoot);
for (const arch of ["arm64", "x64"]) cpSync(join(vendor, `darwin-${arch}`), join(browserRoot, `darwin-${arch}`), { recursive: true });
writeFileSync(join(browserRoot, "universal.json"), `${JSON.stringify({ schemaVersion: 1, targets: ["darwin-arm64", "darwin-x64"] }, null, 2)}\n`);
const feishuRoot = join(outputApp, "Contents/Resources/tuantuan-feishu-runtime");
mkdirSync(feishuRoot);
for (const arch of ["arm64", "x64"]) cpSync(join(feishuVendor, `darwin-${arch}`), join(feishuRoot, `darwin-${arch}`), { recursive: true });
writeFileSync(join(feishuRoot, "universal.json"), `${JSON.stringify({ schemaVersion: 1, targets: ["darwin-arm64", "darwin-x64"] }, null, 2)}\n`);

// electron-builder's directory target does not create updater metadata. Add it
// to the merged app before sealing resources, using the same private feed.
const packageName = JSON.parse(readFileSync("package.json", "utf8")).name;
if (packageName !== "openmausbot") throw new Error("Review the updater cache name after renaming the package.");
writeFileSync(join(outputApp, "Contents/Resources/app-update.yml"), stringify({
  ...privateConfig.publish[0],
  updaterCacheDirName: `${packageName}-updater`,
}));
execFileSync(process.execPath, ["scripts/check-private-package.mjs", join(outputApp, "Contents/Resources")], { stdio: "inherit" });

// No app byte is modified after this pass. The final DMG is mounted and
// independently verified; a successful electron-builder exit is not the gate.
signAdHoc(outputApp);
await verifyAdHocUniversal(outputApp, join(release, "macos-signature-audit.json"));
const dmgRoot = join(release, "dmg-root");
mkdirSync(dmgRoot);
execFileSync("/usr/bin/ditto", [outputApp, join(dmgRoot, "OpenMausBot.app")], { stdio: "inherit" });
symlinkSync("/Applications", join(dmgRoot, "Applications"));
const dmg = join(release, `RuijieBot-${version}-mac-universal.dmg`);
const zip = join(release, `RuijieBot-${version}-mac-universal.zip`);
execFileSync("/usr/bin/hdiutil", ["create", "-volname", `锐捷Bot ${version}`, "-srcfolder", dmgRoot, "-format", "UDZO", dmg], { stdio: "inherit", timeout: 600_000 });
execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", outputApp, zip], { stdio: "inherit", timeout: 600_000 });
execFileSync(process.execPath, ["scripts/regenerate-blockmaps.mjs", dmg, zip], { stdio: "inherit" });

const mount = join(release, "dmg-verify");
mkdirSync(mount);
run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
try { await verifyAdHocUniversal(join(mount, "OpenMausBot.app"), join(release, "macos-dmg-signature-audit.json")); }
finally { run("/usr/bin/hdiutil", ["detach", mount]); }

const files = [zip, dmg].map(file => {
  const bytes = readFileSync(file);
  return { url: file.slice(release.length + 1), sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
});
writeFileSync(join(release, "latest-mac.yml"), stringify({ version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: new Date().toISOString() }));
console.log("Universal DMG and ZIP complete: ad-hoc signed, not notarized.");
