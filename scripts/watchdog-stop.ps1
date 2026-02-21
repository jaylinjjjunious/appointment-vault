$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$watchdogPidFile = Join-Path $projectRoot "data\\watchdog.pid"

if (-not (Test-Path $watchdogPidFile)) {
  Write-Host "Watchdog is not running."
  exit 0
}

$rawValue = Get-Content $watchdogPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
$pidValue = if ($null -eq $rawValue) { "" } else { $rawValue.ToString().Trim() }
$watchdogPid = 0

if (-not [int]::TryParse($pidValue, [ref]$watchdogPid)) {
  Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Watchdog pid file was invalid and has been cleared."
  exit 0
}

$process = Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $watchdogPid -Force -ErrorAction SilentlyContinue
}

Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
Write-Host "Watchdog stopped (pid $watchdogPid)."
