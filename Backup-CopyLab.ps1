[CmdletBinding()]
param(
  [switch]$PassThru,
  [ValidateRange(1, 52)][int]$LocalRetentionCount = 4
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

function New-CopyLabControlLease {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet("maintenance")][string]$RequestType,
    [Parameter(Mandatory = $true)][TimeSpan]$Duration
  )
  $created = [DateTimeOffset]::UtcNow
  $lease = [ordered]@{
    formatVersion = 1
    requestType = $RequestType
    requestId = [guid]::NewGuid().ToString()
    ownerPid = $PID
    createdAt = $created.ToString("o")
    expiresAt = $created.Add($Duration).ToString("o")
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

function Remove-OwnedCopyLabControlLease {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$RequestId,
    [Parameter(Mandatory = $true)][ValidateSet("maintenance")][string]$RequestType
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw
    $lease = $raw | ConvertFrom-Json
    if (
      [string]$lease.requestId -cne $RequestId -or
      [string]$lease.requestType -cne $RequestType -or
      [int]$lease.ownerPid -ne $PID
    ) { return $false }
    if ((Get-Content -LiteralPath $Path -Raw) -cne $raw) { return $false }
    Remove-Item -LiteralPath $Path -Force
    return -not (Test-Path -LiteralPath $Path)
  } catch {
    return $false
  }
}

$dataDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "data"))
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$backupLockPath = Join-Path $dataDirectory "backup.lock"
$backupLockStream = $null
try {
  $backupLockStream = [IO.File]::Open(
    $backupLockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
} catch [IO.IOException] {
  throw "Another CopyLab backup is already running."
}

try {
$source = [IO.Path]::GetFullPath((Join-Path $dataDirectory "copylab.db"))
$learningSource = [IO.Path]::GetFullPath((Join-Path $dataDirectory "learning.db"))
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\backup-cli.js"))
$retentionEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\backup-retention-cli.js"))
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "CopyLab has no database to back up yet."
}
if (-not (Test-Path -LiteralPath $learningSource -PathType Leaf)) {
  throw "CopyLab has no learning database to back up yet. Start the v10 app once, then retry."
}
foreach ($helper in @($entry, $retentionEntry)) {
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "The backup helpers are not built. Run Setup-CopyLab.cmd first."
  }
}

$documents = [IO.Path]::GetFullPath([Environment]::GetFolderPath("MyDocuments"))
$backupDirectory = [IO.Path]::GetFullPath((Join-Path $documents "CopyLab Backups"))
$documentsPrefix = $documents.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $backupDirectory.StartsWith($documentsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The resolved backup directory is outside Documents."
}
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$destination = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-$stamp.db"))
$learningDestination = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-learning-$stamp.db"))
$manifestPath = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-$stamp.pair.json"))
$node = (Get-Command node -ErrorAction Stop).Source
$pidFile = Join-Path $dataDirectory "server.pid"
$supervisorPidFile = Join-Path $dataDirectory "supervisor.pid"
$maintenanceRequest = Join-Path $dataDirectory "supervisor.maintenance.request"
$supervisorStatus = Join-Path $dataDirectory "supervisor.status.json"
$wasRunning = $false
if (Test-Path -LiteralPath $pidFile) {
  $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $serverPid = 0
  if ([int]::TryParse($pidText, [ref]$serverPid)) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
    $commandLine = if ($null -eq $processInfo -or $null -eq $processInfo.CommandLine) { "" } else { [string]$processInfo.CommandLine }
    $wasRunning = $null -ne $processInfo -and
      $processInfo.Name -match "^node(?:\.exe)?$" -and
      $commandLine.Replace("/", "\") -match "apps\\server\\dist\\index\.js"
  }
}

$supervisorRunning = $false
if (Test-Path -LiteralPath $supervisorPidFile -PathType Leaf) {
  $supervisorPidText = (Get-Content -LiteralPath $supervisorPidFile -Raw).Trim()
  $supervisorPid = 0
  if ([int]::TryParse($supervisorPidText, [ref]$supervisorPid)) {
    $supervisorInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $supervisorPid" -ErrorAction SilentlyContinue
    $supervisorCommand = if ($null -eq $supervisorInfo -or $null -eq $supervisorInfo.CommandLine) { "" } else { [string]$supervisorInfo.CommandLine }
    $supervisorRunning = $null -ne $supervisorInfo -and
      $supervisorInfo.Name -match '^(?:powershell|pwsh)(?:\.exe)?$' -and
      $supervisorCommand.Replace("/", "\") -match 'Supervisor-CopyLab\.ps1'
  }
}

$maintenanceOwned = $false
$maintenanceLease = $null
if ($supervisorRunning) {
  try {
  Write-Host "Requesting a planned CopyLab maintenance pause for a consistent backup..." -ForegroundColor Cyan
  for ($attempt = 0; $attempt -lt 20 -and $null -eq $maintenanceLease; $attempt += 1) {
    try {
      $maintenanceLease = New-CopyLabControlLease `
        -Path $maintenanceRequest `
        -RequestType "maintenance" `
        -Duration ([TimeSpan]::FromHours(2))
    } catch [IO.IOException] {
      if ($attempt -eq 19) {
        throw "CopyLab is already in a live or ambiguous maintenance window; this backup did not take ownership of it."
      }
      Start-Sleep -Milliseconds 500
    }
  }
  $maintenanceOwned = $true

  $maintenanceReady = $false
  $maintenanceDeadline = (Get-Date).AddMinutes(15)
  while ((Get-Date) -lt $maintenanceDeadline) {
    if (-not (Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue)) {
      throw "The CopyLab supervisor exited before acknowledging the maintenance pause."
    }
    if (Test-Path -LiteralPath $supervisorStatus -PathType Leaf) {
      try {
        $status = Get-Content -LiteralPath $supervisorStatus -Raw | ConvertFrom-Json
        if (
          $status.state -eq "MAINTENANCE" -and
          $null -eq $status.serverPid -and
          [string]$status.controlRequestId -ceq [string]$maintenanceLease.requestId
        ) {
          $maintenanceReady = $true
          break
        }
      } catch {
        # The supervisor publishes status atomically; retry a transient read race.
      }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $maintenanceReady) {
    throw "The CopyLab supervisor did not enter maintenance inside fifteen minutes; no backup was attempted."
  }
  } catch {
    if ($maintenanceOwned) {
      if (-not (Remove-OwnedCopyLabControlLease `
        -Path $maintenanceRequest `
        -RequestId $maintenanceLease.requestId `
        -RequestType "maintenance")) {
        throw "The backup could not release only its own maintenance lease safely."
      }
      $maintenanceOwned = $false
    }
    throw
  }
} elseif ($wasRunning) {
  Write-Host "Pausing CopyLab briefly for a consistent backup..." -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot "Stop-CopyLab.ps1")
}

$resumeReady = $true
try {
  & $node $entry $source $destination | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "CopyLab database backup failed with exit code $LASTEXITCODE."
  }
  & $node $entry $learningSource $learningDestination | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "CopyLab learning database backup failed with exit code $LASTEXITCODE."
  }

  $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  $learningHash = (Get-FileHash -LiteralPath $learningDestination -Algorithm SHA256).Hash.ToLowerInvariant()
  foreach ($published in @(
    @{ Path = $destination; Hash = $hash },
    @{ Path = $learningDestination; Hash = $learningHash }
  )) {
    $checksum = "$($published.Hash)  $([IO.Path]::GetFileName($published.Path))"
    $checksumPath = "$($published.Path).sha256"
    $temporaryChecksum = "$checksumPath.incomplete-$PID"
    try {
      Set-Content -LiteralPath $temporaryChecksum -Value $checksum -Encoding ascii
      Move-Item -LiteralPath $temporaryChecksum -Destination $checksumPath
    } finally {
      Remove-Item -LiteralPath $temporaryChecksum -Force -ErrorAction SilentlyContinue
    }
  }

  $manifest = [ordered]@{
    formatVersion = 1
    stamp = $stamp
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    mainDatabase = [ordered]@{
      file = [IO.Path]::GetFileName($destination)
      sha256 = $hash
    }
    learningDatabase = [ordered]@{
      file = [IO.Path]::GetFileName($learningDestination)
      sha256 = $learningHash
    }
  }
  $temporaryManifest = "$manifestPath.incomplete-$PID"
  try {
    $manifestJson = $manifest | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText(
      $temporaryManifest,
      $manifestJson,
      [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryManifest -Destination $manifestPath
  } finally {
    Remove-Item -LiteralPath $temporaryManifest -Force -ErrorAction SilentlyContinue
  }

  & $node $retentionEntry $backupDirectory $destination $hash $learningDestination $learningHash $manifestPath $LocalRetentionCount | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "CopyLab backup retention failed with exit code $LASTEXITCODE. The new verified backup was preserved."
  }
} finally {
  if ($maintenanceOwned) {
    if (-not (Remove-OwnedCopyLabControlLease `
      -Path $maintenanceRequest `
      -RequestId $maintenanceLease.requestId `
      -RequestType "maintenance")) {
      throw "The backup could not release only its own maintenance lease safely."
    }
    $maintenanceOwned = $false
    $restartDeadline = (Get-Date).AddMinutes(10)
    $resumeReady = $false
    while ((Get-Date) -lt $restartDeadline) {
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4310/api/setup/status" -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
          $resumeReady = $true
          break
        }
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }
  } elseif ($wasRunning) {
    & (Join-Path $PSScriptRoot "Start-CopyLab.ps1") -NoBrowser
  }
}
if (-not $resumeReady) {
  throw "The verified backup was created, but CopyLab did not return to healthy monitoring inside ten minutes. Check data\supervisor.status.json."
}
Write-Host "Verified CopyLab database pair created:" -ForegroundColor Green
Write-Host $destination
Write-Host $learningDestination
Write-Host $manifestPath
Write-Host "The provider secrets in this backup remain DPAPI-bound to this Windows account." -ForegroundColor Yellow
if ($PassThru) {
  [pscustomobject]@{
    stamp = $stamp
    backupDirectory = $backupDirectory
    mainDatabase = $destination
    learningDatabase = $learningDestination
    manifest = $manifestPath
    mainSha256 = $hash
    learningSha256 = $learningHash
    localRetentionCount = $LocalRetentionCount
  }
}
} finally {
  if ($null -ne $backupLockStream) { $backupLockStream.Dispose() }
}
