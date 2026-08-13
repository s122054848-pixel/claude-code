@echo off
rem Starts the live single-page dispatch planner (lib/server.py) and opens it in the default
rem browser. This window is the server's log/status console -- keep it open while using the
rem report; closing it (or Ctrl+C) stops the server. Unlike RunReport.hta, this doesn't rely on
rem mshta.exe, so it isn't affected by IT policies that block that (see README.md).
setlocal
cd /d "%~dp0"
title 出貨排車 & 3D裝載模擬（即時版）
python lib\server.py
echo.
echo 伺服器已停止。
pause
