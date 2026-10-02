// Private cache for copied/decrypted backup files, plus the guards that keep writes off the backups.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.imsg-skimmer-cache';
const WINDOWS_DRIVE = /^\/mnt\/[a-z](\/|$)/i;
const protectedDirs = new Set();

export class UnsafePathError extends Error {}

export function defaultCacheRoot(env = process.env) {
  if (env.IMSG_SKIMMER_CACHE) return path.resolve(env.IMSG_SKIMMER_CACHE);
  const base = env.XDG_CACHE_HOME ? path.resolve(env.XDG_CACHE_HOME) : path.join(os.homedir(), '.cache');
  return path.join(base, 'imsg-skimmer');
}

// Resolves symlinks on the longest existing prefix so a link cannot redirect a write.
export function resolveReal(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(p);
    tail.unshift(path.basename(current));
    current = parent;
  }
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function protectDir(dir) {
  protectedDirs.add(resolveReal(dir));
}

export function assertWritable(target) {
  const real = resolveReal(target);
  if (WINDOWS_DRIVE.test(real)) {
    throw new UnsafePathError(
      `Refusing to write to ${real}: imsg-skimmer never writes to Windows drives. Use a Linux path such as ~/imsg-export.`,
    );
  }
  for (const dir of protectedDirs) {
    if (isInside(real, dir)) throw new UnsafePathError(`Refusing to write inside a backup folder (${dir}).`);
  }
  return real;
}

export function ensurePrivateDir(dir, { chmodExisting = true } = {}) {
  assertWritable(dir);
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed || chmodExisting) fs.chmodSync(dir, 0o700);
  return dir;
}

export class Cache {
  constructor(root = defaultCacheRoot()) {
    this.root = path.resolve(root);
  }

  init() {
    ensurePrivateDir(this.root);
    const marker = path.join(this.root, MARKER);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, 'imsg-skimmer cache; safe to delete with `imsg-skimmer purge`.\n', { mode: 0o600 });
    }
    return this;
  }

  dirFor(key) {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || key === '.' || key === '..') throw new Error('Invalid cache key');
    this.init();
    return ensurePrivateDir(path.join(this.root, key));
  }

  // Deletes one backup's cache (key) or the whole cache; only a directory carrying our marker.
  purge(key = null) {
    const root = resolveReal(this.root);
    if (!fs.existsSync(root)) return { removed: false, files: 0, bytes: 0 };
    if (!fs.existsSync(path.join(root, MARKER))) {
      throw new UnsafePathError(`${root} is not an imsg-skimmer cache (marker file missing); not deleting it.`);
    }
    assertWritable(root);
    if (root === path.parse(root).root || root === resolveReal(os.homedir())) throw new UnsafePathError('Refusing to delete this directory.');
    let target = root;
    if (key) {
      if (!/^[A-Za-z0-9._-]+$/.test(key) || key === '.' || key === '..') throw new Error('Invalid cache key');
      target = path.join(root, key);
      if (!fs.existsSync(target)) return { removed: false, files: 0, bytes: 0 };
    }
    const stats = usage(target);
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: true, ...stats };
  }
}

function usage(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}
