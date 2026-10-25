param(
  [switch]$RunBuild
)

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$Checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param(
    [ValidateSet("PASS", "WARN", "FAIL")]
    [string]$Status,
    [string]$Name,
    [string]$Detail = ""
  )
  $Checks.Add([pscustomobject]@{ Status = $Status; Name = $Name; Detail = $Detail }) | Out-Null
}

function Read-DotEnv {
  $path = Join-Path $Root ".env"
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content $path -Encoding UTF8) {
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

function Test-HttpOk {
  param([string]$Url, [int]$TimeoutSec = 2)
  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Test-JsonFile {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path $Path)) {
    Add-Check "WARN" $Name "Missing file: $Path"
    return
  }
  try {
    Get-Content $Path -Raw | ConvertFrom-Json | Out-Null
    Add-Check "PASS" $Name "Valid JSON"
  } catch {
    Add-Check "FAIL" $Name "Invalid JSON: $($_.Exception.Message)"
  }
}

function Test-OptionalJsonFile {
  param([string]$Path, [string]$Name, [string]$DefaultValue)
  if (-not (Test-Path $Path)) {
    Add-Check "PASS" $Name "Optional; will be created on first use"
    return
  }
  Test-JsonFile -Path $Path -Name $Name
}

function Resolve-Executable {
  param([string]$Value)
  if (-not $Value) { return $null }
  if ($Value -match "[\\/]") {
    if (Test-Path $Value) { return (Resolve-Path $Value).Path }
    return $null
  }
  $cmd = Get-Command $Value -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

function Resolve-MakensisExecutable {
  param([string]$Value)
  $resolved = Resolve-Executable -Value $Value
  if ($resolved) { return $resolved }

  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  foreach ($root in $roots) {
    $candidate = Join-Path $root "NSIS\makensis.exe"
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  return $null
}

function Test-CommandPresence {
  param([string]$Name, [string]$Value, [bool]$Required = $false)
  $resolved = Resolve-Executable -Value $Value
  if ($resolved) {
    Add-Check "PASS" "$Name CLI" $resolved
  } elseif ($Required) {
    Add-Check "FAIL" "$Name CLI" "Not found: $Value"
  } else {
    Add-Check "WARN" "$Name CLI" "Not found: $Value"
  }
}

# Same rule as server/src/adapters/claudeBinary.ts: a CLAUDE_CODE_BIN pinned to the desktop app's
# claude-code\<version>\<hash>\claude.exe follows upgrades to the newest version in that folder.
function Find-NewestClaudeIn {
  param([string]$Base)
  if (-not (Test-Path $Base)) { return $null }
  $versions = Get-ChildItem -Path $Base -Directory | Where-Object { $_.Name -match '^\d+(\.\d+)*$' } |
    Sort-Object { [version](($_.Name -split '\.' | Select-Object -First 4) -join '.') } -Descending
  foreach ($dir in $versions) {
    $exe = Get-ChildItem -Path $dir.FullName -Directory | ForEach-Object { Join-Path $_.FullName "claude.exe" } |
      Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($exe) { return $exe }
  }
  return $null
}

# Same lookup as the server (server/src/adapters/claudeBinary.ts): a versioned Claude Desktop path is
# swapped for the newest version; a command that is not found falls back to Claude Desktop's bundled copy.
function Resolve-ClaudeCodeBin {
  param([string]$Value)
  if ($Value -match '^(.*[\\/]claude-code)[\\/]\d+(\.\d+)*[\\/][^\\/]+[\\/]claude(\.exe)?$') {
    $newest = Find-NewestClaudeIn -Base $Matches[1]
    if ($newest) { return $newest }
    return $Value
  }
  if (Resolve-Executable -Value $Value) { return $Value }
  $bases = @()
  if ($env:APPDATA) { $bases += Join-Path $env:APPDATA "Claude\claude-code" }
  if ($env:LOCALAPPDATA -and (Test-Path (Join-Path $env:LOCALAPPDATA "Packages"))) {
    $bases += Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Packages") -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "LocalCache\Roaming\Claude\claude-code" }
  }
  foreach ($base in $bases) {
    $newest = Find-NewestClaudeIn -Base $base
    if ($newest) { return $newest }
  }
  return $Value
}

function Get-EnvValue {
  param([hashtable]$Map, [string]$Key, [string]$Fallback)
  if ($Map.ContainsKey($Key) -and $Map[$Key]) { return $Map[$Key] }
  return $Fallback
}

Push-Location $Root
try {
  Add-Check "PASS" "Project root" $Root

  foreach ($dir in @("server", "web", "scripts", "server\data", "logs", "backups")) {
    $path = Join-Path $Root $dir
    if (Test-Path $path) {
      Add-Check "PASS" "Directory $dir" $path
    } else {
      Add-Check "FAIL" "Directory $dir" "Missing"
    }
  }

  foreach ($file in @("package.json", "package-lock.json", ".env.example", "README.md")) {
    $path = Join-Path $Root $file
    if (Test-Path $path) {
      Add-Check "PASS" "File $file" $path
    } else {
      Add-Check "FAIL" "File $file" "Missing"
    }
  }

  foreach ($file in @(
    "install.bat",
    "xgent.bat",
    "scripts\windows\xgent.ps1",
    "scripts\windows\start-app.vbs",
    "scripts\windows\start-on-login.vbs",
    "scripts\windows\start-on-login.ps1",
    "scripts\windows\install-startup-task.ps1",
    "scripts\windows\uninstall-startup-task.ps1",
    "scripts\windows\repair-launchers.ps1",
    "start-app.bat",
    "scripts\agenthub.ps1",
    "scripts\doctor.ps1",
    "scripts\install-agenthub.ps1",
    "scripts\export-config.ps1",
    "scripts\import-config.ps1",
    "scripts\installer-entry.ps1",
    "scripts\manage-shortcuts.ps1",
    "scripts\uninstall-cleanup.ps1",
    "desktop\main.cjs"
  )) {
    $path = Join-Path $Root $file
    if (Test-Path $path) {
      Add-Check "PASS" "Installer file $file" $path
    } else {
      Add-Check "FAIL" "Installer file $file" "Missing"
    }
  }

  $envMap = Read-DotEnv
  if ((Test-Path (Join-Path $Root ".env"))) {
    Add-Check "PASS" ".env" "Found"
    $adminToken = $envMap["ADMIN_TOKEN"]
    if (-not $adminToken -or $adminToken -eq "change-me-please") {
      Add-Check "WARN" "ADMIN_TOKEN" "Set a real token before LAN or tunnel access."
    } else {
      Add-Check "PASS" "ADMIN_TOKEN" "Configured"
    }
    $hostValue = $envMap["HOST"]
    $allowLan = $envMap["ALLOW_LAN_BIND"]
    if ($hostValue -and $hostValue -notin @("127.0.0.1", "localhost") -and $allowLan -notin @("true", "1")) {
      Add-Check "WARN" "HOST" "Non-loopback HOST will be forced back unless ALLOW_LAN_BIND=true."
    }
  } else {
    Add-Check "WARN" ".env" "Missing. Copy .env.example to .env for real use."
  }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $nodeVersion = (& node -v) -replace "^v", ""
    $parts = $nodeVersion.Split(".")
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 13)) {
      Add-Check "PASS" "Node.js" "v$nodeVersion"
    } else {
      Add-Check "FAIL" "Node.js" "Need >= 22.13.0 (node:sqlite without a flag), found v$nodeVersion"
    }
  } else {
    Add-Check "FAIL" "Node.js" "Not found in PATH"
  }

  Test-CommandPresence "npm" "npm" $true

  if (Test-Path (Join-Path $Root "node_modules")) {
    Add-Check "PASS" "Dependencies" "node_modules found"
  } else {
    Add-Check "FAIL" "Dependencies" "Run npm install"
  }

  $electronExe = Join-Path $Root "node_modules\electron\dist\electron.exe"
  $electronShim = Join-Path $Root "node_modules\.bin\electron.cmd"
  if (Test-Path $electronExe) {
    Add-Check "PASS" "Electron desktop runtime" $electronExe
  } elseif (Test-Path (Join-Path $Root "node_modules\electron\install.js")) {
    Add-Check "FAIL" "Electron desktop runtime" "Missing electron.exe. Run install.bat to download the Electron runtime."
  } elseif (Test-Path $electronShim) {
    Add-Check "FAIL" "Electron desktop runtime" "Electron shim exists but runtime is missing. Run install.bat."
  } else {
    Add-Check "WARN" "Electron desktop runtime" "Not found. Run npm install before using start-app.bat."
  }

  if (Test-Path (Join-Path $Root "web\dist\index.html")) {
    Add-Check "PASS" "Web build" "web/dist exists"
  } else {
    Add-Check "WARN" "Web build" "web/dist missing. Run npm run build for prod mode."
  }

  $dataBackupDir = Join-Path $Root "backups\data"
  $latestDataBackup = $null
  if (Test-Path $dataBackupDir) {
    $latestDataBackup = Get-ChildItem -LiteralPath $dataBackupDir -Directory |
      Where-Object { $_.Name -match '^\d{8}-\d{6}-' -and (Test-Path (Join-Path $_.FullName "agenthub.sqlite")) } |
      Sort-Object Name -Descending | Select-Object -First 1
  }
  $dbFile = Join-Path $Root "server\data\agenthub.sqlite"
  if (-not $latestDataBackup -and -not (Test-Path $dbFile)) {
    Add-Check "PASS" "Data backup" "No data yet. The server makes a backup at startup and every 24h."
  } elseif (-not $latestDataBackup) {
    Add-Check "WARN" "Data backup" "No database backup yet in backups\data. The server makes one at startup and every 24h."
  } elseif (((Get-Date) - $latestDataBackup.LastWriteTime).TotalHours -gt 48) {
    Add-Check "WARN" "Data backup" "Latest database backup is older than 48h: $($latestDataBackup.Name)"
  } else {
    Add-Check "PASS" "Data backup" "Latest: $($latestDataBackup.Name)"
  }

  Test-JsonFile -Path (Join-Path $Root "server\data\custom-agents.json") -Name "Custom agents JSON"
  Test-JsonFile -Path (Join-Path $Root "server\data\hidden-agents.json") -Name "Hidden agents JSON"
  Test-OptionalJsonFile -Path (Join-Path $Root "server\data\gateway-settings.json") -Name "Gateway settings JSON" -DefaultValue "{}"
  Test-OptionalJsonFile -Path (Join-Path $Root "server\data\gateway-usage-ledger.json") -Name "Gateway usage ledger JSON" -DefaultValue "[]"

  Test-CommandPresence "Codex" (Get-EnvValue $envMap "CODEX_BIN" "codex")
  Test-CommandPresence "OpenClaw" (Get-EnvValue $envMap "OPENCLAW_BIN" "openclaw")
  Test-CommandPresence "Claude Code" (Resolve-ClaudeCodeBin (Get-EnvValue $envMap "CLAUDE_CODE_BIN" "claude"))
  Test-CommandPresence "Antigravity" (Get-EnvValue $envMap "ANTIGRAVITY_BIN" "agy")
  Test-CommandPresence "Ark CLI" (Get-EnvValue $envMap "ARK_CLI_BIN" "arkcli")
  Test-CommandPresence "Ollama" "ollama"

  $makensis = Resolve-MakensisExecutable -Value (Get-EnvValue $envMap "MAKENSIS_BIN" "makensis")
  if ($makensis) {
    Add-Check "PASS" "NSIS makensis CLI" $makensis
  } else {
    Add-Check "PASS" "NSIS makensis CLI" "Not installed (only needed to build the installer)"
  }

  $healthPort = 4180
  if ($envMap.ContainsKey("PORT") -and $envMap["PORT"] -match "^\d+$") {
    $healthPort = [int]$envMap["PORT"]
  }
  $healthUrl = "http://127.0.0.1:$healthPort/api/health"
  if (Test-HttpOk -Url $healthUrl) {
    Add-Check "PASS" "Xgent Hub health" $healthUrl
  } else {
    Add-Check "WARN" "Xgent Hub health" "Not running or not ready"
  }

  if (Test-HttpOk -Url "http://127.0.0.1:11434/api/tags") {
    Add-Check "PASS" "Ollama API" "http://127.0.0.1:11434/api/tags"
  } else {
    Add-Check "WARN" "Ollama API" "Not running or not installed"
  }

  if ($RunBuild) {
    Write-Host "Running npm run build..."
    & npm run build
    if ($LASTEXITCODE -eq 0) {
      Add-Check "PASS" "npm run build" "Completed"
    } else {
      Add-Check "FAIL" "npm run build" "Exit code $LASTEXITCODE"
    }
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Xgent Hub doctor"
Write-Host "---------------"
foreach ($check in $Checks) {
  $line = "[{0}] {1}" -f $check.Status, $check.Name
  if ($check.Detail) { $line += " - $($check.Detail)" }
  Write-Host $line
}

$failCount = @($Checks | Where-Object { $_.Status -eq "FAIL" }).Count
$warnCount = @($Checks | Where-Object { $_.Status -eq "WARN" }).Count
Write-Host ""
Write-Host "Summary: $failCount failed, $warnCount warnings, $($Checks.Count) checks."

if ($failCount -gt 0) {
  exit 1
}
exit 0
