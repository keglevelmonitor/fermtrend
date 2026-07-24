# ship.ps1 -- one-command ship for FermTrend.
#
# Bumps the version in changelog.json, prepends a new entry with your
# notes, then does git add / commit / push in one shot.  Pages
# redeploys automatically on push.
#
# Usage:
#   .\ship.ps1 "first note" "second note"        Patch bump (0.1.0 -> 0.1.1)
#   .\ship.ps1 -Minor "new feature"              Minor bump (0.1.0 -> 0.2.0)
#   .\ship.ps1 -Major "breaking change"          Major bump (0.1.0 -> 1.0.0)
#   .\ship.ps1                                    Prompts interactively for notes
#   .\ship.ps1 -DryRun "test"                    Bump changelog only; no commit
#
# The commit body is:
#   v<new-version>
#
#   - first note
#   - second note
#
# ASCII-only: this file must stay ASCII per the workspace's .ps1 rule.

param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Message,
    [switch]$Minor,
    [switch]$Major,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Anchor to this script's directory so it works no matter where the
# user invoked it from.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$changelogPath = Join-Path $scriptDir "changelog.json"

# Load existing changelog or create an empty skeleton.
if (Test-Path $changelogPath) {
    $raw = Get-Content -Path $changelogPath -Raw -Encoding UTF8
    $log = $raw | ConvertFrom-Json
} else {
    $log = [PSCustomObject]@{
        current = "0.0.0"
        entries = @()
    }
}

# Parse current version.  Tolerant of "0" / "0.1" / "0.1.2" shapes.
$parts = ($log.current -as [string]) -split "\."
[int]$maj = if ($parts.Count -ge 1) { $parts[0] } else { 0 }
[int]$min = if ($parts.Count -ge 2) { $parts[1] } else { 0 }
[int]$pat = if ($parts.Count -ge 3) { $parts[2] } else { 0 }

if ($Major) {
    $maj = $maj + 1
    $min = 0
    $pat = 0
    $bumpKind = "major"
} elseif ($Minor) {
    $min = $min + 1
    $pat = 0
    $bumpKind = "minor"
} else {
    $pat = $pat + 1
    $bumpKind = "patch"
}
$newVersion = "$maj.$min.$pat"

# Collect notes.  If nothing was passed on the command line, prompt.
if (-not $Message -or $Message.Count -eq 0) {
    Write-Host ""
    Write-Host "Enter change notes.  One per line.  Blank line to finish."
    $notes = @()
    while ($true) {
        $line = Read-Host "  note"
        if ([string]::IsNullOrWhiteSpace($line)) { break }
        $notes += $line.Trim()
    }
} else {
    $notes = @()
    foreach ($m in $Message) {
        if (-not [string]::IsNullOrWhiteSpace($m)) {
            $notes += $m.Trim()
        }
    }
}

if ($notes.Count -eq 0) {
    Write-Host ""
    Write-Host "No change notes provided.  Aborting." -ForegroundColor Yellow
    exit 1
}

# Build new entry and prepend to the entries list.
$today = (Get-Date).ToString("yyyy-MM-dd")
$entry = [PSCustomObject]@{
    version = $newVersion
    date    = $today
    notes   = @($notes)
}

$log.current = $newVersion

# ConvertFrom-Json gives us a fixed-size PSCustomObject array; rebuild
# as a plain array so + works, then reassign.
$existing = @()
if ($log.entries) {
    foreach ($e in $log.entries) { $existing += $e }
}
$log.entries = @($entry) + $existing

# Serialize and write.  Use .NET's WriteAllText so we get UTF-8 without
# a BOM regardless of PowerShell version -- PS 5.1 default utf8 writes
# a BOM which some JSON parsers stumble on.
$json = $log | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($changelogPath, $json, $utf8NoBom)

Write-Host ""
Write-Host "Bumped ($bumpKind) to v$newVersion  ($today)" -ForegroundColor Green
foreach ($n in $notes) {
    Write-Host "  - $n"
}
Write-Host ""

if ($DryRun) {
    Write-Host "Dry run -- changelog.json updated but no git commit/push." -ForegroundColor Yellow
    exit 0
}

# Build commit message file (heredoc-free path to keep bullets clean).
$commitLines = @("v$newVersion", "")
foreach ($n in $notes) { $commitLines += "- $n" }
$commitBody = ($commitLines -join "`n") + "`n"

$tmpFile = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($tmpFile, $commitBody, $utf8NoBom)

Write-Host "Staging changes..."
git add . | Out-Null

Write-Host "Committing..."
git commit -F $tmpFile
Remove-Item -Path $tmpFile -ErrorAction SilentlyContinue

Write-Host "Pushing..."
git push

Write-Host ""
Write-Host "Shipped v$newVersion.  Pages will redeploy in ~30s." -ForegroundColor Green
