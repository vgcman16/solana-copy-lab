[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$StopRunning
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$taskName = "CopyLab Local Dashboard"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  if ($StopRunning) {
    & (Join-Path $PSScriptRoot "Stop-CopyLab.ps1")
  }
  if ($PSCmdlet.ShouldProcess($taskName, "Unregister CopyLab supervisor autostart")) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  Write-Host "CopyLab automatic startup was removed." -ForegroundColor Green
  if (-not $StopRunning) {
    Write-Host "Any currently running supervisor was left running; use Stop-CopyLab.cmd to stop it."
  }
} else {
  Write-Host "CopyLab automatic startup is not installed."
}
