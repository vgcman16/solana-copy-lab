[CmdletBinding()]
param(
  [string]$BackupPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

function Test-VerifiedChecksum {
  param(
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $checksumPath = "$DatabasePath.sha256"
  if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw "$Label checksum sidecar is missing."
  }
  $checksumLine = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
  if ($checksumLine -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
    throw "$Label checksum sidecar is malformed."
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $expectedName = $Matches[2].Trim()
  if ($expectedName -cne [IO.Path]::GetFileName($DatabasePath)) {
    throw "$Label checksum sidecar names a different backup file."
  }
  $actualHash = (Get-FileHash -LiteralPath $DatabasePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne $expectedHash) {
    throw "$Label SHA-256 checksum does not match; restore was refused."
  }
  return $actualHash
}

function Publish-Checksum {
  param([Parameter(Mandatory = $true)][string]$DatabasePath)
  $hash = (Get-FileHash -LiteralPath $DatabasePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumPath = "$DatabasePath.sha256"
  $temporary = "$checksumPath.incomplete-$PID"
  try {
    Set-Content -LiteralPath $temporary -Value "$hash  $([IO.Path]::GetFileName($DatabasePath))" -Encoding ascii
    Move-Item -LiteralPath $temporary -Destination $checksumPath
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
  return $hash
}

if ([string]::IsNullOrWhiteSpace($BackupPath)) {
  $BackupPath = Read-Host "Paste the full path to the verified CopyLab main .db backup"
}
$confirmation = Read-Host "Type RESTORE COPYLAB DATABASES to continue"
if ($confirmation -cne "RESTORE COPYLAB DATABASES") {
  throw "Restore confirmation did not match; nothing was changed."
}

$backup = [IO.Path]::GetFullPath($BackupPath)
$documents = [IO.Path]::GetFullPath([Environment]::GetFolderPath("MyDocuments"))
$backupDirectory = [IO.Path]::GetFullPath((Join-Path $documents "CopyLab Backups"))
$backupPrefix = $backupDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $backup.StartsWith($backupPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Restore accepts backups only from Documents\CopyLab Backups."
}
$backupName = [IO.Path]::GetFileName($backup)
if ($backupName -notmatch '^copylab-(\d{8}-\d{6})\.db$' -or -not (Test-Path -LiteralPath $backup -PathType Leaf)) {
  throw "Select the main copylab-YYYYMMDD-HHMMSS.db file from a verified database pair."
}
$stamp = $Matches[1]
$learningBackup = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-learning-$stamp.db"))
$manifestPath = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-$stamp.pair.json"))
if (-not (Test-Path -LiteralPath $learningBackup -PathType Leaf)) {
  throw "The matching learning database backup is missing."
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "The matching backup-pair manifest is missing."
}

$mainHash = Test-VerifiedChecksum -DatabasePath $backup -Label "Main backup"
$learningHash = Test-VerifiedChecksum -DatabasePath $learningBackup -Label "Learning backup"
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} catch {
  throw "The backup-pair manifest is malformed JSON."
}
if (
  $manifest.formatVersion -ne 1 -or
  $manifest.stamp -cne $stamp -or
  $manifest.mainDatabase.file -cne $backupName -or
  $manifest.mainDatabase.sha256 -cne $mainHash -or
  $manifest.learningDatabase.file -cne [IO.Path]::GetFileName($learningBackup) -or
  $manifest.learningDatabase.sha256 -cne $learningHash
) {
  throw "The backup-pair manifest does not match both verified databases."
}

$dataDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "data"))
$target = [IO.Path]::GetFullPath((Join-Path $dataDirectory "copylab.db"))
$learningTarget = [IO.Path]::GetFullPath((Join-Path $dataDirectory "learning.db"))
if (
  [IO.Path]::GetDirectoryName($target) -ine $dataDirectory -or
  [IO.Path]::GetDirectoryName($learningTarget) -ine $dataDirectory
) {
  throw "Resolved restore targets are outside the CopyLab data directory."
}
$backupEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\backup-cli.js"))
$restoreEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\restore-cli.js"))
foreach ($entry in @($backupEntry, $restoreEntry)) {
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "The restore helpers are not built. Run Setup-CopyLab.cmd first."
  }
}

$pidFile = Join-Path $PSScriptRoot "data\server.pid"
$supervisorPidFile = Join-Path $PSScriptRoot "data\supervisor.pid"
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
$supervisorWasRunning = $false
if (Test-Path -LiteralPath $supervisorPidFile -PathType Leaf) {
  $supervisorPidText = (Get-Content -LiteralPath $supervisorPidFile -Raw).Trim()
  $supervisorPid = 0
  if ([int]::TryParse($supervisorPidText, [ref]$supervisorPid)) {
    $supervisorInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $supervisorPid" -ErrorAction SilentlyContinue
    $supervisorCommand = if ($null -eq $supervisorInfo -or $null -eq $supervisorInfo.CommandLine) { "" } else { [string]$supervisorInfo.CommandLine }
    $supervisorWasRunning = $null -ne $supervisorInfo -and
      $supervisorInfo.Name -match '^(?:powershell|pwsh)(?:\.exe)?$' -and
      $supervisorCommand.Replace("/", "\") -match 'Supervisor-CopyLab\.ps1'
  }
}
$wasRunning = $wasRunning -or $supervisorWasRunning

$node = (Get-Command node -ErrorAction Stop).Source
if ($wasRunning) {
  Write-Host "Stopping CopyLab for a verified paired restore..." -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot "Stop-CopyLab.ps1")
}

$hadMainTarget = Test-Path -LiteralPath $target -PathType Leaf
$hadLearningTarget = Test-Path -LiteralPath $learningTarget -PathType Leaf
$preRestoreStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss-fff")
$preRestore = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-pre-restore-$preRestoreStamp.db"))
$preRestoreLearning = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-learning-pre-restore-$preRestoreStamp.db"))
$preRestoreManifest = [IO.Path]::GetFullPath((Join-Path $backupDirectory "copylab-pre-restore-$preRestoreStamp.pair.json"))
$mainRestored = $false

try {
  $preMainHash = $null
  $preLearningHash = $null
  if ($hadMainTarget) {
    & $node $backupEntry $target $preRestore
    if ($LASTEXITCODE -ne 0) { throw "The pre-restore main safety backup failed." }
    $preMainHash = Publish-Checksum -DatabasePath $preRestore
  }
  if ($hadLearningTarget) {
    & $node $backupEntry $learningTarget $preRestoreLearning
    if ($LASTEXITCODE -ne 0) { throw "The pre-restore learning safety backup failed." }
    $preLearningHash = Publish-Checksum -DatabasePath $preRestoreLearning
  }
  if ($hadMainTarget -and $hadLearningTarget) {
    $preManifest = [ordered]@{
      formatVersion = 1
      stamp = "pre-restore-$preRestoreStamp"
      createdAt = (Get-Date).ToUniversalTime().ToString("o")
      mainDatabase = [ordered]@{ file = [IO.Path]::GetFileName($preRestore); sha256 = $preMainHash }
      learningDatabase = [ordered]@{ file = [IO.Path]::GetFileName($preRestoreLearning); sha256 = $preLearningHash }
    }
    [IO.File]::WriteAllText(
      $preRestoreManifest,
      ($preManifest | ConvertTo-Json -Depth 4),
      [Text.UTF8Encoding]::new($false)
    )
  }

  try {
    & $node $restoreEntry $backup $target
    if ($LASTEXITCODE -ne 0) { throw "Main database restore failed with exit code $LASTEXITCODE." }
    $mainRestored = $true
    & $node $restoreEntry $learningBackup $learningTarget
    if ($LASTEXITCODE -ne 0) { throw "Learning database restore failed with exit code $LASTEXITCODE." }
  } catch {
    $originalFailure = $_.Exception.Message
    if ($mainRestored) {
      try {
        if ($hadMainTarget) {
          & $node $restoreEntry $preRestore $target
          if ($LASTEXITCODE -ne 0) { throw "main rollback exited with $LASTEXITCODE" }
        } else {
          Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        }
      } catch {
        throw "Paired restore failed: $originalFailure Main-ledger rollback also failed: $($_.Exception.Message)"
      }
    }
    throw "Paired restore failed and the prior main ledger was preserved: $originalFailure"
  }
} finally {
  if ($wasRunning) {
    & (Join-Path $PSScriptRoot "Start-CopyLab.ps1") -NoBrowser
  }
}

Write-Host "CopyLab main and learning databases restored and integrity checked." -ForegroundColor Green
Write-Host "The previous ledgers were backed up first. Review PAPER state and balances before any live resume." -ForegroundColor Yellow
