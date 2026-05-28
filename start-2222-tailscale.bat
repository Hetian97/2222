@echo off
chcp 65001 >nul
title 111 EPhone Tailscale Launcher

echo ========================================
echo  启动 111 EPhone + memory-server
echo ========================================
echo.
echo memory-server: http://127.0.0.1:8765
echo Tailscale访问: http://100.81.84.121:8765
echo 前端本地服务: http://127.0.0.1:8000
echo 手机访问前端: http://100.81.84.121:8000
echo.
echo 请保持弹出的两个窗口不要关闭。
echo.

start "Aion Memory Server - 8765" cmd /k "cd /d D:\app\2222EPhone-merge-new\memory-server && node server.js"

timeout /t 2 /nobreak >nul

start "111 Frontend Server - 8000" cmd /k "cd /d D:\app\2222EPhone-merge-new && python -m http.server 8000 --bind 0.0.0.0"

echo 已启动。
echo.
echo 手机上打开：
echo http://100.81.84.121:8000/?v=tailscale
echo.
echo 外部 memory-server 填：
echo http://100.81.84.121:8765
echo.
pause