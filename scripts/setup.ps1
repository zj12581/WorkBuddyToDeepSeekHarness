<#
.SYNOPSIS
  One-command setup for workbuddy-gateway on Windows.

.DESCRIPTION
  Mirrors scripts/setup.sh for machines without Git Bash:
    1. checks Node and locates the desktop login
    2. verifies the upstream is reachable
    3. writes a config file (only when absent)
    4. starts the gateway detached from this shell
    5. waits for a health check
    6. optionally installs the VS Code extension

  Safe to re-run: it repairs rather than duplicates.

.EXAMPLE
  pwsh -File scripts/setup.ps1
  pwsh -File scripts/setup.ps1 -SkipExtension
#>
[CmdletBinding()]
param(
  [int]$Port = 8790,
  [string]$ApiKey = 'workbuddy-local',
  [string]$HostName = '127.0.0.1',
  [switch]$SkipExtension
)

$ErrorActionPreference = 'Stop'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor White }
function Info($msg) { Write-Host "    $msg" }
function Ok($msg)   { Write-Host "    v $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    ! $msg" -ForegroundColor Yellow }
function Bad($msg)  { Write-Host "    x $msg" -ForegroundColor Red }
function Die($msg)  { Bad $msg; exit 1 }

$RepoDir = Split-Path -Parent $PSScriptRoot
$ConfigDir = Join-Path $env:USERPROFILE '.workbuddy-gateway'
$ConfigFile = Join-Path $ConfigDir 'config.json'
$LogDir = Join-Path $ConfigDir 'logs'
$LogFile = Join-Path $LogDir 'gateway.log'
$PidFile = Join-Path $ConfigDir 'gateway.pid'
$GatewayJs = Join-Path $RepoDir 'gateway.js'

Write-Host ''
Write-Host 'WorkBuddy gateway - setup' -ForegroundColor White
Write-Host ''

# ---------------------------------------------------------------- 1. node
Step 'Checking Node.js'
try { $nodeVersion = (& node --version) } catch { Die 'node not found. Install Node 18 or newer first.' }
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 18) { Die "Node 18+ required, found $nodeVersion" }
Ok "node $nodeVersion"

if (-not (Test-Path $GatewayJs)) { Die "gateway.js not found at $GatewayJs" }
Ok "gateway: $GatewayJs"

# ---------------------------------------------------------------- 2. login
Step 'Locating the WorkBuddy / CodeBuddy desktop login'
$authFile = $null
if ($env:WORKBUDDY_AUTH_FILE -and (Test-Path $env:WORKBUDDY_AUTH_FILE)) {
  $authFile = $env:WORKBUDDY_AUTH_FILE
  Ok "using WORKBUDDY_AUTH_FILE: $authFile"
} else {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'CodeBuddyExtension\Data\Public\auth'),
    (Join-Path $env:APPDATA 'CodeBuddyExtension\Data\Public\auth'),
    (Join-Path $env:USERPROFILE '.codebuddy\auth')
  )
  foreach ($dir in $candidates) {
    if (-not (Test-Path $dir)) { continue }
    # Prefer a file named for workbuddy, else the first .info
    $pick = Get-ChildItem $dir -Filter 'workbuddy*.info' -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $pick) {
      $pick = Get-ChildItem $dir -Filter '*.info' -File -ErrorAction SilentlyContinue |
              Select-Object -First 1
    }
    if ($pick) { $authFile = $pick.FullName; break }
  }
}
if (-not $authFile) {
  Bad 'no login state found.'
  Info 'Sign in with the WorkBuddy / CodeBuddy desktop client, then re-run this script.'
  Info 'Or pass -AuthFile / set WORKBUDDY_AUTH_FILE to the *.info path.'
  exit 1
}
Ok "login: $authFile"

try {
  $store = Get-Content $authFile -Raw | ConvertFrom-Json
  $nick = $store.account.nickname
  $domain = $store.auth.domain
  $exp = if ($store.auth.expiresAt) { ([datetimeoffset]::FromUnixTimeMilliseconds([int64]$store.auth.expiresAt)).LocalDateTime } else { '-' }
  Info "account: $nick  domain: $domain  token valid to: $exp"
} catch {
  Warn 'could not read account details from the login file'
}

# ---------------------------------------------------------------- 3. upstream
Step 'Checking the upstream is reachable'
try {
  $r = Invoke-WebRequest -Uri 'https://copilot.tencent.com/' -TimeoutSec 10 -UseBasicParsing
  Ok "upstream responded (HTTP $($r.StatusCode))"
} catch {
  Warn "cannot reach copilot.tencent.com: $($_.Exception.Message)"
  Warn 'setup continues; requests will fail until the network allows it.'
}

# ---------------------------------------------------------------- 4. config
Step 'Writing configuration'
if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

if (Test-Path $ConfigFile) {
  Ok "keeping existing $ConfigFile"
} else {
  $config = [ordered]@{
    host           = $HostName
    port           = $Port
    apiKey         = $ApiKey
    upstream       = 'https://copilot.tencent.com'
    authFile       = $authFile
    logFile        = $LogFile
    desensitize    = $true
    retryOnBlock   = $true
    exposeIdentity = $false
  }
  # Write without a BOM. PowerShell 5.1's `Set-Content -Encoding UTF8` emits one,
  # and JSON.parse rejects a leading U+FEFF. The gateway now tolerates a BOM, but
  # other tools reading this file may not.
  $json = $config | ConvertTo-Json
  [System.IO.File]::WriteAllText($ConfigFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  Ok "wrote $ConfigFile"
}

# ---------------------------------------------------------------- 5. stop old
Step 'Stopping any previous instance'
if (Test-Path $PidFile) {
  $oldPid = (Get-Content $PidFile -Raw).Trim()
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    Ok "stopped pid $oldPid"
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 6. start
Step "Starting the gateway on ${HostName}:${Port}"
$proc = Start-Process -FilePath 'node' `
  -ArgumentList @($GatewayJs, '--config', $ConfigFile, '--log', $LogFile) `
  -WorkingDirectory $RepoDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $LogDir 'gateway.out.log') `
  -RedirectStandardError (Join-Path $LogDir 'gateway.err.log')
$proc.Id | Out-File -FilePath $PidFile -Encoding ascii
Ok "pid $($proc.Id)"

Step 'Waiting for the health check'
$healthy = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri "http://${HostName}:${Port}/health" -TimeoutSec 3 `
      -Headers @{ Authorization = "Bearer $ApiKey" } | Out-Null
    $healthy = $true
    break
  } catch { }
}
if (-not $healthy) {
  Bad 'the gateway did not become healthy within 20s.'
  $errLog = Join-Path $LogDir 'gateway.err.log'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 15 | ForEach-Object { Info $_ } }
  exit 1
}

$models = Invoke-RestMethod -Uri "http://${HostName}:${Port}/v1/models" -TimeoutSec 5 `
  -Headers @{ Authorization = "Bearer $ApiKey" }
$freeCount = ($models.data | Where-Object { $_.tier -eq 'free' }).Count
Ok "healthy - $($models.data.Count) models ($freeCount free)"

# ---------------------------------------------------------------- 7. VS Code
Step 'VS Code extension (optional)'
if ($SkipExtension) {
  Info 'skipped by request'
} else {
  $vsix = Get-ChildItem (Join-Path $RepoDir 'vscode-extension') -Filter '*.vsix' -File -ErrorAction SilentlyContinue |
          Select-Object -First 1
  $codeCli = $null
  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if ($cmd) { $codeCli = $cmd.Source }
  if (-not $codeCli) {
    foreach ($c in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
      'D:\App\Microsoft VS Code\bin\code.cmd',
      'C:\Program Files\Microsoft VS Code\bin\code.cmd'
    )) { if (Test-Path $c) { $codeCli = $c; break } }
  }

  if (-not $vsix) {
    Info 'no .vsix in vscode-extension/ - build one with: cd vscode-extension; npx @vscode/vsce package'
  } elseif (-not $codeCli) {
    Info "the 'code' CLI was not found; install by hand:"
    Info "  VS Code -> Extensions: Install from VSIX... -> $($vsix.FullName)"
  } else {
    try {
      & $codeCli --install-extension $vsix.FullName --force | Out-Null
      Ok "installed $($vsix.Name)"
      Info 'restart VS Code, then pick a WorkBuddy model in the Chat view'
    } catch {
      Warn "VS Code CLI install failed: $($_.Exception.Message)"
    }
  }
}

# ---------------------------------------------------------------- summary
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host ''
Write-Host "  endpoint   http://${HostName}:${Port}/v1"
Write-Host "  api key    $ApiKey"
Write-Host "  config     $ConfigFile"
Write-Host "  logs       $LogFile"
Write-Host "  pid        $((Get-Content $PidFile -Raw).Trim())"
Write-Host ''
Write-Host '  Quick checks'
Write-Host "    Invoke-RestMethod http://${HostName}:${Port}/health -Headers @{Authorization='Bearer $ApiKey'}"
Write-Host '    node probes/probe-models.js        # which model ids this account serves'
Write-Host '    node probes/probe-thinking.js      # which models have a reasoning channel'
Write-Host ''
Write-Host '  hy4-preview-f is free; hy4-preview (no -f) bills credits.'
Write-Host '  Stop it with: pwsh -File scripts/stop.ps1'
Write-Host ''
