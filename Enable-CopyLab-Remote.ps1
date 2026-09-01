param(
  [int]$ServePort = 4311
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

if ($ServePort -lt 1024 -or $ServePort -gt 65535 -or $ServePort -eq 4310) {
  throw "ServePort must be between 1024 and 65535 and cannot be CopyLab's local port 4310."
}

$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
  $installed = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
  if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) {
    throw "Tailscale is not installed. Install it from https://tailscale.com/download/windows and sign in first."
  }
  $tailscalePath = $installed
} else {
  $tailscalePath = $tailscale.Source
}

$statusText = (& $tailscalePath status --json) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0) { throw "Tailscale status could not be read." }
$status = $statusText | ConvertFrom-Json
if ($status.BackendState -ne "Running" -or -not $status.Self.Online) {
  throw "Tailscale must be signed in and online before remote viewing can be enabled."
}
$dnsName = ([string]$status.Self.DNSName).Trim().TrimEnd(".").ToLowerInvariant()
if ($dnsName -notmatch "^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$") {
  throw "Tailscale did not return a valid private DNS name."
}

$origin = "http://${dnsName}:$ServePort"
& $tailscalePath serve --yes --bg "--http=$ServePort" "http://127.0.0.1:4310"
if ($LASTEXITCODE -ne 0) { throw "Tailscale Serve could not be configured." }

$dataDirectory = Join-Path $PSScriptRoot "data"
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$originFile = Join-Path $dataDirectory "remote-readonly-origin.txt"
$temporaryOriginFile = "$originFile.incomplete-$PID"
[System.IO.File]::WriteAllText(
  $temporaryOriginFile,
  $origin,
  [System.Text.UTF8Encoding]::new($false)
)
Move-Item -LiteralPath $temporaryOriginFile -Destination $originFile -Force

$stopScript = Join-Path $PSScriptRoot "Stop-CopyLab.ps1"
$startScript = Join-Path $PSScriptRoot "Start-CopyLab.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
if ($LASTEXITCODE -ne 0) { throw "CopyLab could not be stopped safely." }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -NoBrowser
if ($LASTEXITCODE -ne 0) { throw "CopyLab could not be restarted with private viewing enabled." }

$response = Invoke-WebRequest -UseBasicParsing -Uri "$origin/api/setup/status" -TimeoutSec 20
if ($response.StatusCode -ne 200) {
  throw "The private remote endpoint did not pass its health check."
}

Write-Host "CopyLab remote viewing is ready at $origin" -ForegroundColor Green
Write-Host "Access is private to this Tailscale network. Remote mutations are blocked except the isolated Alpaca PAPER credential form."
Write-Host "On your phone or work device, turn on Tailscale with the same account, then open the URL above."
