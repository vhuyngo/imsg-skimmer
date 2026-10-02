import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Contacts } from '../src/contacts.js';
import { csvCell, safeFileName, slugify } from '../src/export.js';
import { Keybag, WrongPasswordError, aesCbcDecrypt, aesCbcEncrypt, aesUnwrap, aesWrap, parseTLV, pkcs7PaddingLength } from '../src/keybag.js';
import { appleDateSql, attachmentLocation, reactionTarget } from '../src/messages.js';
import { PlistError, UID, parsePlist, unarchive } from '../src/plist.js';
import { attributedBodyText } from '../src/typedstream.js';
import { normalizeForSearch, parseQuery } from '../src/archive.js';
import { mbFileArchive, writeBinaryPlist, writeXmlPlist } from './helpers/plist-writer.js';
import { EXPECTED, ns, sec, typedstreamBody } from './helpers/fixtures.js';

test('binary plist round-trips every supported type', () => {
  const value = {
    ascii: 'hello',
    unicode: 'Tiếng Việt ✓ 😀',
    long: 'x'.repeat(300),
    ints: [0, 255, 65535, 4294967295, 9007199254740991, -5],
    real: 3.25,
    flags: [true, false],
    data: crypto.randomBytes(40),
    date: new Date('2022-01-30T18:11:12.000Z'),
    uid: new UID(70000),
    nested: { list: Array.from({ length: 300 }, (_, i) => i) },
  };
  const parsed = parsePlist(writeBinaryPlist(value));
  assert.equal(parsed.unicode, value.unicode);
  assert.equal(parsed.long, value.long);
  assert.deepEqual(parsed.ints, value.ints);
  assert.equal(parsed.real, 3.25);
  assert.deepEqual(parsed.flags, [true, false]);
  assert.ok(parsed.data.equals(value.data));
  assert.equal(parsed.date.toISOString(), value.date.toISOString());
  assert.ok(parsed.uid instanceof UID && parsed.uid.value === 70000);
  assert.equal(parsed.nested.list[299], 299);
});

test('XML plist parsing handles entities, dates, data and empty elements', () => {
  const xml = writeXmlPlist({ 'Device Name': 'A & B <phone>', n: 42, when: new Date('2024-05-06T07:08:09Z'), blob: Buffer.from('hi'), ok: true, list: [] });
  const parsed = parsePlist(xml);
  assert.equal(parsed['Device Name'], 'A & B <phone>');
  assert.equal(parsed.n, 42);
  assert.equal(parsed.when.toISOString(), '2024-05-06T07:08:09.000Z');
  assert.equal(parsed.blob.toString(), 'hi');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.list, []);
  assert.equal(parsePlist(Buffer.from('<plist><dict><key>s</key><string/><key>e</key><string>&#x1F600;&#65;</string></dict></plist>')).e, '😀A');
});

test('malformed plists raise PlistError instead of crashing', () => {
  assert.throws(() => parsePlist(Buffer.from('bplist00 truncated')), PlistError);
  assert.throws(() => parsePlist(Buffer.from('<plist><dict><key>a</key>')), PlistError);
  const good = writeBinaryPlist({ a: [1, 2, 3] });
  const bad = Buffer.from(good);
  bad.writeBigUInt64BE(999n, bad.length - 8);
  assert.throws(() => parsePlist(bad), PlistError);
});

test('NSKeyedArchiver MBFile records resolve to size, class and key', () => {
  const key = crypto.randomBytes(44);
  const rec = unarchive(parsePlist(mbFileArchive({ relativePath: 'Library/SMS/sms.db', size: 1234, protectionClass: 3, encryptionKey: key })));
  assert.equal(rec.Size, 1234);
  assert.equal(rec.ProtectionClass, 3);
  assert.equal(rec.RelativePath, 'Library/SMS/sms.db');
  assert.ok(rec.EncryptionKey.equals(key));
});

test('AES key wrap matches RFC 3394 and rejects the wrong key', () => {
  const kek = Buffer.from('000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 'hex');
  const key = Buffer.from('00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F', 'hex');
  const wrapped = aesWrap(kek, key);
  assert.equal(wrapped.toString('hex'), '28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21');
  assert.ok(aesUnwrap(kek, wrapped).equals(key));
  const wrong = Buffer.from(kek);
  wrong[31] ^= 0xff;
  assert.equal(aesUnwrap(wrong, wrapped), null);
});

test('AES-CBC with PKCS#7 padding decrypts and the padding length is detected', () => {
  const key = crypto.randomBytes(32);
  const plain = crypto.randomBytes(5000);
  const dec = aesCbcDecrypt(key, aesCbcEncrypt(key, plain));
  assert.equal(pkcs7PaddingLength(dec.subarray(-16)), 8);
  assert.ok(dec.subarray(0, 5000).equals(plain));
  assert.equal(pkcs7PaddingLength(Buffer.from([1, 2, 3, 0])), 0);
});

test('keybag parses TLV, unlocks with the password, and rejects a wrong one', async () => {
  const salt = crypto.randomBytes(20);
  const dpsl = crypto.randomBytes(20);
  const password = 'pässwörd';
  const passcodeKey = crypto.pbkdf2Sync(crypto.pbkdf2Sync(Buffer.from(password), dpsl, 7, 32, 'sha256'), salt, 5, 32, 'sha1');
  const classKey = crypto.randomBytes(32);
  const tlv = (tag, v) => {
    const b = typeof v === 'number' ? Buffer.alloc(4) : v;
    if (typeof v === 'number') b.writeUInt32BE(v);
    const h = Buffer.alloc(8);
    h.write(tag, 0, 'latin1');
    h.writeUInt32BE(b.length, 4);
    return Buffer.concat([h, b]);
  };
  const blob = Buffer.concat([
    tlv('VERS', 4), tlv('TYPE', 1), tlv('UUID', crypto.randomBytes(16)), tlv('WRAP', 0), tlv('SALT', salt), tlv('ITER', 5),
    tlv('DPIC', 7), tlv('DPSL', dpsl), tlv('UUID', crypto.randomBytes(16)), tlv('CLAS', 3), tlv('WRAP', 2), tlv('KTYP', 0),
    tlv('WPKY', aesWrap(passcodeKey, classKey)),
  ]);
  assert.equal(parseTLV(blob).length, 13);
  const kb = Keybag.parse(blob);
  assert.equal(kb.type, 1);
  assert.equal(kb.classKeys.size, 1);
  await assert.rejects(kb.unlock('wrong'), WrongPasswordError);
  await kb.unlock(password);
  const fileKey = crypto.randomBytes(32);
  const prefixed = Buffer.concat([Buffer.from([3, 0, 0, 0]), aesWrap(classKey, fileKey)]);
  assert.ok(kb.unwrapPrefixedKey(prefixed).equals(fileKey));
});

test('attributedBody text is extracted for short, long, mutable and non-ASCII strings', () => {
  assert.equal(attributedBodyText(typedstreamBody('hi')), 'hi');
  assert.equal(attributedBodyText(typedstreamBody(EXPECTED.longAttributed)), EXPECTED.longAttributed);
  assert.equal(attributedBodyText(typedstreamBody(EXPECTED.mutableAttributed, { mutable: true })), EXPECTED.mutableAttributed);
  assert.equal(attributedBodyText(typedstreamBody(EXPECTED.vietnamese)), EXPECTED.vietnamese);
  const huge = 'z'.repeat(70000);
  assert.equal(attributedBodyText(typedstreamBody(huge)), huge);
  assert.equal(attributedBodyText(Buffer.from('not a typedstream')), null);
  const body = typedstreamBody('truncated body');
  assert.equal(attributedBodyText(body.subarray(0, body.indexOf('truncated') + 5)), null);
  assert.equal(attributedBodyText(null), null);
});

test('Apple dates convert from both seconds and nanoseconds since 2001', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (d INTEGER)');
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  ins.run(sec(EXPECTED.dates.secondsFormat));
  ins.run(ns(EXPECTED.dates.nanosecondFormat));
  ins.run(0);
  const rows = db.prepare(`SELECT ${appleDateSql('d')} AS ms FROM t`).all();
  assert.equal(new Date(rows[0].ms).toISOString(), EXPECTED.dates.secondsFormat);
  assert.equal(new Date(rows[1].ms).toISOString(), EXPECTED.dates.nanosecondFormat);
  assert.equal(rows[2].ms, null);
});

test('contact matching: exact digits, national/international suffix, email, ambiguity', () => {
  const c = new Contacts();
  c.add('(555) 010-0001', 'Alice');
  c.add('0555 010 003', 'Huong');
  c.add('alice@example.com', 'Alice');
  c.add('+1 555 777 0001', 'X');
  c.add('+44 555 777 0001', 'Y');
  assert.equal(c.lookup('+15550100001'), 'Alice');
  assert.equal(c.lookup('+84555010003'), 'Huong');
  assert.equal(c.lookup('ALICE@example.com'), 'Alice');
  assert.equal(c.lookup('+15550100009'), null);
  assert.equal(c.lookup('+33557770001'), null, 'ambiguous suffix is not guessed');
  assert.equal(c.lookup('+15557770001'), 'X', 'exact digits still win');
});

test('attachment paths, tapback targets, search normalization and CSV cells', () => {
  assert.deepEqual(attachmentLocation('~/Library/SMS/Attachments/a/b/x.jpg'), ['MediaDomain', 'Library/SMS/Attachments/a/b/x.jpg']);
  assert.deepEqual(attachmentLocation('/var/mobile/Library/SMS/Attachments/x.jpg'), ['MediaDomain', 'Library/SMS/Attachments/x.jpg']);
  assert.equal(attachmentLocation('~/../../etc/passwd'), null);
  assert.equal(reactionTarget('p:0/GUID-1'), 'GUID-1');
  assert.equal(reactionTarget('bp:GUID-2'), 'GUID-2');
  assert.equal(normalizeForSearch('Tôi ĐI được'), 'toi di duoc');
  assert.deepEqual(parseQuery('  "Đi được"  TÔI '), ['di duoc', 'toi']);
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+15550100001'), "'+15550100001");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(safeFileName('../evil/na:me?.jpg'), '_evil_na_me_.jpg');
  assert.equal(slugify('Tôi & Bạn'), 'toi-ban');
});
