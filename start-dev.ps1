# Starts Vite after ensuring dependencies exist. Prefers a full Node.js install (includes npm).
# Run from PowerShell:  .\start-dev.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$npmCandidates = @(
  "$env:ProgramFiles\nodejs\npm.cmd",
  "${env:ProgramFiles(x86)}\nodejs\npm.cmd",
  "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
)

$npm = $npmCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $npm) {
  Write-Host @"
Could not find npm.cmd.

Install Node.js LTS from https://nodejs.org (this adds npm), then reopen the terminal
or run this script again.

If Node is already installed, open a new PowerShell window (PATH refresh) and run:
  cd `"$PSScriptRoot`"
  npm install
  npm run dev
"@
  exit 1
}

Write-Host "Using: $npm"
& $npm install
& $npm run dev
