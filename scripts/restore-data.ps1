param(
  # Folder name under backups\data to restore, e.g. 20261013-123000-daily. Empty = list backups only.
  [string]$Name = "",
  [switch]$Latest,
  [switch]$NoRestart
)

# Restore the database and JSON configs (MCP / tools / custom agents ...) from backups\data.
# Before overwriting, the current data is copied to backups\data\<time>-before-restore, so a restore can be undone.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\restore-data.ps1            (list backups)
#   powershell -ExecutionPolicy Bypass -File scripts\restore-data.ps1 -Latest    (restore newest)
#   powershell -ExecutionPolicy Bypass -File scripts\restore-data.ps1 -Name 20261013-123000-daily
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts with the ANSI code page.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BackupDir = Join-Path $Root "backups\data"
$DataDir = Join-Path $Root "server\data"
$ServiceScript = Join-Path $Root "scripts\agenthub.ps1"
$DataFiles = @("custom-agents.json", "mcp-servers.json", "resource-library.json", "skill-groups.json", "catalog-sources.json", "catalog-installs.json", "hidden-agents.json", "gateway-settings.json", "gateway-usage-ledger.json")

$backups = @()
if (Test-Path $BackupDir) {
  $backups = @(Get-ChildItem -LiteralPath $BackupDir -Directory |
    Where-Object { $_.Name -match '^\d{8}-\d{6}-' -and (Test-Path (Join-Path $_.FullName "agenthub.sqlite")) } |
    Sort-Object Name -Descending)
}

if (-not $Name -and -not $Latest) {
  if ($backups.Count -eq 0) { Write-Output "No data backups in $BackupDir"; exit 0 }
  Write-Output "Data backups (newest first):"
  foreach ($b in $backups) {
    $mb = [math]::Round(((Get-ChildItem -LiteralPath $b.FullName -File | Measure-Object Length -Sum).Sum / 1MB), 1)
    Write-Output ("  {0}  ({1} MB)" -f $b.Name, $mb)
  }
  Write-Output "Restore with: -Latest  or  -Name <folder>"
  exit 0
}

$target = if ($Latest) { $backups | Select-Object -First 1 } else { $backups | Where-Object { $_.Name -eq $Name } | Select-Object -First 1 }
if (-not $target) { throw "Backup not found: $Name" }

Write-Output "Stopping Xgent Hub..."
& $ServiceScript stop | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safety = Join-Path $BackupDir "$stamp-before-restore"
New-Item -ItemType Directory -Force -Path $safety | Out-Null
foreach ($file in @("agenthub.sqlite", "agenthub.sqlite-wal", "agenthub.sqlite-shm") + $DataFiles) {
  $src = Join-Path $DataDir $file
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $safety -Force }
}
Write-Output "Current data saved to $safety"

foreach ($file in @("agenthub.sqlite-wal", "agenthub.sqlite-shm")) {
  $old = Join-Path $DataDir $file
  if (Test-Path $old) { Remove-Item -LiteralPath $old -Force }
}
Copy-Item -LiteralPath (Join-Path $target.FullName "agenthub.sqlite") -Destination (Join-Path $DataDir "agenthub.sqlite") -Force
foreach ($file in $DataFiles) {
  $src = Join-Path $target.FullName $file
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $DataDir $file) -Force }
}
Write-Output "Restored from $($target.Name)"

if (-not $NoRestart) {
  & $ServiceScript start -Mode prod | Select-Object -Last 1
}
