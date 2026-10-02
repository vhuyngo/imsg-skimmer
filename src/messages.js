// Reads sms.db into conversations, messages, attachments and folded tapbacks.
import path from 'node:path';
import { openCachedDatabase } from './backup.js';
import { attributedBodyText } from './typedstream.js';

const APPLE_EPOCH_MS = 978307200000;
// Seconds since 2001 stay below 1e11 until the year 5170; nanosecond values pass it within two minutes.
const NS_THRESHOLD = 100000000000;
const GROUP_STYLE = 43;

export const REACTIONS = {
  2000: ['love', '❤️'],
  2001: ['like', '👍'],
  2002: ['dislike', '👎'],
  2003: ['laugh', '😂'],
  2004: ['emphasize', '‼️'],
  2005: ['question', '❓'],
  2006: ['emoji', null],
  2007: ['sticker', '🏷️'],
};

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
  caf: 'audio/x-caf', m4a: 'audio/mp4', mp3: 'audio/mpeg', amr: 'audio/amr', wav: 'audio/wav', aac: 'audio/aac',
  pdf: 'application/pdf', vcf: 'text/vcard', txt: 'text/plain',
};

export function appleDateSql(column) {
  return `CASE WHEN ${column} IS NULL OR ${column} = 0 THEN NULL
    WHEN abs(${column}) > ${NS_THRESHOLD} THEN ${column} / 1000000 + ${APPLE_EPOCH_MS}
    ELSE ${column} * 1000 + ${APPLE_EPOCH_MS} END`;
}

function columns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return new Set();
  }
}

const picker = (cols, alias) => (name, as = name) => `${cols.has(name) ? `${alias}.${name}` : 'NULL'} AS ${as}`;
const dateOrNull = (cols, alias, name, as) => `${cols.has(name) ? appleDateSql(`${alias}.${name}`) : 'NULL'} AS ${as}`;
const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));

export function attachmentKind(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

// Maps an sms.db attachment path (~/Library/SMS/Attachments/...) to its backup domain and relative path.
export function attachmentLocation(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  const rel = filename.replace(/^~\//, '').replace(/^\/private\/var\/mobile\//, '').replace(/^\/var\/mobile\//, '');
  if (rel.startsWith('/') || rel.split('/').includes('..')) return null;
  return ['MediaDomain', rel];
}

export function reactionTarget(guid) {
  if (typeof guid !== 'string' || !guid) return null;
  const slash = guid.indexOf('/');
  if (slash >= 0) return guid.slice(slash + 1);
  return guid.replace(/^bp:/, '');
}

function systemText(row, actor, other) {
  const who = other ?? 'someone';
  switch (row.item_type) {
    case 1:
      if (row.group_action_type === 0) return `${actor} added ${who} to the conversation.`;
      if (row.group_action_type === 1) return `${actor} removed ${who} from the conversation.`;
      return `${actor} changed the participants.`;
    case 2:
      return row.group_title ? `${actor} named the conversation “${row.group_title}”.` : `${actor} removed the conversation name.`;
    case 3:
      if (row.group_action_type === 0) return `${actor} left the conversation.`;
      if (row.group_action_type === 1) return `${actor} changed the group photo.`;
      if (row.group_action_type === 2) return `${actor} removed the group photo.`;
      return `${actor} updated the conversation.`;
    case 4:
      return `${actor} changed location sharing.`;
    case 6:
      return `${actor} started a FaceTime call.`;
    default:
      return 'Conversation event.';
  }
}

export function readMessagesDb(file, { contacts, hasWal = false } = {}) {
  const db = openCachedDatabase(file, { hasWal });
  try {
    return load(db, contacts);
  } finally {
    db.close();
  }
}

function load(db, contacts) {
  const mcols = columns(db, 'message');
  if (!mcols.has('ROWID')) throw new Error('sms.db has no message table');
  const stats = {
    handles: 0, handlesWithContactName: 0, chats: 0, conversations: 0, messages: 0, orphanMessages: 0,
    secondDates: 0, nanosecondDates: 0, textFromAttributedBody: 0, emptyMessages: 0, systemMessages: 0,
    tapbacksFolded: 0, tapbacksUnresolved: 0, attachments: 0,
  };

  const hcols = columns(db, 'handle');
  const handles = new Map();
  for (const h of db.prepare(`SELECT ROWID AS id, ${picker(hcols, 'h')('id', 'address')}, ${picker(hcols, 'h')('service')} FROM handle h`).iterate()) {
    const handle = String(h.address ?? '');
    const name = contacts?.lookup(handle) ?? null;
    handles.set(h.id, { id: h.id, handle, service: h.service, name });
    stats.handles++;
    if (name) stats.handlesWithContactName++;
  }

  const acols = columns(db, 'attachment');
  const a = picker(acols, 'a');
  const attachments = new Map();
  if (acols.has('ROWID')) {
    const sql = `SELECT a.ROWID AS id, ${a('guid')}, ${a('filename')}, ${a('transfer_name')}, ${a('mime_type')}, ${a('uti')},
      ${a('total_bytes')}, ${a('is_sticker')}, ${a('hide_attachment')} FROM attachment a`;
    for (const row of db.prepare(sql).iterate()) {
      const name = row.transfer_name || (row.filename ? path.posix.basename(row.filename) : '') || `attachment-${row.id}`;
      const ext = path.posix.extname(name).slice(1).toLowerCase();
      const mime = row.mime_type || MIME_BY_EXT[ext] || null;
      const hidden = row.hide_attachment === 1 || /\.pluginPayloadAttachment$/i.test(name);
      attachments.set(row.id, {
        id: row.id,
        guid: row.guid,
        name,
        mime,
        uti: row.uti,
        size: row.total_bytes > 0 ? row.total_bytes : null,
        sticker: row.is_sticker === 1,
        hidden,
        kind: attachmentKind(mime),
        location: attachmentLocation(row.filename),
      });
      stats.attachments++;
    }
  }

  const m = picker(mcols, 'm');
  const messageSql = `SELECT m.ROWID AS id, ${m('guid')}, ${m('text')}, ${m('attributedBody', 'body')}, ${m('subject')},
      ${m('handle_id')}, ${m('is_from_me')}, ${m('service')}, ${m('item_type')}, ${m('group_action_type')}, ${m('group_title')},
      ${m('other_handle')}, ${m('associated_message_guid')}, ${m('associated_message_type')}, ${m('associated_message_emoji')},
      ${m('balloon_bundle_id')}, ${m('thread_originator_guid')}, ${m('is_audio_message')},
      ${dateOrNull(mcols, 'm', 'date', 'date_ms')}, ${dateOrNull(mcols, 'm', 'date_read', 'read_ms')},
      ${dateOrNull(mcols, 'm', 'date_edited', 'edited_ms')}, ${dateOrNull(mcols, 'm', 'date_retracted', 'retracted_ms')},
      ${mcols.has('date') ? `CASE WHEN m.date IS NULL OR m.date = 0 THEN NULL WHEN abs(m.date) > ${NS_THRESHOLD} THEN 1 ELSE 0 END` : 'NULL'} AS date_ns
    FROM message m`;
  const messages = new Map();
  const byGuid = new Map();
  const tapbacks = [];
  const replyGuids = [];
  for (const row of db.prepare(messageSql).iterate()) {
    if (row.date_ns === 1) stats.nanosecondDates++;
    else if (row.date_ns === 0) stats.secondDates++;
    let text = typeof row.text === 'string' && row.text.length ? row.text : null;
    if (text === null && row.body) {
      text = attributedBodyText(row.body);
      if (text !== null) stats.textFromAttributedBody++;
    }
    if (text !== null) text = text.replace(/\uFFFC/g, '').trim() || null;
    const fromMe = row.is_from_me === 1;
    const handleId = row.handle_id > 0 ? row.handle_id : null;
    const unsent = (row.retracted_ms ?? 0) > 0;
    const msg = {
      id: row.id,
      guid: row.guid,
      date: num(row.date_ms),
      dateRead: num(row.read_ms),
      fromMe,
      handleId,
      text,
      subject: typeof row.subject === 'string' && row.subject.trim() ? row.subject.trim() : null,
      service: row.service ?? null,
      system: false,
      edited: !unsent && (row.edited_ms ?? 0) > 0,
      unsent,
      audio: row.is_audio_message === 1,
      attachments: [],
      reactions: [],
      replyToId: null,
      conversationId: null,
    };
    if (row.item_type) {
      const actor = fromMe ? 'You' : (handles.get(handleId)?.name ?? handles.get(handleId)?.handle ?? 'Someone');
      const otherHandle = handles.get(row.other_handle);
      msg.text = systemText(row, actor, otherHandle ? (otherHandle.name ?? otherHandle.handle) : null);
      msg.system = true;
      stats.systemMessages++;
    }
    const type = row.associated_message_type ?? 0;
    if ((type >= 2000 && type <= 2007) || (type >= 3000 && type <= 3007)) {
      tapbacks.push({ msg, type, target: reactionTarget(row.associated_message_guid), emoji: row.associated_message_emoji });
    }
    if (row.thread_originator_guid) replyGuids.push([msg, row.thread_originator_guid]);
    if (!msg.text && row.balloon_bundle_id && !msg.system) {
      const app = String(row.balloon_bundle_id).split(':').pop().split('.').pop();
      msg.text = `[${app || 'app'} message]`;
    }
    messages.set(msg.id, msg);
    if (msg.guid) byGuid.set(msg.guid, msg);
  }

  if (columns(db, 'message_attachment_join').has('message_id')) {
    for (const j of db.prepare('SELECT message_id, attachment_id FROM message_attachment_join').iterate()) {
      const msg = messages.get(j.message_id);
      const att = attachments.get(j.attachment_id);
      if (msg && att && !att.hidden) msg.attachments.push(att);
    }
  }

  // Fold tapbacks into their targets in date order; a removal (3xxx) cancels the sender's matching one.
  tapbacks.sort((x, y) => (x.msg.date ?? 0) - (y.msg.date ?? 0) || x.msg.id - y.msg.id);
  const folded = new Set();
  for (const t of tapbacks) {
    const target = t.target ? byGuid.get(t.target) : null;
    if (!target || target === t.msg) {
      stats.tapbacksUnresolved++;
      continue;
    }
    folded.add(t.msg.id);
    stats.tapbacksFolded++;
    const sender = t.msg.fromMe ? 'me' : `h${t.msg.handleId}`;
    if (t.type >= 3000) {
      const kind = REACTIONS[t.type - 1000][0];
      target.reactions = target.reactions.filter((r) => !(r.senderKey === sender && r.kind === kind));
      continue;
    }
    const [kind, emoji] = REACTIONS[t.type];
    target.reactions = target.reactions.filter((r) => r.senderKey !== sender);
    target.reactions.push({
      kind,
      emoji: kind === 'emoji' ? t.emoji || '🙂' : emoji,
      fromMe: t.msg.fromMe,
      handleId: t.msg.fromMe ? null : t.msg.handleId,
      date: t.msg.date,
      senderKey: sender,
    });
  }
  for (const [msg, guid] of replyGuids) msg.replyToId = byGuid.get(guid)?.id ?? null;

  const ccols = columns(db, 'chat');
  const c = picker(ccols, 'c');
  const chats = db.prepare(`SELECT c.ROWID AS id, ${c('guid')}, ${c('style')}, ${c('chat_identifier', 'identifier')},
      ${c('service_name', 'service')}, ${c('display_name', 'displayName')} FROM chat c ORDER BY c.ROWID`).all();
  stats.chats = chats.length;
  const chatParticipants = new Map();
  if (columns(db, 'chat_handle_join').has('chat_id')) {
    for (const j of db.prepare('SELECT chat_id, handle_id FROM chat_handle_join').iterate()) {
      if (!chatParticipants.has(j.chat_id)) chatParticipants.set(j.chat_id, new Set());
      chatParticipants.get(j.chat_id).add(j.handle_id);
    }
  }
  const chatMessages = new Map();
  if (columns(db, 'chat_message_join').has('chat_id')) {
    for (const j of db.prepare('SELECT chat_id, message_id FROM chat_message_join').iterate()) {
      if (!chatMessages.has(j.chat_id)) chatMessages.set(j.chat_id, []);
      chatMessages.get(j.chat_id).push(j.message_id);
    }
  }

  // SMS and iMessage threads with the same identifier are one conversation, as in the Messages app.
  const byKey = new Map();
  const conversations = [];
  for (const chat of chats) {
    const participants = chatParticipants.get(chat.id) ?? new Set();
    const isGroup = chat.style === GROUP_STYLE || participants.size > 1;
    const key = chat.identifier ? `${isGroup ? 'group' : 'direct'}:${String(chat.identifier).toLowerCase()}` : `chat:${chat.id}`;
    let conv = byKey.get(key);
    if (!conv) {
      conv = { id: chat.id, chatIds: [], identifier: chat.identifier ?? null, isGroup, services: new Set(), displayName: null, participantIds: new Set(), messages: [] };
      byKey.set(key, conv);
      conversations.push(conv);
    }
    conv.chatIds.push(chat.id);
    if (chat.service) conv.services.add(chat.service);
    if (typeof chat.displayName === 'string' && chat.displayName.trim()) conv.displayName = chat.displayName.trim();
    for (const h of participants) conv.participantIds.add(h);
  }

  const assigned = new Set();
  for (const conv of conversations) {
    const ids = new Set();
    for (const chatId of conv.chatIds) for (const id of chatMessages.get(chatId) ?? []) ids.add(id);
    for (const id of ids) {
      const msg = messages.get(id);
      if (!msg || folded.has(id)) continue;
      if (!msg.text && !msg.attachments.length && !msg.system && !msg.subject && !msg.unsent) {
        stats.emptyMessages++;
        continue;
      }
      if (msg.conversationId === null) msg.conversationId = conv.id;
      conv.messages.push(msg);
      assigned.add(id);
    }
    conv.messages.sort((x, y) => (x.date ?? -Infinity) - (y.date ?? -Infinity) || x.id - y.id);
    if (!conv.identifier && conv.participantIds.size === 1) conv.identifier = handles.get([...conv.participantIds][0])?.handle ?? null;
    const seenAddresses = new Set();
    conv.participants = [...conv.participantIds]
      .map((id) => handles.get(id))
      .filter((h) => h && !seenAddresses.has(h.handle.toLowerCase()) && seenAddresses.add(h.handle.toLowerCase()));
    conv.title = conversationTitle(conv, contacts);
    conv.services = [...conv.services];
    delete conv.participantIds;
  }
  for (const [id] of messages) if (!assigned.has(id) && !folded.has(id)) stats.orphanMessages++;

  const kept = conversations.filter((conv) => conv.messages.length);
  kept.sort((x, y) => (lastDate(y) ?? 0) - (lastDate(x) ?? 0) || x.id - y.id);
  stats.conversations = kept.length;
  stats.messages = kept.reduce((n, conv) => n + conv.messages.length, 0);
  return { handles, attachments, conversations: kept, stats };
}

const lastDate = (conv) => conv.messages[conv.messages.length - 1]?.date ?? null;

function conversationTitle(conv, contacts) {
  if (conv.displayName) return conv.displayName;
  const names = conv.participants.map((h) => h.name ?? h.handle).filter(Boolean);
  if (names.length > 4) return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
  if (names.length) return names.join(', ');
  if (conv.identifier) return contacts?.lookup(conv.identifier) ?? conv.identifier;
  return `Conversation ${conv.id}`;
}
