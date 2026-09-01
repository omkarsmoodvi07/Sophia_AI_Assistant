# Start-Sophia.ps1
#
# One click: bring Docker up, bring Sophia up, open her in the browser.
#
# This exists because Sophia's web page is *served by* the Docker containers —
# localhost:8082 is nginx inside sophia-web, talking to sophia-server, talking to
# Postgres. There is no version of "just the Sophia website" that does not
# involve Docker running. What there is, is a version where you never have to
# think about Docker: this script.
#
# Pair it with Stop-Sophia.ps1 if you want nothing running when you are not
# using her. Note that stopping her also stops her heartbeat, so she cannot
# write her diary or do overnight work on a machine where she is stopped.

$ErrorActionPreference = 'Continue'
$repo = 'E:\AI-Research\Repositories\Memoh-main'
$url  = 'http://localhost:8082/bot/sophia'

Set-Location $repo

# --- Docker engine ---------------------------------------------------------
$dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  if (Test-Path $dd) {
    Write-Host 'Starting Docker Desktop...' -ForegroundColor Cyan
    Start-Process $dd -ArgumentList '-Autostart'
  } else {
    Write-Host "Docker Desktop not found at $dd" -ForegroundColor Red
    Write-Host 'Start it from the Start menu, then run this script again.'
    return
  }
}

Write-Host 'Waiting for the Docker engine...' -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}

if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker engine did not come up. Open Docker Desktop and check for errors.' -ForegroundColor Red
  return
}

# --- Sophia ----------------------------------------------------------------
Write-Host 'Starting Sophia...' -ForegroundColor Cyan
docker compose up -d

# Wait for the web container to actually answer before opening the tab, so you
# do not land on a connection-refused page and assume it is broken.
Write-Host 'Waiting for Sophia to answer...' -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(3)
$up = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:8082' -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}

docker compose ps

if ($up) {
  Write-Host 'Sophia is up. Opening her now.' -ForegroundColor Green
  Start-Process $url
} else {
  Write-Host 'Containers started but the web page is not answering yet.' -ForegroundColor Yellow
  Write-Host 'Check: docker compose logs --tail 50 web server'
}
