import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { runtimeArtifacts } from "../connectors/feishu/runtime-artifacts.mjs";
import { checkApprovedArtifacts, extractPinnedExecutable } from "../connectors/feishu/runtime.mjs";
import { extractPinnedTarExecutable, nativeExecutable } from "../connectors/feishu/native-format.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularBytes(file, maxBytes = 100 * 1024 * 1024) {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink() || details.size > maxBytes) throw new Error(`Invalid Feishu runtime file: ${file}`);
  return readFile(file);
}

async function pinnedFile(file, expected, maxBytes) {
  try {
    const bytes = await regularBytes(file, maxBytes);
    return sha256(bytes) === expected ? bytes : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`)));
  });
}

async function publishDirectory(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt >= 6) throw error;
      await delay(100 * 2 ** attempt);
    }
  }
}

async function download(url, destination, expected, maxBytes) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    if (process.platform === "win32") {
      await run("curl.exe", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "15",
        "--max-time", "180", "--output", temporary, url]);
      const bytes = await regularBytes(temporary, maxBytes);
      if (sha256(bytes) !== expected) throw new Error(`Checksum mismatch for ${url}`);
      await rename(temporary, destination);
      return bytes;
    }
    let failure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes || sha256(bytes) !== expected) throw new Error("checksum mismatch");
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, destination);
        return bytes;
      } catch (error) { failure = error; }
    }
    throw failure;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function cachedExecutable(cache, artifact) {
  for (const file of [
    path.join(cache, artifact.directory, artifact.name),
    path.join(cache, artifact.name),
  ]) {
    const bytes = await pinnedFile(file, artifact.executableSha256, artifact.maxBytes);
    if (bytes) return bytes;
  }
  return null;
}

export async function verifyFeishuRuntimeBundle(root, target = `${process.platform}-${process.arch}`) {
  const [platform, arch] = target.split('-');
  const artifacts = runtimeArtifacts(platform, arch);
  const notices = await checkApprovedArtifacts(platform, arch);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 2 || manifest.target !== target) throw new Error("Unsupported or wrong-target Feishu runtime bundle manifest");
  for (const kind of ["cli", "node"]) {
    const artifact = artifacts[kind];
    const file = path.join(root, artifact.directory, artifact.name);
    const bytes = await regularBytes(file, artifact.maxBytes);
    if (sha256(bytes) !== artifact.executableSha256 || manifest.artifacts?.[kind]?.sha256 !== artifact.executableSha256 ||
        manifest.artifacts?.[kind]?.version !== artifact.version || !nativeExecutable(bytes, platform, arch)) {
      throw new Error(`Invalid bundled Feishu ${kind}`);
    }
    const license = await regularBytes(path.join(root, artifact.directory, "LICENSE"), artifact.license.maxBytes);
    if (sha256(license) !== artifact.license.sha256) throw new Error(`Invalid bundled Feishu ${kind} license`);
    for (const notice of notices[kind]) {
      const contents = await regularBytes(path.join(root, artifact.directory, 'licenses', notice.path), notice.bytes);
      if (contents.length !== notice.bytes || sha256(contents) !== notice.sha256) throw new Error(`Invalid bundled Feishu notice: ${notice.path}`);
    }
    if (platform !== 'win32' && !((await lstat(file)).mode & 0o111)) throw new Error(`Feishu executable has no execute permission: ${file}`);
  }
  return true;
}

export async function prepareFeishuRuntime({
  root = ROOT,
  target = `${process.platform}-${process.arch}`,
  cache = process.env.OMB_FEISHU_RUNTIME_CACHE || path.join(root, "dist-native", "feishu-runtime-cache"),
  output = path.join(root, "dist-native", "feishu-runtime", target),
} = {}) {
  const [platform, arch] = target.split('-');
  const artifacts = runtimeArtifacts(platform, arch);
  // Licensing remains an exact-platform gate. Never copy Windows approval
  // flags to Mac just because the upstream version number is the same.
  const notices = await checkApprovedArtifacts(platform, arch);
  const generatedRoot = path.resolve(root, 'dist-native');
  output = path.resolve(output);
  if (!output.startsWith(generatedRoot + path.sep)) throw new Error('Feishu output must be inside the repository dist-native directory');
  try { await verifyFeishuRuntimeBundle(output, target); return output; } catch { /* rebuild exact generated output */ }
  await mkdir(cache, { recursive: true });
  const executables = {};
  for (const kind of ['cli', 'node']) {
    const artifact = artifacts[kind];
    let bytes = await cachedExecutable(cache, artifact);
    if (!bytes) {
      const payload = path.join(cache, target, path.basename(new URL(artifact.url).pathname));
      const archive = await pinnedFile(payload, artifact.sha256, artifact.maxBytes) ??
        await download(artifact.url, payload, artifact.sha256, artifact.maxBytes);
      bytes = artifact.format === 'tar.gz'
        ? extractPinnedTarExecutable(archive, artifact.member, artifact.executableSha256, platform, arch)
        : artifact.member ? extractPinnedExecutable(archive, artifact.member, artifact.executableSha256) : archive;
    }
    if (!nativeExecutable(bytes, platform, arch)) throw new Error(`Wrong Feishu runtime architecture: ${target}/${kind}`);
    executables[kind] = bytes;
  }
  const licenses = {
    cli: path.join(root, "connectors", "feishu", "licenses", "CLI_LICENSE.txt"),
    node: path.join(root, "connectors", "feishu", "licenses", "NODE_LICENSE.txt"),
  };
  const stage = `${output}.stage-${randomUUID()}`;
  try {
    for (const [kind, bytes] of Object.entries(executables)) {
      const artifact = artifacts[kind];
      const directory = path.join(stage, artifact.directory);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, artifact.name), bytes, { flag: "wx", mode: 0o755 });
      await copyFile(licenses[kind], path.join(directory, "LICENSE"));
      for (const notice of notices[kind]) {
        const file = path.join(directory, 'licenses', notice.path);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, notice.contents, { flag: 'wx', mode: 0o644 });
      }
    }
    await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify({
      schemaVersion: 2, target,
      artifacts: Object.fromEntries(["cli", "node"].map((kind) => [kind, {
        version: artifacts[kind].version,
        sha256: artifacts[kind].executableSha256,
      }])),
    }, null, 2)}\n`);
    await verifyFeishuRuntimeBundle(stage, target);
    // Preserve the old complete tree until the new, verified tree is ready.
    const previous = `${output}.previous-${randomUUID()}`;
    let hadPrevious = false;
    try { await rename(output, previous); hadPrevious = true; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try { await publishDirectory(stage, output); }
    catch (error) { if (hadPrevious) await rename(previous, output); throw error; }
    // Retain previous generated resources for recovery; do not delete caller data.
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--target') && !(args.length === 1 && args[0] === '--current')) {
    throw new Error('Usage: node scripts/prepare-feishu-runtime.mjs [--current | --target PLATFORM-ARCH]');
  }
  const targets = args[0] === '--target' ? [args[1]] : process.platform === 'darwin' && !args.length
    ? ['darwin-arm64', 'darwin-x64'] : [`${process.platform}-${process.arch}`];
  for (const target of targets) console.log(`Prepared Feishu runtime: ${await prepareFeishuRuntime({ target })}`);
}
