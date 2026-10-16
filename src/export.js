// Writes conversations to HTML (printable as PDF), CSV and JSON, with attachments copied alongside.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeForSearch } from './archive.js';
import { ensurePrivateDir } from './cache.js';
import { digitsOf } from './contacts.js';
import { isSmsService, outgoingBubbleClass } from './messageService.js';

export const FORMATS = ['html', 'csv', 'json'];

export function slugify(title) {
  return normalizeForSearch(title ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'conversation';
}

const folderSegment = (s, max = 48) =>
  String(s ?? '')
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'unknown';

/** Export folder name: `<index>-<phone-number>-<contact-name>`. */
export function conversationDirName(conv) {
  const index = String(conv.id).padStart(4, '0');
  const phone = phoneFolderSegment(conv);
  const name = folderSegment(slugify(conv.title), 56);
  return `${index}-${phone}-${name}`.slice(0, 200);
}

function phoneFolderSegment(conv) {
  const handles = conv.participants?.map((p) => p.handle).filter(Boolean) ?? [];
  const pick =
    conv.identifier ??
    handles.find((h) => !String(h).includes('@')) ??
    handles[0] ??
    'unknown';
  const digits = digitsOf(pick);
  if (digits.length >= 7) return digits.slice(0, 20);
  if (String(pick).includes('@')) return folderSegment(String(pick).replace(/@/g, '-at-'), 40);
  return folderSegment(pick, 40);
}

export function safeFileName(name) {
  const clean = String(name ?? '').replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '') || 'attachment';
  if (clean.length <= 100) return clean;
  const ext = path.extname(clean).slice(0, 12);
  return clean.slice(0, 100 - ext.length) + ext;
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const pad = (n) => String(n).padStart(2, '0');

export function localStamp(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const personLabel = (p) => (p ? p.name ?? p.handle : 'Unknown');

// Spreadsheet apps execute cells starting with these characters as formulas.
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function record(archive, conv, msg, files) {
  return {
    id: msg.id,
    guid: msg.guid,
    date: iso(msg.date),
    dateRead: iso(msg.dateRead),
    fromMe: msg.fromMe,
    sender: archive.sender(msg, conv),
    service: msg.service,
    text: msg.text,
    subject: msg.subject,
    system: msg.system,
    edited: msg.edited,
    unsent: msg.unsent,
    replyToId: msg.replyToId,
    attachments: msg.attachments.map((att) => ({
      id: att.id,
      name: att.name,
      mime: att.mime,
      size: att.size,
      kind: att.kind,
      file: files.get(att.id) ?? null,
      missing: !archive.attachmentPresent(att),
    })),
    reactions: msg.reactions.map((r) => ({
      kind: r.kind,
      emoji: r.emoji,
      fromMe: r.fromMe,
      sender: r.fromMe ? null : archive.person(r.handleId),
      date: iso(r.date),
    })),
  };
}

const CSV_HEADER = ['message_id', 'date_local', 'date_utc', 'direction', 'sender', 'sender_handle', 'service', 'text', 'subject', 'attachments', 'reactions', 'edited', 'unsent'];

function toCsv(records) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of records) {
    const direction = r.system ? 'system' : r.fromMe ? 'sent' : 'received';
    const reactions = r.reactions.map((x) => `${x.emoji} ${x.fromMe ? 'Me' : personLabel(x.sender)}`).join('; ');
    const attachments = r.attachments.map((a) => a.file ?? `${a.name}${a.missing ? ' (not in backup)' : ''}`).join('; ');
    lines.push(
      [r.id, localStamp(Date.parse(r.date)), r.date ?? '', direction, r.fromMe ? 'Me' : r.sender?.name ?? '', r.fromMe ? '' : r.sender?.handle ?? '',
        r.service ?? '', r.text ?? '', r.subject ?? '', attachments, reactions, r.edited ? 'yes' : '', r.unsent ? 'yes' : '']
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const STYLE = `
:root { color-scheme: light; }
body { font: 14px/1.4 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; background: #f4f4f6; color: #111; }
main { max-width: 820px; margin: 0 auto; padding: 24px 16px 48px; background: #fff; }
header { border-bottom: 1px solid #ddd; margin-bottom: 16px; padding-bottom: 12px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.facts { color: #555; font-size: 12px; margin: 2px 0; }
.day { text-align: center; color: #777; font-size: 12px; margin: 18px 0 8px; }
.msg { display: flex; flex-direction: column; margin: 6px 0; break-inside: avoid; page-break-inside: avoid; }
.msg.me { align-items: flex-end; }
.msg.them { align-items: flex-start; }
.msg.system { align-items: center; color: #777; font-size: 12px; font-style: italic; }
.sender { font-size: 11px; color: #666; margin: 0 10px 2px; }
.bubble { max-width: 75%; padding: 7px 12px; border-radius: 16px; background: #e9e9eb; white-space: pre-wrap; overflow-wrap: anywhere; }
.me .bubble.imessage { background: #0b84ff; color: #fff; }
.me .bubble.sms { background: #34c759; color: #fff; }
.subject { font-weight: 600; }
.meta { font-size: 10px; color: #888; margin: 2px 10px 0; }
.att { margin-top: 6px; }
.att img { max-width: 100%; max-height: 360px; border-radius: 10px; display: block; }
.att video { max-width: 100%; max-height: 360px; display: block; }
.me .bubble a { color: inherit; }
.file { display: inline-block; padding: 4px 8px; border-radius: 8px; background: rgba(0,0,0,0.08); font-size: 12px; }
.missing { opacity: 0.7; font-style: italic; }
.reactions { font-size: 12px; margin: 2px 10px 0; color: #555; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
@media print {
  body { background: #fff; }
  main { max-width: none; padding: 0; }
  video, audio { display: none !important; }
  .print-link { display: inline !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
.print-link { display: none; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>
`;
}

const BROWSER_IMAGES = /^image\/(jpeg|png|gif|webp|bmp|avif|svg\+xml)$/;

function attachmentHtml(a) {
  if (!a.file) return `<div class="att"><span class="file missing">${esc(a.name)} (${a.missing ? 'not in backup' : 'not exported'})</span></div>`;
  const href = esc(a.file.split('/').map(encodeURIComponent).join('/'));
  const link = `<a class="file" href="${href}">${esc(a.name)}</a>`;
  if (a.kind === 'image' && BROWSER_IMAGES.test(a.mime ?? '')) return `<div class="att"><a href="${href}"><img src="${href}" alt="${esc(a.name)}" loading="lazy"></a></div>`;
  if (a.kind === 'video') return `<div class="att"><video controls preload="none" src="${href}"></video><span class="print-link">${link}</span></div>`;
  if (a.kind === 'audio') return `<div class="att"><audio controls preload="none" src="${href}"></audio><span class="print-link">${link}</span></div>`;
  return `<div class="att">${link}</div>`;
}

function conversationHtml(archive, conv, records, range) {
  const people = conv.participants.map((h) => (h.name ? `${h.name} (${h.handle})` : h.handle)).join(', ');
  const first = records[0]?.date;
  const last = records[records.length - 1]?.date;
  const info = archive.meta;
  const parts = [
    `<header><h1>${esc(conv.title)}</h1>`,
    people ? `<p class="facts">Participants: ${esc(people)}</p>` : '',
    `<p class="facts">${records.length} messages · ${esc(localStamp(Date.parse(first)))} – ${esc(localStamp(Date.parse(last)))}${range}</p>`,
    `<p class="facts">From the backup of ${esc(info.deviceName ?? info.id)}${info.productVersion ? ` (iOS ${esc(info.productVersion)})` : ''} · exported ${esc(localStamp(Date.now()))}</p></header>`,
  ];
  let day = null;
  for (const r of records) {
    const stamp = localStamp(Date.parse(r.date));
    const thisDay = stamp.slice(0, 10) || 'Unknown date';
    if (thisDay !== day) {
      day = thisDay;
      parts.push(`<div class="day">${esc(day)}</div>`);
    }
    if (r.system) {
      parts.push(`<div class="msg system" id="m${r.id}">${esc(r.text)} <span class="meta">${esc(stamp.slice(11, 16))}</span></div>`);
      continue;
    }
    const cls = r.fromMe ? 'me' : 'them';
    const bubbleKind = outgoingBubbleClass(r.fromMe, r.service);
    const sender = !r.fromMe && conv.isGroup ? `<div class="sender">${esc(personLabel(r.sender))}</div>` : '';
    const body = [
      r.subject ? `<div class="subject">${esc(r.subject)}</div>` : '',
      r.text ? `<div class="text">${esc(r.text)}</div>` : r.unsent ? '<div class="text missing">Message unsent</div>' : '',
      ...r.attachments.map(attachmentHtml),
    ].join('');
    const serviceNote = r.service
      ? isSmsService(r.service)
        ? r.service.toUpperCase()
        : /^imessage$/i.test(r.service)
          ? ''
          : r.service
      : '';
    const flags = [r.edited ? 'Edited' : '', serviceNote].filter(Boolean).join(' · ');
    const reactions = r.reactions.length
      ? `<div class="reactions">${r.reactions.map((x) => esc(`${x.emoji} ${x.fromMe ? 'You' : personLabel(x.sender)}`)).join(' · ')}</div>`
      : '';
    parts.push(
      `<div class="msg ${cls}" id="m${r.id}">${sender}<div class="bubble${bubbleKind}">${body}</div>` +
        `<div class="meta">${esc(stamp.slice(11, 16))}${flags ? ` · ${esc(flags)}` : ''}</div>${reactions}</div>`,
    );
  }
  return page(conv.title, parts.join('\n'));
}

function indexHtml(archive, rows, range) {
  const info = archive.meta;
  const body = rows
    .map((r) => {
      const links = [
        r.formats.includes('html') ? `<a href="${esc(`${r.dir}/conversation.html`)}">view</a>` : '',
        r.formats.includes('csv') ? `<a href="${esc(`${r.dir}/messages.csv`)}">csv</a>` : '',
        r.formats.includes('json') ? `<a href="${esc(`${r.dir}/conversation.json`)}">json</a>` : '',
      ].filter(Boolean);
      return `<tr><td><code>${esc(r.label)}</code><div class="facts">${esc(r.title)}</div></td><td>${r.messages}</td><td>${r.attachments}</td><td>${esc(localStamp(r.first))}</td><td>${esc(localStamp(r.last))}</td><td>${links.join(' · ')}</td></tr>`;
    })
    .join('\n');
  return page(
    'Messages export',
    `<header><h1>Messages export</h1><p class="facts">${rows.length} conversations${range} · from the backup of ${esc(info.deviceName ?? info.id)} · exported ${esc(localStamp(Date.now()))}</p></header>
<table><thead><tr><th>Conversation (folder name)</th><th>Messages</th><th>Attachments</th><th>First</th><th>Last</th><th>Files</th></tr></thead><tbody>
${body}
</tbody></table>`,
  );
}

function writeFile(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
}

export async function exportConversations(archive, conversations, { outDir, formats = FORMATS, from = null, to = null, attachments = true, log = () => {} }) {
  ensurePrivateDir(outDir, { chmodExisting: false });
  const summary = { conversations: 0, messages: 0, attachmentsCopied: 0, attachmentsMissing: 0, attachmentsFailed: 0 };
  const range = from != null || to != null ? ` · range ${from != null ? localStamp(from).slice(0, 10) : '…'} to ${to != null ? localStamp(to).slice(0, 10) : '…'}` : '';
  const rows = [];
  let n = 0;
  for (const conv of conversations) {
    n++;
    const msgs = archive.messagesIn(conv, { from, to });
    if (!msgs.length) continue;
    const dirName = conversationDirName(conv);
    const dir = ensurePrivateDir(path.join(outDir, dirName));
    const files = new Map();
    let copied = 0;
    if (attachments) {
      for (const msg of msgs) {
        for (const att of msg.attachments) {
          if (files.has(att.id)) continue;
          if (!archive.attachmentPresent(att)) {
            summary.attachmentsMissing++;
            continue;
          }
          const name = `${att.id}-${safeFileName(att.name)}`;
          const attDir = ensurePrivateDir(path.join(dir, 'attachments'));
          try {
            if (await archive.copyAttachment(att, path.join(attDir, name))) {
              files.set(att.id, `attachments/${name}`);
              copied++;
            } else summary.attachmentsMissing++;
          } catch {
            summary.attachmentsFailed++;
          }
        }
      }
    }
    summary.attachmentsCopied += copied;
    const records = msgs.map((msg) => record(archive, conv, msg, files));
    if (formats.includes('json')) {
      const doc = {
        format: 'imsg-skimmer/1',
        exportedAt: new Date().toISOString(),
        backup: { id: archive.meta.id, deviceName: archive.meta.deviceName, productVersion: archive.meta.productVersion, lastBackupDate: iso(archive.meta.lastBackupDate?.getTime()) },
        range: { from: iso(from), to: iso(to) },
        conversation: {
          id: conv.id,
          chatIds: conv.chatIds,
          title: conv.title,
          isGroup: conv.isGroup,
          services: conv.services,
          identifier: conv.identifier,
          participants: conv.participants.map((h) => ({ name: h.name, handle: h.handle })),
        },
        messages: records,
      };
      writeFile(path.join(dir, 'conversation.json'), `${JSON.stringify(doc, null, 2)}\n`);
    }
    if (formats.includes('csv')) writeFile(path.join(dir, 'messages.csv'), toCsv(records));
    if (formats.includes('html')) writeFile(path.join(dir, 'conversation.html'), conversationHtml(archive, conv, records, range));
    rows.push({ title: conv.title, label: dirName, dir: dirName, messages: msgs.length, attachments: copied, first: msgs[0].date, last: msgs[msgs.length - 1].date, formats });
    summary.conversations++;
    summary.messages += msgs.length;
    log(`[${n}/${conversations.length}] conversation ${conv.id}: ${msgs.length} messages, ${copied} attachments`);
  }
  if (formats.includes('html')) {
    const indexPath = path.join(outDir, 'index.html');
    writeFile(indexPath, indexHtml(archive, rows, range));
    // Written last and touched so File Explorer (sort by Date modified) lists index.html first.
    const now = new Date();
    fs.utimesSync(indexPath, now, now);
  }
  return summary;
}
