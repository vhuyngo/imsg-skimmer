@echo off
title imsg-skimmer - Update to latest
cd /d "%~dp0"
echo.
echo Downloads the latest version from GitHub and overwrites Documents\imsg-skimmer.
echo Your exported messages on the Desktop are not deleted.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
