[CmdletBinding()]
param(
  [switch]$InspectInstalledTasks
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw $Message }
}

$scripts = @(
  "Supervisor-CopyLab.ps1",
  "Start-CopyLab.ps1",
  "Stop-CopyLab.ps1",
  "Install-CopyLab-AutoStart.ps1",
  "Remove-CopyLab-AutoStart.ps1",
  "Backup-CopyLab.ps1",
  "Invoke-CopyLab-ScheduledBackup.ps1",
  "Install-CopyLab-BackupTask.ps1",
  "Remove-CopyLab-BackupTask.ps1",
  "Test-CopyLab-RestoreDrill.ps1"
)
foreach ($script in $scripts) {
  $path = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $script))
  Assert-True -Condition (Test-Path -LiteralPath $path -PathType Leaf) -Message "$script is missing."
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $details = ($errors | ForEach-Object { "$($_.Message) at $($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber)" }) -join "; "
    throw "$script has PowerShell parse errors: $details"
  }
}

$supervisorPath = Join-Path $PSScriptRoot "Supervisor-CopyLab.ps1"
$supervisor = Get-Content -LiteralPath $supervisorPath -Raw
Assert-True (
  $supervisor -match [regex]::Escape('http://127.0.0.1:4310') -and
  $supervisor -match [regex]::Escape('$url/api/health')
) "Supervisor health must remain pinned to the constant-time loopback health endpoint."
Assert-True (
  $supervisor -match '\$healthTimeoutSeconds\s*=\s*30' -and
  $supervisor -match '-TimeoutSec\s+\$healthTimeoutSeconds'
) "Supervisor health must allow the bounded 30-second event-loop response window."
Assert-True (
  $supervisor -match 'if \(\$consecutiveUnhealthy -ge 3\)'
) "Supervisor must preserve the three-consecutive-failure recycle threshold."
Assert-True ($supervisor -match '\[IO\.FileShare\]::None') "Supervisor must use an exclusive file lock to prevent duplicates."
Assert-True ($supervisor -match 'crash_loop_detected') "Supervisor crash-loop detection is missing."
Assert-True ($supervisor -match 'supervisor\.maintenance\.request') "Supervisor planned-maintenance coordination is missing."
Assert-True ($supervisor -match 'function Get-ControlRequestState') "Supervisor structured control-request validation is missing."
Assert-True (
  $supervisor -match 'formatVersion' -and
  $supervisor -match 'requestId' -and
  $supervisor -match 'ownerPid' -and
  $supervisor -match 'createdAt' -and
  $supervisor -match 'expiresAt'
) "Supervisor control requests must carry bounded structured lease provenance."
Assert-True ($supervisor -match 'STALE_RECOVERED') "Supervisor stale control-request recovery is missing."
Assert-True ($supervisor -match 'CONTROL_REQUEST_BLOCKED') "Supervisor ambiguous fresh requests must fail safe."
Assert-True ($supervisor -match 'Protect-CopyLabLogText') "Supervisor redaction is missing."
Assert-True (
  $supervisor -match 'if \(\$maintenanceState\.Active\)[\s\S]{0,1800}Start-Sleep -Milliseconds 500'
) "Supervisor maintenance must use a bounded sleep rather than a wait that wakes on the maintenance request itself."

$start = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Start-CopyLab.ps1") -Raw
$stop = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Stop-CopyLab.ps1") -Raw
$autostart = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Install-CopyLab-AutoStart.ps1") -Raw
Assert-True ($start -match 'Supervisor-CopyLab\.ps1') "Manual start must launch the supervisor."
Assert-True ($start -notmatch 'Get-Command node') "Manual start must not launch a detached Node child directly."
Assert-True ($start -notmatch 'Remove-Item[^\r\n]+supervisorStopRequest') "Manual start must not blindly clear a live stop request."
Assert-True ($stop -match 'New-SupervisorStopLease') "Intentional stop must publish a structured bounded lease."
Assert-True ($stop -match 'Remove-OwnedSupervisorStopLease') "Intentional stop must clear only the lease it owns."
Assert-True ($stop -notmatch 'Remove-Item[^\r\n]+maintenanceRequest') "Intentional stop must not clear a concurrent backup lease it does not own."
Assert-True ($autostart -match 'Supervisor-CopyLab\.ps1') "Autostart must register the supervisor."
Assert-True ($autostart -match '-LaunchMode Auto') "Autostart must identify direct automatic launches for recovery diagnostics."
Assert-True ($autostart -notmatch 'Start-CopyLab\.ps1.*-NoBrowser') "Autostart must not register the legacy detached launcher."
Assert-True (
  $autostart -match 'New-ScheduledTaskTrigger\s+`\s*\r?\n\s*-Once' -and
  $autostart -match '-RepetitionInterval \(New-TimeSpan -Minutes 5\)' -and
  $autostart -match '\$triggers\s*=\s*@\(\$logonTrigger, \$watchdogTrigger\)' -and
  $autostart -match '-Trigger \$triggers'
) "Autostart must include the five-minute dead-supervisor watchdog trigger."
Assert-True (
  $autostart -match 'MSFT_TaskLogonTrigger' -and
  $autostart -match 'MSFT_TaskTimeTrigger' -and
  $autostart -match 'Repetition\.Interval' -and
  $autostart -match 'PT5M'
) "Autostart must verify both registered recovery triggers."

$scheduled = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Invoke-CopyLab-ScheduledBackup.ps1") -Raw
$backupInstall = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Install-CopyLab-BackupTask.ps1") -Raw
$backup = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Backup-CopyLab.ps1") -Raw
$retentionCli = Get-Content -LiteralPath (Join-Path $PSScriptRoot "apps\server\src\backup-retention-cli.ts") -Raw
Assert-True ($scheduled -match 'Backup-CopyLab\.ps1') "Scheduled orchestration must reuse the verified paired-backup helper."
Assert-True ($scheduled -match 'backup_skipped_outside_quiet_window') "Scheduled backup must fail closed outside its quiet window."
Assert-True ($scheduled -match 'IsNullOrWhiteSpace\(\$OffDeviceDestination\)') "Secondary copying must require explicit destination configuration."
Assert-True ($scheduled -match 'Remove-ExpiredVerifiedPairs') "Explicit secondary retention is missing."
Assert-True ($scheduled -match 'Test-ChecksumSidecar -DatabasePath \$main -ExpectedHash \$manifest\.mainDatabase\.sha256 -Rehash') "Off-device retention must rehash older main databases before pruning."
Assert-True ($scheduled -match 'Test-ChecksumSidecar -DatabasePath \$learning -ExpectedHash \$manifest\.learningDatabase\.sha256 -Rehash') "Off-device retention must rehash older learning databases before pruning."
Assert-True ($scheduled -match '\[ValidateRange\(1, 52\)\]\[int\]\$LocalRetentionCount = 4') "Scheduled local retention must default to four complete generations."
Assert-True ($scheduled -match 'Backup-CopyLab\.ps1"\) -PassThru -LocalRetentionCount \$LocalRetentionCount') "Scheduled backup must pass the configured local retention count to the verified backup helper."
Assert-True ($backupInstall -match '"-LocalRetentionCount \$LocalRetentionCount"') "The backup task definition must preserve the configured local retention count."
Assert-True ($backup -match '\[ValidateRange\(1, 52\)\]\[int\]\$LocalRetentionCount = 4') "Manual local retention must default to four complete generations."
Assert-True ($backup -match '\$manifestPath \$LocalRetentionCount') "The verified backup helper must pass its local retention count to the retention CLI."
Assert-True ($backup -match 'New-CopyLabControlLease') "Backup maintenance must publish a structured bounded lease."
Assert-True ($backup -match 'Remove-OwnedCopyLabControlLease') "Backup must release only the maintenance lease it owns."
Assert-True ($backup -match 'controlRequestId[^\r\n]+maintenanceLease\.requestId') "Backup must await acknowledgement of its exact maintenance lease."
Assert-True ($retentionCli -match 'DEFAULT_LOCAL_BACKUP_RETENTION_COUNT') "The retention CLI must preserve the four-generation module default when no count is supplied."
Assert-True ($backupInstall -match 'CopyLab Verified Backup') "The verified backup task contract is missing."

$drill = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Test-CopyLab-RestoreDrill.ps1") -Raw
Assert-True ($drill -match 'CopyLab-RestoreDrills') "Restore drill must use its isolated Windows temporary root."
Assert-True ($drill -match '\$target -ieq \$productionMain') "Restore drill must explicitly reject the production main database target."
Assert-True ($drill -match '\$target -ieq \$productionLearning') "Restore drill must explicitly reject the production learning database target."
$learningRestore = '& $node $restoreEntry $learningBackup $drillLearning'
$mainRestore = '& $node $restoreEntry $mainBackup $drillMain'
Assert-True (
  $drill.IndexOf($learningRestore, [StringComparison]::Ordinal) -ge 0 -and
  $drill.IndexOf($learningRestore, [StringComparison]::Ordinal) -lt
    $drill.IndexOf($mainRestore, [StringComparison]::Ordinal)
) "Restore drill must fail fast on the small learning ledger before copying the large main ledger."

# Exercise the same classifier used by direct autostart against isolated
# operating-system temporary files. No production control file or process is
# read, cleared, started, or stopped by this test-only path.
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
  [IO.Path]::DirectorySeparatorChar,
  [IO.Path]::AltDirectorySeparatorChar
)
$controlTestRoot = [IO.Path]::GetFullPath((Join-Path $temporaryBase ("copylab-control-test-" + [guid]::NewGuid().ToString())))
$temporaryPrefix = $temporaryBase + [IO.Path]::DirectorySeparatorChar
Assert-True ($controlTestRoot.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) "Control test root escaped the operating-system temporary directory."
New-Item -ItemType Directory -Path $controlTestRoot -Force | Out-Null
function Write-TestControlLease {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet("maintenance", "supervisor-stop")][string]$RequestType,
    [Parameter(Mandatory = $true)][int]$OwnerPid,
    [Parameter(Mandatory = $true)][DateTimeOffset]$CreatedAt,
    [Parameter(Mandatory = $true)][DateTimeOffset]$ExpiresAt
  )
  $lease = [ordered]@{
    formatVersion = 1
    requestType = $RequestType
    requestId = [guid]::NewGuid().ToString()
    ownerPid = $OwnerPid
    createdAt = $CreatedAt.ToString("o")
    expiresAt = $ExpiresAt.ToString("o")
  }
  [IO.File]::WriteAllText(
    $Path,
    ($lease | ConvertTo-Json -Compress),
    [Text.UTF8Encoding]::new($false)
  )
}
try {
  $now = [DateTimeOffset]::UtcNow
  $liveMaintenance = Join-Path $controlTestRoot "live-maintenance.request"
  Write-TestControlLease `
    -Path $liveMaintenance `
    -RequestType "maintenance" `
    -OwnerPid $PID `
    -CreatedAt $now `
    -ExpiresAt $now.AddMinutes(30)
  $liveMaintenanceState = & $supervisorPath `
    -ControlStateTestPath $liveMaintenance `
    -ControlStateTestType maintenance
  Assert-True ($liveMaintenanceState.State -eq "LIVE") "A live maintenance lease was not recognized."
  Assert-True (Test-Path -LiteralPath $liveMaintenance -PathType Leaf) "A live maintenance lease was cleared."

  $deadMaintenance = Join-Path $controlTestRoot "dead-maintenance.request"
  Write-TestControlLease `
    -Path $deadMaintenance `
    -RequestType "maintenance" `
    -OwnerPid ([int]::MaxValue) `
    -CreatedAt $now `
    -ExpiresAt $now.AddMinutes(30)
  $deadMaintenanceState = & $supervisorPath `
    -ControlStateTestPath $deadMaintenance `
    -ControlStateTestType maintenance
  Assert-True ($deadMaintenanceState.State -eq "STALE_RECOVERED") "A dead-owner maintenance lease was not recovered."
  Assert-True (-not (Test-Path -LiteralPath $deadMaintenance)) "A dead-owner maintenance lease remained after recovery."

  $liveStop = Join-Path $controlTestRoot "live-stop.request"
  Write-TestControlLease `
    -Path $liveStop `
    -RequestType "supervisor-stop" `
    -OwnerPid $PID `
    -CreatedAt $now `
    -ExpiresAt $now.AddMinutes(5)
  $liveStopState = & $supervisorPath `
    -ControlStateTestPath $liveStop `
    -ControlStateTestType supervisor-stop
  Assert-True ($liveStopState.State -eq "LIVE") "A live intentional stop lease was not recognized."
  Assert-True (Test-Path -LiteralPath $liveStop -PathType Leaf) "A live intentional stop lease was cleared."

  $expiredStop = Join-Path $controlTestRoot "expired-stop.request"
  Write-TestControlLease `
    -Path $expiredStop `
    -RequestType "supervisor-stop" `
    -OwnerPid $PID `
    -CreatedAt $now.AddMinutes(-5) `
    -ExpiresAt $now.AddMinutes(-1)
  $expiredStopState = & $supervisorPath `
    -ControlStateTestPath $expiredStop `
    -ControlStateTestType supervisor-stop
  Assert-True ($expiredStopState.State -eq "STALE_RECOVERED") "An expired stop lease was not recovered."
  Assert-True (-not (Test-Path -LiteralPath $expiredStop)) "An expired stop lease remained after recovery."

  $freshMalformed = Join-Path $controlTestRoot "fresh-malformed.request"
  [IO.File]::WriteAllText($freshMalformed, "not-json", [Text.UTF8Encoding]::new($false))
  $freshMalformedState = & $supervisorPath `
    -ControlStateTestPath $freshMalformed `
    -ControlStateTestType maintenance
  Assert-True ($freshMalformedState.State -eq "AMBIGUOUS") "A fresh malformed request did not fail safe."
  Assert-True (Test-Path -LiteralPath $freshMalformed -PathType Leaf) "A fresh ambiguous request was cleared unsafely."

  $oldMalformed = Join-Path $controlTestRoot "old-malformed.request"
  [IO.File]::WriteAllText($oldMalformed, "legacy-power-loss-flag", [Text.UTF8Encoding]::new($false))
  (Get-Item -LiteralPath $oldMalformed).LastWriteTimeUtc = [DateTime]::UtcNow.AddHours(-3)
  $oldMalformedState = & $supervisorPath `
    -ControlStateTestPath $oldMalformed `
    -ControlStateTestType maintenance
  Assert-True ($oldMalformedState.State -eq "STALE_RECOVERED") "An old malformed power-loss request was not recovered."
  Assert-True (-not (Test-Path -LiteralPath $oldMalformed)) "An old malformed request remained after recovery."
} finally {
  $resolvedControlTestRoot = [IO.Path]::GetFullPath($controlTestRoot)
  if (
    $resolvedControlTestRoot.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase) -and
    (Test-Path -LiteralPath $resolvedControlTestRoot -PathType Container)
  ) {
    Remove-Item -LiteralPath $resolvedControlTestRoot -Recurse -Force
  }
}

# Validate runtime prerequisites without acquiring the supervisor lock or
# starting/stopping any process.
& (Join-Path $PSScriptRoot "Supervisor-CopyLab.ps1") -ValidateOnly | Out-Null

# Build both task definitions through PowerShell's ShouldProcess dry-run path.
# These calls neither register nor start a task.
& (Join-Path $PSScriptRoot "Install-CopyLab-AutoStart.ps1") -WhatIf | Out-Null
& (Join-Path $PSScriptRoot "Install-CopyLab-BackupTask.ps1") -WhatIf | Out-Null

if ($InspectInstalledTasks) {
  $runtimeTask = Get-ScheduledTask -TaskName "CopyLab Local Dashboard" -ErrorAction SilentlyContinue
  if ($null -ne $runtimeTask) {
    Assert-True ([string]$runtimeTask.Actions[0].Arguments -match 'Supervisor-CopyLab\.ps1') "The installed runtime task has not yet been migrated to the supervisor action."
    Assert-True ([string]$runtimeTask.Actions[0].Arguments -match '-LaunchMode Auto') "The installed runtime task does not identify its automatic launch mode."
    $runtimeLogonTriggers = @($runtimeTask.Triggers | Where-Object {
      $_.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger"
    })
    $runtimeWatchdogTriggers = @($runtimeTask.Triggers | Where-Object {
      $_.CimClass.CimClassName -eq "MSFT_TaskTimeTrigger" -and
        [string]$_.Repetition.Interval -eq "PT5M"
    })
    Assert-True (
      $runtimeLogonTriggers.Count -eq 1 -and $runtimeWatchdogTriggers.Count -eq 1
    ) "The installed runtime task does not have both logon and five-minute watchdog recovery triggers."
  }
  $backupTask = Get-ScheduledTask -TaskName "CopyLab Verified Backup" -ErrorAction SilentlyContinue
  if ($null -ne $backupTask) {
    Assert-True ([string]$backupTask.Actions[0].Arguments -match 'Invoke-CopyLab-ScheduledBackup\.ps1') "The installed backup task does not use the verified orchestration action."
  }
}

Write-Host "CopyLab operations scripts passed parse, static-contract, prerequisite, and task-definition dry-run checks." -ForegroundColor Green
Write-Host "No process, database, or scheduled task was changed."
