# Phonebook launcher updater (Windows, no install, no admin).
# Called by phonebook-launcher.cmd before starting the server.
# Behavior (mirrors shiftyar-node's updater):
#  - Data lives OUTSIDE app\ (data\directory.db, via DATA_DIR), so
#    updates never touch it. There is no legacy database to migrate.
#  - Reads the latest FULL release from GitHub (the /releases/latest
#    endpoint ignores drafts and prereleases).
#  - If the release is newer than app\VERSION, downloads the
#    hospital-phonebook-vX.Y.Z.zip asset, stops a running background
#    server, swaps app\ (previous version kept as app_old\), and makes
#    sure app\VERSION exists. Concurrent updater runs are serialized
#    with a lock file and each run uses its own per-process temp dir.
#  - The release zip is flat (server.js, lib\, public\, ... at the zip
#    root), so it is expanded into a staging dir that then becomes
#    the new app\.
#  - Prints exactly one word: OK, UPDATED, NOASSET, or OFFLINE.
#  - Any other failure prints OFFLINE and never blocks the server start.
#  - Secure connections on some networks fail intermittently (TLS
#    handshakes aborted mid-flight, succeeding after a few retries):
#    the release check and the download are each retried up to 6 times
#    with a 3-second pause. Permanent HTTP errors (e.g. 403/404) are
#    not retried. OFFLINE is printed when the update cannot proceed:
#    after every retry attempt fails, or when a later local step fails.
#  - app\ is never swapped while a server runs: before the swap, the
#    updater waits briefly for port 3001 to free up and for any
#    PID-file server to exit, and gives up the update if either is
#    still busy (a second launcher may have started one while this
#    updater held the lock).
param(
  [string]$AppDir,
  [string]$PidFile
)
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$repo = 'mcuteangel/hospital-phonebook'

function Invoke-WithRetry {
  param([scriptblock]$Action, [int]$MaxAttempts = 6, [int]$DelaySeconds = 3)
  $attempt = 0
  while ($true) {
    $attempt++
    try {
      return & $Action
    } catch {
      if ($attempt -ge $MaxAttempts) { throw }
      # Permanent HTTP errors (e.g. GitHub 403 rate-limit, 404) will not
      # clear up by retrying: fail fast instead of wasting the quota.
      # Retry only when there is no HTTP response (network/TLS failure)
      # or the status is 408, 429, or 5xx.
      $status = $null
      try {
        $ex = $_.Exception
        if ($ex.Response -and $ex.Response.StatusCode) { $status = [int]$ex.Response.StatusCode }
        elseif ($ex.StatusCode) { $status = [int]$ex.StatusCode }
      } catch { }
      if ($status -and $status -ne 408 -and $status -ne 429 -and ($status -lt 500 -or $status -gt 599)) { throw }
      Start-Sleep -Seconds $DelaySeconds
    }
  }
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $rel = Invoke-WithRetry -Action { Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -TimeoutSec 20 -Headers @{ 'User-Agent' = 'phonebook-launcher' } }
  # A full release may still carry an rc-style tag (v1.2.3-rc.1);
  # compare the numeric prefix only.
  $remoteTag = $rel.tag_name.TrimStart('v')
  $dash = $remoteTag.IndexOf('-')
  if ($dash -ge 0) { $remoteTag = $remoteTag.Substring(0, $dash) }
  $remote = [version]'0.0.0'
  if (-not [version]::TryParse($remoteTag, [ref]$remote)) {
    Write-Output 'OFFLINE'
    exit 0
  }
  $local = [version]'0.0.0'
  $verFile = Join-Path $AppDir 'VERSION'
  if (Test-Path $verFile) {
    $raw = (Get-Content $verFile -Raw).Trim().TrimStart('v')
    $parsed = [version]'0.0.0'
    if ([version]::TryParse($raw, [ref]$parsed)) { $local = $parsed }
  }
  if ($remote -le $local) { Write-Output 'OK'; exit 0 }
  $asset = $rel.assets | Where-Object { $_.name -like 'hospital-phonebook-v*.zip' } | Select-Object -First 1
  if (-not $asset) { Write-Output 'NOASSET'; exit 0 }
  # Stop a running background server before touching app\.
  if (Test-Path $PidFile) {
    $rawPid = (Get-Content $PidFile -Raw).Trim()
    $procId = 0
    if ([int]::TryParse($rawPid, [ref]$procId)) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      $cmdline = $null
      if ($p) {
        try { $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine } catch { }
      }
      if ($p -and $p.ProcessName -eq 'node' -and $cmdline -and $cmdline.Contains('server.js')) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
      }
    }
  }
  # Serialize concurrent updater runs; the handle is released when this
  # process exits, so a stale lock cannot persist.
  $lockPath = Join-Path $env:TEMP 'phonebook-update.lock'
  $lockStream = $null
  try {
    $lockStream = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  } catch {
    Write-Output 'OFFLINE'
    exit 0
  }
  $tmp = Join-Path $env:TEMP ('phonebook-update-' + $PID)
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item $tmp -ItemType Directory | Out-Null
  $zip = Join-Path $tmp 'app.zip'
  Invoke-WithRetry -Action {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -TimeoutSec 300 -Headers @{ 'User-Agent' = 'phonebook-launcher' }
  }
  $stage = Join-Path $tmp 'stage'
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  if (-not (Test-Path (Join-Path $stage 'server.js'))) { throw 'package has no server.js' }
  # A second launcher may have started a server while this updater held
  # the lock; never swap app\ under a running server. Wait briefly for
  # the port to free up and for any PID-file server to exit, then give
  # up the update (the local copy keeps running).
  $busy = $true
  for ($i = 0; $i -lt 5 -and $busy; $i++) {
    $busy = $false
    try {
      if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction Stop) { $busy = $true }
    } catch { }
    if (-not $busy -and (Test-Path $PidFile)) {
      $rawPid = (Get-Content $PidFile -Raw).Trim()
      $procId = 0
      if ([int]::TryParse($rawPid, [ref]$procId)) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') {
          $cmdline = $null
          try { $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine } catch { }
          if ($cmdline -and $cmdline.Contains('server.js')) { $busy = $true }
        }
      }
    }
    if ($busy) { Start-Sleep -Seconds 2 }
  }
  if ($busy) { Write-Output 'OFFLINE'; exit 0 }
  $parent = Split-Path $AppDir -Parent
  $oldApp = Join-Path $parent 'app_old'
  if (Test-Path $oldApp) { Remove-Item $oldApp -Recurse -Force }
  $moved = $false
  try {
    if (Test-Path $AppDir) { Move-Item $AppDir $oldApp; $moved = $true }
    Move-Item $stage $AppDir
  } catch {
    if ($moved -and -not (Test-Path $AppDir) -and (Test-Path $oldApp)) { Move-Item $oldApp $AppDir }
    throw
  }
  $newVerFile = Join-Path $AppDir 'VERSION'
  if (-not (Test-Path $newVerFile)) { $remote.ToString() | Out-File -FilePath $newVerFile -Encoding ascii }
  if ($lockStream) { $lockStream.Close() }
  Write-Output 'UPDATED'
} catch {
  Write-Output 'OFFLINE'
}
