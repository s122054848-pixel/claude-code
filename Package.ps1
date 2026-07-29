<#
  Builds the distributable ZIP for handing this tool to a new user.

  Uses `git archive` rather than hand-picking files: it packages exactly what's
  tracked in git (respecting .gitignore), so config.json, output/*.csv/html/xlsx,
  __pycache__/, and .git/ are never included, and there's no separate include/
  exclude list to keep in sync as the project grows -- if a file shouldn't ship,
  it shouldn't be tracked (or should be in .gitignore).

  Usage:
    .\Package.ps1
  Produces output\dispatch-planner-<date>.zip (gitignored, so packaging never
  dirties the working tree).
#>

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$dirty = git status --porcelain
if ($dirty) {
    Write-Host "警告:工作目錄有未commit的變更,打包只會包含已commit的內容:" -ForegroundColor Yellow
    Write-Host $dirty
    Write-Host ""
}

$date = Get-Date -Format "yyyy-MM-dd"
$outDir = Join-Path $root "output"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$zipPath = Join-Path $outDir "dispatch-planner-$date.zip"

git archive --format=zip -o $zipPath HEAD

$sizeKb = [Math]::Round((Get-Item $zipPath).Length / 1KB)
Write-Host "已打包:$zipPath ($sizeKb KB)" -ForegroundColor Green
Write-Host "內容(git已追蹤的檔案):" -ForegroundColor Cyan
git ls-tree -r --name-only HEAD | ForEach-Object { Write-Host "  $_" }
