$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $env:LOCALAPPDATA 'OpenMausBot-Dev\logs'
$electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$developmentServerPort = 38799
# Source builds intentionally require an explicit trusted control plane before
# sending SSO tokens or provisioning the secure phone tunnel. This branded
# development shortcut targets the same production service as packaged builds.
$env:OMB_CONTROL_PLANE_URL = 'https://accounts.openmausbot.com'
# Windows PowerShell 5.1 can decode a UTF-8-without-BOM script using the
# machine's legacy code page. Construct the localized directory name from
# Unicode code points so Electron and the standalone server always resolve
# the same userData path regardless of that code page.
$ruijieAppName = ([string][char]0x9510) + ([char]0x6377) + 'Bot'
$env:OMB_USER_DATA = Join-Path $env:APPDATA $ruijieAppName
$env:OMB_DATA_DIR = Join-Path $env:USERPROFILE '.openmausbot'
$env:OMB_PORT = [string]$developmentServerPort
# Let Electron own the source server so encrypted plugin credentials travel
# over the same private parent/child channel used by packaged builds.
$env:OMB_DESKTOP_SERVER = '1'
$env:OMB_DESKTOP_PREVIEW = '1'
$env:OMB_BROWSER_CONNECTION = $null

# Match packaged Bot behavior: discover the installed Harness.  Development
# Harness is launched explicitly from its own shortcut when it is the product
# under test; silently overriding the provider here makes a healthy installed
# release invisible and turns a missing development Host into a 30-second
# probe on every Bot refresh.
$env:RUIJIE_HARNESS_EXECUTABLE = $null
$env:RUIJIE_HARNESS_ARGUMENTS = $null
$env:RUIJIE_HARNESS_HOME = $null
$env:RUIJIE_HARNESS_USER_DATA_DIR = $null

# Use the same staged native pair as the Windows installer when available.
# Otherwise a source launch silently chooses system Chrome, whose daemon
# startup can time out even though the packaged headless browser works.
$stagedBrowserRoot = Join-Path $repoRoot 'dist-native\browser\win32-x64'
$stagedBrowser = Join-Path $stagedBrowserRoot 'agent-browser.exe'
$stagedChrome = Join-Path $stagedBrowserRoot 'chrome\chrome-headless-shell-win64\chrome-headless-shell.exe'
if (-not $env:OMB_AGENT_BROWSER_PATH -and -not $env:AGENT_BROWSER_EXECUTABLE_PATH -and -not $env:OMB_BROWSER_BUNDLE_DIR -and
    (Test-Path -LiteralPath $stagedBrowser -PathType Leaf) -and
    (Test-Path -LiteralPath $stagedChrome -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $stagedBrowserRoot 'manifest.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $stagedBrowserRoot 'licenses') -PathType Container)) {
  $env:OMB_BROWSER_BUNDLE_DIR = $stagedBrowserRoot
}

function Set-NodeSystemProxy {
  # Node's fetch does not use the Windows proxy unless env-proxy support is
  # enabled explicitly. Mirror the current per-user proxy without hard-coding
  # a local client's port, while keeping Electron's local services direct.
  $settings = Get-ItemProperty `
    -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' `
    -ErrorAction SilentlyContinue
  if (-not $settings -or $settings.ProxyEnable -ne 1) { return }

  $proxy = [string]$settings.ProxyServer
  if ($proxy.Contains('=')) {
    $entries = @{}
    foreach ($item in $proxy.Split(';', [StringSplitOptions]::RemoveEmptyEntries)) {
      $parts = $item.Split('=', 2)
      if ($parts.Count -eq 2) { $entries[$parts[0].Trim().ToLowerInvariant()] = $parts[1].Trim() }
    }
    $proxy = if ($entries.https) { $entries.https } else { $entries.http }
  }
  if (-not $proxy) { return }
  if ($proxy -notmatch '^[a-z][a-z0-9+.-]*://') { $proxy = "http://$proxy" }

  $env:NODE_USE_ENV_PROXY = '1'
  if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $proxy }
  if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $proxy }
  $localBypass = '127.0.0.1,localhost,::1'
  $env:NO_PROXY = if ($env:NO_PROXY) { "$localBypass,$env:NO_PROXY" } else { $localBypass }
}

Set-NodeSystemProxy

function Test-LocalPort([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    return $task.Wait(250) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Start-LocalService([string]$Script, [string]$Name) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw 'Node.js was not found.' }
  $arguments = @((Join-Path $repoRoot 'node_modules\vite\bin\vite.js'))
  Start-Process -FilePath $nodeCommand.Source `
    -ArgumentList $arguments `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "$Name.log") `
    -RedirectStandardError (Join-Path $logRoot "$Name-error.log")
}

function Stop-LocalDevelopmentService([int]$Port) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) { return }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  $commandLine = [string]$owner.CommandLine
  if ($owner.Name -ne 'node.exe' -or $commandLine -notmatch '(OpenMausBot-source|vite[\\/]bin[\\/]vite\.js|server[\\/]index\.ts)') {
    throw "Port $Port is occupied by another application (PID $($listener.OwningProcess))."
  }
  Stop-Process -Id $listener.OwningProcess -Force
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and (Test-LocalPort $Port)) { Start-Sleep -Milliseconds 100 }
  if (Test-LocalPort $Port) { throw "The stale OpenMausBot service on port $Port did not stop." }
}

function Start-DesktopApp {
  if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
    throw "Electron executable is missing: $electron. Run scripts\install-local-windows-shortcut.ps1."
  }

  # Launch the GUI executable itself. Going through `pnpm dev:desktop` adds a
  # detached cmd/node chain which can die silently after this hidden launcher
  # exits. Unique logs also avoid a stale process keeping the next launch from
  # opening the same redirected file.
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  return Start-Process -FilePath $electron `
    -ArgumentList @($repoRoot) `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput (Join-Path $logRoot "desktop-$stamp.log") `
    -RedirectStandardError (Join-Path $logRoot "desktop-$stamp-error.log") `
    -PassThru
}

function Show-LaunchFailure([string]$Message) {
  $appName = ([string][char]0x9510) + ([char]0x6377) + 'Bot'
  $errorLog = Join-Path $logRoot 'launcher-error.log'
  $details = "$(Get-Date -Format o) $Message"
  try {
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Add-Content -LiteralPath $errorLog -Value $details
  } catch {}
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.Popup(
      "$appName could not start.`n`n$Message`n`nDetails: $errorLog",
      0,
      $appName,
      16
    )
  } catch {}
}

function Invoke-Launcher {
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  Set-Location -LiteralPath $repoRoot

  # Electron is also used as a Node runtime for connector/computer proxy
  # scripts. Those helpers share the same executable path and have no
  # `--type=` flag, so executable-only detection mistakes an orphan helper for
  # the desktop app and skips starting Vite. Match the desktop's sole app-path
  # argument instead.
  $quotedDesktopCommandLine = '"' + $electron + '" ' + $repoRoot
  $plainDesktopCommandLine = $electron + ' ' + $repoRoot
  $alreadyRunning = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'electron.exe' -and
    $_.ExecutablePath -eq $electron -and
    ([string]$_.CommandLine).Trim() -in @($quotedDesktopCommandLine, $plainDesktopCommandLine)
  } | Select-Object -First 1
  if ($alreadyRunning) {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $freshness = Start-Process -FilePath $nodeCommand.Source `
      -ArgumentList @((Join-Path $repoRoot 'scripts\desktop-build-receipt.mjs')) `
      -WorkingDirectory $repoRoot -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logRoot 'freshness.log') `
      -RedirectStandardError (Join-Path $logRoot 'freshness-error.log') `
      -Wait -PassThru
    if ($freshness.ExitCode -ne 0) {
      throw 'Source changed. Quit the development app completely, then open this shortcut again to rebuild. Your running tasks were not stopped.'
    }
    # Let Electron's single-instance event restore, maximize and focus the
    # existing window. The short-lived second process exits normally.
    [void](Start-DesktopApp)
    return
  }

  # A closed development window must not reconnect to a server left behind by
  # another checkout or an older source revision. Electron owns the server so
  # it can pass encrypted credentials through its private child-process channel;
  # this wrapper owns only Vite.
  Stop-LocalDevelopmentService $developmentServerPort
  Stop-LocalDevelopmentService 5199
  # Preview the same compiled UI/server and native pins as the installer.
  # The receipt rejects stale source/output; no Vite-only dependency fallback.
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $prepare = Start-Process -FilePath $nodeCommand.Source `
    -ArgumentList @((Join-Path $repoRoot 'scripts\prepare-local-preview.mjs')) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot 'prepare.log') `
    -RedirectStandardError (Join-Path $logRoot 'prepare-error.log') `
    -Wait -PassThru
  if ($prepare.ExitCode -ne 0) { throw "Preview preparation failed. See $logRoot\prepare-error.log" }

  $env:CUA_DRIVER_PATH = Join-Path $repoRoot 'dist-native\cua-win32-x64\cua-driver.exe'
  $desktopProcess = Start-DesktopApp

  # Electron starts the credential-aware source server before creating its
  # window. Keep the launcher around long enough to surface either failure.
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not $desktopProcess.HasExited -and -not (Test-LocalPort $developmentServerPort)) {
    Start-Sleep -Milliseconds 250
  }
  if ($desktopProcess.HasExited) {
    throw "Desktop process exited during startup with code $($desktopProcess.ExitCode)."
  }
  if (-not (Test-LocalPort $developmentServerPort)) {
    throw "The local bot server did not become ready. See $logRoot"
  }
}

$launcherMutex = [Threading.Mutex]::new($false, 'Local\RuijieBotDevLauncher')
$launcherLockTaken = $false
$launcherFailure = $null
try {
  try {
    # A source rebuild can legitimately exceed a minute. The first launcher
    # owns preparation and its error reporting; repeated clicks join that
    # launch instead of timing out and announcing a false startup failure.
    $launcherLockTaken = $launcherMutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $launcherLockTaken = $true
  }
  if ($launcherLockTaken) { Invoke-Launcher }
} catch {
  $launcherFailure = $_.Exception.Message
} finally {
  if ($launcherLockTaken) { $launcherMutex.ReleaseMutex() }
  $launcherMutex.Dispose()
}
# Never retain the startup lock while waiting for a user to dismiss a dialog.
# A new explicit retry must be able to start even while that old dialog exists.
if ($null -ne $launcherFailure) {
  Show-LaunchFailure $launcherFailure
  exit 1
}
