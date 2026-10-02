// iOS backup keybag (Manifest.plist BackupKeyBag) and the AES primitives used by encrypted backups.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);

const WRAP_PASSCODE = 2;
const KEY_WRAP_IV = Buffer.from('a6a6a6a6a6a6a6a6', 'hex');
export const ZERO_IV = Buffer.alloc(16);
const CLASS_KEY_TAGS = new Set(['CLAS', 'WRAP', 'WPKY', 'KTYP', 'PBKY']);
const WRAP_ALGORITHMS = { 16: 'id-aes128-wrap', 24: 'id-aes192-wrap', 32: 'id-aes256-wrap' };

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect backup password.');
    this.name = 'WrongPasswordError';
  }
}

// RFC 3394 AES key unwrap; returns null when the integrity check fails.
export function aesUnwrap(kek, wrapped) {
  const algorithm = WRAP_ALGORITHMS[kek.length];
  if (!algorithm) throw new Error('Invalid key-encryption key length');
  try {
    const decipher = crypto.createDecipheriv(algorithm, kek, KEY_WRAP_IV);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch {
    return null;
  }
}

export function aesWrap(kek, key) {
  const cipher = crypto.createCipheriv(WRAP_ALGORITHMS[kek.length], kek, KEY_WRAP_IV);
  return Buffer.concat([cipher.update(key), cipher.final()]);
}

export function createCbcDecipher(key) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, ZERO_IV);
  decipher.setAutoPadding(false);
  return decipher;
}

export function aesCbcDecrypt(key, data) {
  const decipher = createCbcDecipher(key);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function aesCbcEncrypt(key, data) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, ZERO_IV);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

// Length of valid PKCS#7 padding at the end of `tail`, or 0.
export function pkcs7PaddingLength(tail) {
  const n = tail[tail.length - 1];
  if (!n || n > 16 || n > tail.length) return 0;
  for (let i = tail.length - n; i < tail.length; i++) if (tail[i] !== n) return 0;
  return n;
}

export function parseTLV(buf) {
  const out = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const tag = buf.toString('latin1', pos, pos + 4);
    const len = buf.readUInt32BE(pos + 4);
    if (pos + 8 + len > buf.length) throw new Error('Malformed backup keybag');
    out.push([tag, buf.subarray(pos + 8, pos + 8 + len)]);
    pos += 8 + len;
  }
  return out;
}

export class Keybag {
  constructor() {
    this.type = null;
    this.uuid = null;
    this.wrap = null;
    this.attrs = {};
    this.classKeys = new Map();
    this.keys = null;
  }

  static parse(buf) {
    if (!Buffer.isBuffer(buf)) throw new Error('Manifest.plist has no BackupKeyBag');
    const kb = new Keybag();
    let current = null;
    const commit = () => {
      if (current && current.CLAS !== undefined) kb.classKeys.set(current.CLAS, current);
    };
    for (const [tag, raw] of parseTLV(buf)) {
      const value = raw.length === 4 ? raw.readUInt32BE(0) : Buffer.from(raw);
      if (tag === 'TYPE') kb.type = value;
      else if (tag === 'UUID' && kb.uuid === null) kb.uuid = value;
      else if (tag === 'WRAP' && kb.wrap === null) kb.wrap = value;
      else if (tag === 'UUID') {
        commit();
        current = { UUID: value };
      } else if (current && CLASS_KEY_TAGS.has(tag)) current[tag] = value;
      else kb.attrs[tag] = value;
    }
    commit();
    return kb;
  }

  // Derives the passcode key (PBKDF2-SHA256 then PBKDF2-SHA1 on iOS 10.2+) and unwraps the class keys.
  async unlock(password) {
    const { SALT, ITER, DPSL, DPIC } = this.attrs;
    if (!Buffer.isBuffer(SALT) || typeof ITER !== 'number') throw new Error('Backup keybag has no password salt');
    const secret = Buffer.from(String(password), 'utf8');
    let stage = secret;
    if (Buffer.isBuffer(DPSL) && typeof DPIC === 'number') stage = await pbkdf2(secret, DPSL, DPIC, 32, 'sha256');
    const passcodeKey = await pbkdf2(stage, SALT, ITER, 32, 'sha1');
    secret.fill(0);
    stage.fill(0);
    const keys = new Map();
    try {
      for (const [cls, ck] of this.classKeys) {
        if (!Buffer.isBuffer(ck.WPKY) || !(ck.WRAP & WRAP_PASSCODE)) continue;
        const key = aesUnwrap(passcodeKey, ck.WPKY);
        if (!key) throw new WrongPasswordError();
        keys.set(cls, key);
      }
    } finally {
      passcodeKey.fill(0);
    }
    if (!keys.size) throw new Error('Backup keybag has no password-protected class keys');
    this.keys = keys;
  }

  // `wrapped` is the 40-byte AES-wrapped key; protection class comes from the file record.
  unwrapKey(protectionClass, wrapped) {
    const classKey = this.keys?.get(protectionClass);
    if (!classKey) throw new Error(`No unlocked key for protection class ${protectionClass}`);
    if (wrapped.length !== 40) throw new Error('Unexpected wrapped key length');
    const key = aesUnwrap(classKey, wrapped);
    if (!key) throw new Error('Could not unwrap a file key (corrupt backup?)');
    return key;
  }

  // ManifestKey and MBFile EncryptionKey blobs: 4-byte little-endian class, then the wrapped key.
  unwrapPrefixedKey(blob) {
    if (!Buffer.isBuffer(blob) || blob.length < 44) throw new Error('Malformed wrapped key');
    return this.unwrapKey(blob.readUInt32LE(0), blob.subarray(4));
  }

  lock() {
    for (const key of this.keys?.values() ?? []) key.fill(0);
    this.keys = null;
  }
}
