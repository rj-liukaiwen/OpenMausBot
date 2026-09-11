import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { browserBundlePaths } from "../server/browser-bundle-release.ts";
import { digest, verifyFeeds } from "../scripts/private-release-assets.mjs";
import { stringify } from "yaml";

test("universal browser selects each CPU and never falls back when a slice is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-universal-test-"));
  try {
    writeFileSync(join(root, "universal.json"), JSON.stringify({ targets: ["darwin-arm64", "darwin-x64"] }));
    mkdirSync(join(root, "darwin-arm64"));
    writeFileSync(join(root, "darwin-arm64", "agent-browser"), "arm fixture");
    const arm = browserBundlePaths(root, "darwin-arm64");
    const intel = browserBundlePaths(root, "darwin-x64");
    assert.equal(arm.engine, join(root, "darwin-arm64", "agent-browser"));
    assert.equal(intel.engine, join(root, "darwin-x64", "agent-browser"));
    assert.equal(existsSync(arm.engine), true);
    assert.equal(existsSync(intel.engine), false);
    assert.match(arm.chrome, /chrome-headless-shell-mac-arm64/);
    assert.match(intel.chrome, /chrome-headless-shell-mac-x64/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing single-architecture browser packages retain their paths", () => {
  for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) {
    const root = join(tmpdir(), "omb-no-universal-marker");
    const bundle = browserBundlePaths(root, target);
    assert.equal(bundle.directory, root);
    assert.equal(bundle.manifest, join(root, "manifest.json"));
  }
});

test("release feed verification rejects changed artifacts and paths outside the asset directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-feed-test-"));
  try {
    const asset = join(root, "candidate.zip");
    writeFileSync(asset, "final package bytes");
    const hash = await digest(asset, "sha512", "base64");
    const feed = { version: "0.1.73", files: [{ url: "candidate.zip", size: Buffer.byteLength("final package bytes"), sha512: hash }], path: "candidate.zip", sha512: hash };
    writeFileSync(join(root, "latest-mac.yml"), stringify(feed));
    await verifyFeeds(root);
    writeFileSync(asset, "different package bytes");
    await assert.rejects(verifyFeeds(root), /hash\/size mismatch/);
    feed.files[0].url = "../candidate.zip";
    writeFileSync(join(root, "latest-mac.yml"), stringify(feed));
    await assert.rejects(verifyFeeds(root), /Invalid asset path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private evaluation config preserves app identity, resources, and explicit signing status", async () => {
  const requireBuilder = createRequire(import.meta.resolve("electron-builder"));
  const { getConfig, validateConfiguration } = requireBuilder("app-builder-lib/out/util/config/config.js");
  const config = await getConfig(fileURLToPath(new URL("../", import.meta.url)), "electron-builder.testing.mjs", null);
  await validateConfiguration(config);
  assert.deepEqual(config.publish, [{ provider: "github", owner: "rj-liukaiwen", repo: "OpenMausBot", private: true }]);
  assert.equal(config.appId, "com.openmausbot.app");
  assert.equal(config.productName, "OpenMausBot");
  assert.equal(config.mac.identity, "-");
  assert.equal(config.mac.notarize, false);
  assert.equal(config.dmg.sign, false);
  assert.equal(config.win.publisherName, undefined);
  assert.equal(config.afterPack, "./scripts/after-pack.mjs");
  for (const platform of ["win", "mac", "linux"]) {
    assert(config[platform].extraResources.some(item => item.to === "browser-engine"));
  }
});
