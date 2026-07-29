<#
  One-time installer for a brand new machine -- run this once after extracting the
  dispatch-planner ZIP, and it walks through everything EXCEPT the two things that
  genuinely can't be automated:
    - installing IBM Informix Client-SDK (proprietary vendor installer)
    - knowing your own ERP account/password (has to come from you, not a script)

  Safe to re-run: each step checks whether it's already done and skips it, so if you
  stop partway (e.g. to install Client-SDK) you can just run it again afterward.

  Usage:
    Right-click this file -> "Run with PowerShell", or from a PowerShell window:
      cd C:\path\to\dispatch-planner
      .\Install.ps1
    Step 5 (creating the ODBC DSN) needs Administrator rights -- if you're not already
    elevated, this script tells you and stops there; the earlier steps still complete
    normally so re-running elevated afterward picks up right where it left off.
#>

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "== 出貨排車工具 安裝精靈 ==" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/5] 檢查 Python 3..." -ForegroundColor Cyan
$pythonOk = $false
try {
    $ver = & python --version 2>&1
    if ($LASTEXITCODE -eq 0) { $pythonOk = $true; Write-Host "  找到:$ver" }
} catch {}
if (-not $pythonOk) {
    Write-Host "  找不到 python。請先安裝 Python 3(64-bit):https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host "  安裝時記得勾選『Add python.exe to PATH』,裝完後重新執行這支腳本。" -ForegroundColor Yellow
    exit 1
}

Write-Host "[2/5] 檢查 Python 套件(openpyxl)..." -ForegroundColor Cyan
& python -c "import openpyxl" 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  已安裝,略過"
} else {
    & python -m pip install -r (Join-Path $root "requirements.txt") --quiet
    if ($LASTEXITCODE -ne 0) { throw "pip install 失敗,請看上面的錯誤訊息" }
    Write-Host "  完成"
}

Write-Host "[3/5] 檢查 Informix Client-SDK..." -ForegroundColor Cyan
$csdkDir = "C:\Program Files (x86)\Informix\Client-SDK"
if (-not (Test-Path (Join-Path $csdkDir "bin\iclit09b.dll"))) {
    Write-Host "  找不到 Informix Client-SDK(32-bit)。這一步無法自動安裝,是廠商的安裝程式——請跟IT/管ERP的人要安裝檔,裝好後重新執行這支腳本(前面已完成的步驟會自動跳過)。" -ForegroundColor Yellow
    exit 1
}
Write-Host "  找到:$csdkDir"

Write-Host "[4/5] 設定 config.json..." -ForegroundColor Cyan
$configPath = Join-Path $root "config.json"
if (Test-Path $configPath) {
    Write-Host "  config.json 已存在,略過(想重新輸入的話,先刪除這個檔案再跑一次這支腳本)"
} else {
    $examplePath = Join-Path $root "config.example.json"
    $config = Get-Content $examplePath -Raw | ConvertFrom-Json

    Write-Host "  請輸入你自己的ERP帳號密碼(跟DBA/IT要一組屬於你自己的帳號,不要共用別人的):"
    $uid = Read-Host "    ERP帳號"
    $securePwd = Read-Host "    ERP密碼(輸入時不會顯示在畫面上)" -AsSecureString
    $plainPwd = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePwd))

    Write-Host "  請輸入ERP主機連線資訊(跟DBA/IT要,這些是內部網路資訊,不會被記錄到任何會分享出去的檔案):"
    $sqlHostsAlias = Read-Host "    伺服器代號(例如 on_tcp1)"
    $sqlHostsHost = Read-Host "    伺服器位址(例如 erp.example.com)"
    $sqlHostsPort = Read-Host "    連接埠(例如 8001)"

    $dbName = Read-Host "  廠區資料庫代號(T2=龍潭廠 / T10=雲林廠 / T3=神岡廠 / T6=路竹廠,直接按Enter預設T10)"
    if (-not $dbName) { $dbName = "T10" }

    $config.db.uid = $uid
    $config.db.pwd = $plainPwd
    $config.db.sqlHostsAlias = $sqlHostsAlias
    $config.db.sqlHostsHost = $sqlHostsHost
    $config.db.sqlHostsPort = $sqlHostsPort
    $config.db.database = $dbName

    $config | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8
    Write-Host "  已寫入 config.json"
}

Write-Host "[5/5] 建立 ODBC DSN..." -ForegroundColor Cyan
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "  這一步需要系統管理員權限。請滑鼠右鍵點 PowerShell -> 『以系統管理員身分執行』,cd 到這個資料夾,再跑一次 .\Install.ps1(前面已完成的步驟會自動跳過,直接接著做這一步)。" -ForegroundColor Yellow
    exit 1
}
& (Join-Path $root "setup\Setup-InformixConnection.ps1") -ConfigPath $configPath

Write-Host ""
Write-Host "安裝完成!測試看看:" -ForegroundColor Green
Write-Host "  .\run.ps1 -Date <隨便一個最近的日期> -Open"
Write-Host "或直接雙擊 RunReport.hta"
