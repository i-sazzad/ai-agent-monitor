import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { PORT, INGEST_TOKEN } from './config';
import { login, authorize } from './auth';
import {
  ingestMany,
  summaryByCoder,
  tokensByModel,
  activityOverTime,
  taskClassBreakdown,
  coderLimitUsage,
  projectSummary,
  fileChangesByProject,
  coderDailyActivity,
  allCoders,
  interactionsForCoder,
  logAccess,
  pruneRetention,
  Filters,
  IngestRow,
} from './db';
import { LIMITS } from './config';

const PUBLIC = path.join(__dirname, '..', 'public');

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveStatic(res: http.ServerResponse, file: string): void {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) return send(res, 404, { error: 'not found' });
  const ext = path.extname(full);
  const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(full));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseFilters(url: URL): Filters {
  const from   = url.searchParams.get('from')   ?? undefined;
  const to     = url.searchParams.get('to')     ?? undefined;
  const coders = url.searchParams.get('coders') ?? '';
  return { from, to, coders: coders ? coders.split(',').filter(Boolean) : undefined };
}

const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const p = url.pathname;

    // ── ingestion ──────────────────────────────────────────────────────────
    if (req.method === 'POST' && p === '/ingest') {
      const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '');
      if (!m || m[1] !== INGEST_TOKEN) return send(res, 401, { error: 'bad ingest token' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const records: IngestRow[] = Array.isArray(body.records) ? body.records : [];
      return send(res, 200, { received: records.length, stored: ingestMany(records) });
    }

    // ── auth ───────────────────────────────────────────────────────────────
    if (req.method === 'POST' && p === '/login') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sid = login(String(body.token ?? ''));
      if (!sid) return send(res, 401, { error: 'invalid credentials' });
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && p === '/logout') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── dashboard API (all require auth) ───────────────────────────────────
    const isApi = p.startsWith('/api/');
    if (req.method === 'GET' && isApi) {
      const s = authorize(req);
      if (!s) return send(res, 401, { error: 'auth required' });
      const f = parseFilters(url);

      if (p === '/api/report') {
        logAccess(s.actor, 'report');
        return send(res, 200, { coders: summaryByCoder(f) });
      }
      if (p === '/api/tokens') {
        logAccess(s.actor, 'tokens');
        return send(res, 200, { rows: tokensByModel(f) });
      }
      if (p === '/api/activity') {
        return send(res, 200, { rows: activityOverTime(f) });
      }
      if (p === '/api/complexity') {
        return send(res, 200, { rows: taskClassBreakdown(f) });
      }
      if (p === '/api/coders') {
        return send(res, 200, { coders: allCoders() });
      }
      if (p === '/api/limits') {
        return send(res, 200, { limits: LIMITS, usage: coderLimitUsage() });
      }
      if (p === '/api/projects') {
        return send(res, 200, { rows: projectSummary(f) });
      }
      if (p === '/api/file-changes') {
        return send(res, 200, { rows: fileChangesByProject(f) });
      }
      const drill = /^\/api\/coder\/(.+)$/.exec(p);
      if (drill) {
        const coder = decodeURIComponent(drill[1]);
        logAccess(s.actor, `drilldown:${coder}`);
        const coderFilter = { ...f, coders: [coder] };
        const allUsage = coderLimitUsage();
        return send(res, 200, {
          coder,
          interactions: interactionsForCoder(coder, 200, f),
          tokens: tokensByModel(coderFilter),
          daily: coderDailyActivity(coder, f),
          projects: projectSummary(coderFilter),
          fileChanges: fileChangesByProject(coderFilter),
          limits: { config: LIMITS, usage: allUsage.find(u => u.coder === coder) ?? null },
        });
      }
    }

    // ── static files ───────────────────────────────────────────────────────
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && p === '/coder.html') return serveStatic(res, 'coder.html');
    if (req.method === 'GET' && p === '/chart.min.js') return serveStatic(res, 'chart.min.js');

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 400, { error: String(err) });
  }
};

pruneRetention();
setInterval(() => { const n = pruneRetention(); if (n) console.log(`retention: pruned ${n} row(s)`); }, 24 * 3600 * 1000);

const certPath = process.env.TLS_CERT;
const keyPath  = process.env.TLS_KEY;
if (certPath && keyPath) {
  https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, handler)
    .listen(PORT, () => console.log(`monitor backend (HTTPS) on https://localhost:${PORT}`));
} else {
  http.createServer(handler)
    .listen(PORT, () => console.log(`monitor backend (HTTP) on http://localhost:${PORT}  — set TLS_CERT/TLS_KEY for HTTPS`));
}
