@echo off
rem Xgent Hub service management on Windows (same commands as scripts/xgent.sh on macOS / Linux).
rem   xgent.bat start ^| stop ^| restart ^| status ^| logs ^| doctor ^| app
rem   xgent.bat autostart on^|off^|status
rem   xgent.bat shortcuts install^|remove^|status
rem   xgent.bat export-config [...] ^| import-config -BundlePath ^<zip^> [...]
rem Run "xgent.bat help" for details. Add --dev to start / restart / status the dev servers.
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\windows\xgent.ps1" %*
set "CODE=%ERRORLEVEL%"

rem Keep the window open when double-clicked (no arguments) or when a shortcut passes --pause.
set "PAUSE_AT_END="
if "%~1"=="" set "PAUSE_AT_END=1"
for %%A in (%*) do if /i "%%~A"=="--pause" set "PAUSE_AT_END=1"
if defined PAUSE_AT_END pause
exit /b %CODE%
