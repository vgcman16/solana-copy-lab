param(
  [int]$ServePort = 4311
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
  $installed = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
  if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) {
    throw "Tailscale is not installed, so its private route could not be disabled safely."
  }
  $tailscalePath = $installed
} else {
  $tailscalePath = $tailscale.Source
}

& $tailscalePath serve "--http=$ServePort" off
if ($LASTEXITCODE -ne 0) { throw "Tailscale Serve could not be disabled." }

$originFile = Join-Path $PSScriptRoot "data\remote-readonly-origin.txt"
Remove-Item -LiteralPath $originFile -Force -ErrorAction SilentlyContinue
$stopScript = Join-Path $PSScriptRoot "Stop-CopyLab.ps1"
$startScript = Join-Path $PSScriptRoot "Start-CopyLab.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
if ($LASTEXITCODE -ne 0) { throw "CopyLab could not be stopped safely." }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -NoBrowser
if ($LASTEXITCODE -ne 0) { throw "CopyLab could not be restarted after private viewing was disabled." }

Write-Host "CopyLab remote viewing is disabled; the dashboard is loopback-only again." -ForegroundColor Green
