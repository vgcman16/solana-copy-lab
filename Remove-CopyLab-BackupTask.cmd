@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Remove-CopyLab-BackupTask.ps1"
if errorlevel 1 (
  echo.
  echo CopyLab verified backup scheduling could not be removed.
  pause
  exit /b 1
)
pause
