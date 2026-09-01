@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Test-CopyLab-RestoreDrill.ps1"
if errorlevel 1 (
  echo.
  echo CopyLab restore drill failed. Review the message above.
  pause
  exit /b 1
)
pause
