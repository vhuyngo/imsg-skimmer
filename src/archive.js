// An opened backup's Messages data: conversations, paging, search, and attachment files.
import { ADDRESS_BOOK, Backup, SMS_DB } from './backup.js';
import { Contacts } from './contacts.js';
import { readMessagesDb } from './messages.js';

export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 1000;
const PREVIEW_CHARS = 120;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalizeForSearch(s) {
  return String(s).normalize('NFD').replace(/\p{M}+/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

export function parseQuery(query) {
  const terms = [];
  for (const m of String(query ?? '').matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = normalizeForSearch((m[1] ?? m[2]).trim());
    if (term) terms.push(term);
  }
  return terms;
}

// First index whose date is >= from (messages without a date sort first).
function lowerBound(msgs, from) {
  let lo = 0;
  let hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((msgs[mid].date ?? -Infinity) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(msgs, to) {
  let lo = 0;
  let hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((msgs[mid].date ?? -Infinity) <= to) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function openArchive(meta, { cache, getPassword, log = () => {} }) {
  const backup = new Backup(meta, cache);
  try {
    await backup.open({ getPassword, log });
    log('Reading the Messages database...');
    const sms = await backup.extractDatabase(...SMS_DB, 'sms.db');
    if (!sms) throw new Error('This backup has no Messages database (sms.db).');
    const ab = await backup.extractDatabase(...ADDRESS_BOOK, 'AddressBook.sqlitedb');
    const contacts = ab ? Contacts.load(ab.path, { hasWal: ab.hasWal }) : Contacts.empty();
    const model = readMessagesDb(sms.path, { contacts, hasWal: sms.hasWal });
    return new Archive(meta, backup, model, contacts);
  } catch (err) {
    backup.close();
    throw err;
  }
}

export class Archive {
  constructor(meta, backup, model, contacts) {
    this.meta = meta;
    this.backup = backup;
    this.handles = model.handles;
    this.attachments = model.attachments;
    this.conversations = model.conversations;
    this.stats = { ...model.stats, contacts: contacts.people };
    this.byId = new Map();
    for (const conv of this.conversations) for (const id of conv.chatIds) this.byId.set(id, conv);
    this.presence = new Map();
    this.normCache = new WeakMap();
  }

  get encrypted() {
    return this.backup.encrypted;
  }

  info() {
    let messages = 0;
    let attachments = 0;
    for (const conv of this.conversations) {
      messages += conv.messages.length;
      for (const msg of conv.messages) attachments += msg.attachments.length;
    }
    return {
      backup: {
        id: this.meta.id,
        deviceName: this.meta.deviceName,
        productVersion: this.meta.productVersion,
        lastBackupDate: this.meta.lastBackupDate ? this.meta.lastBackupDate.getTime() : null,
        encrypted: this.encrypted,
      },
      counts: { conversations: this.conversations.length, messages, attachments },
    };
  }

  conversation(id) {
    return this.byId.get(Number(id)) ?? null;
  }

  range(conv, { from = null, to = null } = {}) {
    const msgs = conv.messages;
    const lo = from == null ? 0 : lowerBound(msgs, from);
    const hi = to == null ? msgs.length : upperBound(msgs, to);
    return { msgs, lo, hi: Math.max(lo, hi) };
  }

  messagesIn(conv, filter) {
    const { msgs, lo, hi } = this.range(conv, filter);
    return msgs.slice(lo, hi);
  }

  summaries(filter = {}) {
    const out = [];
    for (const conv of this.conversations) {
      const { msgs, lo, hi } = this.range(conv, filter);
      if (hi <= lo) continue;
      let attachmentCount = 0;
      for (let i = lo; i < hi; i++) attachmentCount += msgs[i].attachments.length;
      let lastText = null;
      for (let i = hi - 1; i >= Math.max(lo, hi - 50) && lastText === null; i--) {
        const m = msgs[i];
        if (m.text && !m.system) lastText = m.text.length > PREVIEW_CHARS ? `${m.text.slice(0, PREVIEW_CHARS)}…` : m.text;
        else if (m.attachments.length) lastText = `[${m.attachments[0].kind}]`;
      }
      out.push({
        id: conv.id,
        title: conv.title,
        isGroup: conv.isGroup,
        services: conv.services,
        participants: conv.participants.map((h) => ({ name: h.name, handle: h.handle })),
        messageCount: hi - lo,
        attachmentCount,
        firstDate: msgs[lo].date,
        lastDate: msgs[hi - 1].date,
        lastText,
      });
    }
    return out.sort((a, b) => (b.lastDate ?? 0) - (a.lastDate ?? 0) || a.id - b.id);
  }

  page(conv, { from = null, to = null, offset = null, limit = null, around = null } = {}) {
    const { msgs, lo, hi } = this.range(conv, { from, to });
    const total = hi - lo;
    const size = clamp(Number.isInteger(limit) ? limit : DEFAULT_PAGE, 1, MAX_PAGE);
    let start = null;
    if (around != null) {
      const idx = msgs.findIndex((m) => m.id === around);
      if (idx >= lo && idx < hi) start = clamp(idx - lo - Math.floor(size / 2), 0, Math.max(0, total - size));
    }
    if (start === null) start = offset != null ? clamp(offset, 0, total) : Math.max(0, total - size);
    return { total, offset: start, messages: msgs.slice(lo + start, lo + Math.min(total, start + size)) };
  }

  search(query, { conversationId = null, from = null, to = null, limit = 200 } = {}) {
    const terms = parseQuery(query);
    if (!terms.length) return { total: 0, results: [] };
    const convs = conversationId != null ? [this.conversation(conversationId)].filter(Boolean) : this.conversations;
    const hits = [];
    for (const conv of convs) {
      const { msgs, lo, hi } = this.range(conv, { from, to });
      for (let i = lo; i < hi; i++) {
        const msg = msgs[i];
        if (msg.system || (!msg.text && !msg.subject)) continue;
        let norm = this.normCache.get(msg);
        if (norm === undefined) {
          norm = normalizeForSearch(`${msg.subject ?? ''}\n${msg.text ?? ''}`);
          this.normCache.set(msg, norm);
        }
        if (terms.every((t) => norm.includes(t))) hits.push({ conv, msg });
      }
    }
    hits.sort((a, b) => (b.msg.date ?? 0) - (a.msg.date ?? 0) || b.msg.id - a.msg.id);
    return { total: hits.length, results: hits.slice(0, clamp(limit ?? 200, 1, MAX_PAGE)) };
  }

  attachmentById(id) {
    const att = this.attachments.get(Number(id));
    return att && !att.hidden ? att : null;
  }

  // Manifest.db lookup only: a stat per file is slow on /mnt/c, and extraction re-checks the file anyway.
  attachmentPresent(att) {
    if (this.presence.has(att.id)) return this.presence.get(att.id);
    const entry = att.location ? this.backup.lookup(...att.location) : null;
    const present = entry?.flags === 1;
    this.presence.set(att.id, present);
    return present;
  }

  // Cache path of the attachment's bytes (copied or decrypted on first use), or null if not in the backup.
  async attachmentFile(att) {
    if (!this.attachmentPresent(att)) return null;
    const file = await this.backup.extract(...att.location);
    if (!file) this.presence.set(att.id, false);
    return file;
  }

  async copyAttachment(att, dst) {
    if (!this.attachmentPresent(att)) return false;
    const copied = await this.backup.copyOut(...att.location, dst);
    if (!copied) this.presence.set(att.id, false);
    return copied;
  }

  person(handleId) {
    const h = this.handles.get(handleId);
    return h ? { name: h.name, handle: h.handle } : null;
  }

  sender(msg, conv) {
    if (msg.fromMe) return null;
    const p = this.person(msg.handleId);
    if (p || !conv || conv.participants.length !== 1) return p;
    return { name: conv.participants[0].name, handle: conv.participants[0].handle };
  }

  serializeMessage(msg, conv, attachmentUrl = (att) => `/attachments/${att.id}`) {
    return {
      id: msg.id,
      date: msg.date,
      fromMe: msg.fromMe,
      sender: this.sender(msg, conv),
      service: msg.service,
      text: msg.text,
      subject: msg.subject,
      system: msg.system,
      edited: msg.edited,
      unsent: msg.unsent,
      attachments: msg.attachments.map((att) => {
        const present = this.attachmentPresent(att);
        return { id: att.id, name: att.name, mime: att.mime, size: att.size, kind: att.kind, url: present ? attachmentUrl(att) : null, missing: !present };
      }),
      reactions: msg.reactions.map((r) => ({
        kind: r.kind,
        emoji: r.emoji,
        fromMe: r.fromMe,
        sender: r.fromMe ? null : this.person(r.handleId),
        date: r.date,
      })),
    };
  }

  close() {
    this.backup.close();
  }
}
