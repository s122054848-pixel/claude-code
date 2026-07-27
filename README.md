# 出貨排車 & 3D裝載模擬(龍潭廠 / T10 ERP)

從 Informix T10 ERP 查詢當日已確認訂單,依送貨客戶地理位置就近排車,並產生:

- **排車單**(CSV):每車次的送貨客戶、訂單、品號、箱數、堆疊數
- **HTML 報表**:每車次的 3D 裝載模擬圖 + 送貨客戶地理位置圖 + 送貨距離 + 排車單明細

## 使用方式

### 方式一:雙擊 `RunReport.hta`(不需要打指令,一般人用這個)

雙擊 `RunReport.hta`,會開一個小視窗:選日期(預設今天)、車台尺寸留空就好(會讀 `config.json`),按「產生報表」。跑完會自動跳出瀏覽器開啟報表,視窗裡的黑色log框會即時顯示查詢/排車的過程與結果,失敗時錯誤訊息也會顯示在裡面。

產生成功後,再按「打包下載」會把當天的 `orders_<date>.csv`、`dispatch_sheet_<date>.csv`、`dispatch_<date>.html` 三個檔案打包成 `output\dispatch_package_<date>.zip`,並自動開啟資料夾,方便一次拿走或傳給別人(例如傳到通訊軟體、外部硬碟)。

⚠️ `.hta` 是 Windows 內建的「HTML Application」,能直接執行本機命令(這樣才能不開終端機就查ERP、跑Python)。如果貴公司IT有政策封鎖 `mshta.exe`(一種資安常見的鎖法),雙擊可能沒反應或被防毒攔截——這種情況請改用方式二。

### 方式二:PowerShell 指令(進階/排程用)

```powershell
cd C:\Bernard\IT\Claude\dispatch-planner
.\run.ps1 -Date 2026-07-08
.\run.ps1 -Date 2026-07-08 -Open          # 產生後自動用瀏覽器開啟報表
.\run.ps1 -Date 2026-07-08 -TruckL 8400 -TruckW 2400 -TruckH 2300   # 覆寫車台尺寸(預設讀 config.json)
```

輸出檔案在 `output\`:
- `orders_<date>.csv` — 從ERP撈出的原始訂單明細(含尺寸、送貨客戶經緯度)
- `dispatch_sheet_<date>.csv` — 排車單
- `dispatch_<date>.html` — 互動式報表(3D模擬 + 地圖 + 排車單),可直接雙擊用瀏覽器打開,也可以整份分享給別人(不需要伺服器,不需要網路)

## 事前準備

1. **32-bit Informix ODBC 驅動**:這台機器需已安裝 IBM Informix Client-SDK(`C:\Program Files (x86)\Informix\Client-SDK`),且系統已註冊 `INFORMIX 3.34 32 BIT` 這個 ODBC 驅動。驅動是32位元的,所以 `run.ps1` 會自動呼叫 `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`(32位元版PowerShell)來執行資料庫查詢那一段,不需要手動切換。
2. **`informix_t2` 這個 ODBC DSN**:如果這台機器從沒連過ERP、還沒有這個DSN,見下方「換一台新電腦怎麼設定」。
3. **Python 3**(64位元即可,只有裝箱演算法和報表產生用得到,不碰資料庫):需能在 PATH 上用 `python` 執行。
4. **`config.json`**:已填好連線資訊(帳號密碼、DSN、資料庫名稱)與預設車台尺寸。這個檔案含明碼密碼,不要外流或上傳到公開的地方;範本在 `config.example.json`。

## 換一台新電腦怎麼設定(沒有 informix_t2 這個DSN的話)

大部分人不需要看這節——直接拿別人已經產生好的 `dispatch_<date>.html`/`.xlsx` 報表來看就好,那些是純靜態檔案,不需要裝任何東西、不需要DSN。只有想在**自己的電腦上直接跑 `run.ps1` 查ERP**的人才需要這節。

1. 先跟IT/管ERP的人要 **IBM Informix Client-SDK(32-bit)** 安裝檔,裝好(這步無法自動化,是廠商的安裝程式)。
2. 把 `config.example.json` 複製成 `config.json`,填入你自己的ERP帳號密碼,以及 `sqlHostsAlias`/`sqlHostsHost`/`sqlHostsPort`(跟DBA/IT要ERP主機的內部位址和連線代號——**這些是內部網路資訊,故意不寫在README或任何會進git的檔案裡**,只填在 `config.json`,而 `config.json` 已經被 `.gitignore` 排除)。
3. 用系統管理員身份開 PowerShell,執行:
   ```powershell
   cd C:\path\to\dispatch-planner
   .\setup\Setup-InformixConnection.ps1
   ```
   這支腳本會讀 `config.json` 裡剛填的位址,把ERP主機代號寫進機器的 Informix 設定,並建立對應的ODBC DSN。DSN本身**不會**存帳號密碼,密碼只放在你自己的 `config.json`,腳本永遠不會碰到你的密碼。重複執行是安全的。
4. 測試:`.\run.ps1 -Date <隨便一個最近的日期> -Open`

## 專案結構

```
dispatch-planner/
  RunReport.hta             雙擊執行的小視窗(一般人用這個,內部會呼叫 run.ps1)
  run.ps1                   命令列主要進入點
  config.json               連線資訊 + 預設車台尺寸(實際使用,含密碼)
  config.example.json       範本(密碼是佔位字串,不含真實密碼)
  setup/
    Setup-InformixConnection.ps1   新電腦第一次設定DSN用,見上方「換一台新電腦怎麼設定」
  lib/
    extract_orders.ps1       查ERP、輸出 orders_<date>.csv(32-bit PowerShell執行)
    build_dispatch.py        排車演算法 + 產生排車單CSV + 產生HTML報表
    template.html            HTML報表的版面/樣式/JS(build_dispatch.py會把資料塞進這份樣板)
  output/                    每次執行的輸出檔案都會落在這裡
```

## ERP 資料表關聯(這套 T10 Informix 資料庫的欄位對照,經多次來回確認過)

這套ERP(正航/鼎新風格)的表格都是 3碼代號 + `_file` 命名,欄位也是代號,沒有中文欄位名稱,以下是排車功能實際用到、已驗證過的關聯:

| 用途 | 資料表 | 關鍵欄位 |
|---|---|---|
| 訂單主檔 | `oea_file` | `oea01`=訂單號碼、`oea02`=訂單日期、`oea04`=**送貨客戶代號**、`oea40`=機種代號、`oeaconf`=確認狀態(僅取 `'Y'`) |
| 訂單明細 | `oeb_file` | `oeb01`=訂單號碼(關聯 `oea01`)、`oeb04`=品號、`oeb12`=**箱數**(不需換算) |
| 機種單頭 | `utu_file` | `utu01`=機種代號(關聯 `oea_file.oea40`) |
| 機種單身(尺寸) | `utv_file` | `utv00`=機種代號(關聯 `utu_file.utu01`)、`utv112`=**寬**(mm)、`utv113`=**長**(mm)、`utv119`=**厚度**(mm) |
| 客戶主檔 | `occ_file` | `occ01`=客戶代號(關聯 `oea_file.oea04`)、`occ02`=客戶簡稱、`occ732`=**緯度**、`occ733`=**經度** |

查詢鏈:`oea_file` → (`oea01=oeb01`) → `oeb_file` → (`oea40=utu01=utv00`) → `utv_file` 拿尺寸;`oea_file` → (`oea04=occ01`) → `occ_file` 拿送貨客戶名稱與經緯度。

⚠️ 中文欄位(客戶名稱等)透過 ODBC 讀出來，用 Bash/終端機直接印出來會顯示亂碼——這只是終端機顯示的問題，不是資料本身壞掉；只要寫進檔案（本專案都用 UTF-8）就是正確的中文。這台機器的系統 ANSI 內碼頁本來就是 950 (Big5)，跟 Informix 的 `zh_TW.BIG5` 是搭配的。

## 排車演算法(目前的假設,可依實際需求調整)

1. 只抓 `oeaconf='Y'`(已確認)的訂單。
2. 每個訂單品項,依「箱厚度 × 箱數」換算成一疊一疊的貨(每疊疊到接近車台高度),footprint = 寬×長。
3. **依送貨客戶地理位置(經緯度)做最近鄰路線排序**,讓地理位置接近的客戶盡量分到同一批車次,而不是隨機/依代號排序。
4. 依這個路線順序,把每一疊貨用「棚架式(shelf)2D排列」塞進車台地板(長8400×寬2400mm,可覆寫),塞滿一台車才換下一台。
5. 送貨距離 = 同一車次的送貨站,依路線順序,兩兩之間直線距離(haversine)加總——**不是實際道路里程**,只是讓你看整體路線型態合不合理。

如果實際作業邏輯不同(例如：不是疊到車頂而是疊到固定棧板高度、需要考慮重量限制、送貨距離要改用實際路網里程),`lib/build_dispatch.py` 裡的邏輯都是可以再調整的,已加了註解方便找地方改。

## 疑難排解

- **連線失敗 `General error` / `Invalid argument value`**:通常是 DSN/SERVER/SERVICE/locale 設定問題。目前用的是已存在的系統DSN `informix_t2`,執行時用 `DATABASE=T10` 覆寫成查 T10(而不是它原本指向的t2庫),並靠 `INFORMIXDIR` 環境變數載入正確的GLS/locale資源,這個機關在 `lib/extract_orders.ps1` 開頭幾行。
- **`python` 找不到**:確認 `python --version` 在一般(64-bit)PowerShell視窗能跑;如果沒有,調整 `run.ps1` 裡呼叫python的那行,改成完整路徑。
