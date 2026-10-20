param(
  # Called by the server: copy this script to TEMP and run it in a detached process, then return at once.
  # The update has to stop the server (taskkill /T on its process tree), so it must not be the server's child.
  [switch]$Launch,
  [string]$Root = "",
  [string]$Tag = "",
  [ValidateSet("archive", "git")]
  [string]$Mode = "archive",
  [string]$ArchiveUrl = "",
  [string]$FromVersion = "",
  [string]$ToVersion = ""
)

$ErrorActionPreference = "Stop"

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
$LogsDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$StatusFile = Join-Path $LogsDir "update-status.json"
$LogFile = Join-Path $LogsDir "update.log"
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-Status {
  param([string]$State, [string]$Step, [string]$ErrorText = "")
  $status = [ordered]@{
    state = $State
    step = $Step
    fromVersion = $FromVersion
    toVersion = $ToVersion
    tag = $Tag
    mode = $Mode
    updatedAt = (Get-Date).ToString("o")
    error = $ErrorText
    log = $LogFile
  }
  [System.IO.File]::WriteAllText($StatusFile, ($status | ConvertTo-Json), $Utf8NoBom)
}

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  [System.IO.File]::AppendAllText($LogFile, "$line`r`n", $Utf8NoBom)
}

function Quote-Arg {
  param([string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

if ($Launch) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $copy = Join-Path $env:TEMP "xgenthub-update-$stamp.ps1"
  Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force
  Write-Status "running" "queued"
  $argLine = "-NoProfile -ExecutionPolicy Bypass -File {0} -Root {1} -Tag {2} -Mode {3} -FromVersion {4} -ToVersion {5}" -f `
    (Quote-Arg $copy), (Quote-Arg $Root), (Quote-Arg $Tag), $Mode, (Quote-Arg $FromVersion), (Quote-Arg $ToVersion)
  if ($ArchiveUrl) { $argLine += " -ArchiveUrl " + (Quote-Arg $ArchiveUrl) }
  Start-Process -FilePath "powershell.exe" -ArgumentList $argLine -WorkingDirectory $env:TEMP -WindowStyle Hidden
  exit 0
}

function Read-Port {
  $port = 4180
  $envPath = Join-Path $Root ".env"
  if (Test-Path $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
      if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
    }
  }
  if ($env:PORT -match '^\d+$') { $port = [int]$env:PORT }
  return $port
}

function Test-Health {
  param([int]$Seconds)
  $url = "http://127.0.0.1:$(Read-Port)/api/health"
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($res.StatusCode -eq 200) { return $true }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

function Invoke-Logged {
  param([string]$Label, [scriptblock]$Block)
  # npm / git write progress and warnings to stderr; under "Stop" Windows PowerShell 5.1 would turn
  # the first stderr line into a terminating error. Success is judged by the exit code instead.
  $ErrorActionPreference = "Continue"
  Write-Log "> $Label"
  $output = & $Block 2>&1
  foreach ($item in @($output)) { if ($null -ne $item) { Write-Log ("  " + $item.ToString()) } }
  return $LASTEXITCODE
}

function Invoke-AgentHub {
  param([string[]]$Arguments)
  $script = Join-Path $Root "scripts\agenthub.ps1"
  return Invoke-Logged "agenthub.ps1 $($Arguments -join ' ')" { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script @Arguments }
}

function Invoke-NpmInstallAndBuild {
  Push-Location $Root
  try {
    Write-Status "running" "installing"
    $code = Invoke-Logged "npm install" { & npm.cmd install --no-audit --no-fund }
    if ($code -ne 0) { throw "npm install failed (exit $code)" }
    Write-Status "running" "building"
    $code = Invoke-Logged "npm run build" { & npm.cmd run build }
    if ($code -ne 0) { throw "npm run build failed (exit $code)" }
  } finally {
    Pop-Location
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $Root "backups\update-before-$FromVersion-$stamp"
$WorkDir = Join-Path $env:TEMP "xgenthub-update-work-$stamp"
$DataDir = Join-Path $Root "server\data"
$applied = $false
$previousHead = ""

try {
  Write-Log "Updating $FromVersion -> $ToVersion (mode=$Mode, tag=$Tag)"

  Write-Status "running" "stopping"
  Invoke-AgentHub @("stop", "-Mode", "prod") | Out-Null
  Start-Sleep -Seconds 2

  # Program files only: user config (.env), data, logs, backups and dependencies are never part of the backup or the update.
  Write-Status "running" "backup"
  $code = Invoke-Logged "backup to $BackupDir" { robocopy $Root $BackupDir /E /XD node_modules logs backups .git XgentHub-opensource $DataDir /XF .env /R:2 /W:1 /NFL /NDL /NP }
  if ($code -gt 7) { throw "Backup failed (robocopy exit $code)" }

  if ($Mode -eq "git") {
    Write-Status "running" "downloading"
    $dirty = & git -C $Root status --porcelain --untracked-files=no
    if ($dirty) { throw "There are local changes to tracked files. Commit or discard them, then update again." }
    $previousHead = (& git -C $Root rev-parse HEAD).Trim()
    $code = Invoke-Logged "git fetch" { & git -C $Root fetch --tags --force origin }
    if ($code -ne 0) { throw "git fetch failed (exit $code)" }
    Write-Status "running" "applying"
    $applied = $true
    $code = Invoke-Logged "git checkout $Tag" { & git -C $Root -c advice.detachedHead=false checkout --force "refs/tags/$Tag" }
    if ($code -ne 0) { throw "git checkout $Tag failed (exit $code)" }
  } else {
    if (-not $ArchiveUrl) { throw "No archive URL" }
    Write-Status "running" "downloading"
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $zip = Join-Path $WorkDir "update.zip"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Log "> download $ArchiveUrl"
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zip -UseBasicParsing -Headers @{ "User-Agent" = "XgentHub-updater" }
    $extractDir = Join-Path $WorkDir "src"
    Expand-Archive -LiteralPath $zip -DestinationPath $extractDir -Force
    $inner = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName "package.json")) -or -not (Test-Path (Join-Path $inner.FullName "server"))) {
      throw "The downloaded archive does not look like Xgent Hub"
    }
    Write-Status "running" "applying"
    $applied = $true
    $source = $inner.FullName
    $code = Invoke-Logged "copy new version" { robocopy $source $Root /E /XD .git $DataDir /XF .env /R:2 /W:1 /NFL /NDL /NP }
    if ($code -gt 7) { throw "Copying the new version failed (robocopy exit $code)" }
  }

  Invoke-NpmInstallAndBuild

  Write-Status "running" "starting"
  Invoke-AgentHub @("start", "-Mode", "prod", "-StartOllama", "-NoWait") | Out-Null
  if (-not (Test-Health -Seconds 90)) { throw "The service did not come back after the update" }

  Write-Log "Update finished: $ToVersion"
  Write-Status "done" "done"
} catch {
  $message = $_.Exception.Message
  Write-Log "ERROR: $message"
  if ($applied) {
    Write-Status "running" "restoring" $message
    try {
      if ($Mode -eq "git" -and $previousHead) {
        Invoke-Logged "git checkout back to $previousHead" { & git -C $Root -c advice.detachedHead=false checkout --force $previousHead } | Out-Null
      } else {
        Invoke-Logged "restore backup" { robocopy $BackupDir $Root /E /R:2 /W:1 /NFL /NDL /NP } | Out-Null
      }
      Push-Location $Root
      Invoke-Logged "npm install (restore)" { & npm.cmd install --no-audit --no-fund } | Out-Null
      if ($Mode -eq "git") { Invoke-Logged "npm run build (restore)" { & npm.cmd run build } | Out-Null }
      Pop-Location
    } catch {
      Write-Log "Restore problem: $($_.Exception.Message)"
    }
  }
  if (-not (Test-Health -Seconds 3)) {
    Invoke-AgentHub @("start", "-Mode", "prod", "-StartOllama", "-NoWait") | Out-Null
    Test-Health -Seconds 60 | Out-Null
  }
  Write-Status "failed" "failed" $message
} finally {
  if (Test-Path $WorkDir) { Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }
}
