[CmdletBinding()]
param(
  [string]$BackupPath,
  [string]$BackupDirectory,
  [switch]$KeepArtifacts,
  [switch]$PassThru
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
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw "$Label database is missing."
  }
  if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw "$Label checksum sidecar is missing."
  }
  $checksumLine = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
  if ($checksumLine -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
    throw "$Label checksum sidecar is malformed."
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  if ($Matches[2].Trim() -cne [IO.Path]::GetFileName($DatabasePath)) {
    throw "$Label checksum sidecar names a different backup file."
  }
  $actualHash = (Get-FileHash -LiteralPath $DatabasePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -cne $expectedHash) {
    throw "$Label SHA-256 checksum does not match."
  }
  return $actualHash
}

$documents = [IO.Path]::GetFullPath([Environment]::GetFolderPath("MyDocuments"))
if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
  $BackupDirectory = Join-Path $documents "CopyLab Backups"
}
$backupDirectoryPath = [IO.Path]::GetFullPath($BackupDirectory)
if (-not (Test-Path -LiteralPath $backupDirectoryPath -PathType Container)) {
  throw "The backup directory does not exist."
}

if ([string]::IsNullOrWhiteSpace($BackupPath)) {
  $latestManifest = Get-ChildItem -LiteralPath $backupDirectoryPath -File -Filter "copylab-*.pair.json" |
    Where-Object { $_.Name -match '^copylab-(\d{8}-\d{6})\.pair\.json$' } |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if ($null -eq $latestManifest) {
    throw "No timestamped CopyLab backup-pair manifest was found."
  }
  $BackupPath = Join-Path $backupDirectoryPath ($latestManifest.Name -replace '\.pair\.json$', '.db')
}

$mainBackup = [IO.Path]::GetFullPath($BackupPath)
$backupPrefix = $backupDirectoryPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $mainBackup.StartsWith($backupPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The selected backup must be a direct child of the explicit backup directory."
}
$mainName = [IO.Path]::GetFileName($mainBackup)
if ($mainName -notmatch '^copylab-(\d{8}-\d{6})\.db$') {
  throw "Select a timestamped copylab-YYYYMMDD-HHMMSS.db main backup."
}
$stamp = $Matches[1]
$learningBackup = [IO.Path]::GetFullPath((Join-Path $backupDirectoryPath "copylab-learning-$stamp.db"))
$manifestPath = [IO.Path]::GetFullPath((Join-Path $backupDirectoryPath "copylab-$stamp.pair.json"))
foreach ($path in @($mainBackup, $learningBackup, $manifestPath)) {
  if ([IO.Path]::GetDirectoryName($path) -ine $backupDirectoryPath) {
    throw "Every drill input must be a direct child of the explicit backup directory."
  }
}

$mainHash = Test-VerifiedChecksum -DatabasePath $mainBackup -Label "Main backup"
$learningHash = Test-VerifiedChecksum -DatabasePath $learningBackup -Label "Learning backup"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "The matching backup-pair manifest is missing."
}
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
} catch {
  throw "The matching backup-pair manifest is malformed JSON."
}
if (
  $manifest.formatVersion -ne 1 -or
  $manifest.stamp -cne $stamp -or
  $manifest.mainDatabase.file -cne $mainName -or
  $manifest.mainDatabase.sha256 -cne $mainHash -or
  $manifest.learningDatabase.file -cne [IO.Path]::GetFileName($learningBackup) -or
  $manifest.learningDatabase.sha256 -cne $learningHash
) {
  throw "The backup-pair manifest does not match both verified database files."
}

$restoreEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\restore-cli.js"))
$backupEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\backup-cli.js"))
foreach ($entry in @($restoreEntry, $backupEntry)) {
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "The restore-drill helpers are not built. Run Setup-CopyLab.cmd first."
  }
}

$systemTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$drillRoot = [IO.Path]::GetFullPath((Join-Path $systemTemp "CopyLab-RestoreDrills"))
$tempPrefix = $systemTemp.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $drillRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The isolated drill root resolved outside the Windows temporary directory."
}
New-Item -ItemType Directory -Path $drillRoot -Force | Out-Null
$drillRootItem = Get-Item -LiteralPath $drillRoot -Force
if (($drillRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "The isolated restore-drill root cannot be a link or junction."
}
$drillDirectory = [IO.Path]::GetFullPath((Join-Path $drillRoot ([Guid]::NewGuid().ToString("N"))))
$drillPrefix = $drillRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $drillDirectory.StartsWith($drillPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The isolated drill directory resolved outside its dedicated temporary root."
}
New-Item -ItemType Directory -Path $drillDirectory | Out-Null

$drillMain = [IO.Path]::GetFullPath((Join-Path $drillDirectory "copylab.db"))
$drillLearning = [IO.Path]::GetFullPath((Join-Path $drillDirectory "learning.db"))
$productionData = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "data"))
$productionMain = [IO.Path]::GetFullPath((Join-Path $productionData "copylab.db"))
$productionLearning = [IO.Path]::GetFullPath((Join-Path $productionData "learning.db"))
foreach ($target in @($drillMain, $drillLearning)) {
  if (
    [IO.Path]::GetDirectoryName($target) -ine $drillDirectory -or
    $target -ieq $productionMain -or
    $target -ieq $productionLearning -or
    (Test-Path -LiteralPath $target)
  ) {
    throw "Restore drill target isolation failed; production was not touched."
  }
}

$node = (Get-Command node -ErrorAction Stop).Source
$completed = $false
try {
  # Restore the small learning ledger first. Its strict schema verification is
  # a fast fail-closed gate and avoids spending many minutes copying the large
  # main ledger when a pair is incompatible.
  & $node $restoreEntry $learningBackup $drillLearning | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The isolated learning-ledger restore exited with code $LASTEXITCODE." }
  & $node $restoreEntry $mainBackup $drillMain | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The isolated main-ledger restore exited with code $LASTEXITCODE." }

  # Re-open each restored ledger through the existing verified SQLite backup
  # helper. This adds a fresh quick_check without ever naming a production path.
  & $node $backupEntry $drillLearning (Join-Path $drillDirectory "verified-learning.db") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The restored learning ledger failed its post-restore SQLite verification." }
  & $node $backupEntry $drillMain (Join-Path $drillDirectory "verified-copylab.db") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The restored main ledger failed its post-restore SQLite verification." }
  $completed = $true
} finally {
  if (-not $KeepArtifacts) {
    $resolvedDrill = [IO.Path]::GetFullPath($drillDirectory)
    if (-not $resolvedDrill.StartsWith($drillPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean an unexpected restore-drill path."
    }
    Remove-Item -LiteralPath $resolvedDrill -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not $completed) { throw "The isolated restore drill did not complete." }
Write-Host "CopyLab backup pair $stamp passed an isolated restore drill." -ForegroundColor Green
Write-Host "Production data was never a restore target."
if ($KeepArtifacts) {
  Write-Host "Isolated drill artifacts were retained at $drillDirectory" -ForegroundColor Yellow
}
if ($PassThru) {
  [pscustomobject]@{
    ok = $true
    stamp = $stamp
    backupDirectory = $backupDirectoryPath
    artifactsKept = [bool]$KeepArtifacts
    drillDirectory = if ($KeepArtifacts) { $drillDirectory } else { $null }
  }
}
