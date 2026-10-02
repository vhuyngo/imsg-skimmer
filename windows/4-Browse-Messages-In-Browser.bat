@echo off
title imsg-skimmer - Browse in browser
cd /d "%~dp0\.."
setlocal EnableDelayedExpansion
echo.
echo === imsg-skimmer: local web viewer ===
echo Only works on THIS computer. Press Ctrl+C in this window to stop.
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo Run 1-Check-Node.bat first.
  pause
  exit /b 1
)
set "ARGS="
if exist "%USERPROFILE%\Apple\MobileSync\Backup\" set "ARGS=!ARGS! --backup-root "%USERPROFILE%\Apple\MobileSync\Backup""
if exist "%APPDATA%\Apple Computer\MobileSync\Backup\" set "ARGS=!ARGS! --backup-root "%APPDATA%\Apple Computer\MobileSync\Backup""
if "!ARGS!"=="" (
  echo No backup folder found. Back up the iPhone first.
  pause
  exit /b 1
)
set /p BNUM="Backup number (press Enter for 1): "
if "!BNUM!"=="" set "BNUM=1"
echo.
node bin\imsg-skimmer.js serve --backup !BNUM! !ARGS!
