# imsg-skimmer

A local, read-only viewer and exporter for the iMessage, SMS and MMS history stored in iPhone backups
on this PC, similar to the Messages features of iMazing and Decipher TextMessage. It runs in WSL,
reads the backups that iTunes or the Apple Devices app keep on the Windows side, and never changes them.

- Lists the backups on the PC: device, iOS version, last backup date, encryption, completeness.
- Opens unencrypted backups directly and encrypted ones with the backup password.
- Browses conversations in a local web UI with inline attachments, full-text search and a date filter.
- Exports one or all conversations to HTML (printable as PDF), CSV and JSON, with attachments copied.

## Installation

You need **Node.js 24 or newer** ([nodejs.org](https://nodejs.org/)) and a **local iPhone backup** on the same
computer (see [Making a fresh backup](#making-a-fresh-backup)). There are no `npm install` dependencies.

### Get the project

```bash
git clone git@github.com:vhuyngo/imsg-skimmer.git
cd imsg-skimmer
node bin/imsg-skimmer.js --version
```

On Windows without Git, download the repository as a ZIP from GitHub and unzip it, then open a terminal in
that folder.

Optional: add a shortcut so you do not type the full path every time.

```bash
# Linux / macOS / WSL
ln -s "$(pwd)/bin/imsg-skimmer.js" ~/.local/bin/imsg-skimmer
# or: alias imsg-skimmer="node $HOME/imsg-skimmer/bin/imsg-skimmer.js"
```

### Where backups are found

| Your setup | What to do |
|------------|------------|
| **Windows + WSL2** (recommended for this repo) | Clone or copy the project into WSL. `list` searches `C:\Users\…` backup folders automatically via `/mnt/c`. |
| **Mac** | `list` uses `~/Library/Application Support/MobileSync/Backup`. |
| **Windows only** (PowerShell, no WSL) | Pass your backup folder explicitly (Apple Devices or iTunes path): `--backup-root "%USERPROFILE%\Apple\MobileSync\Backup"` or `--backup-root "%APPDATA%\Apple Computer\MobileSync\Backup"`. |

### First run (export everything)

Replace `1` with the backup number from `list` if yours is different.

```bash
node bin/imsg-skimmer.js list
node bin/imsg-skimmer.js export --backup 1 --all --out ~/imsg-export
```

Encrypted backups prompt for the **Encrypt local backup** password in the terminal (input is hidden). Decrypted
files are cached under `~/.cache/imsg-skimmer` until you run `purge`.

### Browse in the browser (optional)

```bash
node bin/imsg-skimmer.js serve --backup 1
```

Open the `http://127.0.0.1:…/?token=…` link printed in the terminal **on this computer only**. Press Ctrl+C
to stop.

### Verify the install (optional)

```bash
npm test
```

Runs automated checks against synthetic backups in a temp directory; your real backup is not modified.

## Privacy and safety

- **Backups are read-only.** imsg-skimmer never writes to `/mnt/<drive>/…` or inside a backup folder,
  and never opens a backup database in place (SQLite would create lock files next to it). The files it
  needs (`Manifest.db`, `sms.db`, `AddressBook.sqlitedb`, attachments you view) are copied or decrypted
  into a private cache, `~/.cache/imsg-skimmer` (mode `0700`), which `imsg-skimmer purge` deletes.
- **Local only.** The web UI listens on `127.0.0.1` only, needs the per-run access token printed in the
  terminal, rejects foreign `Host` headers, and loads nothing from the internet. Nothing is sent anywhere.
- **Passwords.** The backup password is typed at a hidden terminal prompt. It is not accepted as a
  command-line argument, never stored, and never logged. Decrypted copies stay in the cache until you
  run `purge`.
- `list --counts` and the export/serve progress lines print counts and ids only, never message text,
  names or numbers.

## Setup

Requirements: WSL2 and Node.js 24 or newer (`node --version`). There are no npm dependencies: Node's
built-in `node:sqlite`, `crypto`, `http` and test runner cover everything, and the small parsers for
property lists and `attributedBody` are part of the project.

```bash
cd ~/imsg-skimmer
npm test                                     # optional: runs the suite against synthetic backups
alias imsg-skimmer="node $HOME/imsg-skimmer/bin/imsg-skimmer.js"   # add to ~/.bashrc to keep it
```

Or put it on your `PATH` instead of an alias: `ln -s ~/imsg-skimmer/bin/imsg-skimmer.js ~/.local/bin/imsg-skimmer`.

## Commands

```bash
imsg-skimmer list                            # backups found on this PC, numbered
imsg-skimmer list --backup 1                 # conversations in backup #1 (id, type, counts, title)
imsg-skimmer list --backup 1 --counts        # aggregate counts only (no names or text)
imsg-skimmer serve --backup 1                # web UI; open the printed http://127.0.0.1:8686/?token=… link
imsg-skimmer export --backup 1 --all --out ~/imsg-export
imsg-skimmer export --backup 1 --chat 12,57 --format html --from 2021-01-01 --to 2021-12-31 --out ~/trip
imsg-skimmer purge                           # delete the whole cache (or: purge --backup 1)
```

- `--backup` accepts the `#` from `list`, a prefix of the backup folder name, or a folder path.
- Backups are looked for in `C:\Users\<user>\Apple\MobileSync\Backup` (Apple Devices app and the
  Microsoft Store iTunes) and `C:\Users\<user>\AppData\Roaming\Apple Computer\MobileSync\Backup`
  (classic iTunes), reached as `/mnt/c/Users/...`. Use `--backup-root <dir>` (repeatable) to look
  elsewhere. iMazing's `iMazing.Versions` snapshot store is skipped. Incomplete folders are listed with
  the problem (for example `no Info.plist, no Messages database`) and cannot be opened.
- `--from` / `--to` take `YYYY-MM-DD` in local time and are inclusive. `--json` gives machine-readable
  `list` output. `--cache-dir` (or `IMSG_SKIMMER_CACHE`) moves the cache.
- Conversation ids come from `list --backup`. SMS and iMessage threads with the same number or address
  are merged into one conversation, as in the Messages app.

### Encrypted backups

When a backup is encrypted, every command that opens it asks for the password on the terminal (up to
three tries). Unlocking runs Apple's key derivation (PBKDF2, about ten million rounds) and takes a few
seconds. The same password you set in iTunes or Apple Devices under "Encrypt local backup" is needed;
there is no way around it.

### Web UI

`serve` loads the backup, then prints a link such as `http://127.0.0.1:8686/?token=…`. Open it in a
browser on Windows: WSL2 forwards `127.0.0.1` to Windows by default. If the page does not load, check
that `localhostForwarding` is not disabled in `%UserProfile%\.wslconfig`, or use `--port` if 8686 is
taken. Stop the server with Ctrl+C.

The UI has the conversation list (with a title filter), threads with bubbles, sender names in groups,
reactions (tapbacks are folded into the message they react to), inline photos, video and audio,
search across all conversations or the open one (case- and accent-insensitive, `"quoted phrases"`
supported), and a date range filter that applies to the list, the thread and search.

HEIC photos only render in browsers that support HEIC (Safari); elsewhere they appear as a download link.

### Export output

```text
<out>/index.html                         list of exported conversations
<out>/0012-<title>/conversation.html     printable thread (browser: Print > Save as PDF)
<out>/0012-<title>/messages.csv          UTF-8 with BOM, one row per message
<out>/0012-<title>/conversation.json     full detail: participants, messages, reactions, attachments
<out>/0012-<title>/attachments/…         copied attachment files, linked from the HTML and JSON
```

The export folder must be on the Linux side (the default is `./imsg-export-<timestamp>`); writing to a
Windows drive is refused. To open it from Windows, run `explorer.exe .` inside the folder or browse to
`\\wsl$\<distro>\home\<you>\…`. Exports are not in the cache, so `purge` does not remove them. In the
CSV, cells that start with `=`, `+`, `-` or `@` get a leading `'` so spreadsheet apps do not run them as
formulas; the JSON keeps the exact text. Add `--no-attachments` to skip copying files.

## Making a fresh backup

1. Install **Apple Devices** from the Microsoft Store (or use **iTunes** if you already have it),
   connect the iPhone with a USB cable, unlock it and tap **Trust**.
2. Apple Devices: select the iPhone in the sidebar, open **General**, and under Backups choose **Back up
   all of the data on your iPhone to this computer**. iTunes: click the phone icon, open **Summary**,
   and under Backups choose **This Computer**.
3. Optional: tick **Encrypt local backup** and set a password you will remember. Encrypted backups also
   include data such as saved passwords and Health; imsg-skimmer will ask for this password.
4. Click **Back Up Now** and wait until it finishes, then run `imsg-skimmer list`. The new backup shows
   the current date; an interrupted one shows a problem in the Status column.

If **Messages in iCloud** is on, older messages or attachments that the iPhone has offloaded to iCloud
are not in a local backup; imsg-skimmer marks attachments it cannot find as "not in backup".

## Limitations

Out of scope by design: direct USB access to a phone, iCloud, third-party chat apps, creating,
restoring or modifying backups, and serving on the network. Message effects and edit history are not
shown (edited messages are marked), sticker tapbacks appear as a badge without the sticker image, and
group events use short generic descriptions.

## Development

```bash
npm test          # node --test; builds synthetic unencrypted and encrypted backups in a temp dir
```

The tests generate fake backups (low PBKDF2 iterations for the encrypted one) covering seconds and
nanosecond dates, `attributedBody`-only text, a group chat, contact names, tapbacks and an attachment,
and check that the backup folders are byte-for-byte unchanged afterwards. `IMSG_SKIMMER_TEST_PASSWORD`
supplies the password to the CLI in tests only; do not use it for real backups.
`IMSG_SKIMMER_DEBUG=1` prints stack traces on errors.

Layout: `bin/` (entry point), `src/` (backup discovery and decryption, `sms.db` reader, export, server,
CLI), `web/` (UI), `test/` (fixture generator and tests).
