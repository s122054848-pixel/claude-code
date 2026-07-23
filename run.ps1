<#
  Dispatch planner -- end to end: pull one day's confirmed sales orders from the
  T10 Informix ERP, group/pack them into truck loads by delivery-customer proximity,
  and produce a dispatch sheet (CSV) plus an interactive 3D-loading / route-map report (HTML).

  Usage:
      .\run.ps1 -Date 2026-07-08
      .\run.ps1 -Date 2026-07-08 -TruckL 8400 -TruckW 2400 -TruckH 2300
      .\run.ps1 -Date 2026-07-08 -Open        # also opens the HTML report when done

  Requires:
    - config.json filled in with your Informix connection details (see config.example.json)
    - 32-bit Informix ODBC driver + IBM Informix Client-SDK installed (see README.md)
    - Python 3 on PATH (64-bit is fine, only the DB step needs 32-bit PowerShell)
#>
param(
    [Parameter(Mandatory = $true)][string]$Date,   # yyyy-MM-dd
    [double]$TruckL,
    [double]$TruckW,
    [double]$TruckH,
    [switch]$Open
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$configPath = Join-Path $root "config.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json

if (-not $TruckL) { $TruckL = $config.truck.L }
if (-not $TruckW) { $TruckW = $config.truck.W }
if (-not $TruckH) { $TruckH = $config.truck.H }

$outDir = Join-Path $root "output"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$ordersCsv = Join-Path $outDir "orders_$Date.csv"
$dispatchCsv = Join-Path $outDir "dispatch_sheet_$Date.csv"
$reportHtml = Join-Path $outDir "dispatch_$Date.html"

Write-Host "== Step 1/2: extracting confirmed orders for $Date from T10 (32-bit ODBC) ==" -ForegroundColor Cyan
$psx86 = "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
& $psx86 -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "lib\extract_orders.ps1") `
    -Date $Date -ConfigPath $configPath -OutCsv $ordersCsv
if ($LASTEXITCODE -ne 0) { throw "extract_orders.ps1 failed (exit $LASTEXITCODE)" }

Write-Host "== Step 2/2: packing trucks and building the report (Python) ==" -ForegroundColor Cyan
python (Join-Path $root "lib\build_dispatch.py") `
    --csv $ordersCsv --date $Date `
    --template (Join-Path $root "lib\template.html") `
    --out-html $reportHtml --out-csv $dispatchCsv `
    --truck-l $TruckL --truck-w $TruckW --truck-h $TruckH
if ($LASTEXITCODE -ne 0) { throw "build_dispatch.py failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Dispatch sheet: $dispatchCsv"
Write-Host "  HTML report:    $reportHtml"

if ($Open) { Start-Process $reportHtml }
