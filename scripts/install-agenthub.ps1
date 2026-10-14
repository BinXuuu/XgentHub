param(
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$InstallStartupTask,
  [switch]$InstallShortcuts,
  [switch]$StartAfterInstall
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

function Write-Step {
  param([string]$Message)
  Write-Host "[Xgent Hub install] $Message"
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found in PATH."
  }
}

function New-RandomToken {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Ensure-ElectronRuntime {
  $electronExe = Join-Path $Root "node_modules\electron\dist\electron.exe"
  if (Test-Path $electronExe) {
    Write-Step "Electron desktop runtime found."
    return
  }

  $installScript = Join-Path $Root "node_modules\electron\install.js"
  if (-not (Test-Path $installScript)) {
    throw "Electron package is missing. Run npm install again, then rerun install.bat."
  }

  Write-Step "Installing Electron desktop runtime..."
  Remove-Item Env:\ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
  & node $installScript
  if ($LASTEXITCODE -ne 0) { throw "Electron runtime install failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path $electronExe)) {
    throw "Electron runtime install did not create $electronExe"
  }
  Write-Step "Electron desktop runtime installed."
}

Push-Location $Root
try {
  Assert-Command "node"
  Assert-Command "npm"

  foreach ($dir in @("logs", "backups", "server\data", "server\data\attachments")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir) | Out-Null
  }

  $envPath = Join-Path $Root ".env"
  if (-not (Test-Path $envPath)) {
    $example = Join-Path $Root ".env.example"
    if (-not (Test-Path $example)) { throw "Missing .env.example" }
    # Read and write as UTF-8 explicitly. PowerShell 5.1 defaults to the ANSI code page (GBK on Chinese
    # Windows), which garbles the Chinese comments in .env.example and swallows the KEY= line after them.
    $content = [System.IO.File]::ReadAllText($example, [System.Text.Encoding]::UTF8)
    $token = New-RandomToken
    $content = $content -replace "ADMIN_TOKEN=change-me-please", "ADMIN_TOKEN=$token"
    [System.IO.File]::WriteAllText($envPath, $content, (New-Object System.Text.UTF8Encoding $false))
    Write-Step "Created .env with a generated ADMIN_TOKEN."
  } else {
    Write-Step ".env already exists; keeping it."
  }

  foreach ($file in @("custom-agents.json", "hidden-agents.json")) {
    $path = Join-Path $Root "server\data\$file"
    if (-not (Test-Path $path)) {
      Set-Content -Path $path -Value "[]" -Encoding UTF8
      Write-Step "Created server/data/$file"
    }
  }

  if (-not $SkipInstall) {
    Write-Step "Running npm install..."
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }

  Ensure-ElectronRuntime

  if (-not $SkipBuild) {
    Write-Step "Running npm run build..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  }

  Write-Step "Running doctor..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\doctor.ps1")
  if ($LASTEXITCODE -ne 0) { throw "doctor failed with exit code $LASTEXITCODE" }

  if ($InstallStartupTask) {
    Write-Step "Installing startup scheduled task..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "install-startup-task.ps1")
  }

  if ($InstallShortcuts) {
    Write-Step "Installing desktop and Start Menu shortcuts..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\manage-shortcuts.ps1") install
  }

  if ($StartAfterInstall) {
    Write-Step "Starting Xgent Hub..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "scripts\agenthub.ps1") start -Mode prod -StartOllama -OpenBrowser
  }

  Write-Step "Install completed."
} finally {
  Pop-Location
}
