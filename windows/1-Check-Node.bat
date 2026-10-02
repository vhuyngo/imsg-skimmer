@echo off
title imsg-skimmer - Check Node.js
cd /d "%~dp0\.."
echo.
echo === imsg-skimmer: checking Node.js ===
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is NOT installed yet.
  echo.
  echo 1. Open your web browser.
  echo 2. Go to:  https://nodejs.org
  echo 3. Download and run the installer. Keep the default options.
  echo 4. Restart this PC, then double-click this file again.
  echo.
  pause
  exit /b 1
)
echo Node is installed:
node --version
echo.
node -e "const v=process.versions.node.split('.'); if(Number(v[0])<24) process.exit(1)"
if errorlevel 1 (
  echo.
  echo WARNING: imsg-skimmer needs Node.js version 24 or newer.
  echo Download the latest from https://nodejs.org and install it.
  echo.
) else (
  echo Version OK for imsg-skimmer.
)
echo.
echo Project folder:
cd
echo.
pause
