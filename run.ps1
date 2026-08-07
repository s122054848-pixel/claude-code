<#
  Dispatch planner -- end to end: pull a date RANGE of confirmed sales orders from the
  T10 Informix ERP, group/pack them into truck loads by delivery-customer proximity (never
  mixing orders due out on different delivery dates onto one truck), and produce a dispatch
  sheet (CSV/Excel) plus an interactive 3D-loading / route-map / 模擬裝車 report (HTML) --
  the HTML report supports the full date range interactively, same as the demo Artifact.

  Usage:
      .\run.ps1 -StartDate 2026-07-08                          # single day (EndDate defaults to StartDate)
      .\run.ps1 -StartDate 2026-07-01 -EndDate 2026-07-08       # a date range
      .\run.ps1 -StartDate 2026-07-08 -TruckL 8700 -TruckW 2400 -TruckH 2400
      .\run.ps1 -StartDate 2026-07-08 -LoadMode manual   # hand-stacked, no pallets (default: pallet)
      .\run.ps1 -StartDate 2026-07-08 -Open              # also opens the HTML report when done

  Requires:
    - config.json filled in with your Informix connection details (see config.example.json)
    - 32-bit Informix ODBC driver + IBM Informix Client-SDK installed (see README.md)
    - Python 3 on PATH (64-bit is fine, only the DB step needs 32-bit PowerShell)
#>
param(
    [Parameter(Mandatory = $true)][string]$StartDate,   # yyyy-MM-dd
    [string]$EndDate,                                   # yyyy-MM-dd, inclusive -- defaults to StartDate
    [double]$TruckL,
    [double]$TruckW,
    [double]$TruckH,
    [ValidateSet("pallet", "manual")][string]$LoadMode = "pallet",
    [double]$OverhangW = 50,
    [double]$OverhangL = 300,
    [switch]$Open
)

$ErrorActionPreference = "Stop"
if (-not $EndDate) { $EndDate = $StartDate }
$dateLabel = if ($StartDate -eq $EndDate) { $StartDate } else { "$StartDate~$EndDate" }

$root = $PSScriptRoot
$configPath = Join-Path $root "config.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json

if (-not $TruckL) { $TruckL = $config.truck.L }
if (-not $TruckW) { $TruckW = $config.truck.W }
if (-not $TruckH) { $TruckH = $config.truck.H }

$outDir = Join-Path $root "output"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$fileTag = if ($StartDate -eq $EndDate) { $StartDate } else { "${StartDate}_to_${EndDate}" }
$ordersCsv = Join-Path $outDir "orders_$fileTag.csv"
$dispatchCsv = Join-Path $outDir "dispatch_sheet_$fileTag.csv"
$dispatchXlsx = Join-Path $outDir "dispatch_sheet_$fileTag.xlsx"
$reportHtml = Join-Path $outDir "dispatch_$fileTag.html"

Write-Host "== Step 1/2: extracting confirmed orders for $dateLabel from T10 (32-bit ODBC) ==" -ForegroundColor Cyan
$psx86 = "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
& $psx86 -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "lib\extract_orders.ps1") `
    -StartDate $StartDate -EndDate $EndDate -ConfigPath $configPath -OutCsv $ordersCsv
if ($LASTEXITCODE -ne 0) { throw "extract_orders.ps1 failed (exit $LASTEXITCODE)" }

Write-Host "== Step 2/2: packing trucks and building the report (Python) ==" -ForegroundColor Cyan
python (Join-Path $root "lib\build_dispatch.py") `
    --csv $ordersCsv --date $dateLabel `
    --template (Join-Path $root "lib\template.html") `
    --out-html $reportHtml --out-csv $dispatchCsv --out-xlsx $dispatchXlsx `
    --truck-l $TruckL --truck-w $TruckW --truck-h $TruckH `
    --load-mode $LoadMode --overhang-w $OverhangW --overhang-l $OverhangL `
    --plant $config.db.database
if ($LASTEXITCODE -ne 0) { throw "build_dispatch.py failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Dispatch sheet (CSV):   $dispatchCsv"
Write-Host "  Dispatch sheet (Excel): $dispatchXlsx"
Write-Host "  HTML report:            $reportHtml"

if ($Open) { Start-Process $reportHtml }
