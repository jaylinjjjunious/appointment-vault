$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dataDir = Join-Path $projectRoot "data"
$pidFile = Join-Path $dataDir "server.pid"
$supervisorPidFile = Join-Path $dataDir "supervisor.pid"
$stdoutLog = Join-Path $dataDir "server.out.log"
$stderrLog = Join-Path $dataDir "server.err.log"

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

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

$nodePath = (Get-Command node -ErrorAction Stop).Source
Set-Content -Path $supervisorPidFile -Value $PID -Encoding ascii

try {
  while ($true) {
    $env:APP_HOST = $bindHost
    $env:APP_PORT = [string]$port

    $appProcess = Start-Process `
      -FilePath $nodePath `
      -ArgumentList "src/app.js" `
      -WorkingDirectory $projectRoot `
      -PassThru `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog

    Set-Content -Path $pidFile -Value $appProcess.Id -Encoding ascii
    Wait-Process -Id $appProcess.Id -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $supervisorPidFile)) {
      break
    }

    Start-Sleep -Seconds 1
  }
} finally {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
}
