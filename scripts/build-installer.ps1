param(
  [string]$OutputDir,
  [string]$Name,
  [switch]$SkipReleaseCheck
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root "backups" }
if (-not $Name) { $Name = "XgentHub-installer-$(Get-Date -Format 'yyyyMMdd-HHmm')" }

$ReleaseName = "$Name-release"
$ReleaseZip = Join-Path $OutputDir "$ReleaseName.zip"
$ReleaseReport = Join-Path $OutputDir "$ReleaseName.release-check.json"
$StageRoot = Join-Path $OutputDir ".installer-stage-$Name"
$StageDir = Join-Path $StageRoot $Name
$InstallerZip = Join-Path $OutputDir "$Name.zip"
$ManifestPath = Join-Path $StageDir "installer-manifest.json"
$ShaPath = Join-Path $StageDir "SHA256SUMS.txt"

function Assert-SafeGeneratedPath {
  param([string]$Path)
  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside output directory: $resolvedPath"
  }
}

function Get-Sha256 {
  param([string]$Path)
  $cmd = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($cmd) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  }
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($stream)
    return -join ($hash | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

Push-Location $Root
try {
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  if (-not $SkipReleaseCheck) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\release-check.ps1") -OutputDir $OutputDir -Name $ReleaseName
    if ($LASTEXITCODE -ne 0) { throw "release-check failed with exit code $LASTEXITCODE" }
  }

  if (-not (Test-Path $ReleaseZip)) { throw "Missing release zip: $ReleaseZip" }
  if (-not (Test-Path $ReleaseReport)) { throw "Missing release-check report: $ReleaseReport" }

  foreach ($path in @($StageRoot, $InstallerZip)) {
    Assert-SafeGeneratedPath -Path $path
    if (Test-Path $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }

  New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

  $releaseLeaf = Split-Path -Leaf $ReleaseZip
  $reportLeaf = Split-Path -Leaf $ReleaseReport
  Copy-Item -LiteralPath $ReleaseZip -Destination (Join-Path $StageDir $releaseLeaf) -Force
  Copy-Item -LiteralPath $ReleaseReport -Destination (Join-Path $StageDir $reportLeaf) -Force

  $quickstart = @"
# Xgent Hub quick start

1. Install Node.js 22.13+.
2. Extract `$releaseLeaf` to the final Xgent Hub folder.
3. Run install.bat in that folder.
4. Optional before installing on another machine: run npm run installer:smoke against this installer zip from a development checkout.
5. Optional: run xgent.bat shortcuts install.
6. Run start-app.bat to open the desktop app shell, or run xgent.bat start for browser-only mode.
7. Open http://127.0.0.1:4180/?view=onboarding&step=machine to run machine discovery if you are using browser-only mode, or use the port configured by .env PORT.

Use xgent.bat doctor when an agent or local model service is not detected.
Use npm run installer:smoke -- -RunInstall -RunService from a development checkout to verify a temporary install can start, report status, pass doctor, and stop cleanly.
Use npm run installer:nsis:smoke from a development checkout after building the NSIS prototype to verify silent install/uninstall behavior.
Use the configuration center finish step to copy LAN/mobile access URLs after ADMIN_TOKEN and HOST are configured.
Future NSIS/MSI wrappers should call scripts\installer-entry.ps1 for fixed install actions.
To build the NSIS prototype, run npm run installer:nsis after installing NSIS.
"@
  Set-Content -Path (Join-Path $StageDir "QUICKSTART.md") -Value $quickstart -Encoding UTF8

  $installerNotes = Join-Path $Root "docs\installer.md"
  if (Test-Path $installerNotes) {
    Copy-Item -LiteralPath $installerNotes -Destination (Join-Path $StageDir "INSTALLER-ROUTE.md") -Force
  }

  $releaseHash = Get-Sha256 -Path (Join-Path $StageDir $releaseLeaf)
  $reportHash = Get-Sha256 -Path (Join-Path $StageDir $reportLeaf)
  @(
    "$releaseHash  $releaseLeaf",
    "$reportHash  $reportLeaf"
  ) | Set-Content -Path $ShaPath -Encoding ASCII

  $manifest = [ordered]@{
    ok = $true
    route = "zip-first"
    builtAt = (Get-Date).ToString("o")
    installerName = $Name
    releaseZip = $releaseLeaf
    releaseCheckReport = $reportLeaf
    sha256 = [ordered]@{
      releaseZip = $releaseHash
      releaseCheckReport = $reportHash
    }
    nextPackagingOptions = @("NSIS wizard prototype", "WiX MSI", "Electron bundled app")
  }
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -Path $ManifestPath -Encoding UTF8

  Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $InstallerZip -Force
  $installerHash = Get-Sha256 -Path $InstallerZip
  Write-Host "Installer bundle created: $InstallerZip"
  Write-Host "SHA256: $installerHash"
} finally {
  Pop-Location
  if (Test-Path $StageRoot) {
    Assert-SafeGeneratedPath -Path $StageRoot
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
  }
}
