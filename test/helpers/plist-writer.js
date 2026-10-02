// Test-only plist writers used to build synthetic backups.
import { APPLE_EPOCH_MS, UID } from '../../src/plist.js';

function intBytes(v) {
  if (typeof v === 'bigint' || v < 0 || v >= 2 ** 32) {
    const b = Buffer.alloc(9);
    b[0] = 0x13;
    b.writeBigInt64BE(BigInt(v), 1);
    return b;
  }
  if (v < 2 ** 8) return Buffer.from([0x10, v]);
  if (v < 2 ** 16) {
    const b = Buffer.alloc(3);
    b[0] = 0x11;
    b.writeUInt16BE(v, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0x12;
  b.writeUInt32BE(v, 1);
  return b;
}

function header(type, len) {
  return len < 15 ? Buffer.from([(type << 4) | len]) : Buffer.concat([Buffer.from([(type << 4) | 0x0f]), intBytes(len)]);
}

function uintBE(v, n) {
  const b = Buffer.alloc(n);
  if (n === 8) b.writeBigUInt64BE(BigInt(v));
  else b.writeUIntBE(v, 0, n);
  return b;
}

const sizeFor = (max) => (max < 2 ** 8 ? 1 : max < 2 ** 16 ? 2 : max < 2 ** 32 ? 4 : 8);

export function writeBinaryPlist(root) {
  const nodes = [];
  const flatten = (value) => {
    const idx = nodes.length;
    const node = { value };
    nodes.push(node);
    if (Array.isArray(value)) node.children = value.map(flatten);
    else if (value && typeof value === 'object' && !(value instanceof UID) && !Buffer.isBuffer(value) && !(value instanceof Date)) {
      const keys = Object.keys(value);
      node.children = [...keys.map(flatten), ...keys.map((k) => flatten(value[k]))];
      node.dictLen = keys.length;
    }
    return idx;
  };
  flatten(root);
  const refSize = sizeFor(nodes.length);

  const encode = (node) => {
    const v = node.value;
    if (v === null || v === undefined) return Buffer.from([0x00]);
    if (v === false) return Buffer.from([0x08]);
    if (v === true) return Buffer.from([0x09]);
    if (typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))) return intBytes(v);
    if (typeof v === 'number') {
      const b = Buffer.alloc(9);
      b[0] = 0x23;
      b.writeDoubleBE(v, 1);
      return b;
    }
    if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) return Buffer.concat([header(0x5, v.length), Buffer.from(v, 'latin1')]);
      const b = Buffer.from(v, 'utf16le').swap16();
      return Buffer.concat([header(0x6, b.length / 2), b]);
    }
    if (Buffer.isBuffer(v)) return Buffer.concat([header(0x4, v.length), v]);
    if (v instanceof Date) {
      const b = Buffer.alloc(9);
      b[0] = 0x33;
      b.writeDoubleBE((v.getTime() - APPLE_EPOCH_MS) / 1000, 1);
      return b;
    }
    if (v instanceof UID) {
      const n = v.value < 2 ** 8 ? 1 : v.value < 2 ** 16 ? 2 : 4;
      return Buffer.concat([Buffer.from([0x80 | (n - 1)]), uintBE(v.value, n)]);
    }
    const refs = Buffer.concat(node.children.map((c) => uintBE(c, refSize)));
    if (Array.isArray(v)) return Buffer.concat([header(0xa, v.length), refs]);
    return Buffer.concat([header(0xd, node.dictLen), refs]);
  };

  const chunks = [Buffer.from('bplist00', 'latin1')];
  const offsets = [];
  let pos = 8;
  for (const node of nodes) {
    const b = encode(node);
    offsets.push(pos);
    chunks.push(b);
    pos += b.length;
  }
  const offsetSize = sizeFor(pos);
  const tableOffset = pos;
  chunks.push(Buffer.concat(offsets.map((o) => uintBE(o, offsetSize))));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(nodes.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(tableOffset), 24);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function writeXmlPlist(root) {
  const out = (v, ind) => {
    const pad = '\t'.repeat(ind);
    if (v === true) return `${pad}<true/>`;
    if (v === false) return `${pad}<false/>`;
    if (typeof v === 'number' && Number.isInteger(v)) return `${pad}<integer>${v}</integer>`;
    if (typeof v === 'number') return `${pad}<real>${v}</real>`;
    if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>`;
    if (Buffer.isBuffer(v)) return `${pad}<data>\n${pad}${v.toString('base64')}\n${pad}</data>`;
    if (v instanceof Date) return `${pad}<date>${v.toISOString().replace(/\.\d{3}Z$/, 'Z')}</date>`;
    if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => out(x, ind + 1)).join('\n')}\n${pad}</array>`;
    const body = Object.entries(v).map(([k, x]) => `${pad}\t<key>${esc(k)}</key>\n${out(x, ind + 1)}`);
    return `${pad}<dict>\n${body.join('\n')}\n${pad}</dict>`;
  };
  return Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      `<plist version="1.0">\n${out(root, 0)}\n</plist>\n`,
    'utf8',
  );
}

// NSKeyedArchiver-encoded MBFile record, the shape stored in Manifest.db `Files.file`.
export function mbFileArchive({ relativePath, size, protectionClass = 3, encryptionKey = null, mode = 0o100644 }) {
  const now = Math.floor(Date.now() / 1000);
  const objects = ['$null'];
  const root = {
    LastModified: now,
    Birth: now,
    LastStatusChange: now,
    Size: size,
    InodeNumber: 1000 + size,
    Mode: mode,
    UserID: 501,
    GroupID: 501,
    ProtectionClass: protectionClass,
    Flags: 0,
    RelativePath: new UID(2),
  };
  objects.push(root, relativePath);
  if (encryptionKey) {
    root.EncryptionKey = new UID(3);
    objects.push({ 'NS.data': encryptionKey, $class: new UID(4) });
    objects.push({ $classname: 'NSMutableData', $classes: ['NSMutableData', 'NSData', 'NSObject'] });
  }
  root.$class = new UID(objects.length);
  objects.push({ $classname: 'MBFile', $classes: ['MBFile', 'NSObject'] });
  return writeBinaryPlist({ $version: 100000, $archiver: 'NSKeyedArchiver', $top: { root: new UID(1) }, $objects: objects });
}
