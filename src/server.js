// Local web UI and JSON API. Listens on 127.0.0.1 only and requires a per-run access token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = '127.0.0.1';
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const ATTACHMENT_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
const INLINE_TYPES =
  /^(image\/(jpeg|png|gif|webp|bmp|heic|heif|avif|tiff)|video\/(mp4|quicktime|x-m4v|webm|3gpp)|audio\/(mpeg|mp4|aac|wav|x-wav|webm|ogg|x-caf|amr|x-m4a))$/;
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function intParam(url, name, { min = -Infinity, max = Infinity } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new HttpError(400, `Invalid ${name}`);
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
}

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>imsg-skimmer</title>
<p style="font:16px system-ui;margin:3em">Open the link printed in the terminal (it contains an access token).</p>`;

export function createServer(archive, { token = crypto.randomBytes(24).toString('base64url'), log = () => {} } = {}) {
  let allowedHosts = new Set();
  let cookieName = 'imsg_skimmer';

  const authorized = (req) => {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName && safeEqual(v.join('='), token)) return true;
    }
    return false;
  };

  const filter = (url) => ({ from: intParam(url, 'from'), to: intParam(url, 'to') });

  async function route(req, res, url) {
    const p = url.pathname;
    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      const body = fs.readFileSync(path.join(WEB_DIR, file));
      return send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': type, 'Content-Security-Policy': CSP });
    }
    if (p === '/api/info') return json(res, 200, archive.info());
    if (p === '/api/conversations') return json(res, 200, { conversations: archive.summaries(filter(url)) });
    let m = p.match(/^\/api\/conversations\/(\d+)\/messages$/);
    if (m) {
      const conv = archive.conversation(m[1]);
      if (!conv) throw new HttpError(404, 'No such conversation');
      const result = archive.page(conv, {
        ...filter(url),
        offset: intParam(url, 'offset', { min: 0 }),
        limit: intParam(url, 'limit', { min: 1, max: 1000 }),
        around: intParam(url, 'around'),
      });
      return json(res, 200, {
        conversationId: conv.id,
        total: result.total,
        offset: result.offset,
        messages: result.messages.map((msg) => archive.serializeMessage(msg, conv)),
      });
    }
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 500);
      const result = archive.search(q, {
        ...filter(url),
        conversationId: intParam(url, 'conversation'),
        limit: intParam(url, 'limit', { min: 1, max: 1000 }) ?? 200,
      });
      return json(res, 200, {
        total: result.total,
        results: result.results.map(({ conv, msg }) => ({
          conversationId: conv.id,
          conversationTitle: conv.title,
          message: archive.serializeMessage(msg, conv),
        })),
      });
    }
    m = p.match(/^\/attachments\/(\d+)$/);
    if (m) return sendAttachment(req, res, m[1]);
    throw new HttpError(404, 'Not found');
  }

  async function sendAttachment(req, res, id) {
    const att = archive.attachmentById(id);
    const file = att ? await archive.attachmentFile(att) : null;
    if (!file) throw new HttpError(404, 'Attachment not in backup');
    const size = fs.statSync(file).size;
    const inline = INLINE_TYPES.test(att.mime ?? '');
    const headers = {
      'Content-Type': inline ? att.mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Content-Security-Policy': ATTACHMENT_CSP,
      'Accept-Ranges': 'bytes',
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && size > 0 && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        return send(res, 416, undefined, { 'Content-Range': `bytes */${size}` });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(size ? end - start + 1 : 0);
    res.writeHead(status, { ...BASE_HEADERS, ...headers });
    if (req.method === 'HEAD' || size === 0) return res.end();
    await new Promise((resolve, reject) => {
      fs.createReadStream(file, { start, end }).on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) throw new HttpError(403, 'Host not allowed');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const url = new URL(req.url ?? '/', `http://${HOST}`);
      if (url.searchParams.has('token')) {
        if (!safeEqual(url.searchParams.get('token'), token)) throw new HttpError(403, 'Invalid access token');
        return send(res, 303, undefined, {
          'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          Location: url.pathname,
        });
      }
      if (!authorized(req)) {
        if (url.pathname === '/') return send(res, 403, LOCKED_PAGE, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        throw new HttpError(403, 'Missing access token');
      }
      await route(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`Request failed: ${err.message}`);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal error' : err.message });
      else res.destroy();
    }
  });

  return {
    server,
    token,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.off('error', reject);
          const actual = server.address().port;
          allowedHosts = new Set([`${HOST}:${actual}`, `localhost:${actual}`]);
          cookieName = `imsg_skimmer_${actual}`;
          resolve({ port: actual, url: `http://${HOST}:${actual}/?token=${token}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
