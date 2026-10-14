@echo off
setlocal

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\agenthub.ps1" status -Mode dev
set "CODE=%ERRORLEVEL%"
if /i not "%~1"=="--no-pause" pause
exit /b %CODE%
