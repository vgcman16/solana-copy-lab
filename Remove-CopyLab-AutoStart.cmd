@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Remove-CopyLab-AutoStart.ps1"
if errorlevel 1 (
  echo CopyLab automatic startup could not be removed.
  pause
  exit /b 1
)
pause
