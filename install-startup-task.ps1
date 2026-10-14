$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $Root "start-on-login.vbs"
$TaskName = "Xgent Hub Auto Start"
$LegacyTaskName = "AgentHub Auto Start"

if (-not (Test-Path $Launcher)) {
  throw "Missing launcher: $Launcher"
}

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$Launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12)

Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Write-Host "Launcher: $Launcher"
