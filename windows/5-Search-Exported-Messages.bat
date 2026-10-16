@echo off
title imsg-skimmer - Search exported messages
setlocal
set "OUT=%USERPROFILE%\Desktop\My-iPhone-Messages"
echo.
echo === Search your exported messages ===
echo Folder: %OUT%
echo.
if not exist "%OUT%\index.html" (
  echo No export found. Run 3-Export-All-Messages.bat first.
  pause
  exit /b 1
)
set /p PAT="Type a word or name to search for: "
if "%PAT%"=="" (
  echo Nothing to search for.
  pause
  exit /b 1
)
echo.
echo Matching CSV files ^(folder names are in the path^):
set "SEARCH=%PAT%"
powershell -NoProfile -Command "Select-String -Path '%OUT%\*\messages.csv' -Pattern $env:SEARCH -SimpleMatch | ForEach-Object { $_.Path } | Sort-Object -Unique"
echo.
echo Tip: open index.html and look for the same folder name in the first column.
echo.
pause
