@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Disable-CopyLab-Remote.ps1"
if errorlevel 1 (
  echo.
  echo CopyLab remote viewing could not be disabled. Review the message above.
  pause
  exit /b 1
)
