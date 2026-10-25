param(
  [string]$OutputDir,
  [string]$Name,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root "backups" }
if (-not $Name) { $Name = "XgentHub-release-check-$(Get-Date -Format 'yyyyMMdd-HHmm')" }

$ZipPath = Join-Path $OutputDir "$Name.zip"

function Assert-ZipDoesNotContain {
  param([string[]]$Entries, [scriptblock]$Predicate, [string]$Label)
  $matches = @($Entries | Where-Object $Predicate)
  if ($matches.Count -gt 0) {
    throw "Release zip contains forbidden $Label`: $($matches -join ', ')"
  }
}

function Assert-ZipContains {
  param([string[]]$Entries, [string]$Path)
  if (-not ($Entries -contains $Path)) {
    throw "Release zip missing required file: $Path"
  }
}

Push-Location $Root
try {
  if (-not $SkipBuild) {
    Write-Host "[release-check] Running npm run build..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  }

  Write-Host "[release-check] Running doctor..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\doctor.ps1")
  if ($LASTEXITCODE -ne 0) { throw "doctor failed with exit code $LASTEXITCODE" }

  Write-Host "[release-check] Creating release package..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\package-release.ps1") -OutputDir $OutputDir -Name $Name -SkipBuild
  if ($LASTEXITCODE -ne 0) { throw "package-release failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path $ZipPath)) { throw "Release zip was not created: $ZipPath" }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName -replace "\\", "/" })
  } finally {
    $archive.Dispose()
  }

  Assert-ZipDoesNotContain $entries { $_ -eq ".env" -or $_ -like "*/.env" } ".env"
  Assert-ZipDoesNotContain $entries { $_ -like "node_modules/*" -or $_ -like "*/node_modules/*" } "node_modules"
  Assert-ZipDoesNotContain $entries { $_ -like "logs/*" -or $_ -like "*/logs/*" } "logs"
  Assert-ZipDoesNotContain $entries { $_ -like "backups/*" -or $_ -like "*/backups/*" } "backups"
  Assert-ZipDoesNotContain $entries { $_ -like "*.sqlite*" -or $_ -like "*.db" } "database files"
  Assert-ZipDoesNotContain $entries { $_ -like "*.log" } "log files"
  Assert-ZipDoesNotContain $entries { $_ -like ".git/*" -or $_ -like "*/.git/*" } ".git"
  Assert-ZipDoesNotContain $entries { $_ -like "server/data/attachments/*" -or $_ -like "*/server/data/attachments/*" } "attachments"
  Assert-ZipDoesNotContain $entries { $_ -like "server/data/*" -or $_ -like "*/server/data/*" } "server/data (MCP tokens, API keys, snapshots)"
  Assert-ZipDoesNotContain $entries { $_ -like ".codex-runtime/*" -or $_ -like "*/.codex-runtime/*" } ".codex-runtime"
  Assert-ZipDoesNotContain $entries { $_ -like "XgentHub-opensource/*" -or $_ -like "*/XgentHub-opensource/*" } "open-source export copy"
  $progressFileName = [string]::Concat([char]0x9879, [char]0x76ee, [char]0x8fdb, [char]0x5ea6, ".txt")
  Assert-ZipDoesNotContain $entries { (Split-Path $_ -Leaf) -eq $progressFileName } "development progress log"
  Assert-ZipDoesNotContain $entries { $_ -like "docs/*" -or $_ -like "*/docs/*" } "development docs"
  Assert-ZipDoesNotContain $entries { $_ -like "installer/*" -or $_ -like "*/installer/*" } "installer source"
  Assert-ZipDoesNotContain $entries {
    $_ -match '(^|/)(build-installer|build-nsis-installer|package-release|release-check|test-install-package|test-nsis-installer|backup-version)\.(bat|ps1)$'
  } "development scripts"

  $requiredFiles = @(
    "package.json",
    "package-lock.json",
    "README.md",
    "INSTALL.md",
    ".env.example",
    "install.bat",
    "xgent.bat",
    "scripts/windows/xgent.ps1",
    "scripts/windows/start-app.vbs",
    "scripts/windows/start-on-login.vbs",
    "scripts/windows/start-on-login.ps1",
    "scripts/windows/install-startup-task.ps1",
    "scripts/windows/uninstall-startup-task.ps1",
    "scripts/windows/repair-launchers.ps1",
    "start-app.bat",
    "scripts/agenthub.ps1",
    "scripts/doctor.ps1",
    "scripts/update-agenthub.ps1",
    "CHANGELOG.md",
    "scripts/install-agenthub.ps1",
    "scripts/export-config.ps1",
    "scripts/import-config.ps1",
    "scripts/installer-entry.ps1",
    "scripts/manage-shortcuts.ps1",
    "scripts/uninstall-cleanup.ps1",
    "desktop/main.cjs",
    "web/dist/index.html"
  )

  foreach ($required in $requiredFiles) {
    Assert-ZipContains $entries $required
  }

  $report = [ordered]@{
    ok = $true
    checkedAt = (Get-Date).ToString("o")
    zipPath = $ZipPath
    entryCount = $entries.Count
    requiredFilesChecked = $requiredFiles.Count
    forbiddenPatternsChecked = 13
  }
  $reportPath = Join-Path $OutputDir "$Name.release-check.json"
  $report | ConvertTo-Json -Depth 10 | Set-Content -Path $reportPath -Encoding UTF8
  Write-Host "[release-check] Release package passed checks: $ZipPath"
  Write-Host "[release-check] Report: $reportPath"
} finally {
  Pop-Location
}
