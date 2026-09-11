import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopRuntimeLayout } from '../electron/desktop-runtime-layout.mjs';
import { runtimeArtifacts } from '../connectors/feishu/runtime-artifacts.mjs';
import { verifyFeishuRuntimeBundle } from './prepare-feishu-runtime.mjs';

const resources = path.resolve(process.argv[2]);
const { platform, arch } = process;
const layout = desktopRuntimeLayout({ packaged: true, resourcesPath: resources, appRoot: resources, platform, arch });
await verifyFeishuRuntimeBundle(layout.feishu, `${platform}-${arch}`);
const artifacts = runtimeArtifacts(platform, arch);
const home = mkdtempSync(path.join(tmpdir(), 'ruijiebot-feishu-smoke-'));
try {
  const config = path.join(home, 'config'); mkdirSync(config);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: config, LOCALAPPDATA: config, XDG_CONFIG_HOME: config };
  delete env.ELECTRON_RUN_AS_NODE;
  const node = path.join(layout.feishu, artifacts.node.directory, artifacts.node.name);
  const cli = path.join(layout.feishu, artifacts.cli.directory, artifacts.cli.name);
  const options = { env, cwd: home, encoding: 'utf8', timeout: 30_000, windowsHide: true };
  assert.equal(execFileSync(node, ['-p', 'process.arch'], options).trim(), arch);
  const version = execFileSync(cli, ['--version'], options);
  assert(version.includes(artifacts.cli.version), `Unexpected bundled Lark CLI version: ${version}`);
  console.log(`Feishu pinned Node and Lark CLI executed on ${platform}-${arch}; no account authorization performed.`);
} finally { rmSync(home, { recursive: true, force: true }); }
