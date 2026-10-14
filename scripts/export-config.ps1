param(
  [string]$OutputDir,
  [string]$Name,
  [switch]$IncludeSecrets,
  [switch]$IncludeDatabase,
  [switch]$Zip
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root "backups" }
if (-not $Name) { $Name = "AgentHub-config-$(Get-Date -Format 'yyyyMMdd-HHmm')" }

$BundleDir = Join-Path $OutputDir $Name
$ConfigDir = Join-Path $BundleDir "config"
$DataDir = Join-Path $BundleDir "server-data"
$SecretPattern = "(?i)(TOKEN|SECRET|PASSWORD|API_KEY|KEY)$"

function Ensure-EmptyDestination {
  param([string]$Path)
  if (Test-Path $Path) {
    throw "Destination already exists: $Path"
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Redact-EnvFile {
  param([string]$Source, [string]$Destination)
  $lines = @()
  foreach ($line in Get-Content $Source -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or $trimmed.IndexOf("=") -lt 1) {
      $lines += $line
      continue
    }
    $idx = $line.IndexOf("=")
    $key = $line.Substring(0, $idx).Trim()
    if ($key -match $SecretPattern) {
      $lines += "$key="
    } else {
      $lines += $line
    }
  }
  [System.IO.File]::WriteAllLines($Destination, [string[]]$lines, (New-Object System.Text.UTF8Encoding $false))
}

function Copy-CustomAgents {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path $Source)) {
    Set-Content -Path $Destination -Value "[]" -Encoding UTF8
    return
  }
  if ($IncludeSecrets) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    return
  }
  $items = Get-Content $Source -Raw | ConvertFrom-Json
  foreach ($item in @($items)) {
    if ($item.api -and $item.api.apiKey) {
      $item.api.apiKey = ""
    }
  }
  $items | ConvertTo-Json -Depth 20 | Set-Content -Path $Destination -Encoding UTF8
}

Ensure-EmptyDestination -Path $BundleDir
New-Item -ItemType Directory -Force -Path $ConfigDir, $DataDir | Out-Null

$envPath = Join-Path $Root ".env"
$envExamplePath = Join-Path $Root ".env.example"
if (Test-Path $envExamplePath) {
  Copy-Item -LiteralPath $envExamplePath -Destination (Join-Path $ConfigDir ".env.example") -Force
}
if (Test-Path $envPath) {
  if ($IncludeSecrets) {
    Copy-Item -LiteralPath $envPath -Destination (Join-Path $ConfigDir ".env") -Force
  } else {
    Redact-EnvFile -Source $envPath -Destination (Join-Path $ConfigDir ".env.redacted")
  }
}

Copy-CustomAgents -Source (Join-Path $Root "server\data\custom-agents.json") -Destination (Join-Path $DataDir "custom-agents.json")
$hiddenAgents = Join-Path $Root "server\data\hidden-agents.json"
if (Test-Path $hiddenAgents) {
  Copy-Item -LiteralPath $hiddenAgents -Destination (Join-Path $DataDir "hidden-agents.json") -Force
} else {
  Set-Content -Path (Join-Path $DataDir "hidden-agents.json") -Value "[]" -Encoding UTF8
}

foreach ($name in @("gateway-settings.json", "gateway-usage-ledger.json")) {
  $source = Join-Path $Root "server\data\$name"
  $destination = Join-Path $DataDir $name
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination $destination -Force
  } elseif ($name -eq "gateway-settings.json") {
    Set-Content -Path $destination -Value "{}`n" -Encoding UTF8
  } else {
    Set-Content -Path $destination -Value "[]`n" -Encoding UTF8
  }
}

$databaseFiles = @()
if ($IncludeDatabase) {
  foreach ($file in Get-ChildItem (Join-Path $Root "server\data") -Filter "agenthub.sqlite*" -File -ErrorAction SilentlyContinue) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $DataDir $file.Name) -Force
    $databaseFiles += $file.Name
  }
}

$manifest = [ordered]@{
  schemaVersion = 1
  createdAt = (Get-Date).ToString("o")
  sourceRoot = $Root
  computerName = $env:COMPUTERNAME
  userName = $env:USERNAME
  includeSecrets = [bool]$IncludeSecrets
  includeDatabase = [bool]$IncludeDatabase
  databaseFiles = $databaseFiles
  notes = @(
    "Default export redacts .env secret values and custom API keys.",
    "Use -IncludeSecrets only for your own trusted machine migration.",
    "Database export is optional because it may contain task history and local paths."
  )
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $BundleDir "manifest.json") -Encoding UTF8

if ($Zip) {
  $zipPath = "$BundleDir.zip"
  Compress-Archive -Path (Join-Path $BundleDir "*") -DestinationPath $zipPath -Force
  Write-Host "Config bundle created: $BundleDir"
  Write-Host "Zip created: $zipPath"
} else {
  Write-Host "Config bundle created: $BundleDir"
}

if (-not $IncludeSecrets) {
  Write-Host "Secrets were redacted. Run with -IncludeSecrets only for trusted personal migration."
}
