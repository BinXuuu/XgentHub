param(
  [string]$InstallerZip,
  [string]$ReleaseZip,
  [string]$OutputDir,
  [switch]$RunInstall,
  [switch]$RunService,
  [int]$ServicePort = 4291,
  [switch]$KeepStage
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root "backups" }

function Write-Step {
  param([string]$Message)
  Write-Host "[install-smoke] $Message"
}

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

function Add-Check {
  param(
    [System.Collections.ArrayList]$Checks,
    [string]$Status,
    [string]$Name,
    [string]$Detail
  )
  [void]$Checks.Add([ordered]@{
    status = $Status
    name = $Name
    detail = $Detail
  })
  $prefix = if ($Status -eq "pass") { "[PASS]" } elseif ($Status -eq "warn") { "[WARN]" } else { "[FAIL]" }
  Write-Host "$prefix $Name - $Detail"
}

function Get-LatestInstallerZip {
  $candidate = @("XgentHub-installer-*.zip", "AgentHub-installer-*.zip") |
    ForEach-Object { Get-ChildItem -LiteralPath $OutputDir -Filter $_ -File -ErrorAction SilentlyContinue } |
    Where-Object { $_.Name -notlike "*-release.zip" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $candidate) { throw "No XgentHub-installer-*.zip or AgentHub-installer-*.zip found under $OutputDir. Pass -InstallerZip or build an installer first." }
  return $candidate.FullName
}

function Test-HashFile {
  param(
    [string]$HashFile,
    [string]$BaseDir,
    [System.Collections.ArrayList]$Checks
  )
  if (-not (Test-Path $HashFile)) {
    Add-Check $Checks "warn" "SHA256SUMS.txt" "Not present; skipping installer hash check."
    return
  }
  foreach ($line in Get-Content -LiteralPath $HashFile) {
    if ($line -notmatch "^\s*([a-fA-F0-9]{64})\s+(.+?)\s*$") { continue }
    $expected = $matches[1].ToLowerInvariant()
    $leaf = $matches[2].Trim()
    $target = Join-Path $BaseDir $leaf
    if (-not (Test-Path $target)) {
      Add-Check $Checks "fail" "Hash target $leaf" "Missing"
      continue
    }
    $actual = Get-Sha256 $target
    if ($actual -eq $expected) {
      Add-Check $Checks "pass" "Hash target $leaf" $actual
    } else {
      Add-Check $Checks "fail" "Hash target $leaf" "Expected $expected but got $actual"
    }
  }
}

function Set-DotEnvValue {
  param(
    [string]$EnvPath,
    [string]$Key,
    [string]$Value
  )
  $lines = @()
  if (Test-Path $EnvPath) {
    $lines = @(Get-Content -LiteralPath $EnvPath -Encoding UTF8)
  }
  $found = $false
  $updated = foreach ($line in $lines) {
    if ($line -match "^\s*$([regex]::Escape($Key))=") {
      $found = $true
      "$Key=$Value"
    } else {
      $line
    }
  }
  if (-not $found) {
    $updated += "$Key=$Value"
  }
  [System.IO.File]::WriteAllLines($EnvPath, [string[]]$updated, (New-Object System.Text.UTF8Encoding $false))
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

function Invoke-SmokeScript {
  param(
    [string]$InstallRoot,
    [string[]]$Arguments
  )
  $output = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot "scripts\agenthub.ps1") @Arguments 2>&1
  $code = $LASTEXITCODE
  foreach ($line in $output) {
    Write-Host $line
  }
  return $code
}

function Find-InstallRoot {
  param([string]$ExpandedDir)
  $direct = Join-Path $ExpandedDir "install.bat"
  if (Test-Path $direct) { return $ExpandedDir }
  $candidate = Get-ChildItem -LiteralPath $ExpandedDir -Filter "install.bat" -Recurse -File | Select-Object -First 1
  if (-not $candidate) { throw "install.bat was not found after extracting release zip." }
  return $candidate.Directory.FullName
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$StageRoot = Join-Path $OutputDir ".install-smoke-$stamp"
$ReportPath = Join-Path $OutputDir "XgentHub-install-smoke-$stamp.json"
$checks = New-Object System.Collections.ArrayList
$ok = $true

Assert-SafeGeneratedPath $StageRoot
Assert-SafeGeneratedPath $ReportPath

if ($RunService -and -not $RunInstall) {
  throw "-RunService requires -RunInstall because the temporary install folder needs node_modules first."
}

try {
  if (-not $InstallerZip -and -not $ReleaseZip) {
    $InstallerZip = Get-LatestInstallerZip
  }

  New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null

  if ($InstallerZip) {
    $InstallerZip = [System.IO.Path]::GetFullPath($InstallerZip)
    if (-not (Test-Path $InstallerZip)) { throw "Installer zip not found: $InstallerZip" }
    Add-Check $checks "pass" "Installer zip" $InstallerZip

    $installerDir = Join-Path $StageRoot "installer"
    Expand-Archive -LiteralPath $InstallerZip -DestinationPath $installerDir -Force

    $manifestPath = Join-Path $installerDir "installer-manifest.json"
    if (Test-Path $manifestPath) {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      Add-Check $checks "pass" "Installer manifest" "route=$($manifest.route), builtAt=$($manifest.builtAt)"
    } else {
      Add-Check $checks "fail" "Installer manifest" "Missing installer-manifest.json"
    }

    Test-HashFile -HashFile (Join-Path $installerDir "SHA256SUMS.txt") -BaseDir $installerDir -Checks $checks

    $releaseCandidate = Get-ChildItem -LiteralPath $installerDir -Filter "*.zip" -File |
      Where-Object { $_.Name -like "*-release.zip" } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if (-not $releaseCandidate) { throw "No *-release.zip found inside installer bundle." }
    $ReleaseZip = $releaseCandidate.FullName
  }

  $ReleaseZip = [System.IO.Path]::GetFullPath($ReleaseZip)
  if (-not (Test-Path $ReleaseZip)) { throw "Release zip not found: $ReleaseZip" }
  Add-Check $checks "pass" "Release zip" $ReleaseZip

  $installDir = Join-Path $StageRoot "install"
  Expand-Archive -LiteralPath $ReleaseZip -DestinationPath $installDir -Force
  $installRoot = Find-InstallRoot -ExpandedDir $installDir
  Add-Check $checks "pass" "Expanded install root" $installRoot

  foreach ($file in @(
    "install.bat",
    "xgent.bat",
    "start-app.bat",
    "scripts\windows\start-app.vbs",
    "scripts\windows\uninstall-startup-task.ps1",
    "README.md",
    "INSTALL.md",
    ".env.example",
    "package.json",
    "server\package.json",
    "web\package.json",
    "web\dist\index.html",
    "scripts\agenthub.ps1",
    "scripts\install-agenthub.ps1",
    "scripts\installer-entry.ps1",
    "scripts\doctor.ps1",
    "scripts\manage-shortcuts.ps1",
    "scripts\uninstall-cleanup.ps1",
    "desktop\main.cjs"
  )) {
    $path = Join-Path $installRoot $file
    if (Test-Path $path) {
      Add-Check $checks "pass" "Release file $file" $path
    } else {
      Add-Check $checks "fail" "Release file $file" "Missing"
    }
  }

  foreach ($privatePath in @(
    ".env",
    "node_modules",
    "logs",
    "backups",
    "server\data\agenthub.sqlite",
    "docs",
    "installer",
    "INSTALLER.md",
    "$([string]::Concat([char]0x9879, [char]0x76ee, [char]0x8fdb, [char]0x5ea6, '.txt'))",
    "scripts\build-installer.ps1",
    "scripts\build-nsis-installer.ps1",
    "scripts\package-release.ps1",
    "scripts\release-check.ps1",
    "scripts\test-install-package.ps1",
    "scripts\test-nsis-installer.ps1",
    "scripts\backup-version.ps1"
  )) {
    $path = Join-Path $installRoot $privatePath
    if (Test-Path $path) {
      Add-Check $checks "fail" "Private file excluded $privatePath" "Unexpectedly present"
    } else {
      Add-Check $checks "pass" "Private file excluded $privatePath" "Not present"
    }
  }

  if ($RunInstall) {
    Write-Step "Running full install.bat inside smoke install root. This may take a while."
    Push-Location $installRoot
    try {
      & cmd.exe /C "`"$installRoot\install.bat`""
      if ($LASTEXITCODE -ne 0) { throw "install.bat failed with exit code $LASTEXITCODE" }
      Add-Check $checks "pass" "Full install.bat" "Exit code 0"
    } finally {
      Pop-Location
    }
  } else {
    Add-Check $checks "warn" "Full install.bat" "Skipped. Pass -RunInstall to run npm install/build/doctor in the smoke install folder."
  }

  if ($RunService) {
    $envPath = Join-Path $installRoot ".env"
    if (-not (Test-Path $envPath)) {
      Add-Check $checks "fail" "Smoke service .env" "Missing after install.bat"
    } else {
      Set-DotEnvValue -EnvPath $envPath -Key "HOST" -Value "127.0.0.1"
      Set-DotEnvValue -EnvPath $envPath -Key "PORT" -Value ([string]$ServicePort)
      Set-DotEnvValue -EnvPath $envPath -Key "LOG_LEVEL" -Value "warn"
      Add-Check $checks "pass" "Smoke service .env" "HOST=127.0.0.1, PORT=$ServicePort"

      $healthUrl = "http://127.0.0.1:$ServicePort/api/health"
      Write-Step "Starting smoke service on $healthUrl"
      try {
        $startCode = Invoke-SmokeScript -InstallRoot $installRoot -Arguments @("start", "-Mode", "prod", "-BackendPort", ([string]$ServicePort))
        if ($startCode -eq 0) {
          Add-Check $checks "pass" "Smoke service start" "Exit code 0"
        } else {
          Add-Check $checks "fail" "Smoke service start" "Exit code $startCode"
        }

        if (Wait-HttpOk -Url $healthUrl -Seconds 60) {
          Add-Check $checks "pass" "Smoke service health" $healthUrl
        } else {
          Add-Check $checks "fail" "Smoke service health" "Not responding: $healthUrl"
        }

        $statusCode = Invoke-SmokeScript -InstallRoot $installRoot -Arguments @("status", "-Mode", "prod", "-BackendPort", ([string]$ServicePort))
        if ($statusCode -eq 0) {
          Add-Check $checks "pass" "Smoke service status" "Exit code 0"
        } else {
          Add-Check $checks "fail" "Smoke service status" "Exit code $statusCode"
        }

        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installRoot "scripts\doctor.ps1")
        if ($LASTEXITCODE -eq 0) {
          Add-Check $checks "pass" "Smoke service doctor" "Exit code 0"
        } else {
          Add-Check $checks "fail" "Smoke service doctor" "Exit code $LASTEXITCODE"
        }

        $electronCmd = Join-Path $installRoot "node_modules\.bin\electron.cmd"
        $desktopMain = Join-Path $installRoot "desktop\main.cjs"
        if ((Test-Path $electronCmd) -and (Test-Path $desktopMain)) {
          Write-Step "Running desktop shell smoke test."
          $oldXgentHubRoot = $env:XGENT_HUB_ROOT
          $env:XGENT_HUB_ROOT = $installRoot
          try {
            & $electronCmd $desktopMain --smoke
            if ($LASTEXITCODE -eq 0) {
              Add-Check $checks "pass" "Desktop shell smoke" "Exit code 0"
            } else {
              Add-Check $checks "fail" "Desktop shell smoke" "Exit code $LASTEXITCODE"
            }
          } finally {
            if ($null -eq $oldXgentHubRoot) {
              Remove-Item Env:\XGENT_HUB_ROOT -ErrorAction SilentlyContinue
            } else {
              $env:XGENT_HUB_ROOT = $oldXgentHubRoot
            }
          }
        } else {
          Add-Check $checks "fail" "Desktop shell smoke" "Missing electron launcher or desktop/main.cjs"
        }
      } finally {
        $stopCode = Invoke-SmokeScript -InstallRoot $installRoot -Arguments @("stop", "-Mode", "prod", "-BackendPort", ([string]$ServicePort))
        if ($stopCode -eq 0) {
          Add-Check $checks "pass" "Smoke service stop" "Exit code 0"
        } else {
          Add-Check $checks "warn" "Smoke service stop" "Exit code $stopCode"
        }
        if (Test-HttpOk -Url $healthUrl -TimeoutSec 2) {
          Add-Check $checks "warn" "Smoke service cleanup" "Still responding after stop: $healthUrl"
        } else {
          Add-Check $checks "pass" "Smoke service cleanup" "Stopped: $healthUrl"
        }
      }
    }
  } else {
    Add-Check $checks "warn" "Smoke service start/status/doctor" "Skipped. Pass -RunInstall -RunService to start the temporary install on a test port."
  }

  $failures = @($checks | Where-Object { $_.status -eq "fail" })
  $ok = $failures.Count -eq 0
  $report = [ordered]@{
    ok = $ok
    testedAt = (Get-Date).ToString("o")
    installerZip = $InstallerZip
    releaseZip = $ReleaseZip
    stageRoot = $StageRoot
    runInstall = [bool]$RunInstall
    runService = [bool]$RunService
    servicePort = $ServicePort
    checks = $checks
  }
  $report | ConvertTo-Json -Depth 10 | Set-Content -Path $ReportPath -Encoding UTF8
  Write-Host "[install-smoke] Report: $ReportPath"
  if (-not $ok) { throw "Install package smoke test failed with $($failures.Count) failed checks." }
  Write-Host "[install-smoke] Install package smoke test passed."
} finally {
  if ((Test-Path $StageRoot) -and -not $KeepStage) {
    Assert-SafeGeneratedPath $StageRoot
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
  }
}
