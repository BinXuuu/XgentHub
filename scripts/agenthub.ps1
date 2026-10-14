param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Command = "status",

  [ValidateSet("dev", "prod")]
  [string]$Mode = "dev",

  [int]$BackendPort = 4180,
  [int]$FrontendPort = 5180,

  [switch]$OpenBrowser,
  [switch]$StartOllama,
  [switch]$NoWait,
  [string]$OpenPath = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ResolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")

function Read-AgentHubDotEnv {
  $path = Join-Path $Root ".env"
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $idx = $trimmed.IndexOf("=")
    if ($idx -le 0) { continue }
    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
    $map[$key] = $value
  }
  return $map
}

$EnvMap = Read-AgentHubDotEnv
if ($Mode -eq "prod" -and -not $PSBoundParameters.ContainsKey("BackendPort") -and $EnvMap.ContainsKey("PORT") -and $EnvMap["PORT"] -match "^\d+$") {
  $BackendPort = [int]$EnvMap["PORT"]
}

$LogsDir = Join-Path $Root "logs"
$BackupsDir = Join-Path $Root "backups"
$DataDir = Join-Path $Root "server\data"
$AttachmentsDir = Join-Path $DataDir "attachments"
$LogFile = Join-Path $LogsDir ($(if ($Mode -eq "prod") { "agenthub-prod.log" } else { "agenthub-dev.log" }))
$OllamaLogFile = Join-Path $LogsDir "ollama.log"
$HealthUrl = "http://127.0.0.1:$BackendPort/api/health"
$WebUrl = if ($Mode -eq "prod") { "http://127.0.0.1:$BackendPort" } else { "http://127.0.0.1:$FrontendPort" }

function Resolve-OpenUrl {
  if (-not $OpenPath) { return $WebUrl }
  if ($OpenPath -match "^https?://") { return $OpenPath }
  if ($OpenPath.StartsWith("?")) { return "$WebUrl/$OpenPath" }
  if ($OpenPath.StartsWith("/")) { return "$WebUrl$OpenPath" }
  return "$WebUrl/$OpenPath"
}

function Ensure-AgentHubDirectories {
  foreach ($dir in @($LogsDir, $BackupsDir, $DataDir, $AttachmentsDir)) {
    if (-not (Test-Path $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
  }
}

function Write-Step {
  param([string]$Message)
  Write-Host "[Xgent Hub] $Message"
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
  param([string]$Url, [int]$Seconds = 60)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk -Url $Url -TimeoutSec 2) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Get-ListeningPids {
  param([int]$Port)
  $pattern = "^\s*TCP\s+\S+:$Port\s+"
  $pids = @()
  $lines = & netstat.exe -ano -p tcp 2>$null | Select-String -Pattern "LISTENING"
  foreach ($match in $lines) {
    $line = $match.Line.Trim()
    if ($line -notmatch $pattern) { continue }
    $parts = $line -split "\s+"
    $pidText = $parts[-1]
    if ($pidText -match "^\d+$") {
      $pids += [int]$pidText
    }
  }
  return $pids | Sort-Object -Unique
}

function Get-AgentHubTargetPorts {
  if ($Mode -eq "prod") {
    return @($BackendPort) | Sort-Object -Unique
  }
  return @($BackendPort, $FrontendPort) | Sort-Object -Unique
}

function Test-ProcessBelongsToRoot {
  param([int]$ProcessId)

  $visited = @{}
  $currentPid = $ProcessId
  for ($depth = 0; $depth -lt 12 -and $currentPid; $depth++) {
    if ($visited.ContainsKey($currentPid)) { return $false }
    $visited[$currentPid] = $true

    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }

    foreach ($field in @($process.CommandLine, $process.ExecutablePath)) {
      if ($field -and $field.IndexOf($ResolvedRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
      }
    }

    if (-not $process.ParentProcessId -or $process.ParentProcessId -eq $currentPid) {
      return $false
    }
    $currentPid = [int]$process.ParentProcessId
  }

  return $false
}

function Assert-CanStart {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found in PATH."
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found in PATH."
  }
  if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    throw "Dependencies are missing. Run npm install in $Root first."
  }
}

function Start-OllamaService {
  $tagsUrl = "http://127.0.0.1:11434/api/tags"
  if (Test-HttpOk -Url $tagsUrl) {
    Write-Step "Ollama is already running."
    return
  }

  $ollama = (Get-Command ollama -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $ollama) {
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $candidate) { $ollama = $candidate }
  }

  if (-not $ollama) {
    Write-Step "Ollama executable was not found. Skipping Ollama startup."
    return
  }

  Write-Step "Starting Ollama in background."
  $cmdLine = "`"$ollama`" serve >> `"$OllamaLogFile`" 2>&1"
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", $cmdLine) -WorkingDirectory $Root -WindowStyle Hidden

  if (-not $NoWait) {
    if (Wait-HttpOk -Url $tagsUrl -Seconds 60) {
      Write-Step "Ollama is ready."
    } else {
      Write-Step "Ollama did not become ready within 60 seconds. Log: $OllamaLogFile"
    }
  }
}

function Invoke-BackupRetention {
  # Keep only the newest 20 local backups (remote version backups made by backup-version are untouched). Never block startup.
  $pruneScript = Join-Path $Root "scripts\prune-backups.ps1"
  if (-not (Test-Path $pruneScript)) { return }
  try {
    $summary = & $pruneScript -Keep 20 2>&1 | Select-Object -Last 1
    if ($summary) { Write-Step "Backups: $summary" }
  } catch {
    Write-Step "Backup cleanup skipped: $($_.Exception.Message)"
  }
}

function Invoke-LogRotation {
  # Archive last month's logs and drop archives older than one year. Never block startup.
  $rotateScript = Join-Path $Root "scripts\rotate-logs.ps1"
  if (-not (Test-Path $rotateScript)) { return }
  try {
    $summary = & $rotateScript -Root $Root 2>&1 | Select-Object -Last 1
    if ($summary) { Write-Step "Logs: $summary" }
  } catch {
    Write-Step "Log rotation skipped: $($_.Exception.Message)"
  }
}

function Start-AgentHub {
  Ensure-AgentHubDirectories
  Assert-CanStart
  Invoke-BackupRetention

  if ($StartOllama) {
    Start-OllamaService
  }

  if (Test-HttpOk -Url $HealthUrl) {
    Write-Step "Xgent Hub is already running: $HealthUrl"
    if ($OpenBrowser) { Start-Process (Resolve-OpenUrl) | Out-Null }
    return
  }

  Invoke-LogRotation

  $commandLine = if ($Mode -eq "prod") { "npm start" } else { "set PORT=$BackendPort&& npm run dev" }
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Step "Starting Xgent Hub ($Mode) in background."
  Write-Step "Log: $LogFile"

  $cmdLine = "cd /d `"$Root`" && echo.>> `"$LogFile`" && echo [$stamp] Starting Xgent Hub $Mode>> `"$LogFile`" && $commandLine >> `"$LogFile`" 2>&1"
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", $cmdLine) -WorkingDirectory $Root -WindowStyle Hidden

  if (-not $NoWait) {
    if (Wait-HttpOk -Url $HealthUrl -Seconds 60) {
      Write-Step "Xgent Hub is ready: $HealthUrl"
    } else {
      Write-Step "Xgent Hub did not become ready within 60 seconds. Check $LogFile"
    }
  }

  if ($OpenBrowser) {
    Start-Process (Resolve-OpenUrl) | Out-Null
  }
}

function Stop-AgentHub {
  Ensure-AgentHubDirectories
  $ports = @(Get-AgentHubTargetPorts)
  $pids = @()
  foreach ($port in $ports) {
    $pids += Get-ListeningPids -Port $port
  }
  $pids = $pids | Sort-Object -Unique

  if (-not $pids -or $pids.Count -eq 0) {
    Write-Step "Xgent Hub does not appear to be listening on $($ports -join ', ')."
    return
  }

  $ownedPids = @()
  foreach ($processId in $pids) {
    if (Test-ProcessBelongsToRoot -ProcessId $processId) {
      $ownedPids += $processId
    } else {
      Write-Step "Skipping PID $processId because it does not belong to $ResolvedRoot."
    }
  }
  $ownedPids = $ownedPids | Sort-Object -Unique

  if (-not $ownedPids -or $ownedPids.Count -eq 0) {
    Write-Step "No Xgent Hub process owned by $ResolvedRoot is listening on $($ports -join ', ')."
    return
  }

  foreach ($processId in $ownedPids) {
    Write-Step "Stopping PID $processId."
    & taskkill.exe /F /T /PID $processId | Out-Null
  }
}

function Show-AgentHubStatus {
  Ensure-AgentHubDirectories
  $backendPids = @(Get-ListeningPids -Port $BackendPort)
  $frontendPids = if ($Mode -eq "prod") { @() } else { @(Get-ListeningPids -Port $FrontendPort) }
  $healthOk = Test-HttpOk -Url $HealthUrl
  $ollamaOk = Test-HttpOk -Url "http://127.0.0.1:11434/api/tags"

  Write-Host ""
  Write-Host "Xgent Hub status"
  Write-Host "---------------"
  Write-Host "Root        : $Root"
  Write-Host "Logs        : $LogsDir"
  Write-Host "Backups     : $BackupsDir"
  Write-Host "Data        : $DataDir"
  Write-Host "Mode        : $Mode"
  Write-Host "Backend     : $HealthUrl"
  Write-Host "Web URL     : $WebUrl"
  Write-Host "Backend PID : $(@($backendPids) -join ', ')"
  Write-Host "Frontend PID: $(@($frontendPids) -join ', ')"
  Write-Host "Health      : $(if ($healthOk) { 'ok' } else { 'not responding' })"
  Write-Host "Ollama      : $(if ($ollamaOk) { 'ok' } else { 'not responding' })"
  Write-Host ""
}

switch ($Command) {
  "start" {
    Start-AgentHub
  }
  "stop" {
    Stop-AgentHub
  }
  "restart" {
    Stop-AgentHub
    Start-Sleep -Seconds 2
    Start-AgentHub
  }
  "status" {
    Show-AgentHubStatus
  }
}
