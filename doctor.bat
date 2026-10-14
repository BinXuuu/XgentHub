@echo off
setlocal

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\doctor.ps1"
set "CODE=%ERRORLEVEL%"
if /i not "%~1"=="--no-pause" pause
exit /b %CODE%
