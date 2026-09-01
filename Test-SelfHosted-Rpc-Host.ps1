[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$processors = @(Get-CimInstance Win32_Processor)
$physicalDisks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)

$logicalProcessors = [int](($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
$physicalCores = [int](($processors | Measure-Object -Property NumberOfCores -Sum).Sum)
$memoryGb = [math]::Round(([double]$computer.TotalPhysicalMemory / 1GB), 1)
$nvme = @($physicalDisks | Where-Object { $_.BusType -eq "NVMe" -and $_.HealthStatus -eq "Healthy" })

$checks = @(
  [pscustomobject]@{
    Check = "Ubuntu 24.04"
    Passed = $false
    Observed = $os.Caption
    Required = "Dedicated native Ubuntu 24.04 host"
  },
  [pscustomobject]@{
    Check = "CPU"
    Passed = ($physicalCores -ge 16 -and $logicalProcessors -ge 32)
    Observed = "$physicalCores cores / $logicalProcessors threads"
    Required = "At least 16 cores / 32 threads"
  },
  [pscustomobject]@{
    Check = "Memory"
    Passed = ($memoryGb -ge 512)
    Observed = "$memoryGb GB"
    Required = "512 GB for the documented full RPC profile"
  },
  [pscustomobject]@{
    Check = "Separate NVMe volumes"
    Passed = ($nvme.Count -ge 3)
    Observed = "$($nvme.Count) healthy NVMe physical disk(s)"
    Required = "Separate high-write NVMe for accounts, ledger, and snapshots"
  },
  [pscustomobject]@{
    Check = "Accounts capacity"
    Passed = (@($nvme | Where-Object { $_.Size -ge 1TB }).Count -ge 2)
    Observed = "$(@($nvme | Where-Object { $_.Size -ge 1TB }).Count) NVMe disk(s) at least 1 TB"
    Required = "At least two separate 1 TB NVMe disks for accounts and ledger"
  },
  [pscustomobject]@{
    Check = "Snapshot capacity"
    Passed = (@($nvme | Where-Object { $_.Size -ge 500GB }).Count -ge 3)
    Observed = "$(@($nvme | Where-Object { $_.Size -ge 500GB }).Count) NVMe disk(s) at least 500 GB"
    Required = "A separate snapshot NVMe of at least 500 GB"
  }
)

$blockers = @($checks | Where-Object { -not $_.Passed })
[pscustomobject]@{
  ProductionReady = ($blockers.Count -eq 0)
  Machine = $env:COMPUTERNAME
  Checks = $checks
  Blockers = @($blockers | ForEach-Object { "$($_.Check): $($_.Observed); requires $($_.Required)" })
  ManualChecks = @(
    "Stable public IPv4 and at least 1 Gbit/s symmetric bandwidth",
    "RPC HTTP/WSS reachable only through loopback or a private management network",
    "Agave catch-up, archive-depth, restart, disk-pressure, and upgrade drills"
  )
} | ConvertTo-Json -Depth 5
