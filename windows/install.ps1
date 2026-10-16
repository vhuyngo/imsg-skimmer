# Installs or updates imsg-skimmer from GitHub main (overwrites the app folder).
# Re-run anytime to get the latest version. Does not delete exports on your Desktop.
#Requires -Version 5.1
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'Documents\imsg-skimmer'),
  [switch]$SkipNodeCheck,
  [switch]$SkipUpdate,
  [switch]$ExportAfterSetup
)

$ErrorActionPreference = 'Stop'
$RepoZip = 'https://github.com/vhuyngo/imsg-skimmer/archive/refs/heads/main.zip'
$ScriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { '' }

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

function Read-AppVersion([string]$Dir) {
  $pkg = Join-Path $Dir 'package.json'
  if (-not (Test-Path $pkg)) { return $null }
  return (Get-Content $pkg -Raw | ConvertFrom-Json).version
}

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
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget upgrade --id OpenJS.NodeJS.Current -e --accept-package-agreements --accept-source-agreements 2>$null | Out-Null
    }
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

function Sync-Directory([string]$From, [string]$To) {
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $null = & robocopy.exe $From $To /MIR /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) { throw "Could not copy files (robocopy exit $LASTEXITCODE)." }
}

function Download-LatestApp {
  Write-Step "Downloading latest imsg-skimmer from GitHub (branch: main)"
  $tmp = Join-Path $env:TEMP ("imsg-skimmer-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'repo.zip'
    Invoke-WebRequest -Uri $RepoZip -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $extracted = Join-Path $tmp 'imsg-skimmer-main'
    if (-not (Test-Path (Join-Path $extracted 'bin\imsg-skimmer.js'))) {
      throw 'Unexpected ZIP layout from GitHub.'
    }
    return $extracted
  } finally {
    if (Test-Path (Join-Path $tmp 'repo.zip')) { Remove-Item -Force (Join-Path $tmp 'repo.zip') -ErrorAction SilentlyContinue }
  }
}

function Install-OrUpdate-App {
  $oldVersion = Read-AppVersion $InstallDir
  if ($SkipUpdate -and $oldVersion) {
    Write-Host "Skipping download (-SkipUpdate). Version $oldVersion at $InstallDir"
    return (Resolve-Path $InstallDir).Path
  }

  $extracted = Download-LatestApp
  $newVersion = Read-AppVersion $extracted
  if ($oldVersion) {
    Write-Host "Updating $InstallDir (was v$oldVersion, now v$newVersion)..."
  } else {
    Write-Host "Installing v$newVersion to $InstallDir ..."
  }
  Sync-Directory $extracted $InstallDir
  Remove-Item -Recurse -Force (Split-Path $extracted -Parent) -ErrorAction SilentlyContinue

  $meta = @{
    version   = $newVersion
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    source    = 'github.com/vhuyngo/imsg-skimmer@main'
  }
  Set-Content -Path (Join-Path $InstallDir '.install-meta.json') -Value ($meta | ConvertTo-Json) -Encoding UTF8
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

Write-Host 'imsg-skimmer setup / update' -ForegroundColor Green
Ensure-Node
$AppRoot = Install-OrUpdate-App
Write-Launcher $AppRoot
$windows = Join-Path $AppRoot 'windows'
$ver = Read-AppVersion $AppRoot

Write-Step 'Done'
Write-Host @"

App folder:  $AppRoot  (version $ver)
Re-run this script anytime to overwrite with the latest GitHub release.

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

if ($ScriptRoot) {
  $here = (Resolve-Path (Join-Path $ScriptRoot '..')).Path
  if ($here -ne $AppRoot) {
    Write-Host "`nNote: use $AppRoot for the current copy (this folder may be an older ZIP)." -ForegroundColor Yellow
  }
}

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
