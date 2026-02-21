$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
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

$endpointHealthy = Test-Endpoint -HostName $bindHost -PortNumber $port

if (-not (Test-Path $watchdogPidFile)) {
  Write-Host "Watchdog is not running. Endpoint healthy: $endpointHealthy"
  exit 1
}

$rawValue = Get-Content $watchdogPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
$pidValue = if ($null -eq $rawValue) { "" } else { $rawValue.ToString().Trim() }
$watchdogPid = 0
if (-not [int]::TryParse($pidValue, [ref]$watchdogPid)) {
  Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Watchdog pid file was invalid and has been cleared. Endpoint healthy: $endpointHealthy"
  exit 1
}

$process = Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Watchdog is not running (stale pid cleared). Endpoint healthy: $endpointHealthy"
  exit 1
}

Write-Host "Watchdog is running (pid $watchdogPid). Endpoint healthy: $endpointHealthy"
exit 0

