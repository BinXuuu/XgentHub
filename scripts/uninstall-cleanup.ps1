param(
  [Parameter(Mandatory = $true)]
  [string]$Root,

  [ValidateSet("keep-data", "full")]
  [string]$Mode = "keep-data"
)

$ErrorActionPreference = "Stop"

$ResolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
if (-not (Test-Path -LiteralPath $ResolvedRoot)) {
  Write-Host "Install root is already gone: $ResolvedRoot"
  exit 0
}

$allowedBase = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Programs")).TrimEnd("\")
$scriptInstallRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd("\")
$scriptBackupsRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptInstallRoot "backups")).TrimEnd("\")
$isAllowedRoot =
  $ResolvedRoot.StartsWith($allowedBase, [System.StringComparison]::OrdinalIgnoreCase) -or
  $ResolvedRoot.Equals($scriptInstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
  $ResolvedRoot.StartsWith($scriptBackupsRoot, [System.StringComparison]::OrdinalIgnoreCase)

if (-not $isAllowedRoot) {
  throw "Refusing to clean unexpected install root: $ResolvedRoot"
}

function Test-IsCurrentProcessTree {
  param([int]$ProcessId)

  $current = $PID
  for ($depth = 0; $depth -lt 10 -and $current; $depth++) {
    if ($ProcessId -eq $current) { return $true }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.ParentProcessId -or $process.ParentProcessId -eq $current) {
      return $false
    }
    $current = [int]$process.ParentProcessId
  }

  return $false
}

function Get-XgentHubProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $exe = $_.ExecutablePath
    $cmd = $_.CommandLine
    (($exe -and $exe.StartsWith($ResolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
      ($cmd -and $cmd.IndexOf($ResolvedRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) -and
      -not (Test-IsCurrentProcessTree -ProcessId ([int]$_.ProcessId))
  }
}

function Stop-XgentHubProcesses {
  for ($round = 0; $round -lt 3; $round++) {
    $targets = @(Get-XgentHubProcesses | Sort-Object ProcessId -Unique)
    if ($targets.Count -eq 0) { return }

    foreach ($target in $targets) {
      Write-Host "Stopping process $($target.ProcessId) $($target.Name)"
      & cmd.exe /d /s /c "taskkill.exe /F /T /PID $($target.ProcessId) >NUL 2>NUL"
    }
    Start-Sleep -Milliseconds 700
  }
}

function Move-IfExists {
  param([string]$RelativePath, [string]$PreserveRoot)
  $source = Join-Path $ResolvedRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) { return }
  $destination = Join-Path $PreserveRoot $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
  Move-Item -LiteralPath $source -Destination $destination -Force
}

function Restore-IfExists {
  param([string]$RelativePath, [string]$PreserveRoot)
  $source = Join-Path $PreserveRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) { return }
  $destination = Join-Path $ResolvedRoot $RelativePath
  New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
  Move-Item -LiteralPath $source -Destination $destination -Force
}

function Remove-ProgramFiles {
  param([string[]]$KeepNames)

  for ($round = 0; $round -lt 3; $round++) {
    $items = @(Get-ChildItem -LiteralPath $ResolvedRoot -Force -ErrorAction SilentlyContinue | Where-Object {
      $KeepNames -notcontains $_.Name
    })
    if ($items.Count -eq 0) { return }

    foreach ($item in $items) {
      Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 700
  }
}

Stop-XgentHubProcesses

if ($Mode -eq "full") {
  Remove-ProgramFiles -KeepNames @("Uninstall.exe")
  if (-not (Test-Path -LiteralPath (Join-Path $ResolvedRoot "Uninstall.exe"))) {
    Remove-Item -LiteralPath $ResolvedRoot -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

$preserveRoot = Join-Path $env:TEMP ("xgenthub-uninstall-preserve-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $preserveRoot | Out-Null

try {
  foreach ($relativePath in @(".env", "server\data", "logs", "backups")) {
    Move-IfExists -RelativePath $relativePath -PreserveRoot $preserveRoot
  }

  Remove-ProgramFiles -KeepNames @("Uninstall.exe")

  foreach ($relativePath in @(".env", "server\data", "logs", "backups")) {
    Restore-IfExists -RelativePath $relativePath -PreserveRoot $preserveRoot
  }
} finally {
  Remove-Item -LiteralPath $preserveRoot -Recurse -Force -ErrorAction SilentlyContinue
}
