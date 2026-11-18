param(
  [ValidateSet(
    "doctor",
    "install",
    "install-shortcuts",
    "remove-shortcuts",
    "install-startup",
    "remove-startup",
    "start-app",
    "start-prod",
    "start-prod-config",
    "restart-prod",
    "status-prod",
    "open-root",
    "open-logs",
    "open-backups"
  )]
  [string]$Command = "doctor"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$LogsDir = Join-Path $Root "logs"
$BackupsDir = Join-Path $Root "backups"

function Invoke-ProjectScript {
  param([string]$ScriptPath, [string[]]$Arguments = @())
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$ScriptPath failed with exit code $LASTEXITCODE"
  }
}

function Open-AgentHubFolder {
  param([string]$Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  Start-Process -FilePath "explorer.exe" -ArgumentList @($Path)
  Write-Host "Opened folder: $Path"
}

function Request-RestartProd {
  New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $helper = Join-Path $env:TEMP "agenthub-restart-$stamp.ps1"
  $agentHubScript = Join-Path $Root "scripts\agenthub.ps1"
  $restartLog = Join-Path $LogsDir "restart-request.log"
  $helperContent = @"
Start-Sleep -Seconds 2
& '$agentHubScript' restart -Mode prod -StartOllama -NoWait *> '$restartLog'
"@
  Set-Content -Path $helper -Value $helperContent -Encoding UTF8
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helper) -WorkingDirectory $Root -WindowStyle Hidden
  Write-Host "AgentHub production restart scheduled. Log: $restartLog"
}

function Start-DesktopApp {
  $launcher = Join-Path $Root "scripts\windows\start-app.vbs"
  if (Test-Path $launcher) {
    Start-Process -FilePath "wscript.exe" -ArgumentList @("//B", "`"$launcher`"") -WorkingDirectory $Root
    Write-Host "Started Xgent Hub desktop app."
    return
  }
  Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\agenthub.ps1") -Arguments @("start", "-Mode", "prod", "-StartOllama", "-OpenBrowser")
}

switch ($Command) {
  "doctor" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\doctor.ps1")
  }
  "install" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\install-agenthub.ps1") -Arguments @("-InstallShortcuts")
  }
  "install-shortcuts" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\manage-shortcuts.ps1") -Arguments @("install")
  }
  "remove-shortcuts" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\manage-shortcuts.ps1") -Arguments @("remove")
  }
  "install-startup" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\windows\install-startup-task.ps1")
  }
  "remove-startup" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\windows\uninstall-startup-task.ps1")
  }
  "start-app" {
    Start-DesktopApp
  }
  "start-prod" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\agenthub.ps1") -Arguments @("start", "-Mode", "prod", "-StartOllama", "-OpenBrowser")
  }
  "start-prod-config" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\agenthub.ps1") -Arguments @("start", "-Mode", "prod", "-StartOllama", "-OpenBrowser", "-OpenPath", "/?view=onboarding&step=machine")
  }
  "restart-prod" {
    Request-RestartProd
  }
  "status-prod" {
    Invoke-ProjectScript -ScriptPath (Join-Path $Root "scripts\agenthub.ps1") -Arguments @("status", "-Mode", "prod")
  }
  "open-root" {
    Open-AgentHubFolder -Path $Root
  }
  "open-logs" {
    Open-AgentHubFolder -Path $LogsDir
  }
  "open-backups" {
    Open-AgentHubFolder -Path $BackupsDir
  }
}
