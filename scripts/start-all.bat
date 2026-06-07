@echo off
chcp 65001 >nul
title Karen — 一键启动

echo ╔══════════════════════════════════════╗
echo ║     Karen 虚拟人设 — 一键启动       ║
echo ╚══════════════════════════════════════╝
echo.

REM === 1. 启动 NapCatQQ ===
set NAPCAT_DIR=D:\NapCatShell
if not exist "%NAPCAT_DIR%" (
    echo [错误] NapCat 目录不存在: %NAPCAT_DIR%
    pause
    exit /b 1
)

echo [1/2] 启动 NapCatQQ...
start "" /MIN "%NAPCAT_DIR%\napcat.bat"
echo       等待扫码登录（如已登录则自动连接）...
timeout /t 3 /nobreak >nul

REM === 2. 启动 Karen QQ 桥接 ===
echo [2/2] 启动 Karen QQ 桥接...
cd /d "%~dp0\.."
call npm run qq
pause
