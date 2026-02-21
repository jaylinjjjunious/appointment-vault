$ErrorActionPreference = "Stop"

$taskName = "AppointmentVaultAutoHeal"
$schtasksPath = Join-Path $env:WINDIR "System32\\schtasks.exe"

if (-not (Test-Path $schtasksPath)) {
  Write-Host "Auto-heal task check is unavailable: schtasks.exe not found."
  exit 1
}

$result = $null
$exitCode = 1
try {
  $result = & $schtasksPath /Query /TN $taskName /FO LIST /V 2>$null
  $exitCode = $LASTEXITCODE
} catch {
  Write-Host "Auto-heal task is not installed or Task Scheduler is unavailable."
  exit 1
}

if ($exitCode -ne 0) {
  Write-Host "Auto-heal task is not installed."
  exit 1
}

$result
exit 0
