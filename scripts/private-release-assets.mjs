import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

export async function digest(file, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

export function expectedArtifacts(version, platform) {
  if (platform === "windows") return [`RuijieBot-${version}-setup.exe`, `RuijieBot-${version}-x64.zip`, `RuijieBot-${version}-setup.exe.blockmap`, "latest.yml"];
  if (platform === "linux") return [`RuijieBot-${version}-amd64.deb`, `RuijieBot-${version}-x86_64.AppImage`, "latest-linux.yml"];
  if (platform === "macos") return [`RuijieBot-${version}-mac-universal.dmg`, `RuijieBot-${version}-mac-universal.zip`, `RuijieBot-${version}-mac-universal.dmg.blockmap`, `RuijieBot-${version}-mac-universal.zip.blockmap`, "latest-mac.yml", "macos-signature-audit.json", "macos-dmg-signature-audit.json"];
  throw new Error(`Unknown package platform: ${platform}`);
}

export async function verifyFeeds(directory) {
  for (const name of readdirSync(directory).filter(name => /^latest(?:-mac|-linux)?\.yml$/.test(name))) {
    const feed = parse(readFileSync(join(directory, name), "utf8"));
    if (!feed.files?.length) throw new Error(`Empty update feed: ${name}`);
    for (const item of feed.files) {
      if (basename(item.url) !== item.url || item.url.includes("\\")) throw new Error(`Invalid asset path in ${name}`);
      const file = join(directory, item.url);
      if (statSync(file).size !== item.size || await digest(file, "sha512", "base64") !== item.sha512) throw new Error(`Feed hash/size mismatch: ${item.url}`);
    }
    if (feed.path) {
      if (basename(feed.path) !== feed.path || feed.path.includes("\\")) throw new Error(`Invalid legacy asset path in ${name}`);
      if (await digest(join(directory, feed.path), "sha512", "base64") !== feed.sha512) throw new Error(`Legacy feed hash mismatch: ${name}`);
    }
  }
}

async function main() {
  const [platform, directoryArg = "release"] = process.argv.slice(2);
  const directory = resolve(directoryArg);
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const files = expectedArtifacts(version, platform);
  const checksums = [];
  for (const name of files) {
    const file = join(directory, name);
    if (!statSync(file).isFile() || statSync(file).size === 0) throw new Error(`Missing/empty release asset: ${name}`);
    checksums.push({ name, bytes: statSync(file).size, sha256: await digest(file) });
  }
  await verifyFeeds(directory);
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(directory, `SHA256SUMS-${platform}.txt`), `${checksums.map(f => `${f.sha256}  ${f.name}`).join("\n")}\n`);
  writeFileSync(join(directory, `build-report-${platform}.json`), `${JSON.stringify({ schemaVersion: 1, version, sourceSha, platform, signing: platform === "macos" ? "ad-hoc signed, not notarized" : platform === "windows" ? "unsigned" : "not applicable", humanAcceptance: "skipped-by-owner", artifacts: checksums }, null, 2)}\n`);
  const staged = join(directory, "private-artifacts");
  mkdirSync(staged, { recursive: true });
  for (const name of [...files, `SHA256SUMS-${platform}.txt`, `build-report-${platform}.json`]) copyFileSync(join(directory, name), join(staged, name));
  console.log(`Verified ${files.length} ${platform} assets and their update feed hashes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
