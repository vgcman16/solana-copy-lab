@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Enable-CopyLab-Remote.ps1"
if errorlevel 1 (
  echo.
  echo CopyLab remote viewing could not be enabled. Review the message above.
  pause
  exit /b 1
)
