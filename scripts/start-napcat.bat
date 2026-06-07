@echo off
REM NapCatQQ Launcher
REM Set NAPCAT_DIR to your NapCat installation path
set NAPCAT_DIR=D:\NapCatShell

if not exist "%NAPCAT_DIR%" (
    echo [ERROR] NapCat dir not found: %NAPCAT_DIR%
    echo Edit this script and set NAPCAT_DIR to the correct path
    pause
    exit /b 1
)

echo Starting NapCatQQ...
cd /d "%NAPCAT_DIR%"
start "" /MIN napcat.bat

echo NapCatQQ started (minimized to tray)
echo Next: cd karen-persona ^&^& npm run qq
exit /b 0
