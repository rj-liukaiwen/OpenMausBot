import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launcher = new URL("../scripts/start-local-windows.ps1", import.meta.url);
const windowlessLauncher = new URL("../scripts/start-local-windows.vbs", import.meta.url);
const nativeLauncher = new URL("../scripts/OpenMausBot.DevLauncher.cs", import.meta.url);
const shortcutInstaller = new URL("../scripts/install-local-windows-shortcut.ps1", import.meta.url);
const mainProcess = new URL("./main.mjs", import.meta.url);
const onboarding = new URL("../src/components/Onboarding.tsx", import.meta.url);

test("source browser uses the complete staged Windows pair without overriding explicit paths", async () => {
  const source = await readFile(launcher, "utf8");
  assert.match(source, /-not \$env:OMB_AGENT_BROWSER_PATH -and -not \$env:AGENT_BROWSER_EXECUTABLE_PATH/);
  assert.match(source, /\$env:OMB_BROWSER_BUNDLE_DIR = \$stagedBrowserRoot/);
  assert.match(source, /'manifest.json'/);
});

test("the desktop wrapper starts PowerShell without flashing a console", async () => {
  const source = await readFile(windowlessLauncher, "utf8");
  assert.match(source, /start-local-windows\.ps1/);
  assert.match(source, /shell\.Run command, 0, False/);
});

test("the shortcut owns the credential-aware server and prepares installer-equivalent compiled resources", async () => {
  const source = await readFile(launcher, "utf8");
  assert.match(source, /Join-Path \$repoRoot 'node_modules\\vite\\bin\\vite\.js'/);
  assert.match(source, /\$developmentServerPort\s*=\s*38799/);
  assert.match(source, /Stop-LocalDevelopmentService \$developmentServerPort/);
  assert.match(source, /Stop-LocalDevelopmentService 5199/);
  assert.match(source, /\$env:OMB_DESKTOP_SERVER\s*=\s*'1'/);
  assert.doesNotMatch(source, /Start-LocalService 'dev:server'/);
  assert.doesNotMatch(source, /Start-LocalService 'dev' 'vite'/);
  assert.match(source, /prepare-local-preview\.mjs/);
  assert.match(source, /\$env:OMB_DESKTOP_PREVIEW\s*=\s*'1'/);
  assert.match(source, /\$env:OMB_CONTROL_PLANE_URL\s*=\s*'https:\/\/accounts\.openmausbot\.com'/);
  assert.match(source, /\[char\]0x9510/);
  assert.match(source, /\[char\]0x6377/);
  assert.match(source, /\$env:OMB_USER_DATA\s*=\s*Join-Path \$env:APPDATA \$ruijieAppName/);
  assert.match(source, /\$env:OMB_DATA_DIR\s*=\s*Join-Path \$env:USERPROFILE '\.openmausbot'/);
  assert.match(source, /\$env:OMB_PORT\s*=\s*\[string\]\$developmentServerPort/);
  assert.match(source, /Get-ItemProperty[\s\S]*Internet Settings/);
  assert.match(source, /ProxyEnable\s*-ne\s*1/);
  assert.match(source, /\$env:NODE_USE_ENV_PROXY\s*=\s*'1'/);
  assert.match(source, /\$env:HTTPS_PROXY\s*=\s*\$proxy/);
  assert.match(source, /127\.0\.0\.1,localhost,::1/);
  assert.doesNotMatch(source, /\$env:OMB_DESKTOP_PARENT\s*=\s*\$null/);
  assert.doesNotMatch(source, /\$env:OMB_USER_DATA\s*=.*'锐捷Bot'/);
  assert.doesNotMatch(source, /D:\\ChatGPT\\RuijieDSH/);
  assert.match(source, /\$env:RUIJIE_HARNESS_EXECUTABLE\s*=\s*\$null/);
});

test("a second desktop launch reaches Electron so it can restore the existing window", async () => {
  const source = await readFile(launcher, "utf8");
  assert.doesNotMatch(source, /if \(\$alreadyRunning\) \{ exit 0 \}/);
  assert.match(source, /\$quotedDesktopCommandLine/);
  assert.match(source, /\$plainDesktopCommandLine/);
  assert.match(source, /\.CommandLine\)\.Trim\(\) -in/);
  assert.match(
    source,
    /if \(\$alreadyRunning\) \{[\s\S]*Start-DesktopApp[\s\S]*return[\s\S]*\}/,
  );
  assert.match(source, /Start-DesktopApp/);
});

test("concurrent shortcut launches are serialized before checking for an existing window", async () => {
  const source = await readFile(launcher, "utf8");
  assert.match(source, /Threading\.Mutex/);
  assert.match(source, /WaitOne/);
  assert.match(source, /Invoke-Launcher[\s\S]*ReleaseMutex/);
});

test("a cold shortcut launch starts Electron directly and verifies that it stays alive", async () => {
  const source = await readFile(launcher, "utf8");
  assert.match(source, /node_modules\\electron\\dist\\electron\.exe/);
  assert.match(source, /Start-Process[\s\S]*-PassThru/);
  assert.match(source, /HasExited/);
  assert.doesNotMatch(source, /Start-LocalService 'dev:desktop' 'desktop'/);
});

test("an opted-in development desktop uses the same private server ownership path as a package", async () => {
  const source = await readFile(mainProcess, "utf8");
  assert.match(source, /const OWNS_LOCAL_SERVER\s*=\s*app\.isPackaged\s*\|\|\s*process\.env\.OMB_DESKTOP_SERVER\s*===\s*"1"/);
  assert.match(source, /else if \(OWNS_LOCAL_SERVER\) \{\s*serverReady = await startServerPackaged\(\)/);
  assert.match(source, /const entry = desktopLayout.server/);
  assert.match(source, /execArgv:\s*desktopLayout.built\s*\?\s*\[\]\s*:\s*\["--experimental-strip-types"\]/);
});

test("the shortcut is never rewritten while it is launching", async () => {
  const source = await readFile(launcher, "utf8");
  assert.doesNotMatch(source, /set-windows-shortcut-app-id\.ps1/);
});

test("the development shortcut uses a branded native launcher", async () => {
  const [nativeSource, installerSource, mainSource] = await Promise.all([
    readFile(nativeLauncher, "utf8"),
    readFile(shortcutInstaller, "utf8"),
    readFile(mainProcess, "utf8"),
  ]);
  assert.match(nativeSource, /start-local-windows\.ps1/);
  assert.match(nativeSource, /CreateNoWindow\s*=\s*true/);
  assert.match(installerSource, /target:winexe/);
  assert.match(installerSource, /win32icon:/);
  assert.match(installerSource, /OpenMausBot\.DevLauncher\.exe/);
  assert.match(installerSource, /node_modules\\electron\\dist\\electron\.exe/);
  assert.match(installerSource, /rcedit\.exe/);
  assert.match(installerSource, /--set-icon/);
  assert.match(installerSource, /StartMenu/);
  const installerAppId = installerSource.match(/\$localDevelopmentAppId\s*=\s*'([^']+)'/)?.[1];
  const mainAppId = mainSource.match(/app\.isPackaged\s*\?\s*"com\.openmausbot\.app"\s*:\s*"([^"]+)"/)?.[1];
  assert.equal(installerAppId, "com.openmausbot.app.localdev.source");
  assert.equal(mainAppId, installerAppId);
  assert.match(mainSource, /app\.isPackaged\) app\.setPath\("userData", path\.join\(app\.getPath\("appData"\), "锐捷Bot Installed"\)\)/);
  assert.match(mainSource, /app\.isPackaged \? "\.ruijiebot" : "\.openmausbot"/);
  assert.match(mainSource, /root: desktopDataDir\(\)/);
  assert.match(mainSource, /title:\s*"锐捷Bot"/);
  assert.match(mainSource, /OMB_BROWSER_DEFAULT_ENABLED:\s*"1"/);
  assert.match(mainSource, /nativeTheme\.themeSource\s*=\s*nativeThemeSourceForSkin\(skin\)/);
  assert.match(installerSource, /set-windows-shortcut-app-id\.ps1/);
});

test("the Windows shell shows a branded startup surface before the renderer is ready", async () => {
  const source = await readFile(mainProcess, "utf8");
  assert.match(source, /startupSplashDataUrl/);
  assert.match(source, /new WebContentsView/);
  assert.match(source, /startupOverlay\.webContents\.loadURL\(startupSplashDataUrl\(\)\)/);
  assert.match(source, /win\.contentView\.addChildView\(startupOverlay\)/);
  assert.match(source, /await win\.loadURL\(targetUrl\)/);
  assert.match(source, /win\.contentView\.removeChildView\(startupOverlay\)/);
  assert.match(source, /win\.removeListener\("resize", sizeStartupOverlay\)/);
  assert.match(source, /startupOverlay\?\.webContents/);
  assert.ok(
    source.indexOf("startupOverlay.webContents.loadURL(startupSplashDataUrl())") <
      source.indexOf("await win.loadURL(targetUrl)"),
  );
});

test("the enterprise onboarding names the Ruijie product", async () => {
  const source = await readFile(onboarding, "utf8");
  assert.match(source, />登录 锐捷Bot</);
  assert.doesNotMatch(source, />登录 OpenMausBot</);
});
