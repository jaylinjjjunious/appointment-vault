$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
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

& (Join-Path $projectRoot "scripts\\watchdog-start.ps1")

$url = "http://$bindHost`:$port"
try {
  Start-Process $url | Out-Null
} catch {
  cmd /c start "" $url | Out-Null
}

Write-Host "Opened $url"

