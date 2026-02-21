$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dataDir = Join-Path $projectRoot "data"
$watchdogPidFile = Join-Path $dataDir "watchdog.pid"
$watchdogScript = Join-Path $projectRoot "scripts\\watchdog.ps1"
$powershellPath = (Get-Command powershell -ErrorAction Stop).Source

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

function Get-ValidPidFromFile {
  param([string]$FilePath)
  if (-not (Test-Path $FilePath)) {
    return $null
  }

  $rawValue = Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $rawValue) {
    return $null
  }

  $parsed = 0
  if ([int]::TryParse($rawValue.ToString().Trim(), [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }

  return $null
}

$existingPid = Get-ValidPidFromFile -FilePath $watchdogPidFile
if ($existingPid) {
  $existingProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
  if ($existingProcess) {
    Write-Host "Watchdog already running (pid $existingPid)."
    exit 0
  }
}

Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue

$args = "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogScript`""
$process = Start-Process -FilePath $powershellPath -ArgumentList $args -WorkingDirectory $projectRoot -PassThru

Start-Sleep -Seconds 1
$runningProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
if (-not $runningProcess) {
  Write-Error "Failed to start watchdog process."
}

try {
  & (Join-Path $projectRoot "scripts\\ensure.ps1")
} catch {
  Write-Host "Initial ensure attempt failed. Watchdog will keep retrying automatically."
}

Write-Host "Watchdog started (pid $($process.Id))."
