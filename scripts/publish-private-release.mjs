import { appendFileSync, createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { digest, expectedArtifacts, verifyFeeds } from "./private-release-assets.mjs";

const repository = process.env.GITHUB_REPOSITORY;
if (repository !== "rj-liukaiwen/OpenMausBot") throw new Error("Unexpected release repository.");
const version = process.env.RELEASE_VERSION;
const sha = process.env.RELEASE_SHA;
const mode = process.env.RELEASE_MODE;
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{40}$/.test(sha) || !["draft", "prerelease", "artifacts"].includes(mode)) throw new Error("Invalid release inputs.");
const directory = "release-assets";
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
async function api(route, method = "GET", body) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`GitHub ${method} ${route}: ${response.status}: ${data.message}`);
  return data;
}
if (!(await api("")).private) throw new Error("Refusing to publish evaluation assets in a public repository.");
const allowed = new Set();
for (const platform of ["windows", "linux", "macos"]) {
  const reportName = `build-report-${platform}.json`;
  const report = JSON.parse(readFileSync(join(directory, reportName), "utf8"));
  if (report.version !== version || report.sourceSha !== sha) throw new Error(`Mismatched ${platform} build commit/version.`);
  for (const name of expectedArtifacts(version, platform)) {
    allowed.add(name);
    const entry = report.artifacts.find(entry => entry.name === name);
    const file = join(directory, name);
    if (!entry || entry.bytes !== statSync(file).size || entry.sha256 !== await digest(file)) throw new Error(`Artifact provenance mismatch: ${name}`);
  }
  allowed.add(reportName);
  allowed.add(`SHA256SUMS-${platform}.txt`);
}
const intel = JSON.parse(readFileSync(join(directory, "macos-intel-verification.json"), "utf8"));
if (intel.version !== version || intel.sourceSha !== sha || intel.arch !== "x64" || intel.result !== "passed") throw new Error("Intel verification did not pass for this candidate.");
allowed.add("macos-intel-verification.json");
await verifyFeeds(directory);
for (const name of readdirSync(directory)) if (!allowed.has(name)) throw new Error(`Unexpected release file: ${name}`);
if (mode === "artifacts") {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, "All platform artifacts and hashes verified. Artifact-only mode: no Release created.\n");
  process.exit(0);
}
const existing = (await api("/releases?per_page=100")).find(release => release.tag_name === `v${version}`);
if (existing && (!existing.draft || existing.target_commitish !== sha)) throw new Error(`Release v${version} already exists for another candidate or is published. Existing assets will not be overwritten.`);
const body = `Private evaluation build v${version}\n\nBuild commit: ${sha}\n\n- Windows x64: unsigned NSIS installer and portable ZIP.\n- Linux x64: DEB and AppImage.\n- macOS Universal (Intel and Apple Silicon): ad-hoc signed, not notarized. Final DMG signature audit included.\n- Browser and packaged-server checks run on both Mac CPU architectures in CI.\n- Physical Mac TCC, installation and upgrade acceptance: not run. These packages are test candidates.\n- Download while signed into this private GitHub repository. No GitHub token is embedded; automatic private-repository updates are not provided.\n- Enterprise components are retained for development, test and evaluation under their existing license. No redistribution or production authorization is implied.\n\nSee the attached SHA256SUMS and build reports. Do not disable Gatekeeper/SIP or reset TCC to mask a failure.\n`;
const release = existing ?? await api("/releases", "POST", { tag_name: `v${version}`, target_commitish: sha, name: `v${version} · Private evaluation`, body, draft: true, prerelease: true });
const priorAssets = existing ? await api(`/releases/${release.id}/assets?per_page=100`) : [];
const endpoint = release.upload_url.replace(/\{.*$/, "");
if (new URL(endpoint).hostname !== "uploads.github.com") throw new Error("Unexpected GitHub upload endpoint.");
for (const name of [...allowed].sort()) {
  const file = join(directory, name);
  const bytes = statSync(file).size;
  const prior = priorAssets.find(asset => asset.name === name);
  if (prior) {
    if (prior.size !== bytes || prior.digest !== `sha256:${await digest(file)}`) throw new Error(`Existing draft asset cannot be safely reused: ${name}`);
    console.log(`Verified previously uploaded ${name}`);
    continue;
  }
  const response = await fetch(`${endpoint}?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(bytes) }, body: createReadStream(file), duplex: "half" });
  const asset = await response.json();
  if (!response.ok || asset.size !== bytes) throw new Error(`Failed uploading ${name}: HTTP ${response.status}`);
  if (asset.digest && asset.digest !== `sha256:${await digest(file)}`) throw new Error(`Uploaded asset digest differs: ${name}`);
  console.log(`Uploaded and checked ${name}`);
}
const uploaded = await api(`/releases/${release.id}/assets?per_page=100`);
if (uploaded.length !== allowed.size || uploaded.some(asset => !allowed.has(asset.name))) throw new Error("Release assets are incomplete.");
const final = mode === "prerelease" ? await api(`/releases/${release.id}`, "PATCH", { draft: false, prerelease: true, make_latest: "false" }) : release;
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release ready: ${final.html_url}\n\nMode: ${mode}. Physical-machine acceptance remains outstanding.\n`);
appendFileSync(process.env.GITHUB_OUTPUT, `release_url=${final.html_url}\n`);
