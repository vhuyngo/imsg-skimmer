// Command-line entry point: list, serve, export, purge.
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openArchive } from './archive.js';
import { UsageError, defaultBackupRoots, discoverBackups, selectBackup } from './backup.js';
import { Cache, defaultCacheRoot } from './cache.js';
import { FORMATS, exportConversations, localStamp } from './export.js';
import { passwordSource } from './password.js';
import { createServer } from './server.js';

export const VERSION = '0.1.1';
const DEFAULT_PORT = 8686;

const HELP = `imsg-skimmer ${VERSION}: read-only viewer and exporter for Messages in iPhone backups

Usage:
  imsg-skimmer list [--json]                     List the backups found on this PC
  imsg-skimmer list --backup <sel> [--json | --counts] [--from <date>] [--to <date>]
                                                 List a backup's conversations, or only aggregate counts
  imsg-skimmer serve --backup <sel> [--port ${DEFAULT_PORT}]  Browse a backup at http://127.0.0.1:<port>
  imsg-skimmer export --backup <sel> (--all | --chat <id>[,<id>...]) [--out <dir>]
                      [--format html,csv,json] [--from <date>] [--to <date>] [--no-attachments]
  imsg-skimmer purge [--backup <sel>]            Delete cached copies (everything, or one backup's)

Options:
  -b, --backup <sel>       Backup: the # shown by \`list\`, a backup-folder prefix, or a folder path
      --backup-root <dir>  Search this folder instead of the Windows defaults (repeatable)
      --cache-dir <dir>    Cache location (default ~/.cache/imsg-skimmer or $IMSG_SKIMMER_CACHE)
  -c, --chat <id>          Conversation id from \`list --backup\` (repeatable or comma-separated)
  -o, --out <dir>          Export folder (default ./imsg-export-<timestamp>; never on /mnt/<drive>)
  -f, --format <list>      Export formats (default html,csv,json)
      --from, --to <date>  Inclusive date filter, YYYY-MM-DD in local time
  -h, --help               Show this help
  -v, --version            Show the version

Encrypted backups ask for their password on the terminal. It is never stored or logged.`;

const OPTIONS = {
  backup: { type: 'string', short: 'b' },
  'backup-root': { type: 'string', multiple: true },
  'cache-dir': { type: 'string' },
  json: { type: 'boolean' },
  counts: { type: 'boolean' },
  port: { type: 'string', short: 'p' },
  all: { type: 'boolean' },
  chat: { type: 'string', short: 'c', multiple: true },
  out: { type: 'string', short: 'o' },
  format: { type: 'string', short: 'f' },
  from: { type: 'string' },
  to: { type: 'string' },
  'no-attachments': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

export function parseDay(value, edge) {
  if (value === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    const date = edge === 'end' ? new Date(y, mo, d, 23, 59, 59, 999) : new Date(y, mo, d);
    if (date.getMonth() === mo && date.getDate() === d) return date.getTime();
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    return Date.parse(value);
  }
  throw new UsageError(`Invalid date "${value}"; use YYYY-MM-DD.`);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

function table(rows, headers) {
  const cells = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => [...r[i]].length)));
  return cells.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] + (c.length - [...c].length)))).join('  ').trimEnd()).join('\n');
}

function publicBackup(b, i) {
  return {
    number: i + 1,
    id: b.id,
    path: b.path,
    deviceName: b.deviceName,
    productType: b.productType,
    productVersion: b.productVersion,
    lastBackupDate: b.lastBackupDate ? b.lastBackupDate.toISOString() : null,
    encrypted: b.encrypted,
    hasMessages: b.hasSmsDb,
    problems: b.problems,
  };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (s = '') => stdout.write(`${s}\n`);
  const log = (s) => stderr.write(`${s}\n`);
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    log(`imsg-skimmer: ${err.message}\nRun \`imsg-skimmer --help\` for usage.`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) {
    out(VERSION);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (opts.help || command === 'help') {
    out(HELP);
    return 0;
  }
  if (!command) {
    log(HELP);
    return 2;
  }
  const ctx = {
    opts,
    out,
    log,
    cache: new Cache(expandHome(opts['cache-dir'] ?? defaultCacheRoot())),
    roots: opts['backup-root']?.length ? opts['backup-root'].map((r) => path.resolve(expandHome(r))) : defaultBackupRoots(),
  };
  try {
    if (extra.length) throw new UsageError(`Unexpected argument "${extra[0]}".`);
    switch (command) {
      case 'list':
        return await cmdList(ctx);
      case 'serve':
        return await cmdServe(ctx);
      case 'export':
        return await cmdExport(ctx);
      case 'purge':
        return cmdPurge(ctx);
      default:
        throw new UsageError(`Unknown command "${command}". Run \`imsg-skimmer --help\`.`);
    }
  } catch (err) {
    log(`imsg-skimmer: ${err.message}`);
    if (process.env.IMSG_SKIMMER_DEBUG && !(err instanceof UsageError)) log(err.stack);
    return err instanceof UsageError ? 2 : 1;
  }
}

function findBackup(ctx) {
  return selectBackup(discoverBackups(ctx.roots), ctx.opts.backup);
}

async function open(ctx) {
  const meta = findBackup(ctx);
  if (!meta.hasSmsDb) throw new UsageError(`Backup ${meta.id} has no Messages database (${meta.problems.join(', ') || 'incomplete'}).`);
  if (meta.problems.length) ctx.log(`Warning: backup ${meta.id} looks incomplete (${meta.problems.join(', ')}); results may be partial.`);
  ctx.log(`Opening backup ${meta.id}${meta.encrypted ? ' (encrypted)' : ''}...`);
  return openArchive(meta, { cache: ctx.cache, getPassword: passwordSource(ctx.log), log: ctx.log });
}

const filterOf = (opts) => ({ from: parseDay(opts.from, 'start'), to: parseDay(opts.to, 'end') });

async function cmdList(ctx) {
  const { opts, out } = ctx;
  if (!opts.backup && !opts.counts) {
    const backups = discoverBackups(ctx.roots);
    if (opts.json) {
      out(JSON.stringify(backups.map(publicBackup), null, 2));
      return 0;
    }
    if (!backups.length) {
      out(`No iPhone backups found in: ${ctx.roots.join(', ') || '(no default locations exist)'}`);
      return 0;
    }
    const rows = backups.map((b, i) => [
      i + 1,
      b.id,
      b.deviceName ?? '?',
      b.productVersion ?? '?',
      b.lastBackupDate ? localStamp(b.lastBackupDate.getTime()).slice(0, 16) : '?',
      b.encrypted === null ? '?' : b.encrypted ? 'yes' : 'no',
      b.problems.length ? b.problems.join(', ') : 'ok',
      b.root,
    ]);
    out(table(rows, ['#', 'Backup folder', 'Device', 'iOS', 'Last backup', 'Encrypted', 'Status', 'Location']));
    return 0;
  }
  const filter = filterOf(opts);
  const archive = await open(ctx);
  try {
    const summaries = archive.summaries(filter);
    if (opts.counts) {
      const s = archive.stats;
      const counts = {
        conversations: summaries.length,
        groupConversations: summaries.filter((c) => c.isGroup).length,
        messages: summaries.reduce((n, c) => n + c.messageCount, 0),
        attachments: summaries.reduce((n, c) => n + c.attachmentCount, 0),
        handles: s.handles,
        handlesWithContactName: s.handlesWithContactName,
        contacts: s.contacts,
        secondDates: s.secondDates,
        nanosecondDates: s.nanosecondDates,
        textFromAttributedBody: s.textFromAttributedBody,
        tapbacksFolded: s.tapbacksFolded,
        tapbacksUnresolved: s.tapbacksUnresolved,
        systemMessages: s.systemMessages,
        emptyMessagesSkipped: s.emptyMessages,
        orphanMessages: s.orphanMessages,
      };
      out(opts.json ? JSON.stringify(counts, null, 2) : Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('\n'));
      return 0;
    }
    if (opts.json) {
      out(JSON.stringify(summaries, null, 2));
      return 0;
    }
    const rows = summaries.map((c) => [
      c.id,
      c.isGroup ? 'group' : 'direct',
      c.messageCount,
      c.attachmentCount,
      localStamp(c.lastDate).slice(0, 10),
      c.title,
    ]);
    out(table(rows, ['ID', 'Type', 'Messages', 'Attach.', 'Last', 'Conversation']));
    return 0;
  } finally {
    archive.close();
  }
}

async function cmdServe(ctx) {
  const { opts, out, log } = ctx;
  const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port "${opts.port}".`);
  const archive = await open(ctx);
  const app = createServer(archive, { log });
  let url;
  try {
    ({ url } = await app.listen(port));
  } catch (err) {
    archive.close();
    if (err.code === 'EADDRINUSE') throw new UsageError(`Port ${port} is already in use; choose another with --port.`);
    throw err;
  }
  const { counts } = archive.info();
  out(`Loaded ${counts.conversations} conversations, ${counts.messages} messages, ${counts.attachments} attachments.`);
  out(`Open ${url}`);
  out('Listening on 127.0.0.1 only. Press Ctrl+C to stop.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await app.close();
  archive.close();
  return 0;
}

function selectConversations(archive, opts) {
  if (opts.all) return archive.conversations;
  const ids = (opts.chat ?? []).flatMap((c) => c.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new UsageError('Choose conversations with --chat <id> (ids from `imsg-skimmer list --backup <sel>`) or use --all.');
  const convs = [];
  for (const id of ids) {
    const conv = /^\d+$/.test(id) ? archive.conversation(id) : null;
    if (!conv) throw new UsageError(`No conversation with id ${id}.`);
    if (!convs.includes(conv)) convs.push(conv);
  }
  return convs;
}

async function cmdExport(ctx) {
  const { opts, out, log } = ctx;
  const formats = (opts.format ?? FORMATS.join(',')).split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
  const bad = formats.find((f) => !FORMATS.includes(f));
  if (bad || !formats.length) throw new UsageError(`Unknown format "${bad ?? ''}"; use any of ${FORMATS.join(', ')}.`);
  if (!opts.all && !opts.chat?.length) {
    throw new UsageError('Choose conversations with --chat <id> (ids from `imsg-skimmer list --backup <sel>`) or use --all.');
  }
  const filter = filterOf(opts);
  const stamp = localStamp(Date.now()).replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const outDir = path.resolve(expandHome(opts.out ?? `imsg-export-${stamp}`));
  const archive = await open(ctx);
  try {
    const convs = selectConversations(archive, opts);
    const summary = await exportConversations(archive, convs, {
      outDir,
      formats,
      ...filter,
      attachments: !opts['no-attachments'],
      log,
    });
    const failed = summary.attachmentsFailed ? `, ${summary.attachmentsFailed} failed` : '';
    out(
      `Exported ${summary.conversations} conversations, ${summary.messages} messages and ${summary.attachmentsCopied} attachments ` +
        `(${summary.attachmentsMissing} not in backup${failed}) to ${outDir}`,
    );
    return summary.attachmentsFailed ? 1 : 0;
  } finally {
    archive.close();
  }
}

function cmdPurge(ctx) {
  const { opts, out, cache } = ctx;
  if (opts.backup) {
    const meta = findBackup(ctx);
    const r = cache.purge(meta.cacheKey);
    out(r.removed ? `Removed cached data for backup ${meta.id} (${r.files} files, ${formatBytes(r.bytes)}).` : `Nothing cached for backup ${meta.id}.`);
    return 0;
  }
  const r = cache.purge();
  out(r.removed ? `Removed ${cache.root} (${r.files} files, ${formatBytes(r.bytes)}).` : `Nothing to purge at ${cache.root}.`);
  return 0;
}
