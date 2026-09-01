[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$taskName = "CopyLab Local Dashboard"
$launcher = Join-Path $PSScriptRoot "Supervisor-CopyLab.ps1"
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "CopyLab supervisor was not found."
}
& $launcher -ValidateOnly | Out-Null

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -LaunchMode Auto"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument $arguments `
  -WorkingDirectory $PSScriptRoot
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
# Task Scheduler's RestartCount only applies to failures it classifies as
# restartable. An interrupted hidden PowerShell host can instead finish with
# 0xC000013A, leaving a logon-only task Ready until the next sign-in. Add a
# bounded recovery trigger so the task gets another opportunity every five
# minutes. The supervisor's exclusive file lock makes these watchdog launches
# no-ops while the real supervisor is already running.
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$triggers = @($logonTrigger, $watchdogTrigger)
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 2) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

if ($PSCmdlet.ShouldProcess($taskName, "Register same-user CopyLab supervisor with logon and five-minute watchdog recovery")) {
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $triggers `
    -Principal $principal `
    -Settings $settings `
    -Description "Runs the hidden same-user CopyLab supervisor after sign-in and retries every five minutes if it is interrupted; the supervisor owns loopback health checks and bounded child recovery." `
    -Force | Out-Null

  $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $registeredArguments = [string]$registered.Actions[0].Arguments
  if (
    $registeredArguments -notmatch [regex]::Escape("Supervisor-CopyLab.ps1") -or
    $registeredArguments -notmatch [regex]::Escape("-LaunchMode Auto") -or
    $registeredArguments -match [regex]::Escape("Start-CopyLab.ps1")
  ) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    throw "The registered task did not preserve the supervisor action; it was removed."
  }

  $registeredLogonTriggers = @($registered.Triggers | Where-Object {
    $_.CimClass.CimClassName -eq "MSFT_TaskLogonTrigger"
  })
  $registeredWatchdogTriggers = @($registered.Triggers | Where-Object {
    $_.CimClass.CimClassName -eq "MSFT_TaskTimeTrigger" -and
      [string]$_.Repetition.Interval -eq "PT5M"
  })
  if ($registeredLogonTriggers.Count -ne 1 -or $registeredWatchdogTriggers.Count -ne 1) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    throw "The registered task did not preserve both recovery triggers; it was removed."
  }

  Write-Host "CopyLab automatic startup is installed for the current Windows user." -ForegroundColor Green
  Write-Host "It runs the hidden supervisor after sign-in, checks for interrupted supervision every five minutes, and remains bound to the configured local/remote-safe dashboard endpoints."
}
