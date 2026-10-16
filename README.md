# imsg-skimmer

Save and read your **iPhone text messages** (iMessage, SMS, MMS) from a **backup already on your computer**.
Nothing is sent to the internet. The tool does **not** change your phone or your Apple backup.

---

## Start here (Windows, no technical background)

**Full walkthrough:** **[SETUP-WINDOWS.md](SETUP-WINDOWS.md)**

### Simplest path (automated setup)

1. **Back up the iPhone** on this PC with **Apple Devices** (Microsoft Store): plug in → **Back Up Now**.
2. **One-time setup** — pick **one** of these:

   **A) Double-click** (after you downloaded the ZIP once):  
   `windows\0-Setup.bat`  
   Installs Node if `winget` can, and copies the app to `Documents\imsg-skimmer` if needed.

   **B) One PowerShell command** (downloads the installer script from GitHub):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/vhuyngo/imsg-skimmer/main/windows/install.ps1'))"
   ```

   **C) Setup and export in one command** (iPhone must already be backed up to this PC):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $p=Join-Path $env:TEMP 'imsg-install.ps1'; (New-Object Net.WebClient).DownloadFile('https://raw.githubusercontent.com/vhuyngo/imsg-skimmer/main/windows/install.ps1',$p); & $p -ExportAfterSetup }"
   ```

3. **Export messages:** double-click `windows\3-Export-All-Messages.bat`  
   (or run `.\imsg-skimmer.cmd export --backup 1 --all --out "$env:USERPROFILE\Desktop\My-iPhone-Messages"` from `Documents\imsg-skimmer`).

4. Open **`Desktop\My-iPhone-Messages\index.html`** (sort the folder by **Date modified** so `index.html` is on top).

5. Find chats by folder name (`0001-15550100001-alice-example`) or run **`5-Search-Exported-Messages.bat`**.

### Manual path (no scripts)

Download ZIP from [github.com/vhuyngo/imsg-skimmer](https://github.com/vhuyngo/imsg-skimmer) → install [Node 24+](https://nodejs.org) → run `1-Check-Node.bat` → `2-List-My-Backups.bat` → `3-Export-All-Messages.bat`.

### One-liner export (if Node 24+ is already installed)

No ZIP required; downloads the tool each time via `npx`:

```powershell
npx --yes github:vhuyngo/imsg-skimmer export --backup 1 --all --out "$env:USERPROFILE\Desktop\My-iPhone-Messages" --backup-root "$env:USERPROFILE\Apple\MobileSync\Backup" --backup-root "$env:APPDATA\Apple Computer\MobileSync\Backup"
```

Optional: `4-Browse-Messages-In-Browser.bat` reads messages on **this computer only**.

---

## What this program does

| Feature | Description |
|---------|-------------|
| **List backups** | Shows iPhone backups on this PC (device name, date, encrypted or not). |
| **Export** | Writes every conversation to HTML (print to PDF), CSV (Excel), and JSON, with photos/files copied when possible. |
| **Browse** | Local website at `127.0.0.1` with search and date filters — not shareable on the internet. |
| **Purge** | Deletes temporary decrypted copies from the cache (not your export folder). |

---

## What you need

| Requirement | Details |
|-------------|---------|
| **Computer** | Windows (guides above), Mac, or Windows + WSL2 for developers. |
| **iPhone backup on that computer** | From **Apple Devices**, **iTunes**, or **Finder** on Mac — not iCloud-only. |
| **Node.js 24+** | Free from [nodejs.org](https://nodejs.org). No `npm install` for this project. |
| **Backup password** | Only if you enabled **Encrypt local backup** when backing up. Typed locally; never stored. |

**Not supported:** reading messages straight off the cable without a backup, iCloud login, or accessing someone else’s phone without their backup on their machine.

---

## Privacy and safety

- **Read-only:** imsg-skimmer does not modify your Apple backup folder.
- **Local only:** The web UI binds to `127.0.0.1`, needs a one-time token from the terminal, and does not load external websites.
- **Cache:** Decrypted working copies go in a private folder (`%USERPROFILE%\.cache\imsg-skimmer` on Windows, `~/.cache/imsg-skimmer` on Mac/Linux). Run `purge` to remove them.
- **Exports:** Saved where you choose (for example the Desktop). They are **not** deleted by `purge`.
- **Passwords:** Entered in the terminal with hidden typing; not passed on the command line and not logged.

---

## Windows (manual commands)

Open **PowerShell**, `cd` into the folder where you unzipped the project, then:

```powershell
# See backups (tries Apple Devices and classic iTunes locations)
node bin/imsg-skimmer.js list `
  --backup-root "$env:USERPROFILE\Apple\MobileSync\Backup" `
  --backup-root "$env:APPDATA\Apple Computer\MobileSync\Backup"

# Export all messages to the Desktop (use the backup # from list, usually 1)
node bin/imsg-skimmer.js export --backup 1 --all --out "$env:USERPROFILE\Desktop\My-iPhone-Messages" `
  --backup-root "$env:USERPROFILE\Apple\MobileSync\Backup" `
  --backup-root "$env:APPDATA\Apple Computer\MobileSync\Backup"
```

---

## Mac

1. Back up the iPhone in **Finder** (select the phone → Back up all data on this Mac).
2. Install Node 24+ from [nodejs.org](https://nodejs.org).
3. Download and unzip this repository.
4. In **Terminal**:

```bash
cd ~/Downloads/imsg-skimmer-main   # adjust path
node bin/imsg-skimmer.js list
node bin/imsg-skimmer.js export --backup 1 --all --out ~/Desktop/My-iPhone-Messages
```

Backups are read from `~/Library/Application Support/MobileSync/Backup`.

---

## Developers (Git, WSL, all commands)

Clone and test:

```bash
git clone git@github.com:vhuyngo/imsg-skimmer.git
cd imsg-skimmer
node bin/imsg-skimmer.js --version
npm test
```

### Command reference

```text
imsg-skimmer list
imsg-skimmer list --backup <#>              # conversations in that backup
imsg-skimmer list --backup <#> --counts     # numbers only, no names in output
imsg-skimmer serve --backup <#>             # http://127.0.0.1:8686/?token=…
imsg-skimmer export --backup <#> --all --out <dir>
imsg-skimmer export --backup <#> --chat 12,57 --from 2021-01-01 --to 2021-12-31
imsg-skimmer purge                          # delete cache
```

Options:

- `--backup` — number from `list`, folder name prefix, or full path to one backup folder.
- `--backup-root` — folder that contains backup subfolders (repeatable). On WSL, defaults include `/mnt/c/Users/*/Apple/MobileSync/Backup` and classic iTunes paths.
- `--from` / `--to` — `YYYY-MM-DD`, inclusive, local time.
- `--no-attachments` — faster export without copying media files.
- `--format html,csv,json` — default is all three.

### WSL note

If you run inside **WSL** and export to Linux paths, writing to `/mnt/c/...` is **blocked** on purpose. Export to `~/imsg-export` and open from Windows via `\\wsl$\<distro>\home\...` or `explorer.exe .` from WSL.

### Export layout

```text
<out>/index.html                                    (written last; sort by Date modified to find it first)
<out>/<index>-<phone-number>-<contact-name>/conversation.html
<out>/<index>-<phone-number>-<contact-name>/messages.csv
<out>/<index>-<phone-number>-<contact-name>/conversation.json
<out>/<index>-<phone-number>-<contact-name>/attachments/…
```

Example folder: `0001-15550100001-alice-example`. The same string appears in the **Conversation (folder name)** column in `index.html`.

**Find conversations after export:** open `index.html`, or in PowerShell from the export folder:

```powershell
Select-String -Path ".\*\messages.csv" -Pattern "keyword"
```

Outgoing **iMessage** = blue bubble; outgoing **SMS/MMS/RCS** = green; incoming = gray (in exported HTML and the local web UI).

CSV uses a UTF-8 BOM and prefixes cells that start with `=`, `+`, `-`, or `@` with `'` so Excel does not run formulas.

---

## Back up the iPhone (reminder)

1. Install **Apple Devices** (Windows) or use **Finder** (Mac).
2. Connect USB, unlock, **Trust** the computer.
3. Choose **back up to this computer** (not iCloud only).
4. **Back Up Now** and wait until it finishes.

If **Messages in iCloud** is enabled, some older messages or attachments may not be in the PC backup.

---

## Limitations

No USB live extraction, iCloud, third-party chat apps, backup restore, or LAN sharing. Edited messages are marked but history is not shown. Some sticker reactions appear as a generic badge.

---

## Project layout

`bin/` — program entry · `src/` — backup reading, export, server · `web/` — browser UI · `test/` — automated tests · `windows/` — double-click scripts for Windows · `SETUP-WINDOWS.md` — detailed guide for non-technical users.
