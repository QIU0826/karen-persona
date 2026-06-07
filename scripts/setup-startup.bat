@echo off
chcp 65001 >nul
title Karen — 开机自启

REM ============================================
REM Karen 开机自启脚本
REM 用法: 将此脚本的快捷方式放入 Windows 启动文件夹
REM 启动文件夹: shell:startup (Win+R 输入)
REM ============================================

echo [Karen] 正在启动... (%date% %time%)

REM === 1. 启动 NapCatQQ ===
set NAPCAT_DIR=D:\NapCatShell
if exist "%NAPCAT_DIR%\napcat.bat" (
    echo [Karen] 启动 NapCatQQ...
    start "" /MIN "%NAPCAT_DIR%\napcat.bat"
    timeout /t 5 /nobreak >nul
) else (
    echo [Karen] 警告: NapCat 目录不存在，请修改脚本中的 NAPCAT_DIR
)

REM === 2. PM2 启动 Karen QQ 桥接 ===
cd /d "%~dp0\.."
call npx pm2 start ecosystem.config.js
call npx pm2 save

echo [Karen] 启动完成。她已在线。
exit /b 0
