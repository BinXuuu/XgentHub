param(
  [string]$OutputDir,
  [string]$Name,
  [string]$MakensisPath,
  [switch]$SkipReleaseCheck
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root "backups" }
if (-not $Name) { $Name = "XgentHub-setup-nsis-$(Get-Date -Format 'yyyyMMdd-HHmm')" }

$NsisScript = Join-Path $Root "installer\nsis\AgentHub.nsi"
$AppIcon = Join-Path $Root "desktop\assets\xgent-hub.ico"
$ReleaseName = "$Name-release"
$ReleaseZip = Join-Path $OutputDir "$ReleaseName.zip"
$ReleaseReport = Join-Path $OutputDir "$ReleaseName.release-check.json"
$ExePath = Join-Path $OutputDir "$Name.exe"
$LogPath = Join-Path $OutputDir "$Name.nsis.log"
$ReportPath = Join-Path $OutputDir "$Name.nsis-build.json"
$CommandPath = Join-Path $OutputDir "$Name.nsis-command.ps1"

function Resolve-Makensis {
  param([string]$Value)
  if ($Value) {
    if (-not (Test-Path $Value)) { throw "makensis.exe was not found: $Value" }
    return (Resolve-Path -LiteralPath $Value).Path
  }

  $cmd = Get-Command "makensis.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }

  foreach ($candidate in @(
    "$env:ProgramFiles\NSIS\makensis.exe",
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
  )) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Get-Sha256OrNull {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
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
  if (-not (Test-Path $NsisScript)) { throw "Missing NSIS script: $NsisScript" }

  if (-not $SkipReleaseCheck) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\release-check.ps1") -OutputDir $OutputDir -Name $ReleaseName
    if ($LASTEXITCODE -ne 0) { throw "release-check failed with exit code $LASTEXITCODE" }
  }

  if (-not (Test-Path $ReleaseZip)) { throw "Missing release zip: $ReleaseZip" }
  if (-not (Test-Path $ReleaseReport)) { throw "Missing release-check report: $ReleaseReport" }

  $makensis = Resolve-Makensis -Value $MakensisPath
  $nsisArgs = @(
    "/DOUTPUT_EXE=$ExePath",
    "/DRELEASE_ZIP=$ReleaseZip",
    "/DRELEASE_REPORT=$ReleaseReport",
    "/DAPP_ICON=$AppIcon",
    $NsisScript
  )

  $manual = @"
`$makensis = "C:\Program Files (x86)\NSIS\makensis.exe"
& `$makensis "/DOUTPUT_EXE=$ExePath" "/DRELEASE_ZIP=$ReleaseZip" "/DRELEASE_REPORT=$ReleaseReport" "/DAPP_ICON=$AppIcon" "$NsisScript"
"@
  Set-Content -Path $CommandPath -Value $manual -Encoding UTF8

  $compiled = $false
  if ($makensis) {
    if (Test-Path $ExePath) { Remove-Item -LiteralPath $ExePath -Force }
    & $makensis @nsisArgs *> $LogPath
    if ($LASTEXITCODE -ne 0) {
      throw "makensis failed with exit code $LASTEXITCODE. Log: $LogPath"
    }
    if (-not (Test-Path $ExePath)) {
      throw "makensis completed but did not create: $ExePath"
    }
    $compiled = $true
    Write-Host "NSIS installer created: $ExePath"
  } else {
    "makensis.exe was not found. Install NSIS and run $CommandPath to compile the GUI installer." | Set-Content -Path $LogPath -Encoding UTF8
    Write-Host "NSIS script prepared, but makensis.exe was not found."
    Write-Host "Manual compile command: $CommandPath"
  }

  $report = [ordered]@{
    ok = $true
    builtAt = (Get-Date).ToString("o")
    compiled = $compiled
    makensisPath = $makensis
    nsisScript = $NsisScript
    releaseZip = $ReleaseZip
    releaseReport = $ReleaseReport
    exePath = if ($compiled) { $ExePath } else { $null }
    commandPath = $CommandPath
    logPath = $LogPath
    sha256 = [ordered]@{
      releaseZip = Get-Sha256OrNull -Path $ReleaseZip
      releaseReport = Get-Sha256OrNull -Path $ReleaseReport
      exe = Get-Sha256OrNull -Path $ExePath
    }
  }
  $report | ConvertTo-Json -Depth 10 | Set-Content -Path $ReportPath -Encoding UTF8
  Write-Host "NSIS build report: $ReportPath"
} finally {
  Pop-Location
}
