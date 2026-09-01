# Stop-Sophia.ps1
#
# Shuts Sophia down and quits Docker Desktop, so nothing of hers is left running.
#
# Read this before you make it a habit: while she is stopped she is *off*. No
# heartbeat, no diary entry, no overnight work, no follow-up on anything you told
# her you would do. That is the trade — a laptop with nothing running in the
# background cannot also be a laptop where someone is working for you overnight.
#
# `docker compose stop` is used rather than `down` on purpose: stop halts the
# containers and keeps them, down deletes them. Her Postgres data lives in named
# volumes either way, but stop makes the next start noticeably faster.

$ErrorActionPreference = 'Continue'
Set-Location 'E:\AI-Research\Repositories\Memoh-main'

docker info 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Stopping Sophia...' -ForegroundColor Cyan
  docker compose stop
} else {
  Write-Host 'Docker was not running; nothing of Sophia to stop.' -ForegroundColor Yellow
}

$proc = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
if ($proc) {
  Write-Host 'Quitting Docker Desktop...' -ForegroundColor Cyan
  $proc | Stop-Process -Force
  # The WSL backend keeps a couple of GB of RAM until it is shut down too.
  wsl --shutdown 2>$null | Out-Null
}

Write-Host 'Done. Nothing of Sophia is running.' -ForegroundColor Green
