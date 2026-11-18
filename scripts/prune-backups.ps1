param(
  [int]$Keep = 20,
  [switch]$DryRun
)

# Keep only the newest $Keep backups in the local backups/ folder and delete older ones.
# Only local backups/ is touched; version backups in VERSION_BACKUP_ROOT are never touched.
# What counts as one backup:
#   - each directory directly under backups/ (except phase-snapshots, where each child snapshot counts once)
#   - files produced by one build (installer / release zip plus its logs, checks, build records) count once together
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts with the ANSI code page.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$BackupsDir = Join-Path $Root "backups"
if (-not (Test-Path $BackupsDir)) {
  Write-Output "No backups directory: $BackupsDir"
  exit 0
}
if ($Keep -lt 1) { throw "Keep must be at least 1" }

function Get-GroupKey([string]$name) {
  $key = $name
  foreach ($suffix in @(".release-check.json", ".nsis-build.json", ".nsis-command.ps1", ".nsis.log", ".zip", ".exe", ".json", ".log")) {
    if ($key.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $key = $key.Substring(0, $key.Length - $suffix.Length)
      break
    }
  }
  if ($key.EndsWith("-release", [System.StringComparison]::OrdinalIgnoreCase)) { $key = $key.Substring(0, $key.Length - 8) }
  return $key
}

$units = New-Object System.Collections.Generic.List[object]

foreach ($dir in Get-ChildItem -LiteralPath $BackupsDir -Directory -Force) {
  # backups\data holds database/config backups with their own retention (server keeps the newest 14).
  if ($dir.Name -eq "data") { continue }
  if ($dir.Name -eq "phase-snapshots") {
    foreach ($snapshot in Get-ChildItem -LiteralPath $dir.FullName -Directory -Force) {
      $units.Add([pscustomobject]@{ Name = "phase-snapshots\$($snapshot.Name)"; Time = $snapshot.LastWriteTime; Paths = @($snapshot.FullName) })
    }
    continue
  }
  $units.Add([pscustomobject]@{ Name = $dir.Name; Time = $dir.LastWriteTime; Paths = @($dir.FullName) })
}

$fileGroups = Get-ChildItem -LiteralPath $BackupsDir -File -Force |
  Where-Object { $_.Name -ne ".gitkeep" } |
  Group-Object { Get-GroupKey $_.Name }
foreach ($group in $fileGroups) {
  $latest = ($group.Group | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  $units.Add([pscustomobject]@{ Name = $group.Name; Time = $latest; Paths = @($group.Group | ForEach-Object { $_.FullName }) })
}

$ordered = $units | Sort-Object Time -Descending
$kept = @($ordered | Select-Object -First $Keep)
$removed = @($ordered | Select-Object -Skip $Keep)

function Get-UnitSizeMB($unit) {
  $bytes = 0
  foreach ($path in $unit.Paths) {
    if (Test-Path -LiteralPath $path -PathType Container) {
      $bytes += (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    } else {
      $bytes += (Get-Item -LiteralPath $path -Force).Length
    }
  }
  return [math]::Round($bytes / 1MB, 1)
}

Write-Output "Backups found: $($units.Count); keeping newest $Keep; removing $($removed.Count)."
Write-Output "--- keep:"
foreach ($unit in $kept) { Write-Output ("  {0:yyyy-MM-dd HH:mm}  {1}" -f $unit.Time, $unit.Name) }

$freedMB = 0
foreach ($unit in $removed) { $freedMB += Get-UnitSizeMB $unit }
Write-Output ("--- remove: {0} backups, about {1} MB" -f $removed.Count, $freedMB)
foreach ($unit in $removed) { Write-Output ("  {0:yyyy-MM-dd HH:mm}  {1}" -f $unit.Time, $unit.Name) }

if ($DryRun) {
  Write-Output "Dry run: nothing deleted."
  exit 0
}

foreach ($unit in $removed) {
  foreach ($path in $unit.Paths) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
}
$phaseDir = Join-Path $BackupsDir "phase-snapshots"
if ((Test-Path $phaseDir) -and -not (Get-ChildItem -LiteralPath $phaseDir -Force)) { Remove-Item -LiteralPath $phaseDir -Force }
Write-Output "Removed $($removed.Count) old backups."
