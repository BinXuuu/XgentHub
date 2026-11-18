$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$TaskNames = @("Xgent Hub Auto Start", "AgentHub Auto Start")

function Test-TaskBelongsToRoot {
  param($Task)
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
  foreach ($action in $Task.Actions) {
    $text = "$($action.Execute) $($action.Arguments)"
    if ($text.IndexOf($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }
  return $false
}

$removed = 0
$skipped = 0

foreach ($taskName in $TaskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Scheduled task not found: $taskName"
    continue
  }

  if (Test-TaskBelongsToRoot -Task $task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task: $taskName"
    $removed += 1
  } else {
    Write-Host "Skipped scheduled task outside this install root: $taskName"
    $skipped += 1
  }
}

Write-Host "Startup task cleanup completed. Removed=$removed, skipped=$skipped"
exit 0
