@echo off
setlocal

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\agenthub.ps1" status -Mode prod
set "CODE=%ERRORLEVEL%"
if /i not "%~1"=="--no-pause" pause
exit /b %CODE%
