# Xgent Hub service management on Windows. Called by xgent.bat in the install folder.
# Mirrors scripts/xgent.sh on macOS / Linux: start | stop | restart | status | logs, plus Windows extras.

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ScriptsDir = Join-Path $Root "scripts"
$AgentHubScript = Join-Path $ScriptsDir "agenthub.ps1"

$argList = @($args | ForEach-Object { "$_" })
$Command = if ($argList.Count -gt 0) { $argList[0].ToLowerInvariant() } else { "help" }
$flags = @("--pause", "--dev", "--no-browser")
$rest = @($argList | Select-Object -Skip 1 | Where-Object { $flags -notcontains $_.ToLowerInvariant() })
$Mode = if ($argList -icontains "--dev") { "dev" } else { "prod" }
$OpenBrowser = -not ($argList -icontains "--no-browser")

function Show-Help {
  Write-Host ""
  Write-Host "Xgent Hub - xgent.bat <command>"
  Write-Host ""
  Write-Host "  start              Start the background service and open the browser"
  Write-Host "  stop               Stop the service"
  Write-Host "  restart            Restart the service"
  Write-Host "  status             Show status, ports, log and data folders"
  Write-Host "  logs               Show the last lines of the service log (logs -f keeps following)"
  Write-Host "  doctor             Check Node, dependencies, configuration and installed agent CLIs"
  Write-Host "  app                Open the desktop app (same as start-app.bat)"
  Write-Host "  autostart on|off|status    Start Xgent Hub when you log in to Windows"
  Write-Host "  shortcuts install|remove|status    Desktop and Start Menu shortcuts"
  Write-Host "  export-config [-IncludeSecrets] [-Zip]    Export configuration (secrets redacted by default)"
  Write-Host "  import-config -BundlePath <zip> [-RestoreSecrets]    Import a configuration bundle"
  Write-Host ""
  Write-Host "  --dev              With start / restart / status: use the dev servers (npm run dev)"
  Write-Host "  --no-browser       With start / restart: do not open the browser"
  Write-Host ""
}

function Invoke-Script {
  param([string]$Path, [string[]]$Arguments = @())
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments
  exit $LASTEXITCODE
}

function Get-StartupTaskState {
  foreach ($name in @("Xgent Hub Auto Start", "AgentHub Auto Start")) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) {
      $action = $task.Actions | Select-Object -First 1
      return "on (${name}: $($action.Execute) $($action.Arguments))"
    }
  }
  return "off"
}

switch ($Command) {
  { $_ -in @("help", "-h", "--help", "/?") } {
    Show-Help
    exit 0
  }
  { $_ -in @("start", "restart") } {
    $startArgs = @($Command, "-Mode", $Mode, "-StartOllama")
    if ($OpenBrowser) { $startArgs += "-OpenBrowser" }
    Invoke-Script -Path $AgentHubScript -Arguments $startArgs
  }
  "stop" {
    Invoke-Script -Path $AgentHubScript -Arguments @("stop")
  }
  "status" {
    Invoke-Script -Path $AgentHubScript -Arguments @("status", "-Mode", $Mode)
  }
  "logs" {
    $logFile = Join-Path $Root ("logs\" + $(if ($Mode -eq "prod") { "agenthub-prod.log" } else { "agenthub-dev.log" }))
    if (-not (Test-Path $logFile)) {
      Write-Host "No log yet: $logFile"
      exit 0
    }
    Write-Host "Log: $logFile"
    if ($rest -icontains "-f") {
      Get-Content -LiteralPath $logFile -Tail 80 -Wait -Encoding UTF8
    } else {
      Get-Content -LiteralPath $logFile -Tail 80 -Encoding UTF8
    }
    exit 0
  }
  "doctor" {
    Invoke-Script -Path (Join-Path $ScriptsDir "doctor.ps1")
  }
  "app" {
    & (Join-Path $Root "start-app.bat") --no-pause
    exit $LASTEXITCODE
  }
  "autostart" {
    $sub = if ($rest.Count -gt 0) { $rest[0].ToLowerInvariant() } else { "status" }
    switch ($sub) {
      "on" { Invoke-Script -Path (Join-Path $PSScriptRoot "install-startup-task.ps1") }
      "off" { Invoke-Script -Path (Join-Path $PSScriptRoot "uninstall-startup-task.ps1") }
      "status" {
        Write-Host "Autostart: $(Get-StartupTaskState)"
        exit 0
      }
      default {
        Write-Host "Usage: xgent.bat autostart on|off|status"
        exit 2
      }
    }
  }
  "shortcuts" {
    $sub = if ($rest.Count -gt 0) { $rest[0].ToLowerInvariant() } else { "status" }
    if ($sub -notin @("install", "remove", "status")) {
      Write-Host "Usage: xgent.bat shortcuts install|remove|status"
      exit 2
    }
    Invoke-Script -Path (Join-Path $ScriptsDir "manage-shortcuts.ps1") -Arguments @($sub)
  }
  "export-config" {
    Invoke-Script -Path (Join-Path $ScriptsDir "export-config.ps1") -Arguments $rest
  }
  "import-config" {
    Invoke-Script -Path (Join-Path $ScriptsDir "import-config.ps1") -Arguments $rest
  }
  default {
    Write-Host "Unknown command: $Command"
    Show-Help
    exit 2
  }
}
