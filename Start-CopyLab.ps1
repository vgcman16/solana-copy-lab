param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$url = "http://127.0.0.1:4310"
$dataDirectory = Join-Path $PSScriptRoot "data"
$supervisorPidFile = Join-Path $dataDirectory "supervisor.pid"
$statusFile = Join-Path $dataDirectory "supervisor.status.json"
$supervisorEntry = Join-Path $PSScriptRoot "Supervisor-CopyLab.ps1"
$serverEntry = Join-Path $PSScriptRoot "apps\server\dist\index.js"
$webEntry = Join-Path $PSScriptRoot "apps\web\dist\index.html"

if (
  -not (Test-Path -LiteralPath $serverEntry -PathType Leaf) -or
  -not (Test-Path -LiteralPath $webEntry -PathType Leaf)
) {
  & (Join-Path $PSScriptRoot "Setup-CopyLab.ps1")
}
if (-not (Test-Path -LiteralPath $supervisorEntry -PathType Leaf)) {
  throw "The CopyLab supervisor was not found."
}
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null

function Get-VerifiedSupervisorProcess {
  if (-not (Test-Path -LiteralPath $supervisorPidFile -PathType Leaf)) { return $null }
  $existingText = (Get-Content -LiteralPath $supervisorPidFile -Raw).Trim()
  $existingPid = 0
  if (-not [int]::TryParse($existingText, [ref]$existingPid)) {
    Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  $existingInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid" -ErrorAction SilentlyContinue
  $existingCommand = if ($null -eq $existingInfo -or $null -eq $existingInfo.CommandLine) { "" } else { [string]$existingInfo.CommandLine }
  $expectedSupervisor = [IO.Path]::GetFullPath($supervisorEntry).Replace("/", "\")
  if (
    $null -ne $existingInfo -and
    $existingInfo.Name -match "^(?:powershell|pwsh)(?:\.exe)?$" -and
    $existingCommand.Replace("/", "\").IndexOf($expectedSupervisor, [StringComparison]::OrdinalIgnoreCase) -ge 0
  ) {
    return Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
  return $null
}

$supervisorProcess = Get-VerifiedSupervisorProcess
if ($null -eq $supervisorProcess) {
  $powerShellHost = (Get-Process -Id $PID -ErrorAction Stop).Path
  $supervisorProcess = Start-Process `
    -FilePath $powerShellHost `
    -ArgumentList "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisorEntry`" -LaunchMode Manual" `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -PassThru
}

$ready = $false
# A production ledger can be several gigabytes. A versioned SQLite migration
# or index build may legitimately take minutes on the first launch after an
# upgrade, so keep a bounded ten-minute window instead of killing the server
# halfway through an atomic migration after only thirty seconds.
for ($attempt = 0; $attempt -lt 1200; $attempt += 1) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/setup/status" -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 500
  }
  $currentSupervisor = Get-VerifiedSupervisorProcess
  if ($null -eq $currentSupervisor -and $supervisorProcess.HasExited) { break }
  if (Test-Path -LiteralPath $statusFile -PathType Leaf) {
    try {
      $status = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
      if ($status.state -eq "FAILED") { break }
    } catch {
      # An atomic status replacement may briefly race this optional diagnostic read.
    }
  }
}

if (-not $ready) {
  throw "CopyLab did not become ready. Check data\supervisor.status.json, data\supervisor.log, and data\server-error.log."
}

if (-not $NoBrowser) { Start-Process $url }
Write-Host "CopyLab is running locally at $url" -ForegroundColor Green
Write-Host "The hidden supervisor will recover bounded child-process failures."
Write-Host "Use Stop-CopyLab.cmd when you want to stop monitoring and the supervisor."
