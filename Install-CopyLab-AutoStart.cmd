@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-CopyLab-AutoStart.ps1"
if errorlevel 1 (
  echo CopyLab automatic startup could not be installed.
  pause
  exit /b 1
)
pause
