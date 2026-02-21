$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$pidFile = Join-Path $projectRoot "data\\server.pid"
$supervisorPidFile = Join-Path $projectRoot "data\\supervisor.pid"
$watchdogPidFile = Join-Path $projectRoot "data\\watchdog.pid"

$bindHost = if ($env:APP_HOST) { $env:APP_HOST } else { "localhost" }
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

function Test-Endpoint {
  param([string]$HostName, [int]$PortNumber)
  try {
    $response = Invoke-WebRequest -Uri "http://$HostName`:$PortNumber/" -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Get-PidFromFile {
  param([string]$FilePath)

  if (-not (Test-Path $FilePath)) {
    return $null
  }

  $pidRawValue = Get-Content $FilePath -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $pidRawValue) {
    return $null
  }

  $parsedPid = 0
  if ([int]::TryParse($pidRawValue.ToString().Trim(), [ref]$parsedPid) -and $parsedPid -gt 0) {
    return $parsedPid
  }

  return $null
}

$endpointHealthy = Test-Endpoint -HostName $bindHost -PortNumber $port
$supervisorPid = Get-PidFromFile -FilePath $supervisorPidFile
$appPid = Get-PidFromFile -FilePath $pidFile
$watchdogPid = Get-PidFromFile -FilePath $watchdogPidFile

if ($watchdogPid) {
  $watchdogProcess = Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue
  if (-not $watchdogProcess) {
    Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
    $watchdogPid = $null
  }
}

if ($supervisorPid) {
  $supervisorProcess = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
  if (-not $supervisorProcess) {
    Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
    $supervisorPid = $null
  }
}

if ($appPid) {
  $appProcess = Get-Process -Id $appPid -ErrorAction SilentlyContinue
  if (-not $appProcess) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    $appPid = $null
  }
}

if ($endpointHealthy) {
  if ($watchdogPid) {
    Write-Host "Watchdog is running (pid $watchdogPid)."
  }

  if ($supervisorPid) {
    $appPidText = if ($appPid) { $appPid } else { "unknown" }
    Write-Host "Server is running at http://$bindHost`:$port (app pid $appPidText, supervisor pid $supervisorPid)."
    exit 0
  }

  if ($appPid) {
    Write-Host "Server is running at http://$bindHost`:$port (pid $appPid)."
    exit 0
  }

  Write-Host "Server is running at http://$bindHost`:$port (unmanaged: no pid file)."
  exit 0
}

if ($supervisorPid) {
  if ($watchdogPid) {
    Write-Host "Watchdog is running (pid $watchdogPid)."
  }
  Write-Host "Supervisor is running (pid $supervisorPid), but http://$bindHost`:$port is not responding yet."
  exit 1
}

if ($appPid) {
  Write-Host "Process exists (pid $appPid) but http://$bindHost`:$port is not responding."
  exit 1
}

Write-Host "Server is not running."
exit 1

