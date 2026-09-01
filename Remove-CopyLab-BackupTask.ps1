[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$taskName = "CopyLab Verified Backup"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
  Write-Host "CopyLab verified backup task is not installed."
  return
}
if ($PSCmdlet.ShouldProcess($taskName, "Unregister CopyLab verified backup task")) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "CopyLab verified backup task was removed." -ForegroundColor Green
}
