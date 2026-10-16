# Save your iPhone text messages on Windows (step-by-step)

This guide is for **you**, on **your computer**, with **your iPhone**. You do **not** need GitHub, coding, or Linux.
Everything stays on your PC unless **you** choose to copy the export folder somewhere else.

**What you are doing in plain English:**  
Apple already saves a copy of your phone data when you “Back up” the iPhone to this PC. This small program **reads that copy** and writes your messages into a folder on your **Desktop** that you can open in a web browser or Excel.

---

## Words you will see

| Word | Meaning |
|------|--------|
| **Backup** | A snapshot of your iPhone saved on this computer (not iCloud). |
| **Apple Devices** | Microsoft’s app to back up an iPhone on Windows (from the Microsoft Store). |
| **Node.js** | A free program that runs imsg-skimmer. You install it once. |
| **Terminal / black window** | **PowerShell** or **Command Prompt** — a window where you type commands. The included `.bat` files open one for you. |
| **Export** | Copying your messages into HTML, CSV, and JSON files in a folder. |

---

## Before you start — checklist

1. **A Windows PC** where you will plug in the iPhone.
2. **A USB cable** (or reliable connection) for the phone.
3. **Room on the hard drive** — backups and exports can use many gigabytes if you have years of photos in messages.
4. **Your iPhone unlock passcode** (to trust the computer).
5. If you turned on **“Encrypt local backup”** when backing up, you need that **backup password** too (not the same as your Apple ID password unless you chose the same).

---

## Part A — Back up your iPhone to this PC

You only need to do this if you have **never** backed up here, or your last backup is old.

1. Install **Apple Devices** from the **Microsoft Store** (search “Apple Devices”).  
   *(If you already use classic iTunes from the Microsoft Store, that works too.)*
2. Plug the iPhone into the PC. Unlock the phone. If it asks **Trust This Computer?**, tap **Trust** and enter your passcode.
3. Open **Apple Devices**.
4. Click your **iPhone** in the left sidebar.
5. Open **General** (or **Summary** in iTunes).
6. Under **Backups**, choose **Back up all of the data on your iPhone to this computer** (or **This computer** in iTunes).
7. **Optional but common:** turn on **Encrypt local backup** and set a password **you will remember**. Write it down in a safe place.
8. Click **Back Up Now**.
9. Wait until it says the backup finished. **Leave the phone plugged in** until then.

Your backup is now in a hidden folder on this PC. You do not need to find it by hand — the scripts below point the program at it.

---

## Part B — Install Node.js (one time)

1. Open **Microsoft Edge** (or any browser).
2. Go to: **https://nodejs.org**
3. Click the big green button that says something like **Download Node.js (LTS)**.  
   The program needs **version 24 or newer**. If the site only shows “LTS” without a number, download it; we will check the version in step 5.
4. Run the downloaded installer (`node-v…-x64.msi`).
5. Click **Next** through the screens. **Leave all default options checked** (including “Add to PATH”).
6. Finish the installer. **Close and reopen** any black command windows if they were already open.
7. Press the **Windows key**, type **PowerShell**, press **Enter**.
8. Type exactly (then press **Enter**):

   ```text
   node --version
   ```

9. You should see something like `v24.x.x` or higher.  
   - If you see **“node is not recognized”**, restart the PC and try step 8 again.  
   - If the version is **below 24**, go back to nodejs.org and install the **Current** release (24+).

You can close PowerShell.

---

## Part C — Install imsg-skimmer (choose one way)

### Option 1 — Automated (recommended)

**If you already unzipped the download:** double-click  
`imsg-skimmer\windows\0-Setup.bat`

**If you only have PowerShell** (no ZIP yet), paste this **one line**, press Enter, and wait:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/vhuyngo/imsg-skimmer/main/windows/install.ps1'))"
```

That installs Node.js when possible (via `winget`), downloads the app into  
`Documents\imsg-skimmer`, and creates `imsg-skimmer.cmd` for commands.

Then continue at **Part D** (skip the manual ZIP steps below).

### Option 2 — Manual ZIP (no GitHub account needed)

1. Open your browser.
2. Go to: **https://github.com/vhuyngo/imsg-skimmer**
3. Click the green **Code** button, then **Download ZIP**.
4. When the ZIP finishes, open your **Downloads** folder.
5. **Right-click** `imsg-skimmer-main.zip` (or similar) → **Extract All** → **Extract**.
6. You should get a folder named **`imsg-skimmer-main`**.  
   **Rename** it to **`imsg-skimmer`** and move it somewhere easy to find, for example:  
   `C:\Users\YourName\Documents\imsg-skimmer`  
   *(Replace `YourName` with your Windows user name.)*

Remember that folder path — the scripts live inside it.

---

## Part D — Easiest way: use the included scripts

Inside the `imsg-skimmer` folder, open the **`windows`** subfolder. You will see:

| File | What it does |
|------|----------------|
| **`0-Setup.bat`** | **One-time setup:** Node check/install + app folder (run before the others if you use the ZIP). |
| **`1-Check-Node.bat`** | Confirms Node is installed only. |
| **`2-List-My-Backups.bat`** | Shows backups on this PC and gives each a number (`# 1`, `# 2`, …). |
| **`3-Export-All-Messages.bat`** | Exports **all** conversations to your Desktop. |
| **`4-Browse-Messages-In-Browser.bat`** | Opens a private page on **this computer only** to read messages (optional). |
| **`5-Search-Exported-Messages.bat`** | After export, search all `messages.csv` files for a word or name. |

### How to run a `.bat` file

1. **Double-click** the file (for example `1-Check-Node.bat`).
2. A black window opens. Read what it says.
3. When it says **Press any key to continue**, press a key to close it.

**Run them in order:** `1` → `2` → `3` (or `4` instead of `3` if you only want to browse).

### When `3-Export-All-Messages.bat` asks for a password

- If your backup is **encrypted**, the window will say **Backup password:**  
  Type the password you set for **Encrypt local backup**. **Nothing will appear on screen as you type** — that is normal. Press **Enter**.
- Wrong password: it will ask again (up to three tries).
- Unlocking can take **10–30 seconds** the first time. Wait.

### When export finishes

- The script opens your **Desktop** folder **`My-iPhone-Messages`** (or a similar name).

**Find `index.html` first**

1. In File Explorer, open the export folder.
2. Click the **Date modified** column header so the **newest** files are at the **top**.
3. **`index.html`** is written last on purpose, so it should appear at or near the top.
4. Double-click **`index.html`** to open the conversation list in your browser.

Each row shows a **folder name** like `0001-15550100001-alice-example` (number, phone or id, contact name).  
Each conversation also has its own subfolder with that same name, containing **`conversation.html`**, **`messages.csv`**, and **`conversation.json`**.

**Search for specific conversations (terminal)**

You do not have to open every folder by hand.

1. Press **Windows key**, type **PowerShell**, press **Enter**.
2. Go to the export folder (change the path if yours is different):

   ```powershell
   cd $HOME\Desktop\My-iPhone-Messages
   ```

3. Search **all message CSV files** for a word (example: `pharmacy`):

   ```powershell
   Select-String -Path ".\*\messages.csv" -Pattern "pharmacy"
   ```

   The path in the output tells you which folder (`0012-…-contact-name`) matched.

4. Or search the index page:

   ```powershell
   Select-String -Path ".\index.html" -Pattern "alice"
   ```

5. Open that folder’s **`conversation.html`** to read the thread.

To print one chat as PDF: open **`conversation.html`** → browser menu **Print** → **Save as PDF**.

**Message colors in exports and the browser viewer**

- **Blue** bubbles: messages **you sent** with **iMessage**.
- **Green** bubbles: messages **you sent** with **SMS/MMS** (or RCS).
- **Gray** bubbles: messages **you received** (any service).

In a single contact thread, iMessage and SMS can be mixed; each message keeps its own color.

---

## Part E — Manual way (if scripts do not work)

1. Press **Windows key**, type **PowerShell**, press **Enter**.
2. Go to your folder (change the path if you put the folder somewhere else):

   ```powershell
   cd $HOME\Documents\imsg-skimmer
   ```

3. List backups:

   ```powershell
   node bin/imsg-skimmer.js list --backup-root "$env:USERPROFILE\Apple\MobileSync\Backup" --backup-root "$env:APPDATA\Apple Computer\MobileSync\Backup"
   ```

4. Note the backup **number** in the first column (usually **1**).

5. Export everything to your Desktop:

   ```powershell
   node bin/imsg-skimmer.js export --backup 1 --all --out "$env:USERPROFILE\Desktop\My-iPhone-Messages" --backup-root "$env:USERPROFILE\Apple\MobileSync\Backup" --backup-root "$env:APPDATA\Apple Computer\MobileSync\Backup"
   ```

   Change `--backup 1` if step 3 showed a different number.

---

## Privacy (important)

- imsg-skimmer **does not upload** your messages to the internet.
- It **does not change** your iPhone backup.
- It keeps temporary decrypted copies in a cache under your user folder until you delete them (see **Cleanup** below).
- The browse-in-browser option only works on **this PC** (`127.0.0.1`); it is not a link you send to other people.

---

## Cleanup (optional)

To delete temporary cached copies of backup files:

1. Open PowerShell in the `imsg-skimmer` folder (as in Part E).
2. Run:

   ```powershell
   node bin/imsg-skimmer.js purge
   ```

Your **export folder on the Desktop is not deleted** by `purge`.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| **“node is not recognized”** | Reinstall Node from nodejs.org with defaults, restart PC. |
| **No backups listed** | Run a fresh **Back Up Now** in Apple Devices. Keep phone plugged in until done. |
| **“no Messages database”** | Backup did not finish or wrong folder; run backup again. |
| **Forgot encrypt backup password** | Apple cannot recover it; export will not work until you remember it or make a new **unencrypted** backup (turn off encrypt, back up again — only if you accept that tradeoff). |
| **Export is huge / slow** | Normal for long history and many photos. You can close other apps and leave it running. |
| **Photos look wrong in Chrome** | Some iPhone photo formats need Safari; use the files in the **attachments** folder or open HTML in Edge/Safari. |
| **Messages missing** | If **Messages in iCloud** is on, older threads may not be in the PC backup. |

---

## Getting help from family

If you get stuck, send a **screenshot of the black window** (not your message content).  
The person who sent you this tool does **not** need your messages unless **you** choose to share the export folder.
