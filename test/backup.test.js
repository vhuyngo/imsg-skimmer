import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openArchive } from '../src/archive.js';
import { UsageError, discoverBackups, selectBackup } from '../src/backup.js';
import { Cache, UnsafePathError, assertWritable } from '../src/cache.js';
import { WrongPasswordError } from '../src/keybag.js';
import { EXPECTED, PASSWORD, PHOTO_BYTES, snapshotTree } from './helpers/fixtures.js';
import { makeFixtures } from './helpers/setup.js';

const fx = makeFixtures();
const snapshots = {
  plain: snapshotTree(fx.plain.dir),
  encrypted: snapshotTree(fx.encrypted.dir),
};
after(() => fx.cleanup());

const password = (value) => {
  const fn = async () => value;
  fn.interactive = false;
  return fn;
};

test('discovery lists both fixture backups with device, iOS, date and encryption', () => {
  const backups = discoverBackups([fx.backupRoot]);
  assert.equal(backups.length, 2);
  const [plain, enc] = backups;
  assert.equal(plain.id, '00000000-PLAINFIXTURE0001');
  for (const b of backups) {
    assert.equal(b.deviceName, EXPECTED.device.name);
    assert.equal(b.productVersion, EXPECTED.device.ios);
    assert.equal(b.lastBackupDate.toISOString(), EXPECTED.device.lastBackup);
    assert.equal(b.hasSmsDb, true);
    assert.deepEqual(b.problems, []);
  }
  assert.equal(plain.encrypted, false);
  assert.equal(enc.encrypted, true);
  assert.equal(selectBackup(backups, '2'), enc);
  assert.equal(selectBackup(backups, 'ffff'), enc);
  assert.equal(selectBackup(backups, fx.plain.dir), plain);
  assert.throws(() => selectBackup(backups, undefined), UsageError);
  assert.throws(() => selectBackup(backups, 'nope'), UsageError);
});

test('discovery reports an incomplete backup folder instead of failing', () => {
  const broken = path.join(fx.tmp, 'broken-root', 'incomplete');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'Status.plist'), 'not a plist');
  const [b] = discoverBackups([path.dirname(broken)]);
  assert.equal(b.hasSmsDb, false);
  assert.ok(b.problems.includes('no Info.plist'));
  assert.ok(b.problems.includes('no Messages database'));
});

for (const kind of ['plain', 'encrypted']) {
  describe(`${kind} backup`, () => {
    let archive;
    const cache = new Cache(path.join(fx.cacheDir, kind));
    before(async () => {
      const meta = discoverBackups([fx.backupRoot]).find((b) => b.path === fx[kind].dir);
      archive = await openArchive(meta, { cache, getPassword: password(PASSWORD) });
    });
    after(() => archive?.close());

    const conv = (title) => archive.conversations.find((c) => c.title === title);

    test('conversations, merged SMS/iMessage thread, titles from contacts', () => {
      const titles = archive.conversations.map((c) => c.title).sort();
      assert.deepEqual(titles, ['Alice Example', 'Alice Example', 'Bob Sample, +15550100009', 'Example Pharmacy', '+15550100009', EXPECTED.groupName].sort());
      const alice = archive.conversation(1);
      assert.equal(archive.conversation(2), alice, 'SMS chat 2 merges into chat 1');
      assert.deepEqual(alice.services.sort(), ['SMS', 'iMessage']);
      assert.equal(alice.messages.length, 8);
      assert.equal(archive.stats.orphanMessages, 1);
      assert.equal(archive.stats.messages, 19);
    });

    test('dates in seconds and nanoseconds, attributedBody text, edits and unsends', () => {
      const alice = archive.conversation(1);
      const byId = new Map(alice.messages.map((m) => [m.id, m]));
      assert.equal(new Date(byId.get(1).date).toISOString(), EXPECTED.dates.secondsFormat);
      assert.equal(new Date(byId.get(2).date).toISOString(), EXPECTED.dates.nanosecondFormat);
      assert.equal(byId.get(3).text, EXPECTED.attributedOnly);
      assert.equal(byId.get(23).edited, true);
      assert.equal(byId.get(24).unsent, true);
      assert.equal(archive.stats.secondDates, 2);
      assert.equal(archive.stats.nanosecondDates, 22);
      assert.equal(archive.stats.textFromAttributedBody, 4);
      const group = conv(EXPECTED.groupName);
      const texts = group.messages.map((m) => m.text);
      assert.ok(texts.includes(EXPECTED.longAttributed));
      assert.ok(texts.includes(EXPECTED.mutableAttributed));
      assert.deepEqual(alice.messages.map((m) => m.date), [...alice.messages.map((m) => m.date)].sort((a, b) => a - b));
    });

    test('tapbacks fold into their targets; removals cancel; unresolved ones stay', () => {
      const alice = archive.conversation(1);
      const byId = new Map(alice.messages.map((m) => [m.id, m]));
      assert.deepEqual(byId.get(3).reactions.map((r) => [r.kind, r.emoji, r.fromMe]), [['love', '❤️', true]]);
      assert.deepEqual(byId.get(2).reactions, [], 'like then un-like leaves nothing');
      assert.ok(!byId.has(4) && !byId.has(5) && !byId.has(6), 'tapback rows are not shown as messages');
      assert.ok(byId.has(22), 'tapback whose target is missing is kept');
      const group = conv(EXPECTED.groupName);
      const viet = group.messages.find((m) => m.text === EXPECTED.vietnamese);
      assert.deepEqual(viet.reactions.map((r) => [r.kind, r.emoji, r.handleId]), [['emoji', '🔥', 3]]);
      assert.equal(archive.stats.tapbacksFolded, 4);
      assert.equal(archive.stats.tapbacksUnresolved, 1);
    });

    test('group chat participants, contact names (exact, suffix, email, org) and system events', () => {
      const group = conv(EXPECTED.groupName);
      assert.equal(group.isGroup, true);
      assert.deepEqual(group.participants.map((p) => p.name).sort(), ['Alice Example', 'Bob Sample', 'Hương Nguyễn']);
      assert.equal(group.messages[0].system, true);
      assert.match(group.messages[0].text, /named the conversation/);
      const email = archive.conversation(7);
      assert.equal(email.title, 'Alice Example');
      assert.equal(archive.conversation(6).title, 'Example Pharmacy');
      assert.equal(archive.stats.contacts, 4);
      const who = archive.sender(group.messages.find((m) => m.text === EXPECTED.vietnamese), group);
      assert.deepEqual(who, { name: 'Hương Nguyễn', handle: '+84555010003' });
    });

    test('attachments: present file extracted byte-for-byte, missing and hidden handled', async () => {
      const alice = archive.conversation(1);
      const photoMsg = alice.messages.find((m) => m.id === 7);
      assert.equal(photoMsg.text, null, 'the U+FFFC placeholder is stripped');
      const [photo] = photoMsg.attachments;
      assert.equal(photo.name, 'photo.jpg');
      assert.equal(photo.kind, 'image');
      assert.equal(archive.attachmentPresent(photo), true);
      const file = await archive.attachmentFile(photo);
      assert.ok(fs.readFileSync(file).equals(PHOTO_BYTES));
      const group = conv(EXPECTED.groupName);
      const clip = group.messages.find((m) => m.text === 'Me too').attachments[0];
      assert.equal(clip.kind, 'video');
      assert.equal(archive.attachmentPresent(clip), false);
      assert.equal(await archive.attachmentFile(clip), null);
      assert.deepEqual(group.messages.find((m) => m.text === "Who's in?").attachments, [], 'hidden plugin payload is dropped');
    });

    test('search is case- and diacritic-insensitive and honours conversation and date filters', () => {
      assert.equal(archive.search('toi di DUOC').total, 1);
      assert.equal(archive.search('"lives only" ATTRIBUTEDBODY').total, 1);
      assert.equal(archive.search('alice').total, 3);
      assert.equal(archive.search('alice', { conversationId: 1 }).total, 3, 'includes the merged SMS thread');
      assert.equal(archive.search('alice', { conversationId: 3 }).total, 0);
      assert.equal(archive.search('alice', { from: Date.parse('2017-01-01'), to: Date.parse('2022-12-31') }).total, 2);
      assert.equal(archive.search('   ').total, 0);
      const results = archive.search('alice').results.map((r) => r.msg.date);
      assert.deepEqual(results, [...results].sort((a, b) => b - a), 'newest first');
    });

    test('paging: last page by default, offsets, around a message, date range', () => {
      const alice = archive.conversation(1);
      const last = archive.page(alice, { limit: 3 });
      assert.equal(last.total, 8);
      assert.equal(last.offset, 5);
      assert.deepEqual(last.messages.map((m) => m.id), alice.messages.slice(5).map((m) => m.id));
      assert.deepEqual(archive.page(alice, { offset: 0, limit: 2 }).messages.map((m) => m.id), [1, 8]);
      const around = archive.page(alice, { around: 3, limit: 3 });
      assert.ok(around.messages.some((m) => m.id === 3));
      const ranged = archive.page(alice, { from: Date.parse('2022-01-01'), to: Date.parse('2022-01-15T23:59:59Z') });
      assert.deepEqual(ranged.messages.map((m) => m.id), [2, 3]);
      const summaries = archive.summaries({ from: Date.parse('2023-01-01') });
      assert.equal(summaries.length, 4);
      assert.ok(summaries.every((s) => s.lastDate >= Date.parse('2023-01-01')));
    });

    test('cache is private (0700) and the backup folder is untouched', () => {
      assert.equal(fs.statSync(cache.root).mode & 0o777, 0o700);
      assert.equal(fs.statSync(archive.backup.cacheDir).mode & 0o777, 0o700);
      assert.ok(fs.existsSync(path.join(archive.backup.cacheDir, 'sms.db')));
      assert.deepEqual(snapshotTree(fx[kind].dir), snapshots[kind]);
    });
  });
}

test('encrypted backup: wrong password is rejected, missing password is a usage error', async () => {
  const meta = discoverBackups([fx.backupRoot]).find((b) => b.encrypted);
  const cache = new Cache(path.join(fx.cacheDir, 'wrong'));
  await assert.rejects(openArchive(meta, { cache, getPassword: password('not the password') }), WrongPasswordError);
  await assert.rejects(openArchive(meta, { cache }), UsageError);
  assert.ok(!fs.existsSync(path.join(cache.root, meta.cacheKey, 'sms.db')), 'nothing decrypted without the password');
});

test('encrypted Manifest.db and sms.db are ciphertext on disk', () => {
  const head = fs.readFileSync(path.join(fx.encrypted.dir, 'Manifest.db')).subarray(0, 15).toString('latin1');
  assert.notEqual(head, 'SQLite format 3');
  const plainHead = fs.readFileSync(path.join(fx.plain.dir, 'Manifest.db')).subarray(0, 15).toString('latin1');
  assert.equal(plainHead, 'SQLite format 3');
});

test('write guards refuse Windows drives and backup folders; purge only deletes marked caches', async () => {
  assert.throws(() => assertWritable('/mnt/z/imsg-skimmer-test/out'), UnsafePathError);
  assert.throws(() => assertWritable(path.join(fx.plain.dir, 'x')), UnsafePathError);
  const notCache = new Cache(path.join(fx.tmp, 'not-a-cache'));
  fs.mkdirSync(notCache.root);
  fs.writeFileSync(path.join(notCache.root, 'keep.txt'), 'keep');
  assert.throws(() => notCache.purge(), UnsafePathError);
  assert.ok(fs.existsSync(path.join(notCache.root, 'keep.txt')));
  const cache = new Cache(path.join(fx.cacheDir, 'purge'));
  const meta = discoverBackups([fx.backupRoot])[0];
  const archive = await openArchive(meta, { cache });
  archive.close();
  const one = cache.purge(meta.cacheKey);
  assert.equal(one.removed, true);
  assert.ok(one.files >= 3);
  assert.ok(fs.existsSync(cache.root));
  assert.equal(cache.purge().removed, true);
  assert.ok(!fs.existsSync(cache.root));
  assert.deepEqual(snapshotTree(fx.plain.dir), snapshots.plain);
});
