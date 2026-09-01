$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command exited with code $LASTEXITCODE."
  }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "Node.js 24 or newer is required. Install it from https://nodejs.org/ and run setup again."
}
$nodeVersion = (& $nodeCommand.Source --version).TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 24) {
  throw "Node.js 24 or newer is required; found $nodeVersion."
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
if (-not $pnpmCommand -and -not $corepackCommand) {
  throw "pnpm 10.11 is required. Install it with: npm install -g pnpm@10.11.0"
}

function Invoke-Pnpm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  if ($pnpmCommand) {
    Invoke-Checked $pnpmCommand.Source @Arguments
    return
  }
  # `corepack pnpm` works without writing a global shim, which keeps setup
  # usable from a non-administrator Windows account.
  Invoke-Checked $corepackCommand.Source "pnpm" @Arguments
}

Write-Host "Installing locked dependencies..." -ForegroundColor Cyan
Invoke-Pnpm "install" "--frozen-lockfile"
Invoke-Pnpm "--filter" "@copylab/server" "rebuild" "better-sqlite3"

Write-Host "Running security, risk, provider, API, and dashboard checks..." -ForegroundColor Cyan
Invoke-Pnpm "check"

Write-Host "CopyLab is ready. Double-click Start-CopyLab.cmd." -ForegroundColor Green
