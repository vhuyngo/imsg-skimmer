// Builds synthetic iPhone backups (unencrypted and encrypted) with a small Messages history.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileIdFor } from '../../src/backup.js';
import { aesCbcEncrypt, aesWrap } from '../../src/keybag.js';
import { APPLE_EPOCH_MS } from '../../src/plist.js';
import { mbFileArchive, writeBinaryPlist, writeXmlPlist } from './plist-writer.js';

export const PASSWORD = 'correct horse battery staple';
export const LOW_ITERATIONS = { DPIC: 10, ITER: 10 };

export const sec = (iso) => (Date.parse(iso) - APPLE_EPOCH_MS) / 1000;
export const ns = (iso) => BigInt(Date.parse(iso) - APPLE_EPOCH_MS) * 1000000n;

function lenPrefix(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = 0x81;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0x82;
  b.writeUInt32LE(n, 1);
  return b;
}

// NSArchiver "streamtyped" NSAttributedString, the shape of message.attributedBody.
export function typedstreamBody(text, { mutable = false } = {}) {
  const s = (x) => Buffer.from(x, 'latin1');
  const utf8 = Buffer.from(text, 'utf8');
  const head = mutable
    ? [s('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x19NSMutableAttributedString\x00\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x0fNSMutableString\x01\x84\x84\x08NSString\x01\x95\x84\x01+')]
    : [s('\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+')];
  const tail = s(
    '\x86\x84\x02iI\x01' + String.fromCharCode(Math.min(text.length, 127)) +
      '\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x01\x92\x84\x96\x96\x1d__kIMMessagePartAttributeName\x86\x92\x84\x84\x84\x08NSNumber\x00\x84\x84\x07NSValue\x00\x94\x84\x01*\x84\x99\x99\x00\x86\x86\x86',
  );
  return Buffer.concat([...head, lenPrefix(utf8.length), utf8, tail]);
}

const SMS_SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0, is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_service_message INTEGER DEFAULT 0, is_forward INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0, is_archive INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT, was_data_detected INTEGER DEFAULT 0, was_deduplicated INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, date_played INTEGER, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0, share_status INTEGER DEFAULT 0, share_direction INTEGER DEFAULT 0, is_expirable INTEGER DEFAULT 0, expire_state INTEGER DEFAULT 0, message_action_type INTEGER DEFAULT 0, message_source INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB, expressive_send_style_id TEXT, associated_message_range_location INTEGER DEFAULT 0, associated_message_range_length INTEGER DEFAULT 0, time_expressive_send_played INTEGER, message_summary_info BLOB, reply_to_guid TEXT, thread_originator_guid TEXT, thread_originator_part TEXT, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, associated_message_emoji TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, user_info BLOB, transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB, attribution_info BLOB, hide_attachment INTEGER DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
`;

const ADDRESS_BOOK_SCHEMA = `
CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, First TEXT, Last TEXT, Middle TEXT, FirstPhonetic TEXT, MiddlePhonetic TEXT, LastPhonetic TEXT, Organization TEXT, Department TEXT, Note TEXT, Kind INTEGER, Birthday TEXT, JobTitle TEXT, Nickname TEXT, Prefix TEXT, Suffix TEXT);
CREATE TABLE ABMultiValue (UID INTEGER PRIMARY KEY, record_id INTEGER, property INTEGER, identifier INTEGER, label INTEGER, value TEXT, guid TEXT);
`;

const MANIFEST_SCHEMA = `
CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB);
CREATE INDEX FilesDomainIdx ON Files(domain);
CREATE INDEX FilesRelativePathIdx ON Files(relativePath);
CREATE TABLE Properties (key TEXT PRIMARY KEY, value BLOB);
`;

export const PHOTO_PATH = 'Library/SMS/Attachments/ab/11/A1A1A1A1-0000-4000-8000-000000000001/photo.jpg';
export const PHOTO_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.createHash('sha512').update('photo').digest(), Buffer.alloc(4930, 7), Buffer.from([0xff, 0xd9])]);

// Expected values the tests assert against. All data is synthetic.
export const EXPECTED = {
  device: { name: 'Fixture iPhone', ios: '16.1', lastBackup: '2024-05-06T07:08:09.000Z' },
  dates: {
    secondsFormat: '2016-03-05T10:00:00.000Z',
    nanosecondFormat: '2022-01-15T12:00:00.123Z',
  },
  attributedOnly: 'This text lives only in attributedBody on iOS 16',
  longAttributed: `Long attributed message ${'é'.repeat(80)} end`,
  mutableAttributed: 'Mutable string body',
  vietnamese: 'Tôi đi được',
  groupName: 'Weekend Plans',
  script: '<script>alert("x")</script> & friends',
};

function buildSmsDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SMS_SCHEMA);
  const handle = db.prepare('INSERT INTO handle (ROWID, id, service, country) VALUES (?, ?, ?, ?)');
  handle.run(1, '+15550100001', 'iMessage', 'us');
  handle.run(2, 'alice@example.com', 'iMessage', 'us');
  handle.run(3, '+15550100002', 'iMessage', 'us');
  handle.run(4, '+84555010003', 'iMessage', 'vn');
  handle.run(5, '+15550100009', 'SMS', 'us');
  handle.run(6, '+15550100001', 'SMS', 'us');
  handle.run(7, '55501', 'SMS', 'us');

  const chat = db.prepare('INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?, ?)');
  chat.run(1, 'iMessage;-;+15550100001', 45, '+15550100001', 'iMessage', '');
  chat.run(2, 'SMS;-;+15550100001', 45, '+15550100001', 'SMS', '');
  chat.run(3, 'iMessage;+;chat100000000000000001', 43, 'chat100000000000000001', 'iMessage', EXPECTED.groupName);
  chat.run(4, 'SMS;-;+15550100009', 45, '+15550100009', 'SMS', '');
  chat.run(5, 'iMessage;+;chat100000000000000002', 43, 'chat100000000000000002', 'iMessage', null);
  chat.run(6, 'SMS;-;55501', 45, '55501', 'SMS', '');
  chat.run(7, 'iMessage;-;alice@example.com', 45, 'alice@example.com', 'iMessage', '');
  const member = db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)');
  for (const [c, h] of [[1, 1], [2, 6], [3, 1], [3, 3], [3, 4], [4, 5], [5, 3], [5, 5], [6, 7], [7, 2]]) member.run(c, h);

  const insert = db.prepare(`INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, service, date, item_type,
      group_title, associated_message_guid, associated_message_type, associated_message_emoji, cache_has_attachments, date_edited, date_retracted)
    VALUES ($id, $guid, $text, $body, $handle, $me, $service, $date, $item, $title, $assoc, $atype, $emoji, $att, $edited, $retracted)`);
  const join = db.prepare('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)');
  const add = (chatId, m) => {
    const row = { text: null, body: null, handle: 0, me: 0, service: 'iMessage', item: 0, title: null, assoc: null, atype: 0, emoji: null, att: 0, edited: 0, retracted: 0, ...m };
    row.guid = `GUID-${String(m.id).padStart(4, '0')}`;
    insert.run(row);
    if (chatId) join.run(chatId, m.id, m.date);
  };
  const d = (iso) => ns(iso);

  add(1, { id: 1, text: 'Hello from Alice', handle: 1, date: sec(EXPECTED.dates.secondsFormat) });
  add(1, { id: 2, text: 'Hi Alice! 👋', me: 1, handle: 1, date: d(EXPECTED.dates.nanosecondFormat) });
  add(1, { id: 3, body: typedstreamBody(EXPECTED.attributedOnly), handle: 1, date: d('2022-01-15T12:05:00Z') });
  add(1, { id: 4, text: 'Loved “This text lives only…”', me: 1, handle: 1, date: d('2022-01-15T12:06:00Z'), assoc: 'p:0/GUID-0003', atype: 2000 });
  add(1, { id: 5, text: 'Liked “Hi Alice! 👋”', handle: 1, date: d('2022-01-15T12:07:00Z'), assoc: 'p:0/GUID-0002', atype: 2001 });
  add(1, { id: 6, text: 'Removed a like from “Hi Alice! 👋”', handle: 1, date: d('2022-01-15T12:08:00Z'), assoc: 'p:0/GUID-0002', atype: 3001 });
  add(1, { id: 7, text: '\uFFFC', handle: 1, date: d('2022-01-16T09:00:00Z'), att: 1 });
  add(2, { id: 8, text: 'SMS from Alice', handle: 6, service: 'SMS', date: sec('2017-06-01T08:30:00Z') });
  add(3, { id: 9, me: 1, item: 2, title: EXPECTED.groupName, date: d('2022-02-01T10:00:00Z') });
  add(3, { id: 10, text: "Who's in?", handle: 3, date: d('2022-02-01T10:01:00Z'), att: 1 });
  add(3, { id: 11, text: EXPECTED.vietnamese, handle: 4, date: d('2022-02-01T10:02:00Z') });
  add(3, { id: 12, text: 'Me too', me: 1, date: d('2022-02-01T10:03:00Z'), att: 1 });
  add(3, { id: 13, handle: 3, date: d('2022-02-01T10:04:00Z'), assoc: 'p:0/GUID-0011', atype: 2006, emoji: '🔥', body: typedstreamBody('Reacted 🔥 to “Tôi đi được”') });
  add(3, { id: 14, body: typedstreamBody(EXPECTED.longAttributed), handle: 1, date: d('2022-02-02T10:00:00Z') });
  add(3, { id: 15, body: typedstreamBody(EXPECTED.mutableAttributed, { mutable: true }), handle: 3, date: d('2022-02-02T10:01:00Z') });
  add(3, { id: 16, text: EXPECTED.script, handle: 3, date: d('2022-02-02T10:02:00Z') });
  add(4, { id: 17, text: 'Your code is 123456', handle: 5, service: 'SMS', date: d('2023-03-03T03:03:03Z') });
  add(5, { id: 18, text: 'unnamed group message', handle: 3, date: d('2023-04-04T04:04:04Z') });
  add(6, { id: 19, text: 'Your prescription is ready', handle: 7, service: 'SMS', date: d('2023-05-05T05:05:05Z') });
  add(7, { id: 20, text: 'Email handle message', handle: 2, date: d('2023-06-06T06:06:06Z') });
  add(null, { id: 21, text: 'Orphan message', handle: 1, date: d('2023-07-07T07:07:07Z') });
  add(1, { id: 22, text: 'Laughed at “a message that is gone”', me: 1, handle: 1, date: d('2022-01-17T00:00:00Z'), assoc: 'p:0/GUID-9999', atype: 2003 });
  add(1, { id: 23, text: 'Edited text', me: 1, handle: 1, date: d('2022-01-18T00:00:00Z'), edited: d('2022-01-18T00:01:00Z') });
  add(1, { id: 24, me: 1, handle: 1, date: d('2022-01-19T00:00:00Z'), retracted: d('2022-01-19T00:01:00Z') });

  const att = db.prepare('INSERT INTO attachment (ROWID, guid, filename, uti, mime_type, transfer_name, total_bytes, hide_attachment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  att.run(1, 'ATT-1', `~/${PHOTO_PATH}`, 'public.jpeg', 'image/jpeg', 'photo.jpg', PHOTO_BYTES.length, 0);
  att.run(2, 'ATT-2', '/var/mobile/Library/SMS/Attachments/cd/22/B2/clip.mov', 'com.apple.quicktime-movie', 'video/quicktime', 'clip.mov', 123456, 0);
  att.run(3, 'ATT-3', '~/Library/SMS/Attachments/ef/33/C3/link.pluginPayloadAttachment', 'dyn.x', null, 'link.pluginPayloadAttachment', 10, 1);
  const link = db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)');
  link.run(7, 1);
  link.run(12, 2);
  link.run(10, 3);
  db.close();
}

function buildAddressBook(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(ADDRESS_BOOK_SCHEMA);
  const person = db.prepare('INSERT INTO ABPerson (ROWID, First, Last, Organization) VALUES (?, ?, ?, ?)');
  person.run(1, 'Alice', 'Example', null);
  person.run(2, 'Bob', 'Sample', null);
  person.run(3, 'Hương', 'Nguyễn', null);
  person.run(4, null, null, 'Example Pharmacy');
  const mv = db.prepare('INSERT INTO ABMultiValue (UID, record_id, property, identifier, label, value) VALUES (?, ?, ?, 0, 1, ?)');
  mv.run(1, 1, 3, '(555) 010-0001');
  mv.run(2, 1, 4, 'Alice@Example.com');
  mv.run(3, 2, 3, '+1 555-010-0002');
  mv.run(4, 3, 3, '0555 010 003');
  mv.run(5, 4, 3, '55501');
  db.close();
}

function buildKeybag(password, iterations) {
  const salt = crypto.randomBytes(20);
  const dpsl = crypto.randomBytes(20);
  const stage = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), dpsl, iterations.DPIC, 32, 'sha256');
  const passcodeKey = crypto.pbkdf2Sync(stage, salt, iterations.ITER, 32, 'sha1');
  const tlv = (tag, value) => {
    const v = typeof value === 'number' ? Buffer.alloc(4) : value;
    if (typeof value === 'number') v.writeUInt32BE(value);
    const h = Buffer.alloc(8);
    h.write(tag, 0, 'latin1');
    h.writeUInt32BE(v.length, 4);
    return Buffer.concat([h, v]);
  };
  const classKeys = new Map();
  const parts = [
    tlv('VERS', 4), tlv('TYPE', 1), tlv('UUID', crypto.randomBytes(16)), tlv('HMCK', crypto.randomBytes(40)), tlv('WRAP', 0),
    tlv('SALT', salt), tlv('ITER', iterations.ITER), tlv('DPWT', 1), tlv('DPIC', iterations.DPIC), tlv('DPSL', dpsl),
  ];
  for (let cls = 1; cls <= 11; cls++) {
    if (cls === 2) continue;
    const key = crypto.randomBytes(32);
    classKeys.set(cls, key);
    parts.push(tlv('UUID', crypto.randomBytes(16)), tlv('CLAS', cls), tlv('WRAP', 2), tlv('KTYP', 0), tlv('WPKY', aesWrap(passcodeKey, key)));
  }
  return { keybag: Buffer.concat(parts), classKeys };
}

function prefixedKey(cls, classKeys, key) {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(cls);
  return Buffer.concat([prefix, aesWrap(classKeys.get(cls), key)]);
}

// Writes a complete backup folder at `dir`; returns its metadata.
export function buildBackup(dir, { encrypted = false, password = PASSWORD, iterations = LOW_ITERATIONS, udid = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(path.dirname(dir), '.work-'));
  const smsFile = path.join(work, 'sms.db');
  const abFile = path.join(work, 'AddressBook.sqlitedb');
  buildSmsDb(smsFile);
  buildAddressBook(abFile);
  const files = [
    ['HomeDomain', 'Library/SMS/sms.db', fs.readFileSync(smsFile)],
    ['HomeDomain', 'Library/AddressBook/AddressBook.sqlitedb', fs.readFileSync(abFile)],
    ['MediaDomain', PHOTO_PATH, PHOTO_BYTES],
    ['HomeDomain', 'Library/Preferences/com.example.unrelated.plist', Buffer.from('unrelated')],
  ];
  const dirs = [['MediaDomain', 'Library/SMS/Attachments'], ['HomeDomain', 'Library/SMS']];
  fs.rmSync(work, { recursive: true, force: true });

  const kb = encrypted ? buildKeybag(password, iterations) : null;
  const manifestFile = path.join(dir, 'Manifest.db');
  const manifestPlain = encrypted ? path.join(dir, '.manifest-plain.db') : manifestFile;
  const mdb = new DatabaseSync(manifestPlain);
  mdb.exec(MANIFEST_SCHEMA);
  const row = mdb.prepare('INSERT INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, ?, ?)');
  for (const [domain, rel, data] of files) {
    const id = fileIdFor(domain, rel);
    let stored = data;
    let encryptionKey = null;
    if (encrypted) {
      const key = crypto.randomBytes(32);
      stored = aesCbcEncrypt(key, data);
      encryptionKey = prefixedKey(3, kb.classKeys, key);
    }
    fs.mkdirSync(path.join(dir, id.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(dir, id.slice(0, 2), id), stored);
    row.run(id, domain, rel, 1, mbFileArchive({ relativePath: rel, size: data.length, protectionClass: 3, encryptionKey }));
  }
  for (const [domain, rel] of dirs) row.run(fileIdFor(domain, rel), domain, rel, 2, mbFileArchive({ relativePath: rel, size: 0, mode: 0o40755 }));
  mdb.close();

  const lastBackup = new Date(EXPECTED.device.lastBackup);
  const deviceId = udid ?? crypto.randomBytes(20).toString('hex');
  const manifest = {
    Version: '10.0',
    Date: lastBackup,
    SystemDomainsVersion: '24.0',
    WasPasscodeSet: true,
    Lockdown: { ProductVersion: EXPECTED.device.ios, ProductType: 'iPhone14,2', BuildVersion: '20B82', UniqueDeviceID: deviceId, DeviceName: EXPECTED.device.name },
    Applications: {},
    IsEncrypted: encrypted,
  };
  if (encrypted) {
    const manifestKey = crypto.randomBytes(32);
    fs.writeFileSync(manifestFile, aesCbcEncrypt(manifestKey, fs.readFileSync(manifestPlain)));
    fs.rmSync(manifestPlain);
    manifest.BackupKeyBag = kb.keybag;
    manifest.ManifestKey = prefixedKey(4, kb.classKeys, manifestKey);
  }
  fs.writeFileSync(path.join(dir, 'Manifest.plist'), writeBinaryPlist(manifest));
  fs.writeFileSync(
    path.join(dir, 'Info.plist'),
    writeXmlPlist({
      'Device Name': EXPECTED.device.name,
      'Display Name': EXPECTED.device.name,
      'Last Backup Date': lastBackup,
      'Product Type': 'iPhone14,2',
      'Product Version': EXPECTED.device.ios,
      'Unique Identifier': deviceId.toUpperCase(),
      'iTunes Version': '12.12.4.1',
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'Status.plist'),
    writeBinaryPlist({ IsFullBackup: false, Version: '3.3', UUID: crypto.randomUUID().toUpperCase(), Date: lastBackup, BackupState: 'new', SnapshotState: 'finished' }),
  );
  return { dir, encrypted, password: encrypted ? password : null };
}

// Snapshot of every file (path, size, mtime, sha256) so tests can prove a backup was not modified.
export function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}
