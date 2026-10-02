// Minimal property-list readers: binary (bplist00), XML, and NSKeyedArchiver archives.

export const APPLE_EPOCH_MS = 978307200000;
const MAX_DEPTH = 256;

export class PlistError extends Error {}

export class UID {
  constructor(value) {
    this.value = value;
  }
}

function define(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function parsePlist(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length >= 6 && buf.toString('latin1', 0, 6) === 'bplist') return parseBinaryPlist(buf);
  return parseXmlPlist(buf.toString('utf8'));
}

function readUInt(buf, off, n) {
  if (n < 1 || off + n > buf.length) throw new PlistError('truncated binary plist');
  if (n <= 6) return buf.readUIntBE(off, n);
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[off + i];
  if (!Number.isSafeInteger(v)) throw new PlistError('binary plist offset out of range');
  return v;
}

function bigToNumber(v) {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

export function parseBinaryPlist(buf) {
  if (buf.length < 40 || buf.toString('latin1', 0, 6) !== 'bplist') throw new PlistError('not a binary plist');
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const numObjects = readUInt(buf, trailer + 8, 8);
  const topObject = readUInt(buf, trailer + 16, 8);
  const tableOffset = readUInt(buf, trailer + 24, 8);
  if (!offsetSize || offsetSize > 8 || !refSize || refSize > 8) throw new PlistError('bad binary plist trailer');
  if (tableOffset + numObjects * offsetSize > trailer || topObject >= numObjects) {
    throw new PlistError('bad binary plist offset table');
  }
  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) offsets[i] = readUInt(buf, tableOffset + i * offsetSize, offsetSize);

  const cache = new Map();
  const active = new Set();

  function readObject(ref, depth) {
    if (ref >= numObjects) throw new PlistError('bad object reference');
    if (cache.has(ref)) return cache.get(ref);
    if (active.has(ref) || depth > MAX_DEPTH) throw new PlistError('cyclic or too deeply nested plist');
    active.add(ref);
    const value = decode(offsets[ref], depth);
    active.delete(ref);
    cache.set(ref, value);
    return value;
  }

  function sizeAt(off, info) {
    if (info !== 0x0f) return { len: info, pos: off + 1 };
    const marker = buf[off + 1];
    if (marker >> 4 !== 0x1) throw new PlistError('bad length marker');
    const n = 1 << (marker & 0x0f);
    return { len: readUInt(buf, off + 2, n), pos: off + 2 + n };
  }

  function slice(pos, len) {
    if (pos + len > trailer) throw new PlistError('truncated binary plist object');
    return buf.subarray(pos, pos + len);
  }

  function refs(pos, count) {
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = readUInt(buf, pos + i * refSize, refSize);
    return out;
  }

  function decode(off, depth) {
    if (off >= trailer) throw new PlistError('bad object offset');
    const marker = buf[off];
    const type = marker >> 4;
    const info = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        if (marker === 0x00 || marker === 0x0f) return null;
        break;
      case 0x1: {
        const n = 1 << info;
        if (n <= 4) return readUInt(buf, off + 1, n);
        if (n === 8) return bigToNumber(slice(off + 1, 8).readBigInt64BE(0));
        if (n === 16) return bigToNumber(slice(off + 1, 16).readBigUInt64BE(8));
        break;
      }
      case 0x2: {
        const n = 1 << info;
        if (n === 4) return slice(off + 1, 4).readFloatBE(0);
        if (n === 8) return slice(off + 1, 8).readDoubleBE(0);
        break;
      }
      case 0x3:
        if (marker === 0x33) return new Date(APPLE_EPOCH_MS + slice(off + 1, 8).readDoubleBE(0) * 1000);
        break;
      case 0x4: {
        const { len, pos } = sizeAt(off, info);
        return Buffer.from(slice(pos, len));
      }
      case 0x5: {
        const { len, pos } = sizeAt(off, info);
        return slice(pos, len).toString('latin1');
      }
      case 0x6: {
        const { len, pos } = sizeAt(off, info);
        const bytes = Buffer.from(slice(pos, len * 2));
        return bytes.swap16().toString('utf16le');
      }
      case 0x7: {
        const { len, pos } = sizeAt(off, info);
        return slice(pos, len).toString('utf8');
      }
      case 0x8:
        return new UID(readUInt(buf, off + 1, info + 1));
      case 0xa:
      case 0xc: {
        const { len, pos } = sizeAt(off, info);
        return refs(pos, len).map((r) => readObject(r, depth + 1));
      }
      case 0xd: {
        const { len, pos } = sizeAt(off, info);
        const keyRefs = refs(pos, len);
        const valueRefs = refs(pos + len * refSize, len);
        const obj = {};
        for (let i = 0; i < len; i++) {
          define(obj, String(readObject(keyRefs[i], depth + 1)), readObject(valueRefs[i], depth + 1));
        }
        return obj;
      }
      default:
        break;
    }
    throw new PlistError(`unsupported binary plist marker 0x${marker.toString(16)}`);
  }

  return readObject(topObject, 0);
}

const XML_TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z][\w.-]*)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
}

export function parseXmlPlist(text) {
  const tokens = [];
  for (const m of text.matchAll(XML_TOKEN)) {
    if (m[1] !== undefined) tokens.push({ type: 'text', text: m[1] });
    else if (m[3] !== undefined) tokens.push({ type: m[2] ? 'close' : m[4] ? 'empty' : 'open', name: m[3] });
    else if (m[5] !== undefined) tokens.push({ type: 'text', text: decodeEntities(m[5]) });
  }
  let i = 0;
  const isBlank = (t) => t.type === 'text' && !t.text.trim();
  const next = () => {
    while (i < tokens.length && isBlank(tokens[i])) i++;
    if (i >= tokens.length) throw new PlistError('unexpected end of XML plist');
    return tokens[i++];
  };
  const peek = () => {
    while (i < tokens.length && isBlank(tokens[i])) i++;
    return tokens[i];
  };
  const readText = (name) => {
    let out = '';
    while (i < tokens.length && tokens[i].type === 'text') out += tokens[i++].text;
    const end = tokens[i++];
    if (!end || end.type !== 'close' || end.name !== name) throw new PlistError(`unterminated <${name}>`);
    return out;
  };
  const parseInteger = (s) => {
    const t = s.trim();
    if (!/^[+-]?(0x[0-9a-fA-F]+|\d+)$/.test(t)) throw new PlistError('bad <integer>');
    const v = BigInt(t.replace(/^\+/, ''));
    return bigToNumber(v);
  };

  const parseValue = (depth) => {
    if (depth > MAX_DEPTH) throw new PlistError('XML plist too deeply nested');
    const t = next();
    if (t.type === 'empty') {
      switch (t.name) {
        case 'true': return true;
        case 'false': return false;
        case 'string': return '';
        case 'data': return Buffer.alloc(0);
        case 'dict': return {};
        case 'array': return [];
        default: throw new PlistError(`unexpected <${t.name}/>`);
      }
    }
    if (t.type !== 'open') throw new PlistError('malformed XML plist');
    switch (t.name) {
      case 'dict': {
        const obj = {};
        for (;;) {
          const p = peek();
          if (p && p.type === 'close' && p.name === 'dict') { i++; return obj; }
          const k = next();
          if (k.type !== 'open' || k.name !== 'key') throw new PlistError('expected <key> in <dict>');
          define(obj, readText('key'), parseValue(depth + 1));
        }
      }
      case 'array': {
        const arr = [];
        for (;;) {
          const p = peek();
          if (p && p.type === 'close' && p.name === 'array') { i++; return arr; }
          arr.push(parseValue(depth + 1));
        }
      }
      case 'string': return readText('string');
      case 'integer': return parseInteger(readText('integer'));
      case 'real': return Number.parseFloat(readText('real'));
      case 'date': return new Date(readText('date').trim());
      case 'data': return Buffer.from(readText('data').replace(/\s+/g, ''), 'base64');
      case 'true': readText('true'); return true;
      case 'false': readText('false'); return false;
      default: throw new PlistError(`unsupported XML plist element <${t.name}>`);
    }
  };

  while (i < tokens.length && !(tokens[i].type === 'open' && tokens[i].name === 'plist')) i++;
  if (i >= tokens.length) throw new PlistError('no <plist> element');
  i++;
  return parseValue(0);
}

// Resolves an NSKeyedArchiver plist (e.g. the MBFile blobs in Manifest.db) into plain values.
export function unarchive(archive) {
  if (!archive || archive.$archiver !== 'NSKeyedArchiver' || !Array.isArray(archive.$objects)) {
    throw new PlistError('not an NSKeyedArchiver archive');
  }
  const objects = archive.$objects;
  const top = archive.$top?.root ?? Object.values(archive.$top ?? {})[0];

  const resolve = (value, depth) => {
    if (depth > 64) throw new PlistError('archive too deeply nested');
    if (!(value instanceof UID)) return value;
    const obj = objects[value.value];
    if (obj === undefined) throw new PlistError('bad archive reference');
    return decodeObject(obj, depth + 1);
  };

  const decodeObject = (obj, depth) => {
    if (obj === '$null') return null;
    if (obj === null || typeof obj !== 'object' || Buffer.isBuffer(obj) || obj instanceof Date) return obj;
    if (Array.isArray(obj)) return obj.map((v) => resolve(v, depth));
    if ('NS.keys' in obj && 'NS.objects' in obj) {
      const out = {};
      obj['NS.keys'].forEach((k, idx) => define(out, String(resolve(k, depth)), resolve(obj['NS.objects'][idx], depth)));
      return out;
    }
    if ('NS.objects' in obj) return obj['NS.objects'].map((v) => resolve(v, depth));
    if ('NS.data' in obj) return resolve(obj['NS.data'], depth);
    if ('NS.bytes' in obj) return resolve(obj['NS.bytes'], depth);
    if ('NS.string' in obj) return resolve(obj['NS.string'], depth);
    if ('NS.time' in obj) return new Date(APPLE_EPOCH_MS + obj['NS.time'] * 1000);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k !== '$class') define(out, k, resolve(v, depth));
    }
    const cls = obj.$class instanceof UID ? objects[obj.$class.value] : null;
    if (cls && typeof cls.$classname === 'string') {
      Object.defineProperty(out, '$classname', { value: cls.$classname, enumerable: false });
    }
    return out;
  };

  return resolve(top, 0);
}
