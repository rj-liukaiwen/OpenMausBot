import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const builderRequire = createRequire(import.meta.resolve("electron-builder"));
const { getConfig, validateConfiguration } = builderRequire("app-builder-lib/out/util/config/config.js");

test("Ruijie packaging resolves WYunS without losing upstream resources or app identity", async () => {
  const config = await getConfig(root, "electron-builder.ruijie.mjs", null);
  await validateConfiguration(config);
  assert.deepEqual(config.publish, [{ provider: "github", owner: "WYunS", repo: "OpenMausBot" }]);
  assert.equal(config.appId, "com.openmausbot.app");
  assert.equal(config.productName, "OpenMausBot");
  assert.equal(config.afterPack, "./scripts/after-pack.mjs");
  assert.equal(config.win.artifactName, "RuijieBot-${version}-${arch}.${ext}");
  assert.equal(config.mac.artifactName, 'RuijieBot-${version}-mac-${arch}.${ext}');
  assert.equal(config.dmg.artifactName, 'RuijieBot-${version}-mac-${arch}.dmg');
  assert.equal(typeof config.beforePack, 'function');
  assert.equal(config.nsis.shortcutName, "锐捷Bot");
  assert.equal(config.nsis.uninstallDisplayName, "锐捷Bot");
  assert.equal(config.nsis.artifactName, "RuijieBot-${version}-setup.${ext}");
  assert(config.win.extraResources.some((entry) => entry.to === "tuantuan-feishu-runtime"));
  for (const platform of ["win", "mac"]) {
    assert(config[platform].extraResources.some((entry) => entry.to === "tuantuan-feishu"));
    assert(config[platform].extraResources.some((entry) => entry.to === "tuantuan-feishu-runtime" && entry.from.includes('feishu-runtime/')));
    assert(config[platform].extraResources.some((entry) => entry.to === "browser-engine"));
    assert(config[platform].extraResources.some((entry) => entry.to === "cloudflared/cloudflared" || entry.to === "cloudflared/cloudflared.exe"));
  }
  assert(config.extraResources.some((entry) => entry.to === "server"));
  assert(config.extraResources.some((entry) => entry.to === "ui"));
  assert(config.extraResources.some((entry) => entry.to === "companion"));
});

test("the standard Windows package command cannot bypass the Ruijie config or bundled runtimes", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["package:win"], /build:feishu:windows/);
  assert.match(pkg.scripts["package:win"], /--config electron-builder\.ruijie\.mjs/);
  assert.match(pkg.scripts['package:mac'], /--config electron-builder\.ruijie\.mjs/);
  assert.match(pkg.scripts['package:mac'], /build:feishu:mac/);
});

test("internal Mac candidate flags retain the downstream feed and explicitly request ad-hoc signing", async () => {
  const config = await getConfig(root, "electron-builder.ruijie.mjs", { mac: { identity: "-" }, dmg: { sign: false } });
  await validateConfiguration(config);
  assert.equal(config.mac.identity, "-");
  assert.equal(config.mac.notarize, false);
  assert.equal(config.dmg.sign, false);
  assert.equal(config.publish[0].owner, "WYunS");
});

test("syncing downstream main cannot create desktop releases or publish a Docker image", async () => {
  const release = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"], "desktop release must be explicitly dispatched");
  const docker = parse(await readFile(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8"));
  assert.equal(docker.jobs.publish.if,
    "startsWith(github.ref, 'refs/tags/v') && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    "branch pushes may build/smoke but must never publish an image");
});
