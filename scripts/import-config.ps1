param(
  [Parameter(Mandatory = $true)]
  [string]$BundlePath,
  [switch]$RestoreSecrets,
  [switch]$RestoreDatabase
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BackupDir = Join-Path $Root "backups\import-before-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$TempDir = $null

function Resolve-BundleDirectory {
  param([string]$Path)
  $resolved = Resolve-Path $Path -ErrorAction Stop
  $item = Get-Item -LiteralPath $resolved.Path
  if ($item.PSIsContainer) { return $item.FullName }
  if ($item.Extension -ieq ".zip") {
    $script:TempDir = Join-Path $env:TEMP "agenthub-import-$(Get-Date -Format 'yyyyMMddHHmmss')"
    New-Item -ItemType Directory -Force -Path $script:TempDir | Out-Null
    Expand-Archive -LiteralPath $item.FullName -DestinationPath $script:TempDir -Force
    return $script:TempDir
  }
  throw "BundlePath must be a directory or .zip file."
}

function Backup-IfExists {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
  $relative = Resolve-Path -LiteralPath $Path | ForEach-Object {
    $_.Path.Substring($Root.Length).TrimStart("\", "/")
  }
  $target = Join-Path $BackupDir $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $Path -Destination $target -Force
}

try {
  $BundleDir = Resolve-BundleDirectory -Path $BundlePath
  $ConfigDir = Join-Path $BundleDir "config"
  $DataDir = Join-Path $BundleDir "server-data"

  if (-not (Test-Path $ConfigDir) -and -not (Test-Path $DataDir)) {
    throw "Invalid AgentHub config bundle: missing config or server-data directory."
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $Root "server\data") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "backups") | Out-Null

  $envSource = $null
  if ($RestoreSecrets -and (Test-Path (Join-Path $ConfigDir ".env"))) {
    $envSource = Join-Path $ConfigDir ".env"
  } elseif (Test-Path (Join-Path $ConfigDir ".env.redacted")) {
    $envSource = Join-Path $ConfigDir ".env.redacted"
  } elseif (-not $RestoreSecrets -and (Test-Path (Join-Path $ConfigDir ".env"))) {
    Write-Host "Skipping .env because bundle contains secrets. Re-run with -RestoreSecrets if this is your trusted bundle."
  }

  if ($envSource) {
    $envTarget = Join-Path $Root ".env"
    Backup-IfExists -Path $envTarget
    Copy-Item -LiteralPath $envSource -Destination $envTarget -Force
    Write-Host "Restored .env from $envSource"
  }

  foreach ($name in @("custom-agents.json", "hidden-agents.json", "gateway-settings.json", "gateway-usage-ledger.json")) {
    $source = Join-Path $DataDir $name
    if (-not (Test-Path $source)) { continue }
    $target = Join-Path $Root "server\data\$name"
    Backup-IfExists -Path $target
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Host "Restored $name"
  }

  if ($RestoreDatabase) {
    foreach ($file in Get-ChildItem $DataDir -Filter "agenthub.sqlite*" -File -ErrorAction SilentlyContinue) {
      $target = Join-Path $Root "server\data\$($file.Name)"
      Backup-IfExists -Path $target
      Copy-Item -LiteralPath $file.FullName -Destination $target -Force
      Write-Host "Restored $($file.Name)"
    }
    Write-Host "Database restore was requested. Restart AgentHub before using it."
  }

  if (Test-Path $BackupDir) {
    Write-Host "Previous local files backed up to: $BackupDir"
  }
  Write-Host "Config import completed."
} finally {
  if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force
  }
}
