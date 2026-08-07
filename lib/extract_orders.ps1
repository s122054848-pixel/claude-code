<#
  Extracts a date RANGE of confirmed sales orders (with product dimensions and delivery
  customer geo-coordinates) from the T10 Informix ERP database into a CSV file. Filters on
  oea02 (訂單日期/order date); oea101 (訂單交期/delivery date) is pulled through as its own
  column so downstream tools can separate trucks by delivery date the way they're supposed
  to -- a single truck should never carry orders due out on different dates.

  Excludes order LINES that have already shipped: cxd_file is the shipment-note detail
  table, cxd03=oeb01 and cxd04=oeb03 together link a shipment line back to the SPECIFIC
  order line it shipped (matching only on the order number would incorrectly exclude an
  order's still-pending lines just because a different line of that same order already went
  out). Whether it's ACTUALLY left the plant is tracked in a separate table, cxw_file
  (factory-exit/departure record): a shipment note (cxd01, same value space as cxc_file's
  cxc01) counts as shipped once it exists in cxw_file.cxw04. (An earlier version of this
  filter used cxc_file.cxcconf='Y' as the shipped flag -- verified against real data that
  value never actually occurs in this table, so that version silently excluded nothing.
  cxw_file is the correct source for this.)

  The shipped-lines lookup is a SEPARATE query, not folded into the main 5-table join --
  doing it as one query throws an Informix query-plan error (same class of issue as the
  documented "retrieve row by rowid" quirk: this schema's joins get unstable past a certain
  size/shape, not a syntax problem). Matched against the main result set by (order_no,
  line_no) in PowerShell instead. Without this exclusion, a line that's already left the
  plant would still show up asking to be put on a NEW truck.

  Also excludes 備庫訂單 (stock/reserve-warehouse orders): the 3rd character of the order
  number (oea01) is 'B' for these (e.g. UTB-TB0001) -- verified against real data, ~0.32% of
  confirmed orders. These aren't real outbound deliveries, so they don't belong in dispatch
  planning at all.

  occ735 = 路線 (a named delivery route/zone the logistics team already assigns per customer,
  e.g. "01斗六" -- customers sharing one route code cluster tightly by coordinates, verified
  against real data) and occ734 = 主幹道 (the broader highway corridor multiple routes can
  share, e.g. "國3->台1嘉"). Only ~21%/~17% of customers have these set; build_dispatch.py
  falls back to geography-only grouping for customers without one.

  Dimensions: orders with oea37=1 (平板/紙板, flat paperboard sold by the pallet rather than
  boxed under a model) have NO utu_file model at all (oea40 is blank for every single one --
  verified against real data, confirmed via NOT EXISTS against 9856 such lines since
  2026-06-01), so a mandatory join to utu_file/utv_file silently drops them entirely -- they
  never showed up in dispatch planning before this fix. Their real dimensions live directly
  on the order line instead: oeb_file.oeb100/oeb101/oeb102 = width/length/thickness (mm),
  verified by cross-checking against oeb06's free-text description ("紙板 2000x2198" etc.
  matches oeb100/oeb101 exactly across dozens of samples; oeb102 varies too, so it's a real
  per-order value, not a coincidental constant).

  Model dimensions (utu_file/utv_file) are pulled as a SEPARATE small query and merged in
  PowerShell below, rather than joined into the main query -- folding a LEFT OUTER JOIN to
  utu_file/utv_file into the main join works fine against T10 but throws Informix's "retrieve
  row by rowid" error against T6/路竹廠 (same class of issue as the shipped-lines split below;
  this schema's joins get unstable past a certain size/shape on some plant databases, not a
  syntax problem -- which shape trips it seems to depend on the specific database's data/plan).
  Splitting it out sidesteps the query-plan issue on every plant this tool supports (T2/T10/
  T3/T6). Falls back to oeb100/101/102 only when no model match exists, so normal boxed
  orders are unaffected -- verified: same 136 modeled lines, same dimensions, plus 187
  newly-included 平板 lines, for a spot-checked date.

  Must run under 32-bit PowerShell (the installed Informix ODBC driver is 32-bit only):
    C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -File extract_orders.ps1 -StartDate 2026-07-01 -EndDate 2026-07-08

  run.ps1 handles this automatically -- you normally don't call this script directly.
#>
param(
    [Parameter(Mandatory = $true)][string]$StartDate,  # yyyy-MM-dd
    [Parameter(Mandatory = $true)][string]$EndDate,    # yyyy-MM-dd, inclusive
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\config.json"),
    [string]$OutCsv
)

$ErrorActionPreference = "Stop"

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$db = $config.db

if (-not $OutCsv) {
    $OutCsv = Join-Path $PSScriptRoot "..\output\orders_${StartDate}_to_${EndDate}.csv"
}
New-Item -ItemType Directory -Force -Path (Split-Path $OutCsv) | Out-Null

$env:INFORMIXDIR = $db.informixdir
$env:PATH = "$($db.informixdir)\bin;$env:PATH"

$dStart = [datetime]::ParseExact($StartDate, "yyyy-MM-dd", $null)
$dEnd = [datetime]::ParseExact($EndDate, "yyyy-MM-dd", $null)
$mdyStart = "MDY($($dStart.Month),$($dStart.Day),$($dStart.Year))"
$mdyEnd = "MDY($($dEnd.Month),$($dEnd.Day),$($dEnd.Year))"

$connStr = "DSN=$($db.dsn);DATABASE=$($db.database);UID=$($db.uid);PWD=$($db.pwd);"
$conn = New-Object System.Data.Odbc.OdbcConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandTimeout = 90
$cmd.CommandText = @"
SELECT
  a.oea01 AS order_no, a.oea02 AS order_date, a.oea101 AS delivery_date, a.oea04 AS ship_cust_code,
  o.occ02 AS ship_cust_name, o.occ732 AS ship_lat, o.occ733 AS ship_lng,
  o.occ735 AS route, o.occ734 AS main_road,
  b.oeb04 AS item_code, b.oeb12 AS qty_box, b.oeb03 AS line_no,
  a.oea40 AS model_code, b.oeb100 AS raw_width_mm, b.oeb101 AS raw_length_mm, b.oeb102 AS raw_thickness_mm
FROM oea_file a
JOIN oeb_file b ON a.oea01 = b.oeb01
JOIN occ_file o ON a.oea04 = o.occ01
WHERE a.oea02 BETWEEN $mdyStart AND $mdyEnd
  AND a.oeaconf = 'Y'
  AND SUBSTR(a.oea01,3,1) <> 'B'
ORDER BY a.oea04, a.oea01
"@
$da = New-Object System.Data.Odbc.OdbcDataAdapter($cmd)
$dt = New-Object System.Data.DataTable
$da.Fill($dt) | Out-Null

# model dimensions -- see file header for why this has to be a separate query.
$cmdDim = $conn.CreateCommand()
$cmdDim.CommandTimeout = 90
$cmdDim.CommandText = "SELECT u.utu01 AS model_code, v.utv112 AS width_mm, v.utv113 AS length_mm, v.utv119 AS thickness_mm FROM utu_file u, utv_file v WHERE u.utu01 = v.utv00"
$daDim = New-Object System.Data.Odbc.OdbcDataAdapter($cmdDim)
$dtDim = New-Object System.Data.DataTable
$daDim.Fill($dtDim) | Out-Null
$dimByModel = @{}
foreach ($dimRow in $dtDim.Rows) {
    $dimByModel[$dimRow["model_code"].ToString().Trim()] = $dimRow
}

# shipped-lines lookup -- see file header for why this has to be a separate query.
$cmdShip = $conn.CreateCommand()
$cmdShip.CommandTimeout = 90
$cmdShip.CommandText = "SELECT DISTINCT TRIM(d.cxd03) AS order_no, d.cxd04 AS line_no FROM cxd_file d, cxw_file w WHERE TRIM(w.cxw04) = TRIM(d.cxd01)"
$daShip = New-Object System.Data.Odbc.OdbcDataAdapter($cmdShip)
$dtShip = New-Object System.Data.DataTable
$daShip.Fill($dtShip) | Out-Null
$shippedSet = New-Object System.Collections.Generic.HashSet[string]
foreach ($shipRow in $dtShip.Rows) {
    $shippedSet.Add("$($shipRow['order_no'].ToString().Trim())|$($shipRow['line_no'])") | Out-Null
}

Write-Output "ROWCOUNT=$($dt.Rows.Count) (before shipped-line exclusion), SHIPPEDLINES=$($shippedSet.Count)"

function CsvField($v) {
    $s = "$v".Trim()
    if ($s -match '[",\r\n]') { return '"' + ($s -replace '"', '""') + '"' }
    return $s
}

$sw = New-Object System.IO.StreamWriter($OutCsv, $false, [System.Text.Encoding]::UTF8)
$sw.WriteLine("order_no,order_date,delivery_date,ship_cust_code,ship_cust_name,ship_lat,ship_lng,route,main_road,item_code,qty_box,width_mm,length_mm,thickness_mm")
$excludedCount = 0
foreach ($row in $dt.Rows) {
    $key = "$($row['order_no'].ToString().Trim())|$($row['line_no'])"
    if ($shippedSet.Contains($key)) { $excludedCount++; continue }

    # 平板/紙板訂單 (oea37=1) have no utu_file model at all (model_code blank), so dimByModel
    # never has an entry for them -- falls straight to the raw oeb100/101/102 columns already
    # on this row. Normal modeled orders look up their real dimensions from utu_file/utv_file.
    $modelCode = $row["model_code"].ToString().Trim()
    $dimRow = if ($modelCode) { $dimByModel[$modelCode] } else { $null }
    if ($dimRow) {
        $widthMm = $dimRow["width_mm"]; $lengthMm = $dimRow["length_mm"]; $thicknessMm = $dimRow["thickness_mm"]
    } else {
        $widthMm = $row["raw_width_mm"]; $lengthMm = $row["raw_length_mm"]; $thicknessMm = $row["raw_thickness_mm"]
    }

    $fields = @(
        (CsvField $row["order_no"]), (CsvField $row["order_date"]), (CsvField $row["delivery_date"]),
        (CsvField $row["ship_cust_code"]), (CsvField $row["ship_cust_name"]),
        (CsvField $row["ship_lat"]), (CsvField $row["ship_lng"]),
        (CsvField $row["route"]), (CsvField $row["main_road"]),
        (CsvField $row["item_code"]), (CsvField $row["qty_box"]),
        (CsvField $widthMm), (CsvField $lengthMm), (CsvField $thicknessMm)
    )
    $sw.WriteLine([string]::Join(",", $fields))
}
$sw.Close()
$conn.Close()
Write-Output "EXCLUDED_SHIPPED_LINES=$excludedCount"
Write-Output "CSV=$OutCsv"
