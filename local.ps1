# local.ps1 -- serve FermTrend locally for preview.
#
# Usage (from the FermTrend folder):
#   .\local.ps1
#
# Opens a static file server on http://localhost:3000 (and a LAN URL).
# Press Ctrl+C to stop.
#
# ASCII-only: this file must stay ASCII per the workspace's .ps1 rule.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host ""
Write-Host "Serving FermTrend from:" -ForegroundColor Green
Write-Host "  $scriptDir"
Write-Host ""
Write-Host "Open http://localhost:3000  (Ctrl+C to stop)" -ForegroundColor Yellow
Write-Host ""

# --yes skips the npx install prompt when 'serve' is not cached yet.
npx --yes serve .
