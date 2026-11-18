@echo off
setlocal
set "ROOT=%~dp0"
set "ELECTRON=%ROOT%node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo [ERROR] Electron is missing. Run install.bat first.
  if /i not "%~1"=="--no-pause" pause
  exit /b 1
)

set "XGENT_HUB_ROOT=%ROOT%"
start "Xgent Hub" "%ELECTRON%" "%ROOT%desktop\main.cjs"
exit /b 0
