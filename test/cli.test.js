import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { EXPECTED, PASSWORD, PHOTO_BYTES, snapshotTree } from './helpers/fixtures.js';
import { makeFixtures } from './helpers/setup.js';

const BIN = fileURLToPath(new URL('../bin/imsg-skimmer.js', import.meta.url));
const fx = makeFixtures();
const snapshots = { plain: snapshotTree(fx.plain.dir), encrypted: snapshotTree(fx.encrypted.dir) };
after(() => fx.cleanup());

const base = ['--backup-root', fx.backupRoot, '--cache-dir', fx.cacheDir];

// Detached = no controlling terminal, so a password prompt can never block the test run.
function run(args, { env = {}, onStdout = null } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    if (!('IMSG_SKIMMER_TEST_PASSWORD' in env)) delete childEnv.IMSG_SKIMMER_TEST_PASSWORD;
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      onStdout?.(stdout, child);
    });
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('help, version and usage errors', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  for (const cmd of ['list', 'serve', 'export', 'purge']) assert.match(help.stdout, new RegExp(`imsg-skimmer ${cmd}`));
  assert.equal((await run(['--version'])).stdout.trim(), '0.1.1');
  assert.equal((await run(['frobnicate'])).code, 2);
  assert.equal((await run(['list', '--bogus'])).code, 2);
  assert.equal((await run(['export', ...base, '--backup', '1'])).code, 2, 'export needs --chat or --all');
});

test('list shows both backups with iOS, encryption and status', async () => {
  const r = await run(['list', ...base]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^#\s+Backup folder\s+Device\s+iOS\s+Last backup\s+Encrypted\s+Status\s+Location$/);
  assert.match(lines[1], new RegExp(`^1\\s+00000000-PLAINFIXTURE0001\\s+${EXPECTED.device.name}\\s+16\\.1\\s+\\S+ \\S+\\s+no\\s+ok\\s`));
  assert.match(lines[2], /^2\s+ffffffffencrypted\S+\s+.*\s+yes\s+ok\s/);
  const json = JSON.parse((await run(['list', ...base, '--json'])).stdout);
  assert.deepEqual(json.map((b) => [b.number, b.encrypted, b.hasMessages]), [[1, false, true], [2, true, true]]);
});

test('list --backup shows conversations; --counts prints aggregates only', async () => {
  const r = await run(['list', ...base, '--backup', '1']);
  assert.equal(r.code, 0, r.stderr);
  const rows = r.stdout.trim().split('\n');
  assert.match(rows[0], /^ID\s+Type\s+Messages\s+Attach\.\s+Last\s+Conversation$/);
  assert.equal(rows.length, 7);
  const counts = await run(['list', ...base, '--backup', '1', '--counts', '--json']);
  const c = JSON.parse(counts.stdout);
  assert.equal(c.conversations, 6);
  assert.equal(c.messages, 19);
  assert.equal(c.tapbacksFolded, 4);
  assert.ok(!counts.stdout.includes('Alice') && !counts.stdout.includes('+1555'), 'counts output has no names or numbers');
});

test('encrypted backup: password from the test env var works and is never printed', async () => {
  const r = await run(['list', ...base, '--backup', '2', '--counts'], { env: { IMSG_SKIMMER_TEST_PASSWORD: PASSWORD } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^conversations: 6$/m);
  assert.ok(!r.stdout.includes(PASSWORD) && !r.stderr.includes(PASSWORD));
  const wrong = await run(['list', ...base, '--backup', '2', '--counts'], { env: { IMSG_SKIMMER_TEST_PASSWORD: 'nope' } });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /Incorrect backup password/);
  const noTty = await run(['list', ...base, '--backup', '2', '--counts']);
  assert.equal(noTty.code, 1);
  assert.match(noTty.stderr, /terminal is required/);
});

test('export writes all formats with attachments, and refuses Windows drives', async () => {
  const out = path.join(fx.tmp, 'cli-export');
  const r = await run(['export', ...base, '--backup', '2', '--all', '--out', out], { env: { IMSG_SKIMMER_TEST_PASSWORD: PASSWORD } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Exported 6 conversations, 19 messages and 1 attachments \(1 not in backup\)/);
  assert.ok(!r.stderr.includes('Alice'), 'progress lines carry ids and counts only');
  const alice = fs.readdirSync(out).find((d) => d.startsWith('0001-'));
  assert.ok(fs.readFileSync(path.join(out, alice, 'attachments', '1-photo.jpg')).equals(PHOTO_BYTES));
  assert.ok(fs.existsSync(path.join(out, 'index.html')));

  const one = path.join(fx.tmp, 'cli-export-one');
  const single = await run(['export', ...base, '--backup', '1', '--chat', '3', '--format', 'json', '--out', one]);
  assert.equal(single.code, 0, single.stderr);
  assert.deepEqual(fs.readdirSync(one).map((d) => fs.readdirSync(path.join(one, d)).sort()), [['conversation.json']]);

  const refused = await run(['export', ...base, '--backup', '1', '--all', '--out', '/mnt/z/imsg-skimmer-test']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /never writes to Windows drives/);
  const inside = await run(['export', ...base, '--backup', '1', '--all', '--out', path.join(fx.plain.dir, 'out')]);
  assert.equal(inside.code, 1);
  assert.match(inside.stderr, /inside a backup folder/);
});

test('serve prints a tokenised 127.0.0.1 URL, answers API calls, and stops on SIGINT', async () => {
  let checked = null;
  const r = await run(['serve', ...base, '--backup', '1', '--port', '0'], {
    onStdout: (text, child) => {
      const m = text.match(/Open (http:\/\/127\.0\.0\.1:(\d+)\/\?token=\S+)/);
      if (!m || checked) return;
      checked = (async () => {
        const first = await fetch(m[1], { redirect: 'manual' });
        const cookie = first.headers.get('set-cookie').split(';')[0];
        const info = await (await fetch(`http://127.0.0.1:${m[2]}/api/info`, { headers: { cookie } })).json();
        const locked = await fetch(`http://127.0.0.1:${m[2]}/api/info`);
        child.kill('SIGINT');
        return { status: first.status, info, locked: locked.status };
      })();
    },
  });
  const result = await checked;
  assert.equal(result.status, 303);
  assert.equal(result.info.counts.messages, 19);
  assert.equal(result.locked, 403);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Listening on 127\.0\.0\.1 only/);
});

test('purge removes one backup cache or the whole cache; backups stay untouched', async () => {
  assert.equal((await run(['list', ...base, '--backup', '1', '--counts'])).code, 0);
  const one = await run(['purge', ...base, '--backup', '1']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /Removed cached data for backup 00000000-PLAINFIXTURE0001/);
  const all = await run(['purge', ...base]);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /^Removed /);
  assert.ok(!fs.existsSync(fx.cacheDir));
  assert.match((await run(['purge', ...base])).stdout, /Nothing to purge/);
  assert.deepEqual(snapshotTree(fx.plain.dir), snapshots.plain);
  assert.deepEqual(snapshotTree(fx.encrypted.dir), snapshots.encrypted);
});
