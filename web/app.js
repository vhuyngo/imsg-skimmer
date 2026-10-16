// imsg-skimmer web UI. Message text, names and handles are untrusted: they are only ever
// rendered through textContent / text nodes, never parsed as HTML.

const PAGE_SIZE = 200;
const SEARCH_LIMIT = 200;
const PIN_MS = 3000;

const $ = (sel) => document.querySelector(sel);

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function button(className, text, onClick) {
  const b = h('button', className, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

const els = {
  notice: $('#auth-notice'),
  banner: $('#banner'),
  bannerText: $('#banner-text'),
  bannerClose: $('#banner-close'),
  summary: $('#backup-summary'),
  searchForm: $('#search-form'),
  searchInput: $('#search-input'),
  searchScope: $('#search-scope'),
  scopeLabel: $('#scope-label'),
  dateFrom: $('#date-from'),
  dateTo: $('#date-to'),
  dateClear: $('#date-clear'),
  convFilter: $('#conv-filter'),
  convStatus: $('#conv-status'),
  convList: $('#conv-list'),
  main: $('#main'),
};

const state = {
  authFailed: false,
  range: { from: null, to: null },
  conversations: [],
  convMeta: new Map(),
  titleHints: new Map(),
  convButtons: new Map(),
  listPromise: Promise.resolve(),
  view: null,
  search: null,
  routeKey: null,
};

// ---------- formatting ----------

const fmt = {
  time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
  date: new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
  dateTime: new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }),
  day: new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
  full: new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' }),
  num: new Intl.NumberFormat(),
};

const isDate = (ms) => typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const fmtNum = (n) => fmt.num.format(num(n, 0));
const plural = (n, word) => `${fmtNum(n)} ${word}${num(n, 0) === 1 ? '' : 's'}`;
const personLabel = (p) => (p && (p.name || p.handle)) || 'Unknown';
const cleanText = (s) => (typeof s === 'string' ? s.replace(/\uFFFC/g, '') : '');
const hasText = (s) => s.trim() !== '';
// Must match the server's normalizeForSearch so highlights land where the server matched.
const fold = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
const toId = (s) => (s != null && /^\d+$/.test(s) ? Number(s) : null);
const isAbort = (err) => err?.name === 'AbortError';
// Keep in sync with src/messageService.js (browser cannot import Node modules here).
const isSmsService = (service) => typeof service === 'string' && /^(sms|mms|rcs)$/i.test(service.trim());

function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
}

const listDateFormat = {
  format(ms) {
    const sameDay = new Date(ms).toDateString() === new Date().toDateString();
    return sameDay ? fmt.time.format(ms) : fmt.date.format(ms);
  },
};

function fmtSize(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function timeEl(ms, formatter, className) {
  const t = h('time', className);
  if (isDate(ms)) {
    t.textContent = formatter.format(ms);
    t.dateTime = new Date(ms).toISOString();
    t.title = fmt.full.format(ms);
  }
  return t;
}

function safeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u, location.origin);
    return url.origin === location.origin ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

// ---------- errors ----------

function showError(message) {
  if (state.authFailed) return;
  els.bannerText.textContent = message;
  els.banner.hidden = false;
}

function reportError(err) {
  if (isAbort(err) || state.authFailed) return;
  showError(err instanceof Error ? err.message : String(err));
}

function showAuthNotice() {
  if (state.authFailed) return;
  state.authFailed = true;
  for (const ctrl of channels.values()) ctrl.abort();
  els.banner.hidden = true;
  els.notice.hidden = false;
  document.body.classList.add('auth-required');
}

// ---------- API ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const channels = new Map();

function freshSignal(name) {
  channels.get(name)?.abort();
  const ctrl = new AbortController();
  channels.set(name, ctrl);
  return ctrl.signal;
}

function cancel(name) {
  channels.get(name)?.abort();
  channels.delete(name);
}

async function api(path, params = {}, signal) {
  if (state.authFailed) throw new ApiError(403, 'Not authorized');
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, 'Network error: could not reach the imsg-skimmer server. Is it still running?');
  }
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbort(err)) throw err;
  }
  if (res.status === 401 || res.status === 403) {
    showAuthNotice();
    throw new ApiError(res.status, 'Not authorized');
  }
  if (!res.ok) {
    const detail = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
    throw new ApiError(res.status, `Request failed: ${detail}`);
  }
  if (!body || typeof body !== 'object') throw new ApiError(res.status, 'Unexpected response from the server.');
  return body;
}

const messagesPath = (id) => `/api/conversations/${encodeURIComponent(id)}/messages`;

// ---------- backup summary ----------

function renderInfo(info) {
  const b = info?.backup ?? {};
  const c = info?.counts ?? {};
  const frag = document.createDocumentFragment();
  frag.append(h('span', 'device', b.deviceName || 'Unknown device'));
  if (b.productVersion) frag.append(h('span', null, `iOS ${b.productVersion}`));
  if (isDate(b.lastBackupDate)) frag.append(h('span', null, `Backed up ${fmt.dateTime.format(b.lastBackupDate)}`));
  if (b.encrypted) frag.append(h('span', 'badge badge-enc', 'encrypted'));
  frag.append(h('span', null, [
    plural(c.conversations, 'conversation'),
    plural(c.messages, 'message'),
    plural(c.attachments, 'attachment'),
  ].join(' · ')));
  els.summary.replaceChildren(frag);
}

// ---------- date range ----------

function parseDateInput(value, endOfDay) {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(0);
  d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

const hasRange = () => state.range.from != null || state.range.to != null;
const rangeKey = () => `${state.range.from ?? ''}|${state.range.to ?? ''}`;

function rangeParams() {
  const p = {};
  if (state.range.from != null) p.from = state.range.from;
  if (state.range.to != null) p.to = state.range.to;
  return p;
}

function readRange() {
  const from = parseDateInput(els.dateFrom.value, false);
  const to = parseDateInput(els.dateTo.value, true);
  if (from != null && to != null && from > to) return null;
  return { from, to };
}

function syncDateLimits() {
  els.dateTo.min = els.dateFrom.value;
  els.dateFrom.max = els.dateTo.value;
  els.dateClear.disabled = !els.dateFrom.value && !els.dateTo.value;
}

function applyRange() {
  syncDateLimits();
  const range = readRange();
  if (!range) {
    showError('The “From” date is after the “To” date.');
    return;
  }
  if (range.from === state.range.from && range.to === state.range.to) return;
  state.range = range;
  loadConversations();
  const v = state.view;
  if (v?.type === 'thread') navigate(`c=${v.id}`, true);
  else if (v?.type === 'search') showSearch();
}

// ---------- conversation list ----------

function loadConversations() {
  const signal = freshSignal('list');
  els.convStatus.textContent = 'Loading conversations…';
  state.listPromise = api('/api/conversations', rangeParams(), signal).then(
    (data) => {
      state.conversations = Array.isArray(data.conversations) ? data.conversations.filter(Boolean) : [];
      for (const c of state.conversations) state.convMeta.set(c.id, c);
      renderConversationList();
      refreshViewHeader();
    },
    (err) => {
      if (isAbort(err)) return;
      els.convStatus.textContent = 'Could not load conversations.';
      reportError(err);
    },
  );
  return state.listPromise;
}

const convSearchText = new WeakMap();

function convMatches(c, q) {
  let text = convSearchText.get(c);
  if (text === undefined) {
    const parts = [c.title];
    for (const p of c.participants ?? []) parts.push(p?.name, p?.handle);
    text = fold(parts.filter(Boolean).join('\n'));
    convSearchText.set(c, text);
  }
  return text.includes(q);
}

function renderConversationList() {
  const q = fold(els.convFilter.value.trim());
  const shown = q ? state.conversations.filter((c) => convMatches(c, q)) : state.conversations;
  const selected = currentConvId();
  const frag = document.createDocumentFragment();
  state.convButtons.clear();
  for (const c of shown) {
    const b = renderConvItem(c);
    if (c.id === selected) markSelected(b, true);
    state.convButtons.set(c.id, b);
    frag.append(b);
  }
  els.convList.replaceChildren(frag);
  const total = state.conversations.length;
  const inRange = hasRange() ? ' in this date range' : '';
  if (!total) els.convStatus.textContent = `No conversations${inRange}.`;
  else if (q) els.convStatus.textContent = `${fmtNum(shown.length)} of ${plural(total, 'conversation')}`;
  else els.convStatus.textContent = plural(total, 'conversation') + inRange;
}

function renderConvItem(c) {
  const b = button('conv');
  b.dataset.id = String(c.id);
  const top = h('span', 'conv-top');
  top.append(h('span', 'conv-title', c.title || 'Untitled conversation'));
  if (c.isGroup) top.append(h('span', 'badge', 'Group'));
  top.append(timeEl(c.lastDate, listDateFormat, 'conv-date'));
  const bottom = h('span', 'conv-bottom');
  const preview = cleanText(c.lastText).slice(0, 300).replace(/\s+/g, ' ').trim();
  const count = h('span', 'conv-count', fmtNum(c.messageCount));
  count.title = plural(c.messageCount, 'message');
  bottom.append(h('span', 'conv-preview', preview || '—'), count);
  b.append(top, bottom);
  return b;
}

function markSelected(b, on) {
  b.classList.toggle('selected', on);
  if (on) b.setAttribute('aria-current', 'true');
  else b.removeAttribute('aria-current');
}

function currentConvId() {
  return state.view?.type === 'thread' ? state.view.id : null;
}

function updateSelection() {
  for (const b of els.convList.querySelectorAll('.conv.selected')) markSelected(b, false);
  const b = state.convButtons.get(currentConvId());
  if (!b) return;
  markSelected(b, true);
  const list = els.convList.getBoundingClientRect();
  const item = b.getBoundingClientRect();
  if (item.top < list.top) els.convList.scrollTop += item.top - list.top;
  else if (item.bottom > list.bottom) els.convList.scrollTop += item.bottom - list.bottom;
}

function convTitle(id) {
  return state.convMeta.get(id)?.title || state.titleHints.get(id) || 'Conversation';
}

// ---------- routing (#c=<id> or #c=<id>&m=<messageId>) ----------

const hashKey = () => location.hash.replace(/^#/, '');
const baseUrl = () => location.pathname + location.search;

function navigate(hash, replace = false) {
  if (hashKey() !== hash) {
    const url = hash ? `#${hash}` : baseUrl();
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
  route(true);
}

function route(force = false) {
  const key = hashKey();
  if (!force && key === state.routeKey) return;
  state.routeKey = key;
  const params = new URLSearchParams(key);
  const id = toId(params.get('c'));
  if (id != null) openConversation(id, toId(params.get('m')));
  else if (state.search) showSearch();
  else showPlaceholder();
}

function afterViewChange() {
  document.body.classList.toggle('view-open', state.view != null);
  updateSelection();
  updateScope();
}

function showPlaceholder() {
  cancel('view');
  cancel('page');
  state.view = null;
  const box = h('div', 'placeholder');
  box.append(
    h('p', 'placeholder-title', 'Select a conversation'),
    h('p', null, 'Or search all messages with the box above.'),
  );
  els.main.replaceChildren(box);
  afterViewChange();
}

function goToList() {
  if (hashKey() !== '') history.pushState(null, '', baseUrl());
  state.routeKey = '';
  showPlaceholder();
}

function viewHeader(titleText, ...lead) {
  const header = h('header', 'view-header');
  const titleWrap = h('div', 'view-title-wrap');
  const title = h('h2', 'view-title', titleText);
  const sub = h('div', 'view-sub');
  titleWrap.append(title, sub);
  header.append(button('btn back-btn', '← Conversations', goToList), ...lead, titleWrap);
  return { header, title, sub };
}

// ---------- search ----------

function scopeConvId() {
  const v = state.view;
  if (v?.type === 'thread') return v.id;
  if (v?.type === 'search') return v.search.conversation;
  return null;
}

function updateScope() {
  const id = scopeConvId();
  els.searchScope.disabled = id == null;
  els.scopeLabel.classList.toggle('disabled', id == null);
  els.scopeLabel.title = id == null
    ? 'Open a conversation to search only within it'
    : `Search only in “${convTitle(id)}”`;
}

function onSearchSubmit(e) {
  e.preventDefault();
  const q = els.searchInput.value.trim();
  if (!q) {
    els.searchInput.focus();
    return;
  }
  const conversation = els.searchScope.checked && !els.searchScope.disabled ? scopeConvId() : null;
  state.search = { q, conversation, data: null, rangeKey: null, scrollTop: 0 };
  if (hashKey() !== '') history.pushState(null, '', baseUrl());
  state.routeKey = '';
  showSearch();
}

async function showSearch() {
  const search = state.search;
  cancel('page');
  const signal = freshSignal('view');
  const close = button('btn', 'Close', () => {
    state.search = null;
    navigate('');
  });
  const { header, sub } = viewHeader('Search results');
  header.append(close);
  const scroller = h('div', 'scroller');
  const list = h('ol', 'results');
  list.addEventListener('click', onResultClick);
  scroller.append(list);
  const root = h('section', 'view search-view');
  root.append(header, scroller);
  const view = { type: 'search', search, els: { sub, scroller, list } };
  state.view = view;
  els.main.replaceChildren(root);
  afterViewChange();

  const rk = rangeKey();
  if (search.data && search.rangeKey === rk) {
    renderSearchResults(view);
    scroller.scrollTop = search.scrollTop;
    return;
  }
  sub.textContent = `Searching for “${search.q}”…`;
  try {
    const params = { q: search.q, limit: SEARCH_LIMIT, ...rangeParams() };
    if (search.conversation != null) params.conversation = search.conversation;
    const data = await api('/api/search', params, signal);
    if (state.view !== view) return;
    const results = Array.isArray(data.results) ? data.results.filter((r) => r?.message) : [];
    search.data = { total: num(data.total, results.length), results };
    search.rangeKey = rk;
    search.scrollTop = 0;
    renderSearchResults(view);
  } catch (err) {
    if (isAbort(err)) return;
    if (state.view === view) sub.textContent = 'Search failed.';
    reportError(err);
  }
}

function parseTerms(q) {
  const terms = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2].replace(/^"+|"+$/g, '')).trim();
    if (t) terms.push(t);
  }
  return terms;
}

function renderSearchResults(view) {
  const { q, conversation, data } = view.search;
  const terms = [...new Set(parseTerms(q).map((t) => fold(t).replace(/\s+/g, ' ')))].filter(Boolean);
  for (const r of data.results) {
    if (r.conversationTitle) state.titleHints.set(r.conversationId, r.conversationTitle);
  }
  let summary = `${plural(data.total, 'result')} for “${q}”`;
  if (conversation != null) summary += ` in “${convTitle(conversation)}”`;
  if (hasRange()) summary += ' within the selected dates';
  if (data.results.length < data.total) summary += ` · showing the newest ${fmtNum(data.results.length)}`;
  view.els.sub.textContent = summary;
  const frag = document.createDocumentFragment();
  for (const r of data.results) frag.append(renderResult(r, terms));
  if (!data.results.length) frag.append(h('li', 'empty', 'No messages match.'));
  view.els.list.replaceChildren(frag);
}

function renderResult(r, terms) {
  const m = r.message;
  const b = button('result');
  b.dataset.conv = String(r.conversationId);
  b.dataset.msg = String(m.id);
  const top = h('span', 'result-top');
  top.append(
    h('span', 'result-conv', r.conversationTitle || convTitle(r.conversationId)),
    timeEl(m.date, fmt.dateTime, 'result-date'),
  );
  const body = h('span', 'result-body');
  body.append(h('span', 'result-sender', `${m.fromMe ? 'You' : personLabel(m.sender)}: `));
  const subject = cleanText(m.subject);
  const text = cleanText(m.text);
  if (hasText(subject)) {
    const s = h('strong');
    s.append(highlight(subject, terms));
    body.append(s, ' ');
  }
  if (hasText(text)) {
    body.append(highlight(text, terms));
  } else if (!hasText(subject)) {
    const names = (m.attachments ?? []).map((a) => a?.name).filter(Boolean).join(', ');
    body.append(h('em', null, names ? `Attachment: ${names}` : '(no text)'));
  }
  b.append(top, body);
  const li = h('li');
  li.append(b);
  return li;
}

function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) {
    frag.append(text);
    return frag;
  }
  // Each folded UTF-16 unit maps back to the source code point so <mark> wraps the original text.
  let folded = '';
  const starts = [];
  const ends = [];
  let i = 0;
  let prevSpace = false;
  for (const ch of text) {
    const space = /\s/.test(ch);
    const f = space ? (prevSpace ? '' : ' ') : ch.charCodeAt(0) < 128 ? ch.toLowerCase() : fold(ch);
    prevSpace = space;
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    folded += f;
    i += ch.length;
  }
  const ranges = [];
  for (const t of terms) {
    for (let p = folded.indexOf(t); p !== -1; p = folded.indexOf(t, p + t.length)) {
      ranges.push([starts[p], ends[p + t.length - 1]]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (let j = 0; j < ranges.length; j++) {
    const s = Math.max(ranges[j][0], pos);
    let e = ranges[j][1];
    while (j + 1 < ranges.length && ranges[j + 1][0] <= e) e = Math.max(e, ranges[++j][1]);
    while (e < text.length && /\p{M}/u.test(text[e])) e++;
    if (e <= s) continue;
    if (s > pos) frag.append(text.slice(pos, s));
    frag.append(h('mark', null, text.slice(s, e)));
    pos = e;
  }
  if (pos < text.length) frag.append(text.slice(pos));
  return frag;
}

function onResultClick(e) {
  const b = e.target.closest('button.result');
  const view = state.view;
  if (!b || view?.type !== 'search') return;
  view.search.scrollTop = view.els.scroller.scrollTop;
  navigate(`c=${b.dataset.conv}&m=${b.dataset.msg}`);
}

// ---------- thread view ----------

async function openConversation(id, aroundId) {
  cancel('page');
  const signal = freshSignal('view');
  const view = {
    type: 'thread',
    id,
    total: 0,
    start: 0,
    end: 0,
    loaded: false,
    loading: false,
    isGroup: false,
    firstDay: null,
    firstSep: null,
    lastDay: null,
    lastSender: null,
    pin: aroundId ?? 'bottom',
    pinUntil: Infinity,
    elById: new Map(),
    els: null,
  };
  state.view = view;
  view.els = renderThreadShell(view);
  els.main.replaceChildren(view.els.root);
  afterViewChange();
  try {
    const params = { ...rangeParams(), limit: PAGE_SIZE };
    if (aroundId != null) params.around = aroundId;
    const [data] = await Promise.all([api(messagesPath(id), params, signal), state.listPromise]);
    if (state.view !== view) return;
    const msgs = Array.isArray(data.messages) ? data.messages.filter(Boolean) : [];
    view.total = num(data.total, msgs.length);
    view.start = num(data.offset, 0);
    view.end = view.start + msgs.length;
    view.loaded = true;
    view.isGroup = state.convMeta.get(id)?.isGroup ?? inferGroup(msgs);
    appendPage(view, msgs);
    updateThreadChrome(view);
    const target = aroundId != null ? view.elById.get(aroundId) : null;
    if (target) {
      view.pinUntil = Date.now() + PIN_MS;
      settle(view);
      flash(target);
    } else {
      if (aroundId != null && msgs.length) showError('That message is not in the current view (check the date range).');
      view.pin = 'bottom';
      view.pinUntil = Infinity;
      settle(view);
    }
  } catch (err) {
    if (isAbort(err)) return;
    if (state.view === view) {
      view.els.status.hidden = false;
      view.els.status.textContent = 'Could not load messages.';
    }
    reportError(err);
  }
}

function renderThreadShell(view) {
  const results = button('btn results-btn', '← Results', () => navigate(''));
  results.hidden = !state.search;
  const { header, title, sub } = viewHeader(convTitle(view.id), results);
  const count = h('div', 'view-count');
  header.append(count);
  const scroller = h('div', 'scroller');
  scroller.tabIndex = 0;
  scroller.setAttribute('aria-label', 'Messages');
  const earlier = button('btn load-btn', 'Load earlier', () => loadPage(view, -1));
  const later = button('btn load-btn', 'Load later', () => loadPage(view, 1));
  earlier.hidden = true;
  later.hidden = true;
  const list = h('div', 'messages');
  const status = h('div', 'status', 'Loading messages…');
  scroller.append(earlier, list, status, later);
  const unpin = () => {
    view.pin = null;
  };
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    scroller.addEventListener(type, unpin, { passive: true });
  }
  // Media load/error events do not bubble; capture them to keep the pinned position as layout grows.
  const resettle = () => requestAnimationFrame(() => settle(view));
  for (const type of ['load', 'error', 'loadedmetadata']) scroller.addEventListener(type, resettle, true);
  const root = h('section', 'view thread-view');
  root.append(header, scroller);
  const parts = { root, title, sub, count, scroller, earlier, later, list, status };
  fillThreadHeader(view, parts);
  return parts;
}

function fillThreadHeader(view, parts = view.els) {
  const people = state.convMeta.get(view.id)?.participants ?? [];
  parts.title.textContent = convTitle(view.id);
  parts.sub.textContent = people.map(personLabel).join(', ');
  parts.sub.title = people.map((p) => (p?.name && p.handle ? `${p.name} (${p.handle})` : personLabel(p))).join('\n');
  parts.count.textContent = view.loaded ? plural(view.total, 'message') + (hasRange() ? ' in range' : '') : '';
}

function refreshViewHeader() {
  if (state.view?.type === 'thread') fillThreadHeader(state.view);
  updateScope();
}

function updateThreadChrome(view) {
  const { earlier, later, status } = view.els;
  const before = view.start;
  const after = view.total - view.end;
  earlier.hidden = before <= 0;
  later.hidden = after <= 0;
  earlier.textContent = `Load earlier (${fmtNum(before)} more)`;
  later.textContent = `Load later (${fmtNum(after)} more)`;
  status.hidden = view.end > view.start;
  status.textContent = hasRange() ? 'No messages in the selected dates.' : 'No messages.';
  fillThreadHeader(view);
}

async function loadPage(view, dir) {
  if (view.loading || state.view !== view) return;
  const offset = dir < 0 ? Math.max(0, view.start - PAGE_SIZE) : view.end;
  const limit = dir < 0 ? view.start - offset : PAGE_SIZE;
  if (limit <= 0) return;
  const btn = dir < 0 ? view.els.earlier : view.els.later;
  view.loading = true;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const data = await api(messagesPath(view.id), { ...rangeParams(), offset, limit }, freshSignal('page'));
    if (state.view !== view) return;
    const msgs = Array.isArray(data.messages) ? data.messages.filter(Boolean) : [];
    const first = num(data.offset, offset);
    view.total = num(data.total, view.total);
    if (dir < 0) {
      prependPage(view, msgs);
      view.start = first;
    } else {
      appendPage(view, msgs);
      view.end = first + msgs.length;
      if (!msgs.length) view.total = view.end;
    }
  } catch (err) {
    reportError(err);
  } finally {
    view.loading = false;
    btn.disabled = false;
    if (state.view === view) updateThreadChrome(view);
  }
}

function appendPage(view, msgs) {
  const page = renderMessages(view, msgs, view.lastDay, view.lastSender);
  if (view.firstDay == null) {
    view.firstDay = page.firstDay;
    view.firstSep = page.firstSep;
  }
  view.lastDay = page.lastDay;
  view.lastSender = page.lastSender;
  view.els.list.append(page.frag);
}

function prependPage(view, msgs) {
  const { list, scroller } = view.els;
  const anchor = list.querySelector(':scope > .msg');
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  const page = renderMessages(view, msgs, null, null);
  if (page.lastDay != null && page.lastDay === view.firstDay) view.firstSep?.remove();
  if (page.firstDay != null) {
    view.firstDay = page.firstDay;
    view.firstSep = page.firstSep;
  }
  view.lastDay ??= page.lastDay;
  list.prepend(page.frag);
  if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - before;
}

function renderMessages(view, msgs, prevDay, prevSender) {
  const frag = document.createDocumentFragment();
  let firstDay = null;
  let firstSep = null;
  let lastDay = prevDay;
  let lastSender = prevSender;
  for (const m of msgs) {
    if (view.elById.has(m.id)) continue;
    if (isDate(m.date)) {
      const key = dayKey(m.date);
      let sep = null;
      if (key !== lastDay) {
        sep = h('div', 'day-sep');
        sep.setAttribute('role', 'separator');
        sep.append(h('span', null, fmt.day.format(m.date)));
        frag.append(sep);
        lastDay = key;
        lastSender = null;
      }
      if (firstDay == null) {
        firstDay = key;
        firstSep = sep;
      }
    }
    const sender = m.system ? null : m.fromMe ? 'me' : `h:${m.sender?.handle ?? ''}`;
    const showSender = view.isGroup && sender != null && sender !== 'me' && sender !== lastSender;
    const el = renderMessage(m, showSender);
    view.elById.set(m.id, el);
    frag.append(el);
    lastSender = sender;
  }
  return { frag, firstDay, firstSep, lastDay, lastSender };
}

function inferGroup(msgs) {
  const handles = new Set();
  for (const m of msgs) {
    if (!m.fromMe && !m.system && m.sender) handles.add(m.sender.handle);
  }
  return handles.size > 1;
}

function renderMessage(m, showSender) {
  const row = h('div', 'msg');
  row.dataset.id = String(m.id);
  if (m.system) {
    row.classList.add('system');
    const text = cleanText(m.text);
    row.append(h('div', 'system-text', hasText(text) ? text : 'System message'), timeEl(m.date, fmt.time, 'system-time'));
    return row;
  }
  row.classList.add(m.fromMe ? 'out' : 'in');
  if (m.fromMe) row.classList.add(isSmsService(m.service) ? 'sms' : 'imessage');
  if (showSender) row.append(h('div', 'sender', personLabel(m.sender)));
  const bubble = h('div', 'bubble');
  const subject = cleanText(m.subject);
  const text = cleanText(m.text);
  const atts = Array.isArray(m.attachments) ? m.attachments.filter(Boolean) : [];
  if (hasText(subject)) bubble.append(h('div', 'subject', subject));
  if (hasText(text)) bubble.append(h('div', 'text', text));
  if (atts.length) {
    if (!bubble.firstChild) bubble.classList.add('media-only');
    const box = h('div', 'attachments');
    for (const a of atts) box.append(renderAttachment(a));
    bubble.append(box);
  }
  if (!bubble.firstChild) bubble.append(h('div', 'text empty-text', '(no content)'));
  row.append(bubble);
  const reactions = renderReactions(m.reactions);
  if (reactions) row.append(reactions);
  const meta = h('div', 'meta');
  meta.append(timeEl(m.date, fmt.time));
  if (m.edited) meta.append(h('span', 'marker', 'Edited'));
  if (m.unsent) meta.append(h('span', 'marker', 'Unsent'));
  row.append(meta);
  return row;
}

// ---------- attachments & reactions ----------

function renderAttachment(a) {
  const name = (typeof a.name === 'string' && a.name) || 'Attachment';
  const url = a.missing ? null : safeUrl(a.url);
  if (!url) {
    const card = h('div', 'file-card missing');
    card.append(h('span', 'file-name', `${name} (not in backup)`));
    return card;
  }
  if (a.kind === 'image') {
    const link = h('a', 'att-link');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const img = h('img', 'att-img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = name;
    img.addEventListener('error', () => link.replaceWith(fileCard(a, name, url)), { once: true });
    img.src = url;
    link.append(img);
    return link;
  }
  if (a.kind === 'video' || a.kind === 'audio') {
    const wrap = h('div', 'att-media');
    const media = h(a.kind, `att-${a.kind}`);
    media.controls = true;
    media.preload = a.kind === 'video' ? 'metadata' : 'none';
    if (a.kind === 'video') media.playsInline = true;
    media.addEventListener('error', () => wrap.replaceWith(fileCard(a, name, url)), { once: true });
    media.src = url;
    const caption = h('a', 'att-caption', [name, fmtSize(a.size)].filter(Boolean).join(' · '));
    caption.href = url;
    caption.download = name;
    wrap.append(media, caption);
    return wrap;
  }
  return fileCard(a, name, url);
}

function fileCard(a, name, url) {
  const card = h('a', 'file-card');
  card.href = url;
  card.download = name;
  card.title = `Download ${name}`;
  const info = h('span', 'file-info');
  info.append(h('span', 'file-name', name));
  const size = fmtSize(a.size);
  if (size) info.append(h('span', 'file-size', size));
  card.append(h('span', 'file-icon', '📄'), info);
  return card;
}

const REACTION_EMOJI = {
  love: '❤️', like: '👍', dislike: '👎', laugh: '😂', emphasize: '‼️', question: '❓', emoji: '🙂', sticker: '🏷️',
};

function renderReactions(reactions) {
  if (!Array.isArray(reactions) || !reactions.length) return null;
  const groups = new Map();
  for (const r of reactions) {
    if (!r) continue;
    const emoji = (typeof r.emoji === 'string' && r.emoji) || REACTION_EMOJI[r.kind] || '•';
    let g = groups.get(emoji);
    if (!g) groups.set(emoji, (g = { count: 0, who: [] }));
    g.count++;
    g.who.push(r.fromMe ? 'You' : personLabel(r.sender));
  }
  if (!groups.size) return null;
  const box = h('div', 'reactions');
  for (const [emoji, g] of groups) {
    const badge = h('span', 'reaction');
    badge.title = g.who.join(', ');
    badge.append(h('span', 'reaction-emoji', emoji), h('span', 'reaction-count', String(g.count)));
    box.append(badge);
  }
  return box;
}

// ---------- scrolling ----------

function settle(view) {
  if (state.view !== view || view.pin == null) return;
  const { scroller } = view.els;
  if (Date.now() > view.pinUntil) {
    view.pin = null;
  } else if (view.pin === 'bottom') {
    scroller.scrollTop = scroller.scrollHeight;
  } else {
    const el = view.elById.get(view.pin);
    if (!el) return;
    const box = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    scroller.scrollTop += r.top - box.top - Math.max(0, (scroller.clientHeight - r.height) / 2);
  }
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2600);
}

// ---------- startup ----------

function bindEvents() {
  els.bannerClose.addEventListener('click', () => {
    els.banner.hidden = true;
  });
  els.searchForm.addEventListener('submit', onSearchSubmit);
  els.dateFrom.addEventListener('change', () => applyRange());
  els.dateTo.addEventListener('change', () => applyRange());
  els.dateClear.addEventListener('click', () => {
    els.dateFrom.value = '';
    els.dateTo.value = '';
    applyRange();
  });
  let filterTimer = 0;
  els.convFilter.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderConversationList, 80);
  });
  els.convList.addEventListener('click', (e) => {
    const b = e.target.closest('button.conv');
    if (b) navigate(`c=${b.dataset.id}`);
  });
  window.addEventListener('popstate', () => route());
  window.addEventListener('hashchange', () => route());
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
  });
}

async function init() {
  bindEvents();
  const range = readRange();
  if (range) {
    state.range = range;
  } else {
    els.dateFrom.value = '';
    els.dateTo.value = '';
  }
  syncDateLimits();
  try {
    renderInfo(await api('/api/info'));
  } catch (err) {
    if (state.authFailed) return;
    reportError(err);
  }
  loadConversations();
  route(true);
}

init();
