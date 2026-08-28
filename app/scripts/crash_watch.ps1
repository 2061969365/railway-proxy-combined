param(
  [int]$Port = 4096,
  [int]$IntervalSec = 15,
  [int]$StaleSec = 30
)
$ErrorActionPreference = "SilentlyContinue"
Write-Host "[watch] port $Port interval ${IntervalSec}s stale ${StaleSec}s  Ctrl+C to stop"
while ($true) {
  $ok = $false
  $status = $null
  try {
    $status = Invoke-RestMethod "http://127.0.0.1:$Port/api/status" -TimeoutSec 5
    $ok = $status.status -eq "ok"
  } catch {}
  if (-not $ok) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] CRASH detected (no status) -> try restart via start.bat"
    try { & "$PSScriptRoot\..\start.bat" | Out-Null } catch {}
    try {
      $crash = Invoke-RestMethod "http://127.0.0.1:$Port/api/crash" -TimeoutSec 5
      if ($crash.crash) { Write-Host ($crash.crash | ConvertTo-Json -Depth 4) }
    } catch {}
  } else {
    $hb = $null
    try { $hb = Invoke-RestMethod "http://127.0.0.1:$Port/api/heartbeat" -TimeoutSec 5 } catch {}
    if ($hb -and $hb.time) {
      $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $hb.time
      if ($age -gt $StaleSec*1000) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] STALE heartbeat ${age}ms (lastReq $($hb.lastReq.model) $($hb.lastReq.bodyBytes)B) -> restart"
        & "$PSScriptRoot\..\start.bat" | Out-Null
      }
    }
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ok uptime $($status.uptime)s heap $([math]::Round($status.memory.heapUsed/1MB,1))MB"
  }
  Start-Sleep -Seconds $IntervalSec
}
