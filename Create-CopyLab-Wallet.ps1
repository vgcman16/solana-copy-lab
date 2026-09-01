[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$baseUri = "http://127.0.0.1:4310"

function ConvertFrom-SecureValue {
  param([Parameter(Mandatory = $true)][Security.SecureString]$Value)

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-RecoveryPassphrase {
  while ($true) {
    Write-Host ""
    Write-Host "Choose a strong recovery passphrase." -ForegroundColor Cyan
    Write-Host "Use at least 16 characters. Four or more unrelated words is a good minimum."
    Write-Host "Do not reuse your Windows, email, exchange, or primary-wallet password."

    $firstSecure = Read-Host "Recovery passphrase" -AsSecureString
    $secondSecure = Read-Host "Confirm recovery passphrase" -AsSecureString
    $first = ConvertFrom-SecureValue -Value $firstSecure
    $second = ConvertFrom-SecureValue -Value $secondSecure

    if ($first.Length -lt 16) {
      Write-Host "The passphrase must contain at least 16 characters." -ForegroundColor Yellow
      continue
    }
    if ($first -cne $second) {
      Write-Host "The passphrases did not match. Please try again." -ForegroundColor Yellow
      continue
    }
    return $first
  }
}

function Ensure-CopyLabRunning {
  try {
    return Invoke-RestMethod -Uri "$baseUri/api/setup/status" -Method Get -TimeoutSec 5
  }
  catch {
    & (Join-Path $workspace "Start-CopyLab.ps1") -NoBrowser
    return Invoke-RestMethod -Uri "$baseUri/api/setup/status" -Method Get -TimeoutSec 15
  }
}

try {
  Clear-Host
  Write-Host "CopyLab dedicated wallet setup" -ForegroundColor Green
  Write-Host "This creates a new Solana wallet used only by CopyLab."
  Write-Host "Never enter a seed phrase from another wallet here." -ForegroundColor Yellow

  $status = Ensure-CopyLabRunning
  if ($status.wallet.exists) {
    Write-Host ""
    Write-Host "A dedicated wallet already exists:" -ForegroundColor Yellow
    Write-Host $status.wallet.address -ForegroundColor Cyan
    if (-not $status.wallet.backupConfirmed) {
      Write-Host "Its recovery backup has not been confirmed. Do not fund it until the original encrypted recovery file is secured." -ForegroundColor Red
    }
    else {
      Write-Host "Its encrypted recovery backup is confirmed."
    }
    Read-Host "Press Enter to close"
    exit 0
  }

  $documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
  $backupDirectory = Join-Path $documents "CopyLab Recovery"
  [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null

  $writeProbe = Join-Path $backupDirectory (".write-test-{0}" -f [Guid]::NewGuid().ToString("N"))
  [IO.File]::WriteAllText($writeProbe, "ok")
  Remove-Item -LiteralPath $writeProbe -Force

  $passphrase = Read-RecoveryPassphrase
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $security = Invoke-RestMethod -Uri "$baseUri/api/security/csrf" -Method Get -WebSession $session -TimeoutSec 10
  $headers = @{ "x-csrf-token" = [string]$security.csrfToken }
  $body = @{ backupPassphrase = $passphrase } | ConvertTo-Json -Compress

  try {
    $created = Invoke-RestMethod -Uri "$baseUri/api/wallet/create" -Method Post -WebSession $session -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 30
  }
  finally {
    $passphrase = $null
    $body = $null
  }

  $safeFilename = [IO.Path]::GetFileName([string]$created.filename)
  $backupPath = Join-Path $backupDirectory $safeFilename
  if (Test-Path -LiteralPath $backupPath) {
    throw "Refusing to overwrite an existing recovery file: $backupPath"
  }

  $temporaryPath = "$backupPath.tmp"
  $recoveryJson = $created.recovery | ConvertTo-Json -Depth 12
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($temporaryPath, $recoveryJson, $utf8)
  Move-Item -LiteralPath $temporaryPath -Destination $backupPath

  Write-Host ""
  Write-Host "Wallet created." -ForegroundColor Green
  Write-Host "Address:" -ForegroundColor Gray
  Write-Host $created.address -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Encrypted recovery file:" -ForegroundColor Gray
  Write-Host $backupPath -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Before funding, copy that JSON file to a second safe offline location and make sure you remember the passphrase." -ForegroundColor Yellow

  $acknowledgement = Read-Host "After securing the file, type SAVED to confirm"
  if ($acknowledgement -cne "SAVED") {
    Write-Host "Backup confirmation was not recorded. Signing remains blocked." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 0
  }

  $confirmBody = @{ address = [string]$created.address } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$baseUri/api/wallet/confirm-backup" -Method Post -WebSession $session -Headers $headers -ContentType "application/json" -Body $confirmBody -TimeoutSec 15 | Out-Null

  Write-Host ""
  Write-Host "Recovery backup confirmed. The wallet is ready to receive funds." -ForegroundColor Green
  Write-Host "Live trading remains locked until CopyLab's paper and manual promotion gates pass." -ForegroundColor Yellow
  Read-Host "Press Enter to close"
}
catch {
  Write-Host ""
  Write-Host "Wallet setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "No primary-wallet secret was requested or imported."
  Read-Host "Press Enter to close"
  exit 1
}
