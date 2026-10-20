param(
  [Parameter(Mandatory = $true)]
  [string]$VersionName,
  [string]$BackupRoot = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
# Where version snapshots go: -BackupRoot, else VERSION_BACKUP_ROOT in .env (for example a NAS share).
if (-not $BackupRoot) {
  $envPath = Join-Path $Root ".env"
  if (Test-Path $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
      if ($line -match '^\s*VERSION_BACKUP_ROOT\s*=\s*(.*)$') {
        $BackupRoot = $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
}
if (-not $BackupRoot) {
  throw "No backup folder. Pass -BackupRoot <folder> or set VERSION_BACKUP_ROOT in .env."
}
$Destination = Join-Path $BackupRoot $VersionName

if ($VersionName -notmatch "^(XgentHub|AgentHub)-v\d+\.\d+") {
  throw "VersionName should look like XgentHub-v2.1-something-yyyymmdd-hhmm"
}
if (Test-Path $Destination) {
  throw "Backup destination already exists: $Destination"
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null

$excludeDirs = @(
  "node_modules",
  "dist",
  "logs",
  "backups",
  "attachments",
  ".git",
  "XgentHub-opensource"
)
$excludeFiles = @(
  ".env",
  "*.sqlite",
  "*.sqlite-*",
  "*.db",
  "*.log",
  "*.zip",
  "*.tsbuildinfo"
)

robocopy $Root $Destination /E /XD $excludeDirs /XF $excludeFiles /R:2 /W:2 /NFL /NDL /NP | Out-Host
$code = $LASTEXITCODE
if ($code -gt 7) {
  throw "robocopy failed with exit code $code"
}

$manifest = [ordered]@{
  schemaVersion = 1
  versionName = $VersionName
  createdAt = (Get-Date).ToString("o")
  sourceRoot = $Root
  destination = $Destination
  robocopyExitCode = $code
  excludedDirectories = $excludeDirs
  excludedFiles = $excludeFiles
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $Destination "backup-manifest.json") -Encoding UTF8

Write-Host "Backup created: $Destination"
Write-Host "robocopy exit code: $code"
