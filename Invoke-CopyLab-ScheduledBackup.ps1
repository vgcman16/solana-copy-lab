[CmdletBinding()]
param(
  [DayOfWeek]$QuietDay = [DayOfWeek]::Saturday,
  [TimeSpan]$QuietStart = ([TimeSpan]::FromHours(0)),
  [TimeSpan]$QuietEnd = ([TimeSpan]::FromHours(6)),
  [ValidateRange(1, 52)][int]$LocalRetentionCount = 4,
  [string]$OffDeviceDestination,
  [ValidateRange(1, 52)][int]$OffDeviceRetentionCount = 8,
  [switch]$RunRestoreDrill,
  [switch]$IgnoreQuietWindow
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$dataDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "data"))
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$logPath = Join-Path $dataDirectory "scheduled-backup.log"
$lockPath = Join-Path $dataDirectory "scheduled-backup.lock"

function Write-ScheduledBackupEvent {
  param(
    [Parameter(Mandatory = $true)][string]$Event,
    [Parameter(Mandatory = $true)][string]$Message
  )
  $safeMessage = $Message -replace '(?i)\b(api[-_ ]?key|authorization|password|passphrase|secret|token)\b\s*[:=]\s*[^\s,;]+', '$1=[REDACTED]'
  if ($safeMessage.Length -gt 500) { $safeMessage = $safeMessage.Substring(0, 500) + "..." }
  $record = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    event = $Event
    message = $safeMessage
  }
  [IO.File]::AppendAllText(
    $logPath,
    (($record | ConvertTo-Json -Compress) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
}

function Test-ChecksumSidecar {
  param(
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$ExpectedHash,
    [switch]$Rehash
  )
  $sidecar = "$DatabasePath.sha256"
  foreach ($path in @($DatabasePath, $sidecar)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  }
  $line = (Get-Content -LiteralPath $sidecar -Raw).Trim()
  if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') { return $false }
  if ($Matches[1].ToLowerInvariant() -cne $ExpectedHash.ToLowerInvariant()) { return $false }
  if ($Matches[2].Trim() -cne [IO.Path]::GetFileName($DatabasePath)) { return $false }
  if ($Rehash) {
    $actual = (Get-FileHash -LiteralPath $DatabasePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $ExpectedHash.ToLowerInvariant()) { return $false }
  }
  return $true
}

function Copy-VerifiedBackupPair {
  param(
    [Parameter(Mandatory = $true)][psobject]$Backup,
    [Parameter(Mandatory = $true)][string]$DestinationDirectory
  )
  $destination = [IO.Path]::GetFullPath($DestinationDirectory)
  $projectData = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "data"))
  $localBackups = [IO.Path]::GetFullPath([string]$Backup.backupDirectory)
  if (
    $destination -ieq [IO.Path]::GetPathRoot($destination) -or
    $destination -ieq $projectData -or
    $destination -ieq $localBackups
  ) {
    throw "The explicit off-device destination must be a dedicated directory distinct from production data and local backups."
  }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  $destinationItem = Get-Item -LiteralPath $destination -Force
  if (($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The explicit off-device destination cannot itself be a link or junction."
  }

  if (-not (Test-ChecksumSidecar -DatabasePath $Backup.mainDatabase -ExpectedHash $Backup.mainSha256 -Rehash)) {
    throw "The newly created main backup failed source verification before off-device copy."
  }
  if (-not (Test-ChecksumSidecar -DatabasePath $Backup.learningDatabase -ExpectedHash $Backup.learningSha256 -Rehash)) {
    throw "The newly created learning backup failed source verification before off-device copy."
  }

  $sourceFiles = @(
    [string]$Backup.mainDatabase,
    "$($Backup.mainDatabase).sha256",
    [string]$Backup.learningDatabase,
    "$($Backup.learningDatabase).sha256"
  )
  $published = @()
  foreach ($source in $sourceFiles) {
    $target = [IO.Path]::GetFullPath((Join-Path $destination ([IO.Path]::GetFileName($source))))
    if ([IO.Path]::GetDirectoryName($target) -ine $destination) {
      throw "An off-device target resolved outside the explicit destination."
    }
    if (Test-Path -LiteralPath $target) {
      throw "The off-device destination already contains the new backup stamp; nothing was overwritten."
    }
    $temporary = "$target.incomplete-$PID"
    try {
      Copy-Item -LiteralPath $source -Destination $temporary
      Move-Item -LiteralPath $temporary -Destination $target
      $published += $target
    } finally {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }

  $offMain = [IO.Path]::GetFullPath((Join-Path $destination ([IO.Path]::GetFileName($Backup.mainDatabase))))
  $offLearning = [IO.Path]::GetFullPath((Join-Path $destination ([IO.Path]::GetFileName($Backup.learningDatabase))))
  if (-not (Test-ChecksumSidecar -DatabasePath $offMain -ExpectedHash $Backup.mainSha256 -Rehash)) {
    throw "The off-device main backup failed post-copy SHA-256 verification."
  }
  if (-not (Test-ChecksumSidecar -DatabasePath $offLearning -ExpectedHash $Backup.learningSha256 -Rehash)) {
    throw "The off-device learning backup failed post-copy SHA-256 verification."
  }

  # Publish the manifest last. A visible manifest therefore means both database
  # files and checksum sidecars were already copied and rehashed successfully.
  $manifestTarget = [IO.Path]::GetFullPath((Join-Path $destination ([IO.Path]::GetFileName($Backup.manifest))))
  if (Test-Path -LiteralPath $manifestTarget) {
    throw "The off-device destination already contains the new pair manifest."
  }
  $temporaryManifest = "$manifestTarget.incomplete-$PID"
  try {
    Copy-Item -LiteralPath $Backup.manifest -Destination $temporaryManifest
    Move-Item -LiteralPath $temporaryManifest -Destination $manifestTarget
  } finally {
    Remove-Item -LiteralPath $temporaryManifest -Force -ErrorAction SilentlyContinue
  }

  return [pscustomobject]@{
    directory = $destination
    mainDatabase = $offMain
    learningDatabase = $offLearning
    manifest = $manifestTarget
  }
}

function Remove-ExpiredVerifiedPairs {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][int]$Keep
  )
  $root = [IO.Path]::GetFullPath($Directory)
  $verifiedPairs = @()
  foreach ($manifestFile in (Get-ChildItem -LiteralPath $root -File -Filter "copylab-*.pair.json")) {
    if ($manifestFile.Name -notmatch '^copylab-(\d{8}-\d{6})\.pair\.json$') { continue }
    if (($manifestFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $stamp = $Matches[1]
    try {
      $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
      $mainName = "copylab-$stamp.db"
      $learningName = "copylab-learning-$stamp.db"
      $main = [IO.Path]::GetFullPath((Join-Path $root $mainName))
      $learning = [IO.Path]::GetFullPath((Join-Path $root $learningName))
      if (
        $manifest.formatVersion -ne 1 -or
        $manifest.stamp -cne $stamp -or
        $manifest.mainDatabase.file -cne $mainName -or
        $manifest.learningDatabase.file -cne $learningName -or
        -not (Test-ChecksumSidecar -DatabasePath $main -ExpectedHash $manifest.mainDatabase.sha256 -Rehash) -or
        -not (Test-ChecksumSidecar -DatabasePath $learning -ExpectedHash $manifest.learningDatabase.sha256 -Rehash)
      ) { continue }
      $verifiedPairs += [pscustomobject]@{
        Stamp = $stamp
        Files = @($main, "$main.sha256", $learning, "$learning.sha256", $manifestFile.FullName)
      }
    } catch {
      # Malformed, incomplete, unknown, and unverifiable sets are retained for
      # manual inspection. Retention only deletes complete recognized pairs.
    }
  }

  $expired = @($verifiedPairs | Sort-Object Stamp -Descending | Select-Object -Skip $Keep)
  foreach ($pair in $expired) {
    foreach ($path in $pair.Files) {
      $resolved = [IO.Path]::GetFullPath($path)
      if ([IO.Path]::GetDirectoryName($resolved) -ine $root) {
        throw "Retention resolved a path outside the explicit off-device directory."
      }
      $item = Get-Item -LiteralPath $resolved -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Retention refused to remove a linked backup artifact."
      }
      Remove-Item -LiteralPath $resolved -Force
    }
  }
  return $expired.Count
}

$now = Get-Date
if (-not $IgnoreQuietWindow) {
  if ($QuietEnd -le $QuietStart) {
    throw "QuietEnd must be later than QuietStart within the same local day."
  }
  if (
    $now.DayOfWeek -ne $QuietDay -or
    $now.TimeOfDay -lt $QuietStart -or
    $now.TimeOfDay -ge $QuietEnd
  ) {
    Write-ScheduledBackupEvent -Event "backup_skipped_outside_quiet_window" -Message "A delayed task start occurred outside the configured local market-quiet window."
    Write-Host "CopyLab scheduled backup skipped: this start is outside the configured market-quiet window."
    exit 0
  }
}

$scheduledLock = $null
try {
  try {
    $scheduledLock = [IO.File]::Open(
      $lockPath,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch [IO.IOException] {
    Write-ScheduledBackupEvent -Event "backup_skipped_already_running" -Message "Another scheduled backup instance owns the exclusive lock."
    exit 0
  }

  Write-ScheduledBackupEvent -Event "backup_started" -Message "The market-quiet verified paired backup started."
  $backup = & (Join-Path $PSScriptRoot "Backup-CopyLab.ps1") -PassThru -LocalRetentionCount $LocalRetentionCount
  if ($null -eq $backup -or $backup.stamp -notmatch '^\d{8}-\d{6}$') {
    throw "The verified backup helper did not return a valid pair descriptor."
  }

  if ($RunRestoreDrill) {
    & (Join-Path $PSScriptRoot "Test-CopyLab-RestoreDrill.ps1") `
      -BackupPath $backup.mainDatabase `
      -BackupDirectory $backup.backupDirectory | Out-Null
  }

  if (-not [string]::IsNullOrWhiteSpace($OffDeviceDestination)) {
    $offDevice = Copy-VerifiedBackupPair -Backup $backup -DestinationDirectory $OffDeviceDestination
    if ($RunRestoreDrill) {
      & (Join-Path $PSScriptRoot "Test-CopyLab-RestoreDrill.ps1") `
        -BackupPath $offDevice.mainDatabase `
        -BackupDirectory $offDevice.directory | Out-Null
    }
    $deleted = Remove-ExpiredVerifiedPairs -Directory $offDevice.directory -Keep $OffDeviceRetentionCount
    Write-ScheduledBackupEvent -Event "off_device_copy_verified" -Message "The explicitly configured secondary copy was rehashed; $deleted expired verified pair(s) were removed."
  }

  Write-ScheduledBackupEvent -Event "backup_completed" -Message "Verified paired backup $($backup.stamp) completed successfully."
  Write-Host "CopyLab scheduled backup $($backup.stamp) completed." -ForegroundColor Green
} catch {
  Write-ScheduledBackupEvent -Event "backup_failed" -Message $_.Exception.Message
  throw
} finally {
  if ($null -ne $scheduledLock) { $scheduledLock.Dispose() }
}
