param(
  [ValidateSet("status", "install", "remove")]
  [string]$Command = "status"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$AppLauncher = Join-Path $Root "start-app.vbs"
$StartScript = if (Test-Path $AppLauncher) { $AppLauncher } else { Join-Path $Root "start-prod.bat" }
$ElectronExe = Join-Path $Root "node_modules\electron\dist\electron.exe"
$ProjectIcon = Join-Path $Root "desktop\assets\xgent-hub.ico"
$AppIcon = if (Test-Path $ElectronExe) { "$ElectronExe,0" } elseif (Test-Path $ProjectIcon) { $ProjectIcon } else { "$env:SystemRoot\System32\shell32.dll,220" }
$StatusIcon = "$env:SystemRoot\System32\shell32.dll,23"
$StopIcon = "$env:SystemRoot\System32\shell32.dll,131"
$StatusScript = Join-Path $Root "status-prod.bat"
$StopScript = Join-Path $Root "stop.bat"
$ProductName = "Xgent Hub"
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "$ProductName.lnk"
$LegacyDesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "AgentHub.lnk"
$StartMenuDir = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\$ProductName"
$LegacyStartMenuDir = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\AgentHub"
$StartMenuShortcut = Join-Path $StartMenuDir "$ProductName.lnk"
$StartMenuStatusShortcut = Join-Path $StartMenuDir "$ProductName Status.lnk"
$StartMenuStopShortcut = Join-Path $StartMenuDir "Stop $ProductName.lnk"
$LegacyStartMenuShortcut = Join-Path $LegacyStartMenuDir "AgentHub.lnk"
$LegacyStartMenuStatusShortcut = Join-Path $LegacyStartMenuDir "AgentHub Status.lnk"
$LegacyStartMenuStopShortcut = Join-Path $LegacyStartMenuDir "Stop AgentHub.lnk"

function New-AgentHubShortcut {
  param(
    [string]$ShortcutPath,
    [string]$TargetPath,
    [string]$Description,
    [string]$IconLocation = $AppIcon
  )

  if (-not (Test-Path $TargetPath)) {
    throw "Missing shortcut target: $TargetPath"
  }

  $parent = Split-Path -Parent $ShortcutPath
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.WorkingDirectory = $Root
  $shortcut.Description = $Description
  $shortcut.IconLocation = $IconLocation
  $shortcut.Save()
}

function Remove-IfExists {
  param([string]$Path)
  if (Test-Path $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Get-ShortcutState {
  $desktop = (Test-Path $DesktopShortcut) -or (Test-Path $LegacyDesktopShortcut)
  $currentStartMenu = (Test-Path $StartMenuShortcut) -and (Test-Path $StartMenuStatusShortcut) -and (Test-Path $StartMenuStopShortcut)
  $legacyStartMenu = (Test-Path $LegacyStartMenuShortcut) -and (Test-Path $LegacyStartMenuStatusShortcut) -and (Test-Path $LegacyStartMenuStopShortcut)
  $startMenu = $currentStartMenu -or $legacyStartMenu
  return [ordered]@{
    desktopShortcut = $DesktopShortcut
    desktopInstalled = $desktop
    startMenuDir = $StartMenuDir
    startMenuInstalled = $startMenu
    installed = ($desktop -and $startMenu)
  }
}

switch ($Command) {
  "install" {
    Remove-IfExists -Path $LegacyDesktopShortcut
    Remove-IfExists -Path $LegacyStartMenuShortcut
    Remove-IfExists -Path $LegacyStartMenuStatusShortcut
    Remove-IfExists -Path $LegacyStartMenuStopShortcut
    if ((Test-Path $LegacyStartMenuDir) -and -not (Get-ChildItem -LiteralPath $LegacyStartMenuDir -Force -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $LegacyStartMenuDir -Force
    }
    New-AgentHubShortcut -ShortcutPath $DesktopShortcut -TargetPath $StartScript -Description "Open Xgent Hub" -IconLocation $AppIcon
    New-AgentHubShortcut -ShortcutPath $StartMenuShortcut -TargetPath $StartScript -Description "Open Xgent Hub" -IconLocation $AppIcon
    New-AgentHubShortcut -ShortcutPath $StartMenuStatusShortcut -TargetPath $StatusScript -Description "Check Xgent Hub status" -IconLocation $StatusIcon
    New-AgentHubShortcut -ShortcutPath $StartMenuStopShortcut -TargetPath $StopScript -Description "Stop Xgent Hub" -IconLocation $StopIcon
    Write-Host "Xgent Hub shortcuts installed."
  }
  "remove" {
    Remove-IfExists -Path $DesktopShortcut
    Remove-IfExists -Path $LegacyDesktopShortcut
    Remove-IfExists -Path $StartMenuShortcut
    Remove-IfExists -Path $StartMenuStatusShortcut
    Remove-IfExists -Path $StartMenuStopShortcut
    Remove-IfExists -Path $LegacyStartMenuShortcut
    Remove-IfExists -Path $LegacyStartMenuStatusShortcut
    Remove-IfExists -Path $LegacyStartMenuStopShortcut
    if ((Test-Path $StartMenuDir) -and -not (Get-ChildItem -LiteralPath $StartMenuDir -Force -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $StartMenuDir -Force
    }
    if ((Test-Path $LegacyStartMenuDir) -and -not (Get-ChildItem -LiteralPath $LegacyStartMenuDir -Force -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $LegacyStartMenuDir -Force
    }
    Write-Host "Xgent Hub shortcuts removed."
  }
}

Get-ShortcutState | ConvertTo-Json -Depth 5
