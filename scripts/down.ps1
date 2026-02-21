$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$pidFile = Join-Path $projectRoot "data\\server.pid"
$supervisorPidFile = Join-Path $projectRoot "data\\supervisor.pid"
$watchdogPidFile = Join-Path $projectRoot "data\\watchdog.pid"

$port = 3000
if ($env:APP_PORT) {
  $parsedPort = 0
  if ([int]::TryParse($env:APP_PORT, [ref]$parsedPort) -and $parsedPort -gt 0) {
    $port = $parsedPort
  }
} elseif ($env:PORT) {
  $parsedPort = 0
  if ([int]::TryParse($env:PORT, [ref]$parsedPort) -and $parsedPort -gt 0) {
    $port = $parsedPort
  }
}

function Stop-ByPidFile {
  param(
    [string]$FilePath,
    [string]$Label
  )

  if (-not (Test-Path $FilePath)) {
    return $false
  }

  $pidRawValue = Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1
  $pidRaw = if ($null -eq $pidRawValue) { "" } else { $pidRawValue.ToString().Trim() }
  $managedPid = 0
  if (-not [int]::TryParse($pidRaw, [ref]$managedPid)) {
    Remove-Item $FilePath -Force -ErrorAction SilentlyContinue
    Write-Host "$Label pid file was invalid and has been cleared."
    return $false
  }

  $process = Get-Process -Id $managedPid -ErrorAction SilentlyContinue
  if (-not $process) {
    Remove-Item $FilePath -Force -ErrorAction SilentlyContinue
    Write-Host "$Label pid file was stale and has been cleared."
    return $false
  }

  Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue
  Remove-Item $FilePath -Force -ErrorAction SilentlyContinue
  Write-Host "$Label stopped (pid $managedPid)."
  return $true
}

$stoppedWatchdog = Stop-ByPidFile -FilePath $watchdogPidFile -Label "Watchdog"
Start-Sleep -Milliseconds 250
$stoppedSupervisor = Stop-ByPidFile -FilePath $supervisorPidFile -Label "Supervisor"
Start-Sleep -Milliseconds 250
$stoppedServer = Stop-ByPidFile -FilePath $pidFile -Label "Server"

if ($stoppedWatchdog -or $stoppedSupervisor -or $stoppedServer) {
  Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  Write-Host "No server pid file found. Nothing to stop."
  exit 0
}

$ownerPid = $listener.OwningProcess
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
$cmdLine = if ($processInfo) { $processInfo.CommandLine } else { "" }

if ($cmdLine -and $cmdLine -match "src[\\/]+app\.js") {
  Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped unmanaged app process on port $port (pid $ownerPid)."
  exit 0
}

Write-Host "A different process is listening on port $port (pid $ownerPid). Not stopping it automatically."
