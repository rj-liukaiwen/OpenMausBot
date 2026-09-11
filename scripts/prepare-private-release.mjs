import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const repository = process.env.GITHUB_REPOSITORY;
if (repository !== "rj-liukaiwen/OpenMausBot") throw new Error("This evaluation workflow is restricted to rj-liukaiwen/OpenMausBot.");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const version = (process.env.RELEASE_VERSION?.trim() || manifest.version).replace(/^v/, "");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Version must have the form v0.1.73 or 0.1.73.");
const tag = `v${version}`;
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
const infoResponse = await fetch(`https://api.github.com/repos/${repository}`, { headers });
if (!infoResponse.ok || !(await infoResponse.json()).private) throw new Error("Evaluation builds require a private repository.");
for (const route of [`git/ref/tags/${tag}`, `releases/tags/${tag}`]) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, { headers });
  if (response.status !== 404) throw new Error(response.ok ? `${tag} already exists; use a new version instead of overwriting it.` : `Could not verify ${tag}: HTTP ${response.status}`);
}
if (git("status", "--porcelain")) throw new Error("Release preparation requires a clean checkout.");
const sourceSha = git("rev-parse", "HEAD");
manifest.version = version;
writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync("build/private-release.json", `${JSON.stringify({ schemaVersion: 1, version, sourceSha, upstreamSha: "a9c8187712e6f99c8a63dadec2835c43dd982446", repository, workflowRun: process.env.GITHUB_RUN_ID, signing: { windows: "unsigned", macos: "ad-hoc signed, not notarized" }, usage: "private development, test and evaluation only" }, null, 2)}\n`);
git("config", "user.name", "github-actions[bot]");
git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
git("add", "package.json", "build/private-release.json");
if (git("diff", "--cached", "--name-only")) git("commit", "-m", `build: prepare private evaluation ${tag}`);
const sha = git("rev-parse", "HEAD");
const candidateBranch = `evaluation/${tag}/${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
git("push", "origin", `HEAD:refs/heads/${candidateBranch}`);
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nsha=${sha}\nsource_sha=${sourceSha}\n`);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Private evaluation ${tag}\n\nSource: \`${sourceSha}\`\n\nBuild commit shared by all platforms: \`${sha}\`\n\nWindows unsigned; macOS ad-hoc signed, not notarized.\n`);
