import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const resources = resolve(process.argv[2]);
const update = parse(readFileSync(join(resources, "app-update.yml"), "utf8"));
assert.equal(update.provider, "github");
assert.equal(update.owner, "rj-liukaiwen");
assert.equal(update.repo, "OpenMausBot");
assert.equal(update.private, true);
assert.equal(update.publisherName, undefined);
assert.equal(update.token, undefined);
const meta = JSON.parse(readFileSync(join(resources, "private-release.json"), "utf8"));
assert.equal(meta.version, JSON.parse(readFileSync("package.json", "utf8")).version);
assert.equal(meta.repository, "rj-liukaiwen/OpenMausBot");
for (const file of ["app.asar", "ui/index.html", "server/index.js", "server/ruijie-computer-proxy.js", "companion/index.js", "licenses/OpenMausBot-LICENSE.txt", "licenses/OpenMausBot-NOTICE.txt"]) {
  assert(existsSync(join(resources, file)), `Missing packaged resource: ${file}`);
}
console.log(`Verified private updater target, version and package resources: ${resources}`);
