param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot "../release/RuijieBot-$Version-setup.exe"
if ((Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'NotSigned') { throw 'Expected unsigned evaluation installer' }
Write-Output 'Windows Authenticode state is NotSigned as configured.'
