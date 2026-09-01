[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [DayOfWeek]$Day = [DayOfWeek]::Saturday,
  [ValidateRange(0, 23)][int]$Hour = 3,
  [ValidateRange(0, 59)][int]$Minute = 15,
  [ValidateRange(0, 23)][int]$QuietStartHour = 0,
  [ValidateRange(1, 12)][int]$QuietWindowHours = 6,
  [ValidateRange(1, 52)][int]$LocalRetentionCount = 4,
  [string]$OffDeviceDestination,
  [ValidateRange(1, 52)][int]$OffDeviceRetentionCount = 8,
  [switch]$RunRestoreDrill
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$taskName = "CopyLab Verified Backup"
$runner = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "Invoke-CopyLab-ScheduledBackup.ps1"))
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
  throw "The CopyLab scheduled-backup runner was not found."
}
if (-not [string]::IsNullOrWhiteSpace($OffDeviceDestination)) {
  $OffDeviceDestination = [IO.Path]::GetFullPath($OffDeviceDestination)
  if ($OffDeviceDestination.Contains('"')) {
    throw "The explicit off-device destination contains an unsupported quote character."
  }
}

$quietStart = [TimeSpan]::FromHours($QuietStartHour)
$quietEnd = $quietStart.Add([TimeSpan]::FromHours($QuietWindowHours))
if ($quietEnd.TotalHours -gt 24) {
  throw "The configured market-quiet window must end on the same local day."
}
$argumentParts = @(
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-WindowStyle Hidden",
  "-ExecutionPolicy Bypass",
  "-File `"$runner`"",
  "-QuietDay $Day",
  "-QuietStart `"$($quietStart.ToString())`"",
  "-QuietEnd `"$($quietEnd.ToString())`"",
  "-LocalRetentionCount $LocalRetentionCount",
  "-OffDeviceRetentionCount $OffDeviceRetentionCount"
)
if (-not [string]::IsNullOrWhiteSpace($OffDeviceDestination)) {
  $argumentParts += "-OffDeviceDestination `"$OffDeviceDestination`""
}
if ($RunRestoreDrill) { $argumentParts += "-RunRestoreDrill" }
$arguments = $argumentParts -join " "

$runAt = (Get-Date).Date.AddHours($Hour).AddMinutes($Minute)
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek $Day -At $runAt
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

if ($PSCmdlet.ShouldProcess($taskName, "Register weekly same-user verified backup task")) {
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Creates a verified CopyLab database pair only inside the configured Saturday-style market-quiet window; optional secondary copy requires an explicit destination." `
    -Force | Out-Null

  $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $registeredArguments = [string]$registered.Actions[0].Arguments
  if (
    $registeredArguments -notmatch [regex]::Escape("Invoke-CopyLab-ScheduledBackup.ps1") -or
    $registeredArguments -match [regex]::Escape("Backup-CopyLab.cmd")
  ) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    throw "The registered backup task did not preserve the verified orchestration action; it was removed."
  }

  Write-Host "CopyLab verified backup task installed for $Day at $($runAt.ToString('HH:mm')) local time." -ForegroundColor Green
  Write-Host "Missed starts outside the $($quietStart.ToString())-$($quietEnd.ToString()) quiet window are logged and skipped."
  if ([string]::IsNullOrWhiteSpace($OffDeviceDestination)) {
    Write-Host "No off-device destination was configured; only the verified local backup will be created."
  } else {
    Write-Host "The explicit secondary destination will receive atomically published, rehashed pairs."
  }
}
