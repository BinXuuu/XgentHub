$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogsDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogsDir "startup.log"
$AgentHubScript = Join-Path $Root "scripts\agenthub.ps1"

if (-not (Test-Path $LogsDir)) {
  New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
}

function Write-StartupLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Value "[$stamp] $Message" -Encoding UTF8
}

function Test-HttpOk {
  param([string]$Url, [int]$TimeoutSec = 2)
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-HttpOk {
  param([string]$Url, [int]$Seconds = 45)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk -Url $Url -TimeoutSec 2) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

Write-StartupLog "Startup task begin. Root=$Root"

if (Test-Path $AgentHubScript) {
  Write-StartupLog "Calling agenthub.ps1 start -Mode prod -StartOllama."
  try {
    & $AgentHubScript start -Mode prod -StartOllama 2>&1 | ForEach-Object {
      Write-StartupLog $_.ToString()
    }
  } catch {
    Write-StartupLog "Xgent Hub startup failed: $($_.Exception.Message)"
  }
} else {
  Write-StartupLog "Missing script: $AgentHubScript"
}

Write-StartupLog "Startup task end."
