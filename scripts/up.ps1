$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dataDir = Join-Path $projectRoot "data"
$pidFile = Join-Path $dataDir "server.pid"
$supervisorPidFile = Join-Path $dataDir "supervisor.pid"
$stderrLog = Join-Path $dataDir "server.err.log"

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

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

if (Test-Endpoint -HostName $bindHost -PortNumber $port) {
  Write-Host "Server is already reachable at http://$bindHost`:$port"
  exit 0
}

$supervisorPid = Get-PidFromFile -FilePath $supervisorPidFile
if ($supervisorPid) {
  $supervisorProcess = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
  if ($supervisorProcess) {
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-Endpoint -HostName $bindHost -PortNumber $port) {
        Write-Host "Server recovered at http://$bindHost`:$port (supervisor pid $supervisorPid)"
        exit 0
      }
    }
  }
}

Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue

$powershellPath = (Get-Command powershell -ErrorAction Stop).Source
$supervisorScript = Join-Path $projectRoot "scripts\\supervisor.ps1"
$supervisorArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$supervisorScript`""

$env:APP_HOST = $bindHost
$env:APP_PORT = [string]$port

$supervisorProcess = Start-Process `
  -FilePath $powershellPath `
  -ArgumentList $supervisorArgs `
  -WorkingDirectory $projectRoot `
  -PassThru

Set-Content -Path $supervisorPidFile -Value $supervisorProcess.Id -Encoding ascii

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Endpoint -HostName $bindHost -PortNumber $port) {
    $appPid = Get-PidFromFile -FilePath $pidFile
    $appPidText = if ($appPid) { $appPid } else { "unknown" }
    Write-Host "Server started at http://$bindHost`:$port (app pid $appPidText, supervisor pid $($supervisorProcess.Id))"
    exit 0
  }

  $runningCheck = Get-Process -Id $supervisorProcess.Id -ErrorAction SilentlyContinue
  if (-not $runningCheck) {
    break
  }
}

Remove-Item $supervisorPidFile -Force -ErrorAction SilentlyContinue
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Server failed to stay up. Last stderr lines:"
if (Test-Path $stderrLog) {
  Get-Content $stderrLog -Tail 20
}
Write-Error "Startup failed. Try: npm run dev"

