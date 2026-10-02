@echo off
title imsg-skimmer - Export all messages
cd /d "%~dp0\.."
setlocal EnableDelayedExpansion
echo.
echo === imsg-skimmer: export ALL conversations ===
echo This writes files to your Desktop. Nothing is uploaded.
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
  echo No backup folder found. Run 2-List-My-Backups.bat after backing up the iPhone.
  pause
  exit /b 1
)
set "OUT=%USERPROFILE%\Desktop\My-iPhone-Messages"
set /p BNUM="Backup number from step 2 (press Enter for 1): "
if "!BNUM!"=="" set "BNUM=1"
echo.
echo Exporting backup !BNUM! to:
echo   !OUT!
echo.
echo If your backup is encrypted, you will be asked for the backup password next.
echo Typing will be hidden. That is normal.
echo.
node bin\imsg-skimmer.js export --backup !BNUM! --all --out "!OUT!" !ARGS!
if errorlevel 1 (
  echo.
  echo Export failed. Read the message above, or run 2-List-My-Backups.bat again.
  pause
  exit /b 1
)
echo.
echo Done. Opening the folder on your Desktop...
start "" "!OUT!"
echo.
pause
