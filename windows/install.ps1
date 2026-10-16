# Installs Node.js 24+ (via winget when possible), fetches imsg-skimmer if needed,
# and optionally runs the first export. Safe to run more than once.
#Requires -Version 5.1
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'Documents\imsg-skimmer'),
  [switch]$SkipNodeCheck,
  [switch]$ExportAfterSetup
)

$ErrorActionPreference = 'Stop'
$RepoZip = 'https://github.com/vhuyngo/imsg-skimmer/archive/refs/heads/main.zip'
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { '' }

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

function Get-NodeMajor {
  try {
    $v = (node --version 2>$null).Trim()
    if (-not $v) { return 0 }
    return [int]($v -replace '^v', '').Split('.')[0]
  } catch { return 0 }
}

function Ensure-Node {
  if ($SkipNodeCheck) { return }
  $major = Get-NodeMajor
  if ($major -ge 24) {
    Write-Host "Node.js $(node --version) OK."
    return
  }
  Write-Step 'Node.js 24 or newer is required'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Trying winget (OpenJS.NodeJS.Current)...'
    winget install --id OpenJS.NodeJS.Current -e --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $major = Get-NodeMajor
  }
  if ($major -lt 24) {
    Write-Host ''
    Write-Host 'Install Node.js 24+ manually from https://nodejs.org then run this script again.'
    Write-Host 'Close and reopen PowerShell after installing.'
    exit 1
  }
}

function Get-AppRoot {
  if ($ScriptRoot) {
    $sibling = Join-Path $ScriptRoot '..'
    if (Test-Path (Join-Path $sibling 'bin\imsg-skimmer.js')) {
      return (Resolve-Path $sibling).Path
    }
  }
  if (Test-Path (Join-Path $InstallDir 'bin\imsg-skimmer.js')) {
    return (Resolve-Path $InstallDir).Path
  }
  return $null
}

function Ensure-App {
  $existing = Get-AppRoot
  if ($existing) {
    Write-Host "imsg-skimmer found at $existing"
    return $existing
  }
  Write-Step "Downloading imsg-skimmer to $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $tmp = Join-Path $env:TEMP ("imsg-skimmer-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'repo.zip'
  Invoke-WebRequest -Uri $RepoZip -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extracted = Join-Path $tmp 'imsg-skimmer-main'
  if (-not (Test-Path $extracted)) { throw 'Unexpected ZIP layout from GitHub.' }
  Copy-Item -Path (Join-Path $extracted '*') -Destination $InstallDir -Recurse -Force
  Remove-Item -Recurse -Force $tmp
  return (Resolve-Path $InstallDir).Path
}

function Write-Launcher([string]$AppRoot) {
  $cmd = @"
@echo off
node "%~dp0bin\imsg-skimmer.js" %*
"@
  Set-Content -Path (Join-Path $AppRoot 'imsg-skimmer.cmd') -Value $cmd -Encoding ASCII
}

function Get-BackupArgs {
  $args = @()
  $p1 = Join-Path $env:USERPROFILE 'Apple\MobileSync\Backup'
  $p2 = Join-Path $env:APPDATA 'Apple Computer\MobileSync\Backup'
  if (Test-Path $p1) { $args += '--backup-root'; $args += $p1 }
  if (Test-Path $p2) { $args += '--backup-root'; $args += $p2 }
  return $args
}

Write-Host 'imsg-skimmer setup' -ForegroundColor Green
Ensure-Node
$AppRoot = Ensure-App
Write-Launcher $AppRoot
$windows = Join-Path $AppRoot 'windows'

Write-Step 'Done'
Write-Host @"

App folder:  $AppRoot
Quick commands (open PowerShell):

  cd "$AppRoot"
  .\imsg-skimmer.cmd list
  .\imsg-skimmer.cmd export --backup 1 --all --out "$env:USERPROFILE\Desktop\My-iPhone-Messages"

Or double-click in:  $windows
  2-List-My-Backups.bat
  3-Export-All-Messages.bat

After export: open Desktop\My-iPhone-Messages\index.html
(search: 5-Search-Exported-Messages.bat)
"@

if ($ExportAfterSetup) {
  Write-Step 'Running export (backup 1) to Desktop\My-iPhone-Messages'
  $out = Join-Path $env:USERPROFILE 'Desktop\My-iPhone-Messages'
  $backupArgs = Get-BackupArgs
  if (-not $backupArgs.Count) {
    Write-Host 'No iPhone backup folder found. Back up the phone in Apple Devices first.'
    exit 1
  }
  & node (Join-Path $AppRoot 'bin\imsg-skimmer.js') export --backup 1 --all --out $out @backupArgs
  if ($LASTEXITCODE -eq 0) { Start-Process $out }
}
