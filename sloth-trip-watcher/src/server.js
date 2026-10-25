import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config, configWarnings, health } from './config.js';
import { checkAll, runCheck } from './check.js';
import { geocode } from './sources.js';
import { mutate, readWatches } from './store.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const MAX_BODY_BYTES = 10_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': CONTENT_TYPES.json, 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

const isRealDate = (s) => DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

async function createWatch(body) {
  const destination = String(body.destination ?? '').trim();
  const origin = String(body.origin ?? '').trim();
  const { from, to } = body;
  const budgetInr = Number(body.budgetInr);
  if (!destination) throw new HttpError(400, 'Where to? Destination is required.');
  if (!origin) throw new HttpError(400, 'Where are you starting from? Origin is required.');
  if (!isRealDate(from) || !isRealDate(to)) throw new HttpError(400, 'Dates must be YYYY-MM-DD.');
  if (from > to) throw new HttpError(400, 'The earliest date must be on or before the latest date.');
  if (!Number.isFinite(budgetInr) || budgetInr <= 0) throw new HttpError(400, 'Budget must be a positive number of rupees.');

  let place;
  try {
    place = await geocode(destination);
  } catch (err) {
    throw new HttpError(502, `Map lookup failed: ${err.message}`);
  }
  if (!place) throw new HttpError(400, `Couldn't find ${destination} on the map.`);

  const watch = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    place,
    origin,
    from,
    to,
    budgetInr,
    weekendsOnly: body.weekendsOnly === true,
    noRain: body.noRain !== false,
    vibe: String(body.vibe ?? '').trim().slice(0, 200),
    lastCheck: null,
    notifiedFor: null,
  };
  await mutate((watches) => watches.push(watch));
  return watch;
}

async function api(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, health());

  if (pathname === '/api/watches') {
    if (req.method === 'GET') {
      const watches = await readWatches();
      return sendJson(res, 200, watches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    if (req.method === 'POST') return sendJson(res, 201, await createWatch(await readBody(req)));
  }

  const match = pathname.match(/^\/api\/watches\/([0-9a-f-]{36})(\/check)?$/);
  if (match) {
    const [, id, check] = match;
    if (!check && req.method === 'DELETE') {
      const removed = await mutate((watches) => {
        const index = watches.findIndex((w) => w.id === id);
        if (index >= 0) watches.splice(index, 1);
        return index >= 0;
      });
      if (!removed) throw new HttpError(404, 'No such watch.');
      res.writeHead(204).end();
      return;
    }
    if (check && req.method === 'POST') {
      let updated;
      try {
        updated = await runCheck(id);
      } catch (err) {
        throw new HttpError(502, `Check failed: ${err.message}`);
      }
      if (!updated) throw new HttpError(404, 'No such watch.');
      return sendJson(res, 200, updated);
    }
  }

  throw new HttpError(404, 'Not found.');
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path.');
  }
  // URL parsing already resolves dot segments; this also rejects encoded tricks like %2e%2e, backslashes and NULs.
  if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) throw new HttpError(400, 'Bad path.');
  const file = new URL(`.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`, PUBLIC_DIR);
  if (!file.href.startsWith(PUBLIC_DIR.href)) throw new HttpError(400, 'Bad path.');

  let content;
  try {
    content = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not found.');
  }
  const ext = file.pathname.split('.').pop();
  res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : content);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else await serveStatic(req, res, pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(`[http] ${req.method} ${pathname}:`, err);
    if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'Something went wrong.' });
  }
});

for (const warning of configWarnings()) console.warn(`[config] ${warning}`);

server.listen(config.port, '0.0.0.0', () => {
  const h = health();
  console.log(`🦥 Sloth Trip Watcher on http://0.0.0.0:${config.port} (gemma: ${h.gemma || 'off'}, places: ${h.serpapi ? 'on' : 'off'}, telegram: ${h.telegram ? 'on' : 'off'}, checks every ${config.checkEveryHours}h)`);
});

// setInterval overflows past 2^31-1 ms (~24.8 days) and would then fire every millisecond.
const intervalMs = Math.min(config.checkEveryHours * 3_600_000, 2 ** 31 - 1);
setInterval(() => {
  checkAll().catch((err) => console.error('[check] run failed:', err));
}, intervalMs);

// Writes are atomic (temp file + rename), so stopping mid-check can't corrupt the data file.
process.on('SIGTERM', () => process.exit(0));
