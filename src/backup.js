// Backup discovery and read-only access to backup files through Manifest.db.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { assertWritable, protectDir, resolveReal } from './cache.js';
import { Keybag, WrongPasswordError, createCbcDecipher, pkcs7PaddingLength } from './keybag.js';
import { parsePlist, unarchive } from './plist.js';

export const SMS_DB = ['HomeDomain', 'Library/SMS/sms.db'];
export const ADDRESS_BOOK = ['HomeDomain', 'Library/AddressBook/AddressBook.sqlitedb'];
const BACKUP_MARKERS = ['Info.plist', 'Manifest.plist', 'Manifest.db', 'Status.plist'];
const FILE_FLAG = 1;

export class UsageError extends Error {}

export function fileIdFor(domain, relativePath) {
  return crypto.createHash('sha1').update(`${domain}-${relativePath}`).digest('hex');
}

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function defaultBackupRoots() {
  const roots = [];
  let users = [];
  try {
    users = fs.readdirSync('/mnt/c/Users', { withFileTypes: true });
  } catch {
    users = [];
  }
  for (const user of users) {
    if (!user.isDirectory()) continue;
    for (const rel of ['Apple/MobileSync/Backup', 'AppData/Roaming/Apple Computer/MobileSync/Backup']) {
      const dir = path.join('/mnt/c/Users', user.name, rel);
      if (isDir(dir)) roots.push(dir);
    }
  }
  const mac = path.join(os.homedir(), 'Library/Application Support/MobileSync/Backup');
  if (isDir(mac)) roots.push(mac);
  return roots;
}

function readPlistFile(file, problems) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') problems.push(`${path.basename(file)} unreadable`);
    return null;
  }
  try {
    return parsePlist(data);
  } catch {
    problems.push(`${path.basename(file)} is not a valid plist`);
    return null;
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const date = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v : null);

export function inspectBackup(dir) {
  const problems = [];
  const info = readPlistFile(path.join(dir, 'Info.plist'), problems);
  const manifest = readPlistFile(path.join(dir, 'Manifest.plist'), problems);
  const status = readPlistFile(path.join(dir, 'Status.plist'), problems);
  const lockdown = manifest?.Lockdown ?? {};
  const smsId = fileIdFor(...SMS_DB);
  const hasSmsDb = exists(path.join(dir, smsId.slice(0, 2), smsId));
  if (!info) problems.push('no Info.plist');
  if (!manifest) problems.push('no Manifest.plist');
  if (!exists(path.join(dir, 'Manifest.db'))) problems.push('no Manifest.db');
  if (!hasSmsDb) problems.push('no Messages database');
  if (status && typeof status.SnapshotState === 'string' && status.SnapshotState !== 'finished') {
    problems.push(`snapshot ${status.SnapshotState}`);
  }
  const real = resolveReal(dir);
  const id = path.basename(dir);
  return {
    id,
    path: dir,
    root: path.dirname(dir),
    deviceName: str(info?.['Device Name']) ?? str(info?.['Display Name']) ?? str(lockdown.DeviceName),
    productType: str(info?.['Product Type']) ?? str(lockdown.ProductType),
    productVersion: str(info?.['Product Version']) ?? str(lockdown.ProductVersion),
    lastBackupDate: date(info?.['Last Backup Date']) ?? date(status?.Date) ?? date(manifest?.Date),
    encrypted: typeof manifest?.IsEncrypted === 'boolean' ? manifest.IsEncrypted : null,
    hasSmsDb,
    problems,
    usable: problems.length === 0,
    cacheKey: `${id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 8)}`,
  };
}

const looksLikeBackup = (dir) => BACKUP_MARKERS.some((f) => exists(path.join(dir, f)));

export function discoverBackups(roots) {
  const found = [];
  const seen = new Set();
  const add = (dir) => {
    const real = resolveReal(dir);
    if (seen.has(real)) return;
    seen.add(real);
    found.push(inspectBackup(dir));
  };
  for (const root of roots) {
    if (looksLikeBackup(root)) {
      add(root);
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'iMazing.Versions') continue;
      const dir = path.join(root, entry.name);
      if (looksLikeBackup(dir)) add(dir);
    }
  }
  return found;
}

// Accepts the # shown by `list`, a backup-folder prefix, or a path.
export function selectBackup(backups, selector) {
  if (!selector) {
    const withSms = backups.filter((b) => b.hasSmsDb);
    if (withSms.length === 1) return withSms[0];
    if (!withSms.length) throw new UsageError('No backup with a Messages database was found. Run `imsg-skimmer list`.');
    throw new UsageError('Several backups found; choose one with --backup <# or folder prefix> (see `imsg-skimmer list`).');
  }
  const sel = String(selector).trim().replace(/^#/, '');
  if (/^\d{1,3}$/.test(sel) && Number(sel) >= 1 && Number(sel) <= backups.length) return backups[Number(sel) - 1];
  if (sel.includes('/')) {
    const real = resolveReal(sel);
    const hit = backups.find((b) => resolveReal(b.path) === real);
    if (hit) return hit;
    if (looksLikeBackup(real)) return inspectBackup(real);
    throw new UsageError(`${sel} is not a backup folder.`);
  }
  let matches = backups.filter((b) => b.id.toLowerCase().startsWith(sel.toLowerCase()));
  if (matches.length > 1) {
    const withSms = matches.filter((b) => b.hasSmsDb);
    if (withSms.length === 1) matches = withSms;
  }
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new UsageError(`No backup matches "${sel}". Run \`imsg-skimmer list\`.`);
  throw new UsageError(`"${sel}" matches ${matches.length} backups; use the # from \`imsg-skimmer list\`.`);
}

function decodeFileRecord(blob) {
  if (!blob) return null;
  try {
    const rec = unarchive(parsePlist(Buffer.from(blob)));
    return {
      size: Number.isFinite(rec.Size) ? rec.Size : null,
      protectionClass: Number.isFinite(rec.ProtectionClass) ? rec.ProtectionClass : null,
      encryptionKey: Buffer.isBuffer(rec.EncryptionKey) ? rec.EncryptionKey : null,
    };
  } catch {
    return null;
  }
}

const sqliteUrl = (file, immutable) => {
  const url = pathToFileURL(file);
  if (immutable) url.searchParams.set('immutable', '1');
  return url;
};

// Opens a cached SQLite copy without creating -wal/-shm files next to it.
export function openCachedDatabase(file, { hasWal = false } = {}) {
  return hasWal ? new DatabaseSync(file) : new DatabaseSync(sqliteUrl(file, true), { readOnly: true });
}

async function copyTo(src, dst) {
  await pipeline(fs.createReadStream(src), fs.createWriteStream(dst, { mode: 0o600, flags: 'wx' }));
}

async function decryptTo(src, dst, key, plainSize, { sqlite = false } = {}) {
  await pipeline(fs.createReadStream(src), createCbcDecipher(key), fs.createWriteStream(dst, { mode: 0o600, flags: 'wx' }));
  const written = fs.statSync(dst).size;
  if (plainSize !== null && plainSize <= written) {
    if (plainSize < written) fs.truncateSync(dst, plainSize);
    return;
  }
  if (written < 16) return;
  const tail = Buffer.alloc(16);
  const fd = fs.openSync(dst, 'r');
  try {
    fs.readSync(fd, tail, 0, 16, written - 16);
  } finally {
    fs.closeSync(fd);
  }
  const pad = pkcs7PaddingLength(tail);
  if (pad && (!sqlite || (written - pad) % 512 === 0)) fs.truncateSync(dst, written - pad);
}

export class Backup {
  constructor(meta, cache) {
    this.meta = meta;
    this.dir = meta.path;
    this.cache = cache;
    this.encrypted = false;
    this.keybag = null;
    this.db = null;
  }

  async open({ getPassword, log = () => {} } = {}) {
    protectDir(this.dir);
    protectDir(this.meta.root);
    const manifestPlist = parsePlist(fs.readFileSync(path.join(this.dir, 'Manifest.plist')));
    this.encrypted = manifestPlist.IsEncrypted === true;
    this.cacheDir = this.cache.dirFor(this.meta.cacheKey);
    this.filesDir = path.join(this.cacheDir, 'files');
    const src = path.join(this.dir, 'Manifest.db');
    const dst = path.join(this.cacheDir, 'Manifest.db');
    if (this.encrypted) {
      if (!getPassword) throw new UsageError('This backup is encrypted; its password is required.');
      this.keybag = Keybag.parse(manifestPlist.BackupKeyBag);
      await this.#unlock(getPassword, log);
      const key = this.keybag.unwrapPrefixedKey(manifestPlist.ManifestKey);
      try {
        await this.#materialize(src, dst, (tmp) => decryptTo(src, tmp, key, null, { sqlite: true }));
      } finally {
        key.fill(0);
      }
    } else {
      await this.#materialize(src, dst, (tmp) => copyTo(src, tmp));
    }
    this.db = openCachedDatabase(dst);
    this.lookupStmt = this.db.prepare('SELECT fileID, flags, file FROM Files WHERE domain = ? AND relativePath = ?');
    this.byIdStmt = this.db.prepare('SELECT fileID, flags, file FROM Files WHERE fileID = ?');
    this.fileCount = this.db.prepare('SELECT count(*) AS n FROM Files').get().n;
    return this;
  }

  async #unlock(getPassword, log) {
    for (let attempt = 1; ; attempt++) {
      const password = await getPassword(attempt);
      if (typeof password !== 'string' || !password) throw new UsageError('No backup password provided.');
      log('Unlocking backup keybag (this can take several seconds)...');
      try {
        await this.keybag.unlock(password);
        return;
      } catch (err) {
        if (err instanceof WrongPasswordError && getPassword.interactive && attempt < 3) {
          log('Incorrect password, try again.');
          continue;
        }
        throw err;
      }
    }
  }

  #readMeta() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.cacheDir, 'meta.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  // Copies or decrypts `src` into the cache once; reuses the copy while the source is unchanged.
  async #materialize(src, dst, produce) {
    const st = fs.statSync(src);
    const fingerprint = `${st.size}:${Math.round(st.mtimeMs)}:${this.encrypted ? 'dec' : 'raw'}`;
    const rel = path.relative(this.cacheDir, dst);
    const meta = this.#readMeta();
    if (meta[rel] === fingerprint && exists(dst)) return dst;
    assertWritable(dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    const tmp = `${dst}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await produce(tmp);
      fs.renameSync(tmp, dst);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    meta[rel] = fingerprint;
    const metaFile = path.join(this.cacheDir, 'meta.json');
    fs.writeFileSync(`${metaFile}.tmp`, JSON.stringify(meta), { mode: 0o600 });
    fs.renameSync(`${metaFile}.tmp`, metaFile);
    return dst;
  }

  lookup(domain, relativePath) {
    const candidates = [relativePath, relativePath.normalize('NFC'), relativePath.normalize('NFD')];
    for (const rel of new Set(candidates)) {
      const row = this.lookupStmt.get(domain, rel);
      if (row) return { fileID: row.fileID, flags: row.flags, record: decodeFileRecord(row.file) };
    }
    const row = this.byIdStmt.get(fileIdFor(domain, relativePath));
    return row ? { fileID: row.fileID, flags: row.flags, record: decodeFileRecord(row.file) } : null;
  }

  sourcePath(entry) {
    return path.join(this.dir, entry.fileID.slice(0, 2), entry.fileID);
  }

  #find(domain, relativePath) {
    const entry = this.lookup(domain, relativePath);
    if (!entry || entry.flags !== FILE_FLAG) return null;
    const src = this.sourcePath(entry);
    return exists(src) ? { entry, src } : null;
  }

  // Writes the plaintext of a backup file to `tmp`.
  async #produce({ entry, src }, tmp) {
    if (!this.encrypted) return copyTo(src, tmp);
    const rec = entry.record;
    if (!rec?.encryptionKey) {
      if ((rec?.size ?? 0) === 0) return copyTo(src, tmp);
      throw new Error(`Missing encryption key for ${entry.fileID}`);
    }
    const key = this.keybag.unwrapPrefixedKey(rec.encryptionKey);
    try {
      await decryptTo(src, tmp, key, rec.size);
    } finally {
      key.fill(0);
    }
  }

  // Returns the cache path of a backup file (copied or decrypted on first use), or null if absent.
  async extract(domain, relativePath, { as = null } = {}) {
    const found = this.#find(domain, relativePath);
    if (!found) return null;
    const dst = as ? path.join(this.cacheDir, as) : path.join(this.filesDir, found.entry.fileID);
    return this.#materialize(found.src, dst, (tmp) => this.#produce(found, tmp));
  }

  // Writes a backup file straight to `dst` outside the cache (used by exports).
  async copyOut(domain, relativePath, dst) {
    const found = this.#find(domain, relativePath);
    if (!found) return false;
    assertWritable(dst);
    const tmp = `${dst}.partial-${process.pid}`;
    try {
      await this.#produce(found, tmp);
      fs.renameSync(tmp, dst);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return true;
  }

  // Extracts a SQLite database plus its -wal sidecar when the backup has one.
  async extractDatabase(domain, relativePath, name) {
    const db = await this.extract(domain, relativePath, { as: name });
    if (!db) return null;
    const wal = await this.extract(domain, `${relativePath}-wal`, { as: `${name}-wal` });
    return { path: db, hasWal: Boolean(wal) };
  }

  close() {
    this.db?.close();
    this.db = null;
    this.keybag?.lock();
  }
}
