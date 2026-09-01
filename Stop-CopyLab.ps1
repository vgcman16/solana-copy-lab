$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$dataDirectory = Join-Path $PSScriptRoot "data"
$serverPidFile = Join-Path $dataDirectory "server.pid"
$supervisorPidFile = Join-Path $dataDirectory "supervisor.pid"
$serverStopRequest = Join-Path $dataDirectory "stop.request"
$supervisorStopRequest = Join-Path $dataDirectory "supervisor.stop.request"
$maintenanceRequest = Join-Path $dataDirectory "supervisor.maintenance.request"
$expectedServerEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\index.js")).Replace("/", "\")
$expectedSupervisorEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Supervisor-CopyLab.ps1")).Replace("/", "\")

function New-SupervisorStopLease {
  param([Parameter(Mandatory = $true)][string]$Path)
  $created = [DateTimeOffset]::UtcNow
  $lease = [ordered]@{
    formatVersion = 1
    requestType = "supervisor-stop"
    requestId = [guid]::NewGuid().ToString()
    ownerPid = $PID
    createdAt = $created.ToString("o")
    expiresAt = $created.AddMinutes(10).ToString("o")
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($lease | ConvertTo-Json -Compress))
  $stream = $null
  try {
    $stream = [IO.File]::Open(
      $Path,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::Read
    )
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  return [pscustomobject]$lease
}

function Remove-OwnedSupervisorStopLease {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$RequestId
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw
    $lease = $raw | ConvertFrom-Json
    if (
      [string]$lease.requestId -cne $RequestId -or
      [string]$lease.requestType -cne "supervisor-stop" -or
      [int]$lease.ownerPid -ne $PID
    ) { return $false }
    if ((Get-Content -LiteralPath $Path -Raw) -cne $raw) { return $false }
    Remove-Item -LiteralPath $Path -Force
    return -not (Test-Path -LiteralPath $Path)
  } catch {
    return $false
  }
}

function Get-VerifiedProcessFromPidFile {
  param(
    [Parameter(Mandatory = $true)][string]$PidFile,
    [Parameter(Mandatory = $true)][ValidateSet("Server", "Supervisor")][string]$Kind
  )
  if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $null }
  $pidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  $processId = 0
  if (-not [int]::TryParse($pidText, [ref]$processId)) {
    throw "The CopyLab $Kind PID file is invalid; no process was stopped."
  }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $processInfo) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  $commandLine = if ($null -eq $processInfo.CommandLine) { "" } else { [string]$processInfo.CommandLine }
  $normalizedCommand = $commandLine.Replace("/", "\")
  $valid = if ($Kind -eq "Server") {
    $processInfo.Name -match '^node(?:\.exe)?$' -and
      $normalizedCommand.IndexOf($expectedServerEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } else {
    $processInfo.Name -match '^(?:powershell|pwsh)(?:\.exe)?$' -and
      $normalizedCommand.IndexOf($expectedSupervisorEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  if (-not $valid) {
    throw "PID $processId does not belong to the CopyLab $Kind process; nothing was stopped."
  }
  return [pscustomobject]@{ Id = $processId; Info = $processInfo }
}

$supervisor = Get-VerifiedProcessFromPidFile -PidFile $supervisorPidFile -Kind "Supervisor"
$server = Get-VerifiedProcessFromPidFile -PidFile $serverPidFile -Kind "Server"
if ($null -eq $supervisor -and $null -eq $server) {
  Write-Host "CopyLab is not running."
  exit 0
}

$stopLease = $null
if ($null -ne $supervisor) {
  try {
    $stopLease = New-SupervisorStopLease -Path $supervisorStopRequest
  } catch [IO.IOException] {
    # An existing request may belong to another still-running Stop command.
    # Never overwrite or clear a request that this process does not own.
    Write-Host "A supervisor stop request is already pending; it remains authoritative."
  }
}
# The supervisor prioritizes a live stop lease ahead of maintenance. Do not
# clear a maintenance lease owned by a concurrent backup process.
if ($null -ne $server) {
  Set-Content -LiteralPath $serverStopRequest -Value "stop" -NoNewline
}

# Allow in-flight provider requests, large SQLite checkpoints, and the optional
# Pyth worker enough time to finish their current atomic operation before the
# bounded force-stop fallback.
for ($attempt = 0; $attempt -lt 600; $attempt += 1) {
  $supervisorAlive = $null -ne $supervisor -and $null -ne (Get-Process -Id $supervisor.Id -ErrorAction SilentlyContinue)
  $serverAlive = $null -ne $server -and $null -ne (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)
  if (-not $supervisorAlive -and -not $serverAlive) { break }
  Start-Sleep -Milliseconds 250
}

if ($null -ne $server -and (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) {
  $server = Get-VerifiedProcessFromPidFile -PidFile $serverPidFile -Kind "Server"
  if ($null -ne $server) { Stop-Process -Id $server.Id -Force }
}
if ($null -ne $supervisor -and (Get-Process -Id $supervisor.Id -ErrorAction SilentlyContinue)) {
  $supervisor = Get-VerifiedProcessFromPidFile -PidFile $supervisorPidFile -Kind "Supervisor"
  if ($null -ne $supervisor) { Stop-Process -Id $supervisor.Id -Force }
}
Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $serverStopRequest -Force -ErrorAction SilentlyContinue
if ($null -ne $stopLease) {
  if (-not (Remove-OwnedSupervisorStopLease -Path $supervisorStopRequest -RequestId $stopLease.requestId)) {
    throw "The stop command refused to clear a supervisor stop lease it no longer owns."
  }
}
Write-Host "CopyLab monitoring and its supervisor stopped." -ForegroundColor Green
