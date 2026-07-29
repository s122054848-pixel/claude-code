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
.\run.ps1 -Date 2026-07-08 -TruckL 8700 -TruckW 2400 -TruckH 2400   # 覆寫車廂內徑(預設讀 config.json)
```

輸出檔案在 `output\`:
- `orders_<date>.csv` — 從ERP撈出的原始訂單明細(含尺寸、送貨客戶經緯度)
- `dispatch_sheet_<date>.csv` — 排車單
- `dispatch_<date>.html` — 互動式報表(3D模擬 + 地圖 + 排車單),可直接雙擊用瀏覽器打開,也可以整份分享給別人(不需要伺服器,不需要網路)

## 給新用戶安裝(要在自己電腦上直接跑 `run.ps1` 查ERP 的人才需要)

大部分人不需要看這節——直接拿別人已經產生好的 `dispatch_<date>.html`/`.xlsx` 報表來看就好,那些是純靜態檔案,不需要裝任何東西、不需要DSN。只有想在**自己的電腦上直接跑 `run.ps1`/`RunReport.hta` 查ERP**的人才需要照著下面步驟裝一次。

**快速安裝**:拿到 `dispatch-planner-<date>.zip`(見下方「打包工具給別人」)解壓縮後,直接執行 `.\Install.ps1`,它會自動做完下面第2、3、5、6步(檢查Python套件、互動輸入config.json、建立ODBC DSN),只有第4步(裝Informix Client-SDK,廠商安裝程式)沒辦法自動化、需要跟IT要安裝檔。中斷了(例如要先去裝Client-SDK)可以直接重新執行 `.\Install.ps1`,已完成的步驟會自動跳過。下面是完整的手動步驟,供想了解細節或 `Install.ps1` 遇到問題時對照。

1. **複製整個 `dispatch-planner` 資料夾**到這台電腦(或用 `git clone` 這個repo)。
2. **安裝 Python 3**(64-bit 即可,只有裝箱演算法和報表產生用得到,不碰資料庫):在一般(64-bit)PowerShell視窗確認 `python --version`能跑。
3. **安裝 Python 套件**:
   ```powershell
   pip install -r requirements.txt
   ```
   目前只用到 `openpyxl`(產生排車單的 `.xlsx` 檔要用)。
4. **安裝 32-bit Informix ODBC 驅動**:跟IT/管ERP的人要 **IBM Informix Client-SDK(32-bit)** 安裝檔,裝好(這步無法自動化,是廠商的安裝程式)。裝好後這台機器上應該會有 `C:\Program Files (x86)\Informix\Client-SDK`,且系統已註冊 `INFORMIX 3.34 32 BIT` 這個 ODBC 驅動——驅動是32位元的,所以 `run.ps1` 會自動呼叫 `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`(32位元版PowerShell)來執行資料庫查詢那一段,不需要手動切換。
5. **設定 `config.json`**:把 `config.example.json` 複製成 `config.json`,填入你自己的ERP帳號密碼,以及 `sqlHostsAlias`/`sqlHostsHost`/`sqlHostsPort`(跟DBA/IT要ERP主機的內部位址和連線代號——**這些是內部網路資訊,故意不寫在README或任何會進git的檔案裡**,只填在 `config.json`,而 `config.json` 已經被 `.gitignore` 排除)。這個檔案含明碼密碼,不要外流或上傳到公開的地方。
6. **建立 `informix_t2` 這個 ODBC DSN**:用系統管理員身份開 PowerShell,執行:
   ```powershell
   cd C:\path\to\dispatch-planner
   .\setup\Setup-InformixConnection.ps1
   ```
   這支腳本會讀 `config.json` 裡剛填的位址,把ERP主機代號寫進機器的 Informix 設定,並建立對應的ODBC DSN。DSN本身**不會**存帳號密碼,密碼只放在你自己的 `config.json`,腳本永遠不會碰到你的密碼。重複執行是安全的。
7. **測試**:`.\run.ps1 -Date <隨便一個最近的日期> -Open`,或直接雙擊 `RunReport.hta`。跑成功、瀏覽器跳出報表,就代表這台電腦裝好了。

## 打包工具給別人(維護者用)

要把整套工具交給新用戶(例如另一個廠區的同事),在專案根目錄執行:

```powershell
.\Package.ps1
```

會用 `git archive` 把目前 git 已commit的內容打包成 `output\dispatch-planner-<date>.zip`。用 `git archive` 而不是手動列清單的好處是它自動只抓git有追蹤的檔案——`config.json`(真實密碼)、`output\` 底下的訂單/報表資料、`.git\` 本身都不會進去,以後專案新增檔案也不用記得回來改打包清單,只要記得該不該讓這個檔案進git就好。

把產生的zip傳給新用戶(通訊軟體、共用資料夾都可以),對方解壓縮後照上面「給新用戶安裝」的**快速安裝**執行 `.\Install.ps1` 即可。

⚠️ 執行前如果有還沒commit的變更,`Package.ps1` 會印出警告——打包的內容永遠是**已commit**的版本,不是工作目錄目前的樣子。

## 專案結構

```
dispatch-planner/
  RunReport.hta             雙擊執行的小視窗(一般人用這個,內部會呼叫 run.ps1)
  run.ps1                   命令列主要進入點
  Install.ps1               新電腦一鍵安裝精靈,見上方「給新用戶安裝」快速安裝
  Package.ps1               打包成zip交給新用戶用,見上方「打包工具給別人」
  config.json               連線資訊 + 預設車台尺寸(實際使用,含密碼)
  config.example.json       範本(密碼是佔位字串,不含真實密碼)
  requirements.txt          Python套件清單(pip install -r requirements.txt)
  setup/
    Setup-InformixConnection.ps1   新電腦第一次設定DSN用,見上方「給新用戶安裝」
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
| 訂單主檔 | `oea_file` | `oea01`=**訂單號碼**、`oea02`=訂單日期、`oea04`=**送貨客戶代號**、`oea40`=機種代號、`oeaconf`=確認狀態(僅取 `'Y'`) |
| 訂單明細 | `oeb_file` | `oeb01`=訂單號碼(關聯 `oea01`)、`oeb03`=**行號**、`oeb04`=品號、`oeb12`=**箱數**(不需換算) |
| 機種單頭 | `utu_file` | `utu01`=機種代號(關聯 `oea_file.oea40`) |
| 機種單身(尺寸) | `utv_file` | `utv00`=機種代號(關聯 `utu_file.utu01`)、`utv112`=**寬**(mm)、`utv113`=**長**(mm)、`utv119`=**厚度**(mm) |
| 客戶主檔 | `occ_file` | `occ01`=客戶代號(關聯 `oea_file.oea04`)、`occ02`=客戶簡稱、`occ732`=**緯度**、`occ733`=**經度**、`occ735`=**路線**、`occ734`=**主幹道** |
| 出貨單頭 | `cxc_file` | `cxc01`=出貨單號(⚠️ `cxcconf` 欄位看起來像「已出貨」旗標,但驗證過這個資料庫裡永遠不會是 `'Y'`,不能用) |
| 出貨單身 | `cxd_file` | `cxd01`=出貨單號、`cxd03`=訂單號碼(關聯 `oeb01`)、`cxd04`=**行號**(關聯 `oeb03`,注意是數字欄位,不能 `TRIM`) |
| 出廠記錄檔 | `cxw_file` | `cxw04`=出貨單號(關聯 `cxd01`)——**真正的「已出貨」判斷依據**:一張出貨單只要出現在這裡就代表已經出廠 |

查詢鏈:`oea_file` → (`oea01=oeb01`) → `oeb_file` → (`oea40=utu01=utv00`) → `utv_file` 拿尺寸;`oea_file` → (`oea04=occ01`) → `occ_file` 拿送貨客戶名稱、經緯度、路線、主幹道;`oeb_file` → (`oeb01=cxd03` 且 `oeb03=cxd04`,**行號層級**,不能只比對訂單號碼) → `cxd_file` → (`cxd01=cxw04`) → `cxw_file` 判斷該筆訂單明細是否已出貨。

⚠️ 中文欄位(客戶名稱等)透過 ODBC 讀出來，用 Bash/終端機直接印出來會顯示亂碼——這只是終端機顯示的問題，不是資料本身壞掉；只要寫進檔案（本專案都用 UTF-8）就是正確的中文。這台機器的系統 ANSI 內碼頁本來就是 950 (Big5)，跟 Informix 的 `zh_TW.BIG5` 是搭配的。

## 成車規則(排車演算法,依現況整理,調整過就更新這節)

這節記錄「哪些訂單會被排進車次」「哪些客戶會排在同一輛車」「同一輛車內怎麼裝」的完整規則,依實際加上的順序整理、依邏輯分類。程式碼在 `lib/build_dispatch.py`,每條規則都能在裡面找到對應的函式與註解。

### 一、訂單篩選(這些訂單/明細行不會進入排車)

1. 只抓 `oeaconf='Y'`(已確認)的訂單。
2. **排除已出貨的明細行**:透過 `cxw_file`(出廠記錄)判斷,在**行號層級**比對(`oeb01=cxd03` 且 `oeb03=cxd04`)——同一張訂單只出貨了其中幾行,其餘還沒出貨的行仍會照常排車,不會整張訂單被排除。
3. **排除備庫訂單**:訂單號碼(`oea01`)第 3 碼是 `B` 的(例如 `UTB-TB0001`)不是實際出貨,整張排除。

### 二、成車分組規則(哪些客戶會排進同一輛車),依優先順序

1. **裝載率優先,距離其次**:每個客戶的訂單整批(不拆散)嘗試塞進每一輛已經在用的車,優先選「塞進去之後裝載率(體積)最滿」的那一輛;裝載率打平時再比距離(送貨客戶之間的實際路網距離,不是直線),塞進去之後跟車上其他客戶最近的優先。
2. **同一客戶盡量同車**:除非這位客戶的貨量單獨就超過一整車,才會被迫拆成多輛車(拆的時候還是先把一輛車塞好、塞滿了才開下一輛,不會東拼西湊)。
3. **路線相同優先**(`occ735`):客戶如果在 ERP 裡有指定「路線」代碼,同一輛車上其他客戶的路線代碼必須完全相同——這條規則**取代**下面第 5 條的方向限制,不再看方向。約 21% 的客戶(以有實際訂單的客戶來算接近 100%)有路線代碼。
4. **路線未成車時,主幹道相同可合併**(`occ734`):兩輛車各自路線不同、但都還有空間時,如果這兩條路線共用同一個「主幹道」代碼,允許合併成一輛車——只在確實裝得下時才會合併,不會為了合併硬擠。
5. **沒有路線代碼的客戶,退回方向限制**:車次一旦裝上第一位沒有路線代碼的客戶,就以廠區為原點鎖定南北、東西象限,之後只能加入同象限的客戶(在方向豁免半徑內——預設15km,可調——的客戶不受此限)。
6. **有路線代碼與沒有路線代碼的客戶,永不同車**——避免兩種分組邏輯混在一起難以追蹤。
7. 每個訂單品項,依「箱厚度 × 箱數」換算成一疊一疊的貨(每疊疊到接近車廂高度),footprint = 寬×長。

### 三、車廂內裝載規則

1. **裝載率 = 車廂空間(體積)使用率**,不是樓面(地板面積)使用率——同樣的地板佔用面積,疊得越高裝載率越高,比較符合「這台車實際裝了多少東西」的直覺。
2. 車廂內用「棚架式(shelf)2D排列」塞每一疊貨,塞滿地板才換下一台車。
3. 車廂內徑預設 **8700×2400×2400mm**,可用 `-TruckL`/`-TruckW`/`-TruckH` 或 `RunReport.hta` 的欄位覆寫(存在 `config.json` 裡當預設值)。

### 四、送貨距離計算

1. 採用 **OSRM 實際路網距離**,不是直線距離(直線距離只在路網查詢失敗時當備援)。
2. 車次內的送貨站順序,用最近鄰 + **2-opt 局部優化**,盡量縮短這台車實際要跑的總里程(避免最近鄰貪心排法留下一段繞遠路)。

### 跟展示版(claude.ai Artifact「排車單 & 3D裝載模擬」)的差異

展示版的排車核心邏輯(第二節)完全相同,額外多了這台工具沒有的功能:成車後保證裝車順序不交錯(對應真實搬運動線,可能因此多開一輛車)、每輛車最大客戶數上限(可調)、棧板/手工疊車兩種模式、棧板容許延伸寬度、3D視覺化。這台命令列工具走的是更單純的單次批次流程,沒有這些互動參數。

## 疑難排解

- **連線失敗 `General error` / `Invalid argument value`**:通常是 DSN/SERVER/SERVICE/locale 設定問題。目前用的是已存在的系統DSN `informix_t2`,執行時用 `DATABASE=T10` 覆寫成查 T10(而不是它原本指向的t2庫),並靠 `INFORMIXDIR` 環境變數載入正確的GLS/locale資源,這個機關在 `lib/extract_orders.ps1` 開頭幾行。
- **`python` 找不到**:確認 `python --version` 在一般(64-bit)PowerShell視窗能跑;如果沒有,調整 `run.ps1` 裡呼叫python的那行,改成完整路徑。
