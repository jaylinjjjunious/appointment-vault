$ErrorActionPreference = "Stop"

$taskName = "AppointmentVaultAutoHeal"
$schtasksPath = Join-Path $env:WINDIR "System32\\schtasks.exe"

if (-not (Test-Path $schtasksPath)) {
  Write-Host "Could not find schtasks.exe on this system."
  exit 1
}

$deleteExit = 1
try {
  & $schtasksPath /Delete /TN $taskName /F | Out-Null
  $deleteExit = $LASTEXITCODE
} catch {
  $deleteExit = 1
}

if ($deleteExit -ne 0) {
  Write-Host "Auto-heal task was not found: $taskName"
  exit 0
}

Write-Host "Auto-heal task removed: $taskName"
