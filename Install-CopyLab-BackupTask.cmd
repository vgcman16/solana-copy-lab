@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-CopyLab-BackupTask.ps1"
if errorlevel 1 (
  echo.
  echo CopyLab verified backup scheduling could not be installed.
  pause
  exit /b 1
)
pause
