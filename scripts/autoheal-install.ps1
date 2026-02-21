$ErrorActionPreference = "Stop"

$taskName = "AppointmentVaultAutoHeal"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$watchdogStartScript = Join-Path $projectRoot "scripts\\watchdog-start.ps1"
$powershellPath = (Get-Command powershell -ErrorAction Stop).Source
$schtasksPath = Join-Path $env:WINDIR "System32\\schtasks.exe"

if (-not (Test-Path $schtasksPath)) {
  Write-Error "Could not find schtasks.exe on this system."
}

$taskCommand = "`"$powershellPath`" -NoProfile -ExecutionPolicy Bypass -File `"$watchdogStartScript`""

$createExit = 1
try {
  & $schtasksPath /Create /TN $taskName /TR $taskCommand /SC MINUTE /MO 1 /F | Out-Null
  $createExit = $LASTEXITCODE
} catch {
  Write-Error "Failed to create scheduled task '$taskName'."
}

if ($createExit -ne 0) {
  Write-Error "Failed to create scheduled task '$taskName'."
}

$runExit = 1
try {
  & $schtasksPath /Run /TN $taskName | Out-Null
  $runExit = $LASTEXITCODE
} catch {
  $runExit = 1
}

if ($runExit -ne 0) {
  Write-Host "Scheduled task created, but could not start immediately. It will run on its next interval."
} else {
  Write-Host "Scheduled task created and started: $taskName"
}

Write-Host "Auto-heal is installed. The app watchdog will be checked every 1 minute."
