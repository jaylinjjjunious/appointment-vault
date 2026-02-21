$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$bindHost = if ($env:APP_HOST) { $env:APP_HOST } else { "127.0.0.1" }
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

if (Test-Endpoint -HostName $bindHost -PortNumber $port) {
  Write-Host "Server is reachable at http://$bindHost`:$port"
  exit 0
}

& (Join-Path $projectRoot "scripts\\up.ps1")
