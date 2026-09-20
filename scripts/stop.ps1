<#
.SYNOPSIS
  Stop the gateway started by scripts/setup.ps1.

.EXAMPLE
  pwsh -File scripts/stop.ps1
#>
[CmdletBinding()]
param([int]$Port = 8790)

$ErrorActionPreference = 'Stop'
$ConfigDir = Join-Path $env:USERPROFILE '.workbuddy-gateway'
$PidFile = Join-Path $ConfigDir 'gateway.pid'

$stopped = $false
if (Test-Path $PidFile) {
  $gwPid = (Get-Content $PidFile -Raw).Trim()
  if (-not $gwPid) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'empty pid file, removed'
  } else {
    $proc = Get-Process -Id $gwPid -ErrorAction SilentlyContinue
    if (-not $proc) {
      Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
      Write-Host "pid $gwPid is not running, removed stale pid file"
    } else {
      Write-Host "stopping pid $gwPid ..."
      Stop-Process -Id $gwPid -Force
      Start-Sleep -Milliseconds 800
      Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
      Write-Host 'stopped'
      $stopped = $true
    }
  }
} else {
  Write-Host "no pid file at $PidFile - nothing recorded as running"
}

# Report anything still holding the port, so a silent leftover is visible.
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
  Write-Host "note: something is still listening on port $Port (pid $($listener.OwningProcess))"
} else {
  Write-Host "port $Port is free"
}
