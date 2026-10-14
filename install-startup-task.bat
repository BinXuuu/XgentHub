@echo off
setlocal

set "ROOT=%~dp0"
set "TASK_NAME=Xgent Hub Auto Start"
set "LAUNCHER=%ROOT%start-on-login.vbs"

echo.
echo ============================================
echo   Install Xgent Hub Startup Task
echo ============================================
echo.

if not exist "%LAUNCHER%" (
    echo [ERROR] Missing launcher: %LAUNCHER%
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%install-startup-task.ps1"
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to create scheduled task.
    exit /b 1
)

echo.
echo Installed: %TASK_NAME%
echo It will start Ollama and Xgent Hub in the background after you log in.
exit /b 0
