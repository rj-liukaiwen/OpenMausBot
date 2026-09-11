#requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$Resources,
  [string]$EngineCandidate,
  [int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This verifier needs an interactive Windows desktop.' }
if (-not [Environment]::UserInteractive) { throw 'No interactive desktop: no-console verification is NOT executed.' }
$repo = Split-Path -Parent $PSScriptRoot
$resolvedResources = (Resolve-Path -LiteralPath $Resources).Path
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class RuijieConsoleProbe {
  public delegate bool Callback(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] Visible() {
    var result = new List<string>();
    EnumWindows((h,p)=> { var name=new StringBuilder(256); GetClassName(h,name,256);
      if(IsWindowVisible(h) && (name.ToString()=="ConsoleWindowClass" || name.ToString()=="CASCADIA_HOSTING_WINDOW_CLASS")) {
        uint id; GetWindowThreadProcessId(h,out id); result.Add(h+":"+id+":"+name);
      } return true; },IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$baseline = @([RuijieConsoleProbe]::Visible())
$observed = [Collections.Generic.HashSet[string]]::new()
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Get-Command node.exe).Source
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.WorkingDirectory = $repo
$info.ArgumentList.Add((Join-Path $PSScriptRoot 'smoke-browser-bundle.mjs'))
$info.ArgumentList.Add('--resources')
$info.ArgumentList.Add($resolvedResources)
if ($EngineCandidate) {
  $info.ArgumentList.Add('--engine-candidate')
  $info.ArgumentList.Add((Resolve-Path -LiteralPath $EngineCandidate).Path)
}
$child = [Diagnostics.Process]::Start($info)
$output = $child.StandardOutput.ReadToEndAsync()
$errors = $child.StandardError.ReadToEndAsync()
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
try {
  while (-not $child.HasExited) {
    foreach ($window in [RuijieConsoleProbe]::Visible()) {
      if ($window -notin $baseline) { [void]$observed.Add($window) }
    }
    if ([DateTime]::UtcNow -gt $deadline) {
      $child.Kill($true) # Only this verifier's own fixture tree.
      throw 'Browser fixture timed out; no release approval.'
    }
    Start-Sleep -Milliseconds 10
  }
  $output.GetAwaiter().GetResult()
  $errors.GetAwaiter().GetResult()
  [pscustomobject]@{
    ok = ($child.ExitCode -eq 0 -and $observed.Count -eq 0)
    fixtureExitCode = $child.ExitCode
    newVisibleConsoleWindows = @($observed)
    caveat = 'Run on an idle interactive desktop; unrelated new terminals fail conservatively. Also inspect full installed-app workflow.'
  } | ConvertTo-Json -Depth 3
  if ($child.ExitCode -ne 0 -or $observed.Count -ne 0) { exit 1 }
} finally { $child.Dispose() }
