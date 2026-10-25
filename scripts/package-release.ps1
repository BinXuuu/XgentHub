param(
  [string]$OutputDir,
  [string]$Name,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root "backups" }
if (-not $Name) { $Name = "XgentHub-release-$(Get-Date -Format 'yyyyMMdd-HHmm')" }

$StageRoot = Join-Path $OutputDir ".package-stage-$Name"
$StageDir = Join-Path $StageRoot $Name
$ZipPath = Join-Path $OutputDir "$Name.zip"

function Assert-SafeGeneratedPath {
  param([string]$Path)
  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside output directory: $resolvedPath"
  }
}

Push-Location $Root
try {
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  if (-not $SkipBuild) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  }

  foreach ($path in @($StageRoot, $ZipPath)) {
    Assert-SafeGeneratedPath -Path $path
    if (Test-Path $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

  $progressFileName = [string]::Concat([char]0x9879, [char]0x76ee, [char]0x8fdb, [char]0x5ea6, ".txt")
  # server\data holds this machine's runtime data: database, MCP tokens, custom agent API keys,
  # undo snapshot repos (copies of workspace code), usage caches. Never ship it; install.bat recreates defaults.
  $excludeDirs = @("node_modules", "logs", "backups", ".git", ".github", "XgentHub-opensource", "attachments", "docs", "installer", ".codex-runtime", (Join-Path $Root "server\data"))
  $excludeFiles = @(
    ".env",
    ".env.bak",
    ".env.*.tmp",
    ".env.corrupt-*",
    "*.sqlite",
    "*.sqlite-*",
    "*.db",
    "*.log",
    "*.tsbuildinfo",
    ".gitignore",
    $progressFileName,
    "INSTALLER.md",
    "build-installer.ps1",
    "build-nsis-installer.ps1",
    "package-release.ps1",
    "release-check.ps1",
    "test-install-package.ps1",
    "test-nsis-installer.ps1",
    "backup-version.ps1"
  )
  robocopy $Root $StageDir /E /XD $excludeDirs /XF $excludeFiles /R:2 /W:2 /NFL /NDL /NP | Out-Host
  $code = $LASTEXITCODE
  if ($code -gt 7) { throw "robocopy failed with exit code $code" }

  foreach ($relativePath in @("desktop\README.md")) {
    $target = Join-Path $StageDir $relativePath
    if (Test-Path $target) {
      Remove-Item -LiteralPath $target -Force
    }
  }

$installDoc = @"
# Xgent Hub install package

1. Install Node.js 22.13+.
2. Extract this folder to the target path.
3. Run install.bat.
4. Run start-app.bat to open the desktop app shell, or run xgent.bat start for browser-only mode.
5. Open http://127.0.0.1:4180/?view=onboarding&step=machine to run machine discovery if you are using browser-only mode, or use the port configured by .env PORT.

Daily controls:
- start-app.bat opens the Xgent Hub desktop app shell and starts the local service when needed.
- xgent.bat start | stop | restart | status | logs | doctor manages the background service.
- xgent.bat shortcuts install creates desktop and Start Menu shortcuts.
- xgent.bat autostart on | off starts Xgent Hub when you log in (off removes only tasks of this install folder).
- Run xgent.bat help for all commands.

Config migration:
- xgent.bat export-config creates a redacted config bundle.
- xgent.bat import-config -BundlePath <bundle> restores a config bundle and backs up overwritten local files first.
- For personal migration with secrets, run:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-config.ps1 -IncludeSecrets -Zip
- On the target machine, run:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/import-config.ps1 -BundlePath <bundle> -RestoreSecrets

Post-install actions:
- powershell -File scripts\installer-entry.ps1 doctor
- powershell -File scripts\installer-entry.ps1 start-app
- powershell -File scripts\installer-entry.ps1 status-prod
- powershell -File scripts\installer-entry.ps1 start-prod-config
- powershell -File scripts\installer-entry.ps1 restart-prod
- powershell -File scripts\installer-entry.ps1 open-logs
- powershell -File scripts\installer-entry.ps1 open-backups
- Open http://127.0.0.1:4180/?view=onboarding&step=finish to copy local/LAN access URLs and review security warnings. If .env PORT is changed, use that port instead.
"@
  Set-Content -Path (Join-Path $StageDir "INSTALL.md") -Value $installDoc -Encoding UTF8

  Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath -Force
  Write-Host "Release package created: $ZipPath"
} finally {
  Pop-Location
  if (Test-Path $StageRoot) {
    Assert-SafeGeneratedPath -Path $StageRoot
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
  }
}
