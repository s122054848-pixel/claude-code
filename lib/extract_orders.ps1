<#
  Extracts one day's confirmed sales orders (with product dimensions and delivery
  customer geo-coordinates) from the T10 Informix ERP database into a CSV file.

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

  Must run under 32-bit PowerShell (the installed Informix ODBC driver is 32-bit only):
    C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -File extract_orders.ps1 -Date 2026-07-08

  run.ps1 handles this automatically -- you normally don't call this script directly.
#>
param(
    [Parameter(Mandatory = $true)][string]$Date,      # yyyy-MM-dd
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\config.json"),
    [string]$OutCsv
)

$ErrorActionPreference = "Stop"

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$db = $config.db

if (-not $OutCsv) {
    $OutCsv = Join-Path $PSScriptRoot "..\output\orders_$Date.csv"
}
New-Item -ItemType Directory -Force -Path (Split-Path $OutCsv) | Out-Null

$env:INFORMIXDIR = $db.informixdir
$env:PATH = "$($db.informixdir)\bin;$env:PATH"

$d = [datetime]::ParseExact($Date, "yyyy-MM-dd", $null)
$mdy = "MDY($($d.Month),$($d.Day),$($d.Year))"

$connStr = "DSN=$($db.dsn);DATABASE=$($db.database);UID=$($db.uid);PWD=$($db.pwd);"
$conn = New-Object System.Data.Odbc.OdbcConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandTimeout = 90
$cmd.CommandText = @"
SELECT
  a.oea01 AS order_no, a.oea02 AS order_date, a.oea04 AS ship_cust_code,
  o.occ02 AS ship_cust_name, o.occ732 AS ship_lat, o.occ733 AS ship_lng,
  b.oeb04 AS item_code, b.oeb12 AS qty_box, b.oeb03 AS line_no,
  v.utv112 AS width_mm, v.utv113 AS length_mm, v.utv119 AS thickness_mm
FROM oea_file a, oeb_file b, utu_file u, utv_file v, occ_file o
WHERE a.oea02 = $mdy
  AND a.oeaconf = 'Y'
  AND SUBSTR(a.oea01,3,1) <> 'B'
  AND a.oea01 = b.oeb01
  AND a.oea40 = u.utu01
  AND u.utu01 = v.utv00
  AND a.oea04 = o.occ01
ORDER BY a.oea04, a.oea01
"@
$da = New-Object System.Data.Odbc.OdbcDataAdapter($cmd)
$dt = New-Object System.Data.DataTable
$da.Fill($dt) | Out-Null

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
$sw.WriteLine("order_no,order_date,ship_cust_code,ship_cust_name,ship_lat,ship_lng,item_code,qty_box,width_mm,length_mm,thickness_mm")
$excludedCount = 0
foreach ($row in $dt.Rows) {
    $key = "$($row['order_no'].ToString().Trim())|$($row['line_no'])"
    if ($shippedSet.Contains($key)) { $excludedCount++; continue }
    $fields = @(
        (CsvField $row["order_no"]), (CsvField $row["order_date"]),
        (CsvField $row["ship_cust_code"]), (CsvField $row["ship_cust_name"]),
        (CsvField $row["ship_lat"]), (CsvField $row["ship_lng"]),
        (CsvField $row["item_code"]), (CsvField $row["qty_box"]),
        (CsvField $row["width_mm"]), (CsvField $row["length_mm"]), (CsvField $row["thickness_mm"])
    )
    $sw.WriteLine([string]::Join(",", $fields))
}
$sw.Close()
$conn.Close()
Write-Output "EXCLUDED_SHIPPED_LINES=$excludedCount"
Write-Output "CSV=$OutCsv"
