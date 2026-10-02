import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openArchive } from '../src/archive.js';
import { discoverBackups } from '../src/backup.js';
import { Cache, UnsafePathError } from '../src/cache.js';
import { exportConversations } from '../src/export.js';
import { createServer } from '../src/server.js';
import { EXPECTED, PASSWORD, PHOTO_BYTES, snapshotTree } from './helpers/fixtures.js';
import { makeFixtures } from './helpers/setup.js';

const fx = makeFixtures();
const before_ = { plain: snapshotTree(fx.plain.dir), encrypted: snapshotTree(fx.encrypted.dir) };
after(() => fx.cleanup());

async function open(kind) {
  const meta = discoverBackups([fx.backupRoot]).find((b) => b.path === fx[kind].dir);
  const getPassword = async () => PASSWORD;
  return openArchive(meta, { cache: new Cache(path.join(fx.cacheDir, kind)), getPassword });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const convDir = (out, id) => path.join(out, fs.readdirSync(out).find((d) => d.startsWith(`${String(id).padStart(4, '0')}-`)));

for (const kind of ['plain', 'encrypted']) {
  describe(`export from the ${kind} backup`, () => {
    let archive;
    const out = path.join(fx.tmp, `export-${kind}`);
    let summary;
    before(async () => {
      archive = await open(kind);
      summary = await exportConversations(archive, archive.conversations, { outDir: out });
    });
    after(() => archive?.close());

    test('writes index plus HTML, CSV and JSON for every conversation', () => {
      assert.deepEqual(summary, { conversations: 6, messages: 19, attachmentsCopied: 1, attachmentsMissing: 1, attachmentsFailed: 0 });
      assert.ok(fs.existsSync(path.join(out, 'index.html')));
      const dirs = fs.readdirSync(out).filter((d) => fs.statSync(path.join(out, d)).isDirectory());
      assert.equal(dirs.length, 6);
      for (const d of dirs) {
        for (const f of ['conversation.html', 'messages.csv', 'conversation.json']) assert.ok(fs.existsSync(path.join(out, d, f)), `${d}/${f}`);
        assert.equal(fs.statSync(path.join(out, d)).mode & 0o777, 0o700);
      }
    });

    test('JSON keeps dates, attributedBody text, reactions and copied attachments', () => {
      const dir = convDir(out, 1);
      const doc = readJson(path.join(dir, 'conversation.json'));
      assert.equal(doc.conversation.title, 'Alice Example');
      assert.equal(doc.messages.length, 8);
      assert.equal(doc.messages[0].date, EXPECTED.dates.secondsFormat);
      const m3 = doc.messages.find((m) => m.id === 3);
      assert.equal(m3.text, EXPECTED.attributedOnly);
      assert.deepEqual(m3.reactions.map((r) => [r.kind, r.fromMe]), [['love', true]]);
      const photo = doc.messages.find((m) => m.id === 7).attachments[0];
      assert.match(photo.file, /^attachments\/1-photo\.jpg$/);
      assert.ok(fs.readFileSync(path.join(dir, photo.file)).equals(PHOTO_BYTES));
    });

    test('CSV has a BOM, a header and one row per message', () => {
      const csv = fs.readFileSync(path.join(convDir(out, 1), 'messages.csv'), 'utf8');
      assert.ok(csv.startsWith('\uFEFFmessage_id,date_local,date_utc,direction,sender'));
      assert.equal(csv.trimEnd().split('\r\n').length, 9);
      assert.match(csv, /,received,Alice Example,'\+15550100001,iMessage,Hello from Alice,/);
    });

    test('HTML escapes message text and links attachments; missing ones are labelled', () => {
      const group = fs.readFileSync(path.join(convDir(out, 3), 'conversation.html'), 'utf8');
      assert.ok(!group.includes('<script>alert'), 'message text is escaped');
      assert.ok(group.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; friends'));
      assert.ok(group.includes('clip.mov (not in backup)'));
      assert.ok(group.includes(EXPECTED.groupName));
      const alice = fs.readFileSync(path.join(convDir(out, 1), 'conversation.html'), 'utf8');
      assert.ok(alice.includes('<img src="attachments/1-photo.jpg"'));
      assert.ok(alice.includes('@media print'));
    });
  });
}

test('export honours date range, formats and --no-attachments; refuses Windows drives', async () => {
  const archive = await open('plain');
  try {
    const out = path.join(fx.tmp, 'export-filtered');
    const s = await exportConversations(archive, archive.conversations, { outDir: out, formats: ['json'], from: Date.parse('2023-01-01'), attachments: false });
    assert.equal(s.conversations, 4);
    assert.equal(s.attachmentsCopied, 0);
    const dirs = fs.readdirSync(out);
    assert.ok(!dirs.includes('index.html'));
    assert.ok(dirs.every((d) => fs.readdirSync(path.join(out, d)).join() === 'conversation.json'));
    await assert.rejects(exportConversations(archive, archive.conversations, { outDir: '/mnt/z/imsg-skimmer-test' }), UnsafePathError);
    await assert.rejects(exportConversations(archive, archive.conversations, { outDir: path.join(fx.plain.dir, 'export') }), UnsafePathError);
  } finally {
    archive.close();
  }
});

function request(port, pathname, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('web server', () => {
  let archive;
  let app;
  let port;
  let cookie;
  const get = (p, headers = {}) => request(port, p, { headers: { Cookie: cookie, ...headers } });
  const getJson = async (p) => {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} -> ${r.status} ${r.body}`);
    return JSON.parse(r.body.toString('utf8'));
  };

  before(async () => {
    archive = await open('encrypted');
    app = createServer(archive);
    ({ port } = await app.listen(0));
    const r = await request(port, `/?token=${app.token}`);
    assert.equal(r.status, 303);
    cookie = r.headers['set-cookie'][0].split(';')[0];
  });
  after(async () => {
    await app?.close();
    archive?.close();
  });

  test('listens on 127.0.0.1 only and requires the token', async () => {
    assert.equal(app.server.address().address, '127.0.0.1');
    const locked = await request(port, '/');
    assert.equal(locked.status, 403);
    assert.match(locked.body.toString(), /link printed in the terminal/);
    assert.equal((await request(port, '/api/info')).status, 403);
    assert.equal((await request(port, '/?token=wrong')).status, 403);
    assert.match(cookie, new RegExp(`^imsg_skimmer_${port}=`));
  });

  test('rejects foreign Host headers and non-GET methods', async () => {
    assert.equal((await request(port, '/api/info', { host: 'evil.example', headers: { Cookie: cookie } })).status, 403);
    assert.equal((await request(port, '/api/info', { host: `attacker.test:${port}`, headers: { Cookie: cookie } })).status, 403);
    assert.equal((await request(port, '/api/info', { method: 'POST', headers: { Cookie: cookie } })).status, 405);
    assert.equal((await request(port, '/api/info', { host: `localhost:${port}`, headers: { Cookie: cookie } })).status, 200);
  });

  test('serves the UI with a strict CSP and private-data headers', async () => {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'; script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.body.toString(), /app\.js/);
    assert.match((await get('/app.js')).headers['content-type'], /javascript/);
    assert.match((await get('/app.css')).headers['content-type'], /text\/css/);
  });

  test('info, conversations and date filter', async () => {
    const info = await getJson('/api/info');
    assert.deepEqual(info.counts, { conversations: 6, messages: 19, attachments: 2 });
    assert.equal(info.backup.encrypted, true);
    assert.equal(info.backup.deviceName, EXPECTED.device.name);
    const { conversations } = await getJson('/api/conversations');
    assert.equal(conversations.length, 6);
    assert.deepEqual(conversations.map((c) => c.lastDate), [...conversations.map((c) => c.lastDate)].sort((a, b) => b - a));
    const group = conversations.find((c) => c.title === EXPECTED.groupName);
    assert.equal(group.isGroup, true);
    assert.equal(group.participants.length, 3);
    const recent = await getJson(`/api/conversations?from=${Date.parse('2023-01-01')}`);
    assert.equal(recent.conversations.length, 4);
  });

  test('message pages, around, reactions and attachments metadata', async () => {
    const page = await getJson('/api/conversations/1/messages?limit=3');
    assert.equal(page.total, 8);
    assert.equal(page.offset, 5);
    assert.equal(page.messages.length, 3);
    const all = await getJson('/api/conversations/1/messages');
    const m3 = all.messages.find((m) => m.id === 3);
    assert.equal(m3.text, EXPECTED.attributedOnly);
    assert.deepEqual(m3.reactions, [{ kind: 'love', emoji: '❤️', fromMe: true, sender: null, date: Date.parse('2022-01-15T12:06:00Z') }]);
    const photo = all.messages.find((m) => m.id === 7).attachments[0];
    assert.deepEqual(photo, { id: 1, name: 'photo.jpg', mime: 'image/jpeg', size: PHOTO_BYTES.length, kind: 'image', url: '/attachments/1', missing: false });
    const around = await getJson('/api/conversations/1/messages?around=3&limit=3');
    assert.ok(around.messages.some((m) => m.id === 3));
    const groupPage = await getJson('/api/conversations/3/messages');
    const clip = groupPage.messages.find((m) => m.text === 'Me too').attachments[0];
    assert.equal(clip.missing, true);
    assert.equal(clip.url, null);
    const viet = groupPage.messages.find((m) => m.text === EXPECTED.vietnamese);
    assert.deepEqual(viet.sender, { name: 'Hương Nguyễn', handle: '+84555010003' });
    assert.equal((await get('/api/conversations/999/messages')).status, 404);
    assert.equal((await get('/api/conversations/1/messages?limit=abc')).status, 400);
  });

  test('search endpoint', async () => {
    const r = await getJson(`/api/search?q=${encodeURIComponent('toi di duoc')}`);
    assert.equal(r.total, 1);
    assert.equal(r.results[0].conversationTitle, EXPECTED.groupName);
    assert.equal(r.results[0].message.text, EXPECTED.vietnamese);
    const scoped = await getJson('/api/search?q=alice&conversation=3');
    assert.equal(scoped.total, 0);
    const ranged = await getJson(`/api/search?q=alice&to=${Date.parse('2020-01-01')}`);
    assert.equal(ranged.total, 2);
  });

  test('attachments stream decrypted bytes, support ranges, and hide missing or hidden files', async () => {
    const full = await get('/attachments/1');
    assert.equal(full.status, 200);
    assert.equal(full.headers['content-type'], 'image/jpeg');
    assert.match(full.headers['content-security-policy'], /sandbox/);
    assert.ok(full.body.equals(PHOTO_BYTES));
    const part = await get('/attachments/1', { Range: 'bytes=0-9' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], `bytes 0-9/${PHOTO_BYTES.length}`);
    assert.ok(part.body.equals(PHOTO_BYTES.subarray(0, 10)));
    assert.equal((await get('/attachments/2')).status, 404);
    assert.equal((await get('/attachments/3')).status, 404);
  });

  test('backups were never modified', () => {
    assert.deepEqual(snapshotTree(fx.plain.dir), before_.plain);
    assert.deepEqual(snapshotTree(fx.encrypted.dir), before_.encrypted);
  });
});
