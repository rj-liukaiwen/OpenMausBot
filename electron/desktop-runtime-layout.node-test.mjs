import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { desktopRuntimeLayout } from './desktop-runtime-layout.mjs';

test('development preview and package use compiled code and target-specific native resources', () => {
  const options = { appRoot: path.resolve('checkout'), resourcesPath: path.resolve('installed/resources'), platform: 'win32', arch: 'x64', resolveResourceRoot: (value) => value };
  const preview = desktopRuntimeLayout({ ...options, packaged: false, preview: true });
  const installed = desktopRuntimeLayout({ ...options, packaged: true, preview: false });
  assert.equal(preview.built, true); assert.equal(installed.built, true);
  assert.equal(preview.server, path.join(options.appRoot, 'dist-server/index.js'));
  assert.equal(preview.ui, path.join(options.appRoot, 'dist'));
  assert.equal(preview.feishu, path.join(options.appRoot, 'dist-native/feishu-runtime/win32-x64'));
  assert.equal(installed.feishu, path.join(options.resourcesPath, 'tuantuan-feishu-runtime'));
  assert.equal(installed.server, path.join(options.resourcesPath, 'server/index.js'));
  assert.equal('dataDir' in preview, false, 'Content mode must not replace development data identity');
  const hmr = desktopRuntimeLayout({ ...options, packaged: false, preview: false });
  assert.equal(hmr.built, false); assert.equal(hmr.feishu, undefined);
  assert.equal(hmr.server, path.join(options.appRoot, 'server/index.ts'));
});

test('a development shortcut through a junction resolves trusted native resources without changing data or MCP identity', () => {
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'ruijie-layout-junction-')));
  const physical = path.join(temp, 'physical'), alias = path.join(temp, 'shortcut');
  try {
    mkdirSync(physical);
    symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const layout = desktopRuntimeLayout({ packaged: false, preview: true,
      appRoot: alias, resourcesPath: path.join(temp, 'electron'), platform: process.platform, arch: process.arch });
    assert.equal(layout.feishu, path.join(physical, 'dist-native/feishu-runtime', `${process.platform}-${process.arch}`));
    assert.equal(layout.browser, path.join(physical, 'dist-native/browser', `${process.platform}-${process.arch}`));
    assert.equal(layout.server, path.join(alias, 'dist-server/index.js'));
    assert.equal('dataDir' in layout, false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
