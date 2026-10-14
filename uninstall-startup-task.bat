@echo off
setlocal

set "ROOT=%~dp0"

echo.
echo Removing Xgent Hub startup tasks for this install root...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%uninstall-startup-task.ps1"
exit /b %ERRORLEVEL%
