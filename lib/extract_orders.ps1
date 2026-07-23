<#
  Extracts one day's confirmed sales orders (with product dimensions and delivery
  customer geo-coordinates) from the T10 Informix ERP database into a CSV file.

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
  b.oeb04 AS item_code, b.oeb12 AS qty_box,
  v.utv112 AS width_mm, v.utv113 AS length_mm, v.utv119 AS thickness_mm
FROM oea_file a, oeb_file b, utu_file u, utv_file v, occ_file o
WHERE a.oea02 = $mdy
  AND a.oeaconf = 'Y'
  AND a.oea01 = b.oeb01
  AND a.oea40 = u.utu01
  AND u.utu01 = v.utv00
  AND a.oea04 = o.occ01
ORDER BY a.oea04, a.oea01
"@
$da = New-Object System.Data.Odbc.OdbcDataAdapter($cmd)
$dt = New-Object System.Data.DataTable
$da.Fill($dt) | Out-Null
Write-Output "ROWCOUNT=$($dt.Rows.Count)"

function CsvField($v) {
    $s = "$v".Trim()
    if ($s -match '[",\r\n]') { return '"' + ($s -replace '"', '""') + '"' }
    return $s
}

$sw = New-Object System.IO.StreamWriter($OutCsv, $false, [System.Text.Encoding]::UTF8)
$sw.WriteLine("order_no,order_date,ship_cust_code,ship_cust_name,ship_lat,ship_lng,item_code,qty_box,width_mm,length_mm,thickness_mm")
foreach ($row in $dt.Rows) {
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
Write-Output "CSV=$OutCsv"
