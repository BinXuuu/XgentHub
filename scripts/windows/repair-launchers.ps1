# Re-point Xgent Hub shortcuts and the logon task after the Windows launchers moved into scripts\windows (v1.1.1).
# Older installs created them against files in the install root (start-app.vbs, status-prod.bat, stop.bat,
# start-on-login.vbs). A git based update deletes those files, so agenthub.ps1 start runs this to fix them.
# It only touches shortcuts and tasks that point into this install root, and never deletes the old files.

$ErrorActionPreference = "Stop"

$Root = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot))).TrimEnd("\")
$LegacyNames = @("start-app.vbs", "start-prod.bat", "status-prod.bat", "stop.bat", "start-on-login.vbs")

function Test-LegacyTarget {
  param([string]$Text)
  foreach ($name in $LegacyNames) {
    if ($Text.IndexOf("$Root\$name", [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}

$changed = @()

$shortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Xgent Hub.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "AgentHub.lnk")
)
foreach ($dir in @("Xgent Hub", "AgentHub")) {
  $menuDir = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\$dir"
  if (Test-Path $menuDir) {
    $shortcutPaths += @(Get-ChildItem -LiteralPath $menuDir -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
}

$shell = New-Object -ComObject WScript.Shell
$needShortcuts = $false
foreach ($path in $shortcutPaths) {
  if (-not (Test-Path $path)) { continue }
  if (Test-LegacyTarget -Text $shell.CreateShortcut($path).TargetPath) { $needShortcuts = $true }
}
if ($needShortcuts) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path (Split-Path -Parent $PSScriptRoot) "manage-shortcuts.ps1") install | Out-Null
  $changed += "shortcuts"
}

foreach ($taskName in @("Xgent Hub Auto Start", "AgentHub Auto Start")) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) { continue }
  $text = ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " "
  if (Test-LegacyTarget -Text $text) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-startup-task.ps1") | Out-Null
    $changed += "startup task"
    break
  }
}

if ($changed.Count -gt 0) {
  Write-Output "Updated launchers to scripts\windows: $($changed -join ', ')"
}
