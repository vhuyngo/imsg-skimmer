@echo off
title imsg-skimmer - List backups
cd /d "%~dp0\.."
setlocal EnableDelayedExpansion
echo.
echo === imsg-skimmer: backups on this PC ===
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
  echo No standard backup folder was found.
  echo.
  echo Back up your iPhone first:
  echo   - Open Apple Devices from the Microsoft Store
  echo   - Plug in the iPhone, choose Back Up Now
  echo.
  pause
  exit /b 1
)
node bin\imsg-skimmer.js list !ARGS!
echo.
echo Use the number in the first column as --backup when exporting ^(usually 1^).
echo.
pause
