@echo off
setlocal

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\agenthub.ps1" start -Mode prod -StartOllama -OpenBrowser
exit /b %ERRORLEVEL%
