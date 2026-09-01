[CmdletBinding()]
param(
  [switch]$ValidateOnly,
  [ValidateSet("Auto", "Manual")][string]$LaunchMode = "Auto",
  [string]$ControlStateTestPath,
  [ValidateSet("maintenance", "supervisor-stop")][string]$ControlStateTestType = "maintenance"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Set-Location -LiteralPath $PSScriptRoot

$url = "http://127.0.0.1:4310"
$healthUrl = "$url/api/health"
$healthTimeoutSeconds = 30
$dataDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "data"))
$serverEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\server\dist\index.js"))
$webEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "apps\web\dist\index.html"))
$serverPidFile = Join-Path $dataDirectory "server.pid"
$supervisorPidFile = Join-Path $dataDirectory "supervisor.pid"
$lockFile = Join-Path $dataDirectory "supervisor.lock"
$stopRequestFile = Join-Path $dataDirectory "stop.request"
$supervisorStopRequestFile = Join-Path $dataDirectory "supervisor.stop.request"
$maintenanceRequestFile = Join-Path $dataDirectory "supervisor.maintenance.request"
$statusFile = Join-Path $dataDirectory "supervisor.status.json"
$logFile = Join-Path $dataDirectory "supervisor.log"
$stdoutLog = Join-Path $dataDirectory "server-out.log"
$stderrLog = Join-Path $dataDirectory "server-error.log"
$maintenanceLeaseDuration = [TimeSpan]::FromHours(2)
$stopLeaseDuration = [TimeSpan]::FromMinutes(10)
$ambiguousLeaseGrace = [TimeSpan]::FromMinutes(5)

function New-ControlRequestState {
  param(
    [Parameter(Mandatory = $true)][string]$State,
    [Parameter(Mandatory = $true)][bool]$Active,
    [Parameter(Mandatory = $true)][string]$Reason,
    [AllowNull()][string]$RequestId = $null,
    [AllowNull()][Nullable[int]]$OwnerPid = $null
  )
  return [pscustomobject]@{
    State = $State
    Active = $Active
    Reason = $Reason
    RequestId = $RequestId
    OwnerPid = $OwnerPid
  }
}

function Remove-ControlRequestIfUnchanged {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedContent
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $true }
  try {
    $current = Get-Content -LiteralPath $Path -Raw
    if ($current -cne $ExpectedContent) { return $false }
    Remove-Item -LiteralPath $Path -Force
    return -not (Test-Path -LiteralPath $Path)
  } catch {
    return $false
  }
}

function Get-ControlRequestState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet("maintenance", "supervisor-stop")][string]$RequestType,
    [switch]$RecoverStale
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return New-ControlRequestState -State "MISSING" -Active $false -Reason "No control request exists."
  }

  $maximumDuration = if ($RequestType -eq "maintenance") {
    $maintenanceLeaseDuration
  } else {
    $stopLeaseDuration
  }
  $now = [DateTimeOffset]::UtcNow
  try {
    $item = Get-Item -LiteralPath $Path -Force
  } catch {
    if (-not (Test-Path -LiteralPath $Path)) {
      return New-ControlRequestState -State "MISSING" -Active $false -Reason "The control request was released during inspection."
    }
    return New-ControlRequestState -State "AMBIGUOUS" -Active $true -Reason "The control request metadata could not be inspected safely."
  }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    return New-ControlRequestState -State "AMBIGUOUS" -Active $true -Reason "The control request is a link or reparse point."
  }

  $raw = $null
  $lease = $null
  try {
    $raw = [string](Get-Content -LiteralPath $Path -Raw)
    if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 4096) { throw "Control request is too large." }
    # PowerShell 7.6 auto-converts ISO JSON strings into DateTime values unless
    # DateKind=String is requested. Preserve the signed wire representation so
    # the strict round-trip timestamp parser below behaves identically on
    # Windows PowerShell 5.1 and modern pwsh.
    $jsonOptions = @{}
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey("DateKind")) {
      $jsonOptions.DateKind = "String"
    }
    $lease = $raw | ConvertFrom-Json @jsonOptions
  } catch {
    $age = $now.UtcDateTime - $item.LastWriteTimeUtc
    if ($null -ne $raw -and $age -gt $maximumDuration.Add($ambiguousLeaseGrace)) {
      if ($RecoverStale -and (Remove-ControlRequestIfUnchanged -Path $Path -ExpectedContent $raw)) {
        return New-ControlRequestState -State "STALE_RECOVERED" -Active $false -Reason "An old malformed control request was removed."
      }
      return New-ControlRequestState -State "STALE" -Active $true -Reason "An old malformed control request could not be removed safely."
    }
    return New-ControlRequestState -State "AMBIGUOUS" -Active $true -Reason "The control request is malformed or being published."
  }

  $required = @("formatVersion", "requestType", "requestId", "ownerPid", "createdAt", "expiresAt")
  $properties = if ($null -eq $lease) { @() } else { @($lease.PSObject.Properties.Name) }
  $missing = @($required | Where-Object { $_ -notin $properties })
  $ownerPid = 0
  $requestId = [guid]::Empty
  $createdAt = [DateTimeOffset]::MinValue
  $expiresAt = [DateTimeOffset]::MinValue
  $valid = $missing.Count -eq 0
  if ($valid) {
    try {
      $valid = [int]$lease.formatVersion -eq 1 -and
        [string]$lease.requestType -ceq $RequestType -and
        [guid]::TryParse([string]$lease.requestId, [ref]$requestId) -and
        $requestId -ne [guid]::Empty -and
        [int]::TryParse([string]$lease.ownerPid, [ref]$ownerPid) -and
        $ownerPid -gt 0
      if ($valid) {
        $createdAt = [DateTimeOffset]::ParseExact(
          [string]$lease.createdAt,
          "o",
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::RoundtripKind
        )
        $expiresAt = [DateTimeOffset]::ParseExact(
          [string]$lease.expiresAt,
          "o",
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::RoundtripKind
        )
        $duration = $expiresAt - $createdAt
        $valid = $duration -gt [TimeSpan]::Zero -and
          $duration -le $maximumDuration -and
          $createdAt -le $now.AddMinutes(2)
      }
    } catch {
      $valid = $false
    }
  }
  if (-not $valid) {
    $age = $now.UtcDateTime - $item.LastWriteTimeUtc
    if ($age -gt $maximumDuration.Add($ambiguousLeaseGrace)) {
      if ($RecoverStale -and (Remove-ControlRequestIfUnchanged -Path $Path -ExpectedContent $raw)) {
        return New-ControlRequestState -State "STALE_RECOVERED" -Active $false -Reason "An old invalid control request was removed."
      }
      return New-ControlRequestState -State "STALE" -Active $true -Reason "An old invalid control request could not be removed safely."
    }
    return New-ControlRequestState -State "AMBIGUOUS" -Active $true -Reason "The control request schema or lease bounds are invalid."
  }

  $staleReason = $null
  if ($expiresAt -le $now) {
    $staleReason = "The control-request lease expired."
  } else {
    $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $owner) {
      $staleReason = "The control-request owner process no longer exists."
    } else {
      try {
        $ownerStartedAt = [DateTimeOffset]$owner.StartTime.ToUniversalTime()
        if ($ownerStartedAt -gt $createdAt.AddSeconds(5)) {
          $staleReason = "The control-request PID was reused after its lease was created."
        } elseif ($owner.ProcessName -notmatch '^(?:powershell|pwsh)$') {
          return New-ControlRequestState -State "AMBIGUOUS" -Active $true -Reason "The live owner process type is not a recognized PowerShell host." -RequestId $requestId.ToString() -OwnerPid $ownerPid
        }
      } catch {
        return New-ControlRequestState -State "AMBIGUOUS" -Active $true -Reason "The control-request owner could not be validated." -RequestId $requestId.ToString() -OwnerPid $ownerPid
      }
    }
  }
  if ($null -ne $staleReason) {
    if ($RecoverStale -and (Remove-ControlRequestIfUnchanged -Path $Path -ExpectedContent $raw)) {
      return New-ControlRequestState -State "STALE_RECOVERED" -Active $false -Reason $staleReason -RequestId $requestId.ToString() -OwnerPid $ownerPid
    }
    return New-ControlRequestState -State "STALE" -Active $true -Reason "$staleReason The file could not be removed safely." -RequestId $requestId.ToString() -OwnerPid $ownerPid
  }
  return New-ControlRequestState -State "LIVE" -Active $true -Reason "The bounded control-request lease and its owner are live." -RequestId $requestId.ToString() -OwnerPid $ownerPid
}

function Protect-CopyLabLogText {
  param([AllowNull()][object]$Value)
  $text = if ($null -eq $Value) { "" } else { [string]$Value }
  $text = $text -replace '(?i)\bBearer\s+[^\s,;]+', 'Bearer [REDACTED]'
  $text = $text -replace '(?i)\b(api[-_ ]?key|authorization|password|passphrase|secret|token)\b\s*[:=]\s*[^\s,;]+', '$1=[REDACTED]'
  $text = $text -replace '(?i)(https?://[^?\s]+)\?[^\s]+', '$1?[REDACTED]'
  if ($text.Length -gt 600) { $text = $text.Substring(0, 600) + "..." }
  return $text
}

function Write-SupervisorEvent {
  param(
    [Parameter(Mandatory = $true)][string]$Event,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if ((Test-Path -LiteralPath $logFile -PathType Leaf) -and (Get-Item -LiteralPath $logFile).Length -ge 5MB) {
    $previousLog = "$logFile.1"
    Remove-Item -LiteralPath $previousLog -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $logFile -Destination $previousLog
  }
  $record = [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    event = Protect-CopyLabLogText $Event
    message = Protect-CopyLabLogText $Message
  }
  $line = ($record | ConvertTo-Json -Compress) + [Environment]::NewLine
  [IO.File]::AppendAllText($logFile, $line, [Text.UTF8Encoding]::new($false))
}

function Publish-SupervisorStatus {
  param(
    [Parameter(Mandatory = $true)][string]$State,
    [Parameter(Mandatory = $true)][string]$Message,
    [AllowNull()][Nullable[int]]$ServerPid = $null,
    [int]$ConsecutiveFailures = 0,
    [int]$BackoffSeconds = 0,
    [AllowNull()][string]$ControlRequestId = $null
  )
  $status = [ordered]@{
    formatVersion = 1
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    state = $State
    message = Protect-CopyLabLogText $Message
    supervisorPid = $PID
    serverPid = if ($null -eq $ServerPid) { $null } else { [int]$ServerPid }
    consecutiveFailures = $ConsecutiveFailures
    backoffSeconds = $BackoffSeconds
    controlRequestId = $ControlRequestId
    healthEndpoint = $healthUrl
  }
  $temporary = "$statusFile.incomplete-$PID"
  try {
    [IO.File]::WriteAllText(
      $temporary,
      ($status | ConvertTo-Json -Depth 3),
      [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporary -Destination $statusFile -Force
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Get-VerifiedServerProcess {
  if (-not (Test-Path -LiteralPath $serverPidFile -PathType Leaf)) {
    # During a multi-gigabyte startup migration the child may exist for several
    # minutes before it is able to listen and publish server.pid. Adopt exactly
    # one command-line match so a supervisor introduced during that window does
    # not create a duplicate Node process.
    $expectedEntry = $serverEntry.Replace("/", "\")
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $candidateCommand = if ($null -eq $_.CommandLine) { "" } else { ([string]$_.CommandLine).Replace("/", "\") }
      $candidateCommand.IndexOf($expectedEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($candidates.Count -gt 1) {
      throw "More than one CopyLab child command was found; duplicate recovery was refused."
    }
    if ($candidates.Count -eq 1) {
      return [pscustomobject]@{ Id = [int]$candidates[0].ProcessId; CommandLine = [string]$candidates[0].CommandLine }
    }
    return $null
  }
  $pidText = (Get-Content -LiteralPath $serverPidFile -Raw).Trim()
  $serverPid = 0
  if (-not [int]::TryParse($pidText, [ref]$serverPid)) {
    Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
  if ($null -eq $processInfo) {
    Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  $commandLine = if ($null -eq $processInfo.CommandLine) { "" } else { [string]$processInfo.CommandLine }
  $normalizedCommand = $commandLine.Replace("/", "\")
  if (
    $processInfo.Name -notmatch '^node(?:\.exe)?$' -or
    $normalizedCommand.IndexOf($serverEntry.Replace("/", "\"), [StringComparison]::OrdinalIgnoreCase) -lt 0
  ) {
    throw "The server PID file points to a process that is not CopyLab. No process was adopted or stopped."
  }
  return [pscustomobject]@{ Id = $serverPid; CommandLine = $normalizedCommand }
}

function Test-CopyLabHealth {
  try {
    # The server performs some legacy synchronous dashboard work. A dedicated
    # constant-time route avoids adding database/vault work to this probe, while
    # the bounded response window tolerates an in-flight event-loop stall without
    # recycling an otherwise healthy child.
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec $healthTimeoutSeconds
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-ProcessAlive {
  param([int]$ProcessId)
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Start-CopyLabServerProcess {
  $existing = Get-VerifiedServerProcess
  if ($null -ne $existing) { return $existing }

  if (Test-CopyLabHealth) {
    throw "Port 4310 answered the CopyLab health probe without a verified CopyLab PID; startup was refused to prevent a duplicate or port collision."
  }

  Remove-Item -LiteralPath $stopRequestFile -Force -ErrorAction SilentlyContinue
  $env:COPYLAB_PORT = "4310"
  $env:COPYLAB_DATA_DIR = $dataDirectory
  $env:COPYLAB_DB_PATH = Join-Path $dataDirectory "copylab.db"
  $env:COPYLAB_LEARNING_DB_PATH = Join-Path $dataDirectory "learning.db"
  $remoteOriginFile = Join-Path $dataDirectory "remote-readonly-origin.txt"
  if (Test-Path -LiteralPath $remoteOriginFile -PathType Leaf) {
    $env:COPYLAB_REMOTE_READONLY_ORIGIN = (Get-Content -LiteralPath $remoteOriginFile -Raw).Trim()
  } else {
    Remove-Item Env:COPYLAB_REMOTE_READONLY_ORIGIN -ErrorAction SilentlyContinue
  }

  $node = (Get-Command node -ErrorAction Stop).Source
  $process = Start-Process `
    -FilePath $node `
    -ArgumentList @("`"$serverEntry`"") `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
  Write-SupervisorEvent -Event "server_starting" -Message "Started the local CopyLab child process."
  return [pscustomobject]@{ Id = [int]$process.Id; CommandLine = $serverEntry }
}

function Stop-CopyLabServerProcess {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [ValidateRange(1, 900)][int]$GraceSeconds = 120,
    [Parameter(Mandatory = $true)][string]$Reason
  )
  if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
    Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
    return
  }

  Set-Content -LiteralPath $stopRequestFile -Value "stop" -NoNewline
  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  while ((Get-Date) -lt $deadline -and (Test-ProcessAlive -ProcessId $ProcessId)) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-ProcessAlive -ProcessId $ProcessId) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    $commandLine = if ($null -eq $processInfo -or $null -eq $processInfo.CommandLine) { "" } else { [string]$processInfo.CommandLine }
    if (
      $null -eq $processInfo -or
      $processInfo.Name -notmatch '^node(?:\.exe)?$' -or
      $commandLine.Replace("/", "\").IndexOf($serverEntry.Replace("/", "\"), [StringComparison]::OrdinalIgnoreCase) -lt 0
    ) {
      throw "The managed child PID no longer belongs to CopyLab; force-stop was refused."
    }
    Stop-Process -Id $ProcessId -Force
    Write-SupervisorEvent -Event "server_force_stopped" -Message "The child exceeded its bounded graceful-stop window during $Reason."
  } else {
    Write-SupervisorEvent -Event "server_stopped" -Message "The child stopped cleanly during $Reason."
  }
  Remove-Item -LiteralPath $serverPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stopRequestFile -Force -ErrorAction SilentlyContinue
}

function Wait-CopyLabInterruptible {
  param([ValidateRange(0, 3600)][int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $stopState = Get-ControlRequestState `
      -Path $supervisorStopRequestFile `
      -RequestType "supervisor-stop" `
      -RecoverStale
    $maintenanceState = Get-ControlRequestState `
      -Path $maintenanceRequestFile `
      -RequestType "maintenance" `
      -RecoverStale
    if ($stopState.Active -or $maintenanceState.Active) { return }
    Start-Sleep -Milliseconds 250
  }
}

function Test-AnyActiveControlRequest {
  $stopState = Get-ControlRequestState `
    -Path $supervisorStopRequestFile `
    -RequestType "supervisor-stop" `
    -RecoverStale
  $maintenanceState = Get-ControlRequestState `
    -Path $maintenanceRequestFile `
    -RequestType "maintenance" `
    -RecoverStale
  return [bool]($stopState.Active -or $maintenanceState.Active)
}

if (-not [string]::IsNullOrWhiteSpace($ControlStateTestPath)) {
  $testPath = [IO.Path]::GetFullPath($ControlStateTestPath)
  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  ) + [IO.Path]::DirectorySeparatorChar
  if (-not $testPath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Control-state tests are restricted to the operating-system temporary directory."
  }
  Get-ControlRequestState -Path $testPath -RequestType $ControlStateTestType -RecoverStale
  return
}

foreach ($required in @($serverEntry, $webEntry)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "CopyLab is not built. Run Setup-CopyLab.cmd before starting the supervisor."
  }
}
$nodeCommand = Get-Command node -ErrorAction Stop
if ($ValidateOnly) {
  [pscustomobject]@{
    ok = $true
    supervisor = $MyInvocation.MyCommand.Path
    node = $nodeCommand.Source
    healthEndpoint = $healthUrl
  }
  return
}

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$lockStream = $null
$ownsLock = $false
try {
  try {
    $lockStream = [IO.File]::Open(
      $lockFile,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch [IO.IOException] {
    # Another same-user supervisor owns the exclusive file handle. Exiting
    # successfully keeps Task Scheduler and concurrent launchers from creating
    # a restart storm around the already-running instance.
    return
  }
  $ownsLock = $true

  $lockStream.SetLength(0)
  $lockBytes = [Text.Encoding]::ASCII.GetBytes([string]$PID)
  $lockStream.Write($lockBytes, 0, $lockBytes.Length)
  $lockStream.Flush($true)
  Set-Content -LiteralPath $supervisorPidFile -Value ([string]$PID) -NoNewline
  Write-SupervisorEvent -Event "supervisor_started" -Message "The same-user CopyLab supervisor acquired its exclusive lock."

  $failureTimes = @()
  $restartAttempt = 0
  $healthySince = $null
  $consecutiveUnhealthy = 0
  $crashLoopUntil = $null
  $managedServerPid = $null

  while ($true) {
    $stopState = Get-ControlRequestState `
      -Path $supervisorStopRequestFile `
      -RequestType "supervisor-stop" `
      -RecoverStale
    if ($stopState.State -eq "STALE_RECOVERED") {
      Write-SupervisorEvent -Event "stale_stop_request_recovered" -Message "$($stopState.Reason) Launch mode: $LaunchMode."
    }
    if ($stopState.State -eq "LIVE") { break }
    if ($stopState.Active) {
      $blockedServer = Get-VerifiedServerProcess
      if ($null -ne $blockedServer) {
        Publish-SupervisorStatus -State "STOPPING_FOR_CONTROL_REVIEW" -Message "A fresh but ambiguous stop request is being honored fail-safe." -ServerPid $blockedServer.Id
        Stop-CopyLabServerProcess -ProcessId $blockedServer.Id -GraceSeconds 120 -Reason "ambiguous supervisor stop request"
        $managedServerPid = $null
      }
      Publish-SupervisorStatus -State "CONTROL_REQUEST_BLOCKED" -Message $stopState.Reason
      Start-Sleep -Milliseconds 500
      continue
    }

    $maintenanceState = Get-ControlRequestState `
      -Path $maintenanceRequestFile `
      -RequestType "maintenance" `
      -RecoverStale
    if ($maintenanceState.State -eq "STALE_RECOVERED") {
      Write-SupervisorEvent -Event "stale_maintenance_request_recovered" -Message "$($maintenanceState.Reason) Launch mode: $LaunchMode."
    }
    if ($maintenanceState.Active) {
      $maintenanceServer = Get-VerifiedServerProcess
      if ($null -ne $maintenanceServer) {
        Publish-SupervisorStatus -State "STOPPING_FOR_MAINTENANCE" -Message "A planned maintenance pause was requested." -ServerPid $maintenanceServer.Id
        Stop-CopyLabServerProcess -ProcessId $maintenanceServer.Id -GraceSeconds 600 -Reason "planned maintenance"
        $managedServerPid = $null
      }
      if ($maintenanceState.State -eq "LIVE") {
        Publish-SupervisorStatus `
          -State "MAINTENANCE" `
          -Message "The child service is stopped for a planned maintenance window." `
          -ControlRequestId $maintenanceState.RequestId
      } else {
        Publish-SupervisorStatus -State "CONTROL_REQUEST_BLOCKED" -Message $maintenanceState.Reason
      }
      Start-Sleep -Milliseconds 500
      continue
    }

    $server = Get-VerifiedServerProcess
    if ($null -eq $server -and $null -ne $managedServerPid) {
      $failureTimes += Get-Date
      $failureTimes = @($failureTimes | Where-Object { $_ -gt (Get-Date).AddMinutes(-10) })
      $restartAttempt += 1
      $healthySince = $null
      $managedServerPid = $null
      Write-SupervisorEvent -Event "server_exited" -Message "The child exited unexpectedly and will be restarted with bounded backoff."
      if ($failureTimes.Count -ge 5) {
        $crashLoopUntil = (Get-Date).AddMinutes(15)
        Write-SupervisorEvent -Event "crash_loop_detected" -Message "Five failures occurred inside ten minutes; restart attempts are cooling down for fifteen minutes."
      }
    } elseif ($null -ne $server) {
      $managedServerPid = [int]$server.Id
    }
    if ($null -eq $server) {
      $now = Get-Date
      $failureTimes = @($failureTimes | Where-Object { $_ -gt $now.AddMinutes(-10) })
      if ($null -ne $crashLoopUntil -and $now -lt $crashLoopUntil) {
        $remaining = [Math]::Max(1, [int][Math]::Ceiling(($crashLoopUntil - $now).TotalSeconds))
        Publish-SupervisorStatus -State "CRASH_LOOP" -Message "Repeated failures triggered a bounded recovery cooldown." -ConsecutiveFailures $failureTimes.Count -BackoffSeconds $remaining
        Wait-CopyLabInterruptible -Seconds ([Math]::Min($remaining, 5))
        continue
      }
      $crashLoopUntil = $null

      if ($restartAttempt -gt 0) {
        $backoffSeconds = [int][Math]::Min(60, [Math]::Pow(2, [Math]::Min($restartAttempt, 5)))
        Publish-SupervisorStatus -State "BACKOFF" -Message "Waiting before a bounded child restart." -ConsecutiveFailures $failureTimes.Count -BackoffSeconds $backoffSeconds
        Wait-CopyLabInterruptible -Seconds $backoffSeconds
        if (Test-AnyActiveControlRequest) { continue }
      }

      try {
        $server = Start-CopyLabServerProcess
        $managedServerPid = [int]$server.Id
        Publish-SupervisorStatus -State "STARTING" -Message "Waiting for the loopback health probe." -ServerPid $server.Id -ConsecutiveFailures $failureTimes.Count
      } catch {
        $failureTimes += Get-Date
        $restartAttempt += 1
        Write-SupervisorEvent -Event "server_start_failed" -Message $_.Exception.Message
        if ($failureTimes.Count -ge 5) {
          $crashLoopUntil = (Get-Date).AddMinutes(15)
          Write-SupervisorEvent -Event "crash_loop_detected" -Message "Five failures occurred inside ten minutes; restart attempts are cooling down for fifteen minutes."
        }
        continue
      }

      $startupDeadline = (Get-Date).AddMinutes(10)
      $ready = $false
      while ((Get-Date) -lt $startupDeadline) {
        if (Test-AnyActiveControlRequest) { break }
        if (-not (Test-ProcessAlive -ProcessId $server.Id)) { break }
        if (Test-CopyLabHealth) {
          $ready = $true
          break
        }
        Start-Sleep -Milliseconds 500
      }

      if (-not $ready) {
        if (Test-ProcessAlive -ProcessId $server.Id) {
          $startupMaintenanceState = Get-ControlRequestState `
            -Path $maintenanceRequestFile `
            -RequestType "maintenance" `
            -RecoverStale
          $startupStopGrace = if ($startupMaintenanceState.Active) { 600 } else { 120 }
          Stop-CopyLabServerProcess -ProcessId $server.Id -GraceSeconds $startupStopGrace -Reason "failed or interrupted startup health check"
        }
        $managedServerPid = $null
        if (-not (Test-AnyActiveControlRequest)) {
          $failureTimes += Get-Date
          $failureTimes = @($failureTimes | Where-Object { $_ -gt (Get-Date).AddMinutes(-10) })
          $restartAttempt += 1
          Write-SupervisorEvent -Event "startup_health_failed" -Message "The child did not become healthy inside the bounded startup window."
          if ($failureTimes.Count -ge 5) {
            $crashLoopUntil = (Get-Date).AddMinutes(15)
            Write-SupervisorEvent -Event "crash_loop_detected" -Message "Five failures occurred inside ten minutes; restart attempts are cooling down for fifteen minutes."
          }
        }
        continue
      }

      $healthySince = Get-Date
      $consecutiveUnhealthy = 0
      Publish-SupervisorStatus -State "HEALTHY" -Message "The loopback health probe is ready." -ServerPid $server.Id -ConsecutiveFailures $failureTimes.Count
      Write-SupervisorEvent -Event "server_healthy" -Message "The child passed the loopback health probe."
    }

    if (-not (Test-ProcessAlive -ProcessId $server.Id)) {
      $failureTimes += Get-Date
      $failureTimes = @($failureTimes | Where-Object { $_ -gt (Get-Date).AddMinutes(-10) })
      $restartAttempt += 1
      $healthySince = $null
      $managedServerPid = $null
      Write-SupervisorEvent -Event "server_exited" -Message "The child exited unexpectedly and will be restarted with bounded backoff."
      if ($failureTimes.Count -ge 5) {
        $crashLoopUntil = (Get-Date).AddMinutes(15)
        Write-SupervisorEvent -Event "crash_loop_detected" -Message "Five failures occurred inside ten minutes; restart attempts are cooling down for fifteen minutes."
      }
      continue
    }

    if (Test-CopyLabHealth) {
      $consecutiveUnhealthy = 0
      if ($null -eq $healthySince) { $healthySince = Get-Date }
      if ((Get-Date) -gt $healthySince.AddMinutes(15)) {
        $restartAttempt = 0
        $failureTimes = @()
      }
      Publish-SupervisorStatus -State "HEALTHY" -Message "The loopback health probe is ready." -ServerPid $server.Id -ConsecutiveFailures $failureTimes.Count
    } else {
      $consecutiveUnhealthy += 1
      Publish-SupervisorStatus -State "UNHEALTHY" -Message "The loopback health probe did not answer." -ServerPid $server.Id -ConsecutiveFailures $consecutiveUnhealthy
      if ($consecutiveUnhealthy -ge 3) {
        Stop-CopyLabServerProcess -ProcessId $server.Id -GraceSeconds 120 -Reason "repeated health-probe failure"
        $managedServerPid = $null
        $failureTimes += Get-Date
        $failureTimes = @($failureTimes | Where-Object { $_ -gt (Get-Date).AddMinutes(-10) })
        $restartAttempt += 1
        $healthySince = $null
        $consecutiveUnhealthy = 0
        Write-SupervisorEvent -Event "health_restart" -Message "Three consecutive loopback health probes failed; the child was recycled."
        if ($failureTimes.Count -ge 5) {
          $crashLoopUntil = (Get-Date).AddMinutes(15)
          Write-SupervisorEvent -Event "crash_loop_detected" -Message "Five failures occurred inside ten minutes; restart attempts are cooling down for fifteen minutes."
        }
      }
    }
    Wait-CopyLabInterruptible -Seconds 5
  }

  $finalServer = Get-VerifiedServerProcess
  Publish-SupervisorStatus -State "STOPPING" -Message "A same-user supervisor stop was requested." -ServerPid $(if ($null -eq $finalServer) { $null } else { $finalServer.Id })
  if ($null -ne $finalServer) {
    Stop-CopyLabServerProcess -ProcessId $finalServer.Id -GraceSeconds 120 -Reason "supervisor shutdown"
  }
  Publish-SupervisorStatus -State "STOPPED" -Message "The CopyLab supervisor and child service are stopped."
  Write-SupervisorEvent -Event "supervisor_stopped" -Message "The supervisor completed a requested shutdown."
} catch {
  try {
    Write-SupervisorEvent -Event "supervisor_failed" -Message $_.Exception.Message
    Publish-SupervisorStatus -State "FAILED" -Message $_.Exception.Message
  } catch {
    # Preserve the original failure if status publication itself is unavailable.
  }
  try {
    $unmanagedChild = Get-VerifiedServerProcess
    if ($null -ne $unmanagedChild) {
      Stop-CopyLabServerProcess -ProcessId $unmanagedChild.Id -GraceSeconds 120 -Reason "supervisor failure"
    }
  } catch {
    # The original supervisor failure remains authoritative. PID validation in
    # Stop-CopyLabServerProcess still prevents stopping an unrelated process.
  }
  throw
} finally {
  if ($ownsLock) {
    Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorStopRequestFile -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
