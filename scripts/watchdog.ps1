$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dataDir = Join-Path $projectRoot "data"
$watchdogPidFile = Join-Path $dataDir "watchdog.pid"
$watchdogLog = Join-Path $dataDir "watchdog.log"
$powershellPath = (Get-Command powershell -ErrorAction Stop).Source
$upScript = Join-Path $projectRoot "scripts\\up.ps1"
$upArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$upScript`""
$recoveryStdout = Join-Path $dataDir "watchdog-recovery.out.log"
$recoveryStderr = Join-Path $dataDir "watchdog-recovery.err.log"

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

$intervalSeconds = 5
if ($env:WATCHDOG_INTERVAL_SECONDS) {
  $parsedInterval = 0
  if ([int]::TryParse($env:WATCHDOG_INTERVAL_SECONDS, [ref]$parsedInterval) -and $parsedInterval -ge 2) {
    $intervalSeconds = $parsedInterval
  }
}

function Write-WatchdogLog {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $watchdogLog -Value "[$timestamp] $Message"
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

function Should-Run {
  if (-not (Test-Path $watchdogPidFile)) {
    return $false
  }

  $pidRawValue = Get-Content $watchdogPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $pidRawValue) {
    return $false
  }

  $pidRaw = $pidRawValue.ToString().Trim()
  return $pidRaw -eq $PID.ToString()
}

Set-Content -Path $watchdogPidFile -Value $PID -Encoding ascii
Write-WatchdogLog "Watchdog started (pid $PID). Monitoring http://$bindHost`:$port every $intervalSeconds sec."

try {
  while (Should-Run) {
    if (-not (Test-Endpoint -HostName $bindHost -PortNumber $port)) {
      Write-WatchdogLog "Endpoint down. Running recovery via scripts/up.ps1."
      try {
        if (Test-Path $recoveryStdout) {
          Remove-Item $recoveryStdout -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path $recoveryStderr) {
          Remove-Item $recoveryStderr -Force -ErrorAction SilentlyContinue
        }

        $recoveryProcess = Start-Process `
          -FilePath $powershellPath `
          -ArgumentList $upArgs `
          -WorkingDirectory $projectRoot `
          -Wait `
          -PassThru `
          -RedirectStandardOutput $recoveryStdout `
          -RedirectStandardError $recoveryStderr

        if (Test-Path $recoveryStdout) {
          Get-Content $recoveryStdout | ForEach-Object { Write-WatchdogLog $_ }
          Remove-Item $recoveryStdout -Force -ErrorAction SilentlyContinue
        }

        if (Test-Path $recoveryStderr) {
          Get-Content $recoveryStderr | ForEach-Object { Write-WatchdogLog "stderr: $_" }
          Remove-Item $recoveryStderr -Force -ErrorAction SilentlyContinue
        }

        if ($recoveryProcess.ExitCode -ne 0) {
          Write-WatchdogLog "Recovery command exited with code $($recoveryProcess.ExitCode)."
        }
      } catch {
        Write-WatchdogLog "Recovery error: $($_.Exception.Message)"
      }
    }

    Start-Sleep -Seconds $intervalSeconds
  }
} finally {
  if (Test-Path $watchdogPidFile) {
    $pidRawValue = Get-Content $watchdogPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $pidRawValue -and $pidRawValue.ToString().Trim() -eq $PID.ToString()) {
      Remove-Item $watchdogPidFile -Force -ErrorAction SilentlyContinue
    }
  }

  Write-WatchdogLog "Watchdog stopped (pid $PID)."
}
