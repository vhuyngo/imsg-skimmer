@echo off
title imsg-skimmer - One-time setup
cd /d "%~dp0"
echo.
echo This will check Node.js and make sure imsg-skimmer is ready.
echo It does NOT export messages unless you pass -ExportAfterSetup to install.ps1.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
