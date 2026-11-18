param(
  [string]$Root = "",
  [int]$KeepDays = 365
)

# Monthly log rotation + one-year retention for logs\*.log.
#   - A log last written in an earlier month is moved to logs\archive\<name>-<yyyy-MM>.log
#     (appended if that month's archive already exists).
#   - Archives last written more than $KeepDays days ago are deleted.
# Runs before the service starts (agenthub.ps1), when its own log is not open. Files that are
# locked by another process (e.g. a running Ollama) are skipped and retried next time.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts with the ANSI code page.
$ErrorActionPreference = "Stop"

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$LogsDir = Join-Path $Root "logs"
$ArchiveDir = Join-Path $LogsDir "archive"
if (-not (Test-Path $LogsDir)) { Write-Output "No logs directory"; exit 0 }

$now = Get-Date
$currentMonth = $now.ToString("yyyy-MM")
$moved = 0
$deleted = 0
$skipped = 0

foreach ($log in Get-ChildItem -LiteralPath $LogsDir -File -Filter "*.log") {
  $month = $log.LastWriteTime.ToString("yyyy-MM")
  if ($month -eq $currentMonth) { continue }
  if (-not (Test-Path $ArchiveDir)) { New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null }
  $target = Join-Path $ArchiveDir ("{0}-{1}.log" -f $log.BaseName, $month)
  try {
    if (Test-Path $target) {
      $bytes = [System.IO.File]::ReadAllBytes($log.FullName)
      $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Append)
      try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
      $stamp = $log.LastWriteTime
      Remove-Item -LiteralPath $log.FullName -Force
      (Get-Item -LiteralPath $target).LastWriteTime = $stamp
    } else {
      Move-Item -LiteralPath $log.FullName -Destination $target
    }
    $moved++
  } catch {
    $skipped++
  }
}

if (Test-Path $ArchiveDir) {
  $cutoff = $now.AddDays(-$KeepDays)
  foreach ($old in Get-ChildItem -LiteralPath $ArchiveDir -File -Filter "*.log" | Where-Object { $_.LastWriteTime -lt $cutoff }) {
    try {
      Remove-Item -LiteralPath $old.FullName -Force
      $deleted++
    } catch {
      $skipped++
    }
  }
}

Write-Output ("Archived {0} log(s), deleted {1} older than {2} days, skipped {3} in use." -f $moved, $deleted, $KeepDays, $skipped)
