@echo off
title imsg-skimmer - One-time setup
cd /d "%~dp0"
echo.
echo This checks Node.js and installs OR UPDATES imsg-skimmer from GitHub.
echo Older copies in Documents\imsg-skimmer are overwritten with the latest files.
echo Your Desktop export folder is not touched. Re-run anytime for updates.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
