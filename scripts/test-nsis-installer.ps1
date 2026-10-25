param(
  [string]$InstallerExe,
  [string]$OutputDir,
  [int]$ServicePort = 4292,
  [switch]$KeepStage
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDir) { $OutputDir = Join-Path $Root "backups" }

function Write-Step {
  param([string]$Message)
  Write-Host "[nsis-smoke] $Message"
}

function Assert-SafeGeneratedPath {
  param([string]$Path)
  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside output directory: $resolvedPath"
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

function Get-LatestInstallerExe {
  $candidate = Get-ChildItem -LiteralPath $OutputDir -Filter "XgentHub-setup-nsis-*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $candidate) { throw "No XgentHub-setup-nsis-*.exe found under $OutputDir. Pass -InstallerExe or build the NSIS installer first." }
  return $candidate.FullName
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

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$StageRoot = Join-Path $OutputDir ".nsis-smoke-$stamp"
$ReportPath = Join-Path $OutputDir "XgentHub-nsis-smoke-$stamp.json"
$checks = New-Object System.Collections.ArrayList
$ok = $true

Assert-SafeGeneratedPath $StageRoot
Assert-SafeGeneratedPath $ReportPath

try {
  if (-not $InstallerExe) {
    $InstallerExe = Get-LatestInstallerExe
  }
  $InstallerExe = [System.IO.Path]::GetFullPath($InstallerExe)
  if (-not (Test-Path $InstallerExe)) { throw "NSIS installer exe not found: $InstallerExe" }
  Add-Check $checks "pass" "NSIS installer exe" $InstallerExe

  if (Test-Path $StageRoot) {
    Assert-SafeGeneratedPath $StageRoot
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
  }

  Write-Step "Silent installing to $StageRoot"
  $install = Start-Process -FilePath $InstallerExe -ArgumentList @("/S", "/D=$StageRoot") -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -eq 0) {
    Add-Check $checks "pass" "NSIS silent install" "Exit code 0"
  } else {
    Add-Check $checks "fail" "NSIS silent install" "Exit code $($install.ExitCode)"
  }

  foreach ($required in @(
    "install.bat",
    "Uninstall.exe",
    ".env",
    "package.json",
    "node_modules",
    "start-app.bat",
    "xgent.bat",
    "scripts\windows\start-app.vbs",
    "desktop\main.cjs",
    "web\dist\index.html",
    "scripts\windows\uninstall-startup-task.ps1",
    "scripts\uninstall-cleanup.ps1"
  )) {
    $path = Join-Path $StageRoot $required
    if (Test-Path $path) {
      Add-Check $checks "pass" "Installed file $required" $path
    } else {
      Add-Check $checks "fail" "Installed file $required" "Missing"
    }
  }

  $envPath = Join-Path $StageRoot ".env"
  if (Test-Path $envPath) {
    Set-DotEnvValue -EnvPath $envPath -Key "HOST" -Value "127.0.0.1"
    Set-DotEnvValue -EnvPath $envPath -Key "PORT" -Value ([string]$ServicePort)
    Add-Check $checks "pass" "NSIS smoke .env" "HOST=127.0.0.1, PORT=$ServicePort"
  }

  $healthUrl = "http://127.0.0.1:$ServicePort/api/health"
  $agentHubScript = Join-Path $StageRoot "scripts\agenthub.ps1"
  if (Test-Path $agentHubScript) {
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $agentHubScript start -Mode prod -BackendPort $ServicePort
      if ($LASTEXITCODE -eq 0) {
        Add-Check $checks "pass" "NSIS smoke service start" "Exit code 0"
      } else {
        Add-Check $checks "fail" "NSIS smoke service start" "Exit code $LASTEXITCODE"
      }

      if (Test-HttpOk -Url $healthUrl -TimeoutSec 5) {
        Add-Check $checks "pass" "NSIS smoke service health" $healthUrl
      } else {
        Add-Check $checks "fail" "NSIS smoke service health" "Not responding: $healthUrl"
      }

      & powershell -NoProfile -ExecutionPolicy Bypass -File $agentHubScript status -Mode prod -BackendPort $ServicePort
      if ($LASTEXITCODE -eq 0) {
        Add-Check $checks "pass" "NSIS smoke service status" "Exit code 0"
      } else {
        Add-Check $checks "fail" "NSIS smoke service status" "Exit code $LASTEXITCODE"
      }

      $electronCmd = Join-Path $StageRoot "node_modules\.bin\electron.cmd"
      $desktopMain = Join-Path $StageRoot "desktop\main.cjs"
      if ((Test-Path $electronCmd) -and (Test-Path $desktopMain)) {
        Write-Step "Running desktop shell smoke test."
        $oldXgentHubRoot = $env:XGENT_HUB_ROOT
        $env:XGENT_HUB_ROOT = $StageRoot
        try {
          & $electronCmd $desktopMain --smoke
          if ($LASTEXITCODE -eq 0) {
            Add-Check $checks "pass" "NSIS desktop shell smoke" "Exit code 0"
          } else {
            Add-Check $checks "fail" "NSIS desktop shell smoke" "Exit code $LASTEXITCODE"
          }
        } finally {
          if ($null -eq $oldXgentHubRoot) {
            Remove-Item Env:\XGENT_HUB_ROOT -ErrorAction SilentlyContinue
          } else {
            $env:XGENT_HUB_ROOT = $oldXgentHubRoot
          }
        }
      } else {
        Add-Check $checks "fail" "NSIS desktop shell smoke" "Missing electron launcher or desktop/main.cjs"
      }

      if ((Test-Path $electronCmd) -and (Test-Path $desktopMain)) {
        Write-Step "Starting persistent desktop shell before uninstall cleanup test."
        $desktopProcess = Start-Process -FilePath $electronCmd -ArgumentList @($desktopMain, "--hold-smoke") -WorkingDirectory $StageRoot -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 3
        $runningDesktop = Get-Process -Id $desktopProcess.Id -ErrorAction SilentlyContinue
        if ($runningDesktop) {
          Add-Check $checks "pass" "Persistent desktop before uninstall" "PID $($desktopProcess.Id)"
        } else {
          Add-Check $checks "fail" "Persistent desktop before uninstall" "Electron process exited before uninstall"
        }
      }
    } finally {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $agentHubScript stop -Mode prod -BackendPort $ServicePort
      if (Test-HttpOk -Url $healthUrl -TimeoutSec 2) {
        Add-Check $checks "warn" "NSIS smoke service cleanup" "Still responding after stop: $healthUrl"
      } else {
        Add-Check $checks "pass" "NSIS smoke service cleanup" "Stopped: $healthUrl"
      }
    }
  }

  $remainingBeforeUninstall = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.CommandLine -and $_.CommandLine.IndexOf($StageRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
      ($_.ExecutablePath -and $_.ExecutablePath.IndexOf($StageRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
  if ($remainingBeforeUninstall.Count -gt 0) {
    Add-Check $checks "pass" "Owned processes before uninstall" "$($remainingBeforeUninstall.Count) process(es) will test cleanup"
  } else {
    Add-Check $checks "warn" "Owned processes before uninstall" "No persistent owned process remained before uninstall"
  }

  $uninstaller = Join-Path $StageRoot "Uninstall.exe"
  if (Test-Path $uninstaller) {
    Write-Step "Silent uninstalling from $StageRoot"
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -Wait -PassThru -WindowStyle Hidden
    if ($uninstall.ExitCode -eq 0) {
      Add-Check $checks "pass" "NSIS silent uninstall" "Exit code 0"
    } else {
      Add-Check $checks "fail" "NSIS silent uninstall" "Exit code $($uninstall.ExitCode)"
    }
  }

  foreach ($retained in @(".env", "server\data", "logs", "backups")) {
    $path = Join-Path $StageRoot $retained
    if (Test-Path $path) {
      Add-Check $checks "pass" "Retained after uninstall $retained" $path
    } else {
      Add-Check $checks "fail" "Retained after uninstall $retained" "Missing"
    }
  }

  foreach ($removed in @(
    "Uninstall.exe",
    "package.json",
    "package-lock.json",
    "install.bat",
    "xgent.bat",
    "desktop",
    "docs",
    "installer",
    "node_modules",
    "scripts",
    "web"
  )) {
    $path = Join-Path $StageRoot $removed
    if (Test-Path $path) {
      Add-Check $checks "fail" "Removed after uninstall $removed" "Still present: $path"
    } else {
      Add-Check $checks "pass" "Removed after uninstall $removed" "Removed"
    }
  }

  $remainingAfterUninstall = @(Get-CimInstance Win32_Process | Where-Object {
    ($_.CommandLine -and $_.CommandLine.IndexOf($StageRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
      ($_.ExecutablePath -and $_.ExecutablePath.IndexOf($StageRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
  if ($remainingAfterUninstall.Count -gt 0) {
    Add-Check $checks "fail" "Owned processes after uninstall" "$($remainingAfterUninstall.Count) process(es) still reference $StageRoot"
  } else {
    Add-Check $checks "pass" "Owned processes after uninstall" "None"
  }

  $failures = @($checks | Where-Object { $_.status -eq "fail" })
  $ok = $failures.Count -eq 0
  $report = [ordered]@{
    ok = $ok
    testedAt = (Get-Date).ToString("o")
    installerExe = $InstallerExe
    stageRoot = $StageRoot
    servicePort = $ServicePort
    checks = $checks
  }
  $report | ConvertTo-Json -Depth 10 | Set-Content -Path $ReportPath -Encoding UTF8
  Write-Step "Report: $ReportPath"
  if (-not $ok) { throw "NSIS smoke test failed with $($failures.Count) failed checks." }
  Write-Step "NSIS smoke test passed."
} finally {
  if ($ok -and (Test-Path $StageRoot) -and -not $KeepStage) {
    Assert-SafeGeneratedPath $StageRoot
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
  }
}
