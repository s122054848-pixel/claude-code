<#
  One-time setup for a NEW computer that wants to run this dispatch-planner tool itself
  (i.e. run extract_orders.ps1 / run.ps1 directly, not just view a report someone else
  already generated -- generated HTML/CSV/xlsx reports are plain static files and need
  none of this).

  This does NOT install the Informix Client-SDK itself -- that's IBM's proprietary
  installer and isn't something this script can fetch or bundle. Get it from wherever
  your IT department distributes internal ERP client software, install it first, then
  run this script.

  What this script sets up (values all come from config.json, not hardcoded here, since
  the internal ERP server address shouldn't end up in a git history -- see config.example.json
  for which fields to fill in and ask your DBA/IT for the real values):
    1. The Informix server alias -> host:port, stored in the registry the way the Windows
       Informix CSDK expects it (there's no sqlhosts text file on Windows -- CSDK reads
       this from the registry instead).
    2. A matching entry in the Windows services file (belt-and-braces; some CSDK versions
       fall back to resolving the server-alias's port via the services file if the
       registry SqlHosts entry doesn't have SERVICE set, so this makes the setup work
       either way).
    3. The ODBC System DSN itself, pointing at the CSDK driver, with SERVER=<alias> and
       the zh_TW.BIG5 locale the server expects.

  Deliberately does NOT store a UID/PWD in the DSN -- extract_orders.ps1 always passes
  UID/PWD explicitly in the connection string from config.json, so the DSN's own stored
  credentials (if any) are never used. Keeping the DSN itself credential-free means this
  script never needs your ERP password, and nothing here has to be treated as a secret.

  Must run as Administrator (writes HKEY_LOCAL_MACHINE and the system services file).
  Safe to re-run -- every step checks for the already-correct state first.

  Usage:
    1. Copy config.example.json to config.json and fill in db.sqlHostsAlias / sqlHostsHost /
       sqlHostsPort / dsn / database (ask your DBA/IT for the real host -- these are
       intentionally NOT filled in by default so the internal server address never has to
       be hardcoded in a script that might get shared or committed).
    2. Right-click PowerShell -> "Run as Administrator", then:
         cd C:\path\to\dispatch-planner
         .\setup\Setup-InformixConnection.ps1
#>
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\config.json")
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "Must run as Administrator (this writes HKEY_LOCAL_MACHINE and the system services file). Right-click PowerShell -> `"Run as Administrator`" and try again."
}

if (-not (Test-Path $ConfigPath)) {
    throw "Config file not found at $ConfigPath. Copy config.example.json to config.json and fill in db.sqlHostsAlias/sqlHostsHost/sqlHostsPort/dsn/database first (ask your DBA/IT for the real ERP server host), then re-run this script."
}
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$db = $config.db
foreach ($field in @("sqlHostsAlias", "sqlHostsHost", "sqlHostsPort", "dsn", "database", "informixdir")) {
    if (-not $db.$field) { throw "config.json is missing db.$field -- fill it in (see config.example.json) and re-run." }
}

$csdkDir = $db.informixdir
$driverDll = Join-Path $csdkDir "bin\iclit09b.dll"
$driverName = "INFORMIX 3.34 32 BIT"

Write-Host "== Step 1/4: checking Informix Client-SDK is installed ==" -ForegroundColor Cyan
if (-not (Test-Path $driverDll)) {
    throw @"
Informix Client-SDK not found at $csdkDir (missing $driverDll).
Install IBM Informix Client-SDK (32-bit) first -- ask IT/whoever manages the ERP client
software for the installer -- then re-run this script.
"@
}
Write-Host "  found $driverDll"

Write-Host "== Step 2/4: checking the '$driverName' ODBC driver is registered ==" -ForegroundColor Cyan
$driverKey = "HKLM:\SOFTWARE\WOW6432Node\ODBC\ODBCINST.INI\$driverName"
if (-not (Test-Path $driverKey)) {
    throw "Client-SDK is installed but the '$driverName' 32-bit ODBC driver isn't registered ($driverKey missing). The Client-SDK install looks incomplete -- try reinstalling it, then re-run this script."
}
Write-Host "  driver registered OK"

Write-Host "== Step 3/4: registering the $($db.sqlHostsAlias) server alias ==" -ForegroundColor Cyan
$sqlHostsKey = "HKLM:\SOFTWARE\WOW6432Node\Informix\SqlHosts\$($db.sqlHostsAlias)"
New-Item -Path $sqlHostsKey -Force | Out-Null
Set-ItemProperty -Path $sqlHostsKey -Name "HOST" -Value $db.sqlHostsHost -Type String
Set-ItemProperty -Path $sqlHostsKey -Name "SERVICE" -Value $db.sqlHostsPort -Type String
Set-ItemProperty -Path $sqlHostsKey -Name "PROTOCOL" -Value "onsoctcp" -Type String
Write-Host "  $sqlHostsKey -> HOST=$($db.sqlHostsHost) SERVICE=$($db.sqlHostsPort) PROTOCOL=onsoctcp"

$servicesPath = "$env:WINDIR\System32\drivers\etc\services"
$servicesLine = "$($db.sqlHostsAlias)         $($db.sqlHostsPort)/tcp                            #informix"
$existing = Get-Content $servicesPath -ErrorAction SilentlyContinue
if ($existing -match "^\s*$([regex]::Escape($db.sqlHostsAlias))\s") {
    Write-Host "  services file already has a $($db.sqlHostsAlias) entry, leaving it as-is"
} else {
    Add-Content -Path $servicesPath -Value $servicesLine
    Write-Host "  added '$servicesLine' to $servicesPath"
}

Write-Host "== Step 4/4: creating the $($db.dsn) ODBC System DSN ==" -ForegroundColor Cyan
if (Get-OdbcDsn -Name $db.dsn -Platform 32-bit -ErrorAction SilentlyContinue) {
    Remove-OdbcDsn -Name $db.dsn -DsnType System -Platform 32-bit -ErrorAction SilentlyContinue
    Write-Host "  removed existing $($db.dsn) DSN to recreate it cleanly"
}
Add-OdbcDsn -Name $db.dsn -DriverName $driverName -DsnType System -Platform 32-bit -SetPropertyValue @(
    "DATABASE=$($db.database)",
    "SERVER=$($db.sqlHostsAlias)",
    "CLIENT_LOCALE=zh_TW.BIG5",
    "DB_LOCALE=zh_TW.BIG5"
)
Write-Host "  $($db.dsn) DSN created (no UID/PWD stored -- extract_orders.ps1 supplies those from config.json at connect time)"

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "Next step: test it with .\run.ps1 -Date <a recent date, e.g. yesterday> -Open"
