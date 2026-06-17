#!/usr/bin/env node
/**
 * Agent Monitor — Capture Agent
 * Drop this file + a .env into any folder on any coder's PC and run:
 *   node agent.js
 * Zero npm dependencies — uses only built-in Node.js modules.
 * Works on Windows, Linux, macOS.
 */
'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── Load .env from same directory as this script ──────────────────────────────
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1]) {
      const val = m[2].replace(/^["']|["']$/g, '');
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  }
}

const INGEST_URL   = (process.env.INGEST_URL || '').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const CODER        = process.env.CODER_NAME  || (() => {
  try { return os.userInfo().username || 'unknown'; } catch { return 'unknown'; }
})();
const CLAUDE_EMAIL   = process.env.CLAUDE_ACCOUNT_EMAIL   || '';
const OPENCODE_EMAIL = process.env.OPENCODE_ACCOUNT_EMAIL || '';

if (!INGEST_URL || !INGEST_TOKEN) {
  console.error('ERROR: Set INGEST_URL and INGEST_TOKEN in .env (see agent.env.example)');
  process.exit(1);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const emptyTok = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

// ── Identity ──────────────────────────────────────────────────────────────────
function localIps() {
  try {
    for (const ifaces of Object.values(os.networkInterfaces() || {}))
      for (const ni of (ifaces || []))
        if (!ni.internal && ni.family === 'IPv4' && ni.address.startsWith('192.168.'))
          return [ni.address];
  } catch {}
  return [];
}

function claudeAccountId() {
  try {
    const f = path.join(os.homedir(), '.claude', '.credentials.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return CLAUDE_EMAIL || (d.organizationUuid ? String(d.organizationUuid) : null);
  } catch { return CLAUDE_EMAIL || null; }
}

function opencodeAccountId() {
  if (OPENCODE_EMAIL) return OPENCODE_EMAIL;
  const home = os.homedir();
  for (const p of [
    path.join(home, '.config', 'opencode', 'config.json'),
    path.join(home, '.opencode', 'config.json'),
    path.join(home, '.config', 'opencode', 'auth.json'),
  ]) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const id = d.email || d.user || d.username || d.account || d.userId;
      if (id) return String(id);
    } catch {}
  }
  return null;
}

// ── Task classifier ───────────────────────────────────────────────────────────
const CRITICAL_KW = ['concurrency','race condition','deadlock','mutex','thread','security','auth','authentication','authorization','crypto','encryption','vulnerability','exploit','architecture','algorithm','optimize','performance','memory leak','distributed','migration','debug','root cause'];
const SIMPLE_KW   = ['crud','getter','setter','boilerplate','rename','typo','comment','format','lint','config','readme','docstring','stub','scaffold','add a field','simple test'];

function classify(prompt) {
  const t = (prompt || '').toLowerCase();
  const c = CRITICAL_KW.reduce((n, w) => t.includes(w) ? n + 1 : n, 0);
  const s = SIMPLE_KW.reduce((n, w)   => t.includes(w) ? n + 1 : n, 0);
  if (c > s) return { taskClass: 'critical', confidence: Math.min(0.5 + 0.2 * (c - s), 0.95) };
  if (s > c) return { taskClass: 'simple',   confidence: Math.min(0.5 + 0.2 * (s - c), 0.95) };
  return { taskClass: 'moderate', confidence: 0.3 };
}

// ── Secret redaction ──────────────────────────────────────────────────────────
const REDACT = [
  [/sk-ant-[A-Za-z0-9_\-]{10,}/g,                                        'anthropic-key'],
  [/sk-[A-Za-z0-9]{20,}/g,                                               'openai-key'],
  [/AKIA[0-9A-Z]{16}/g,                                                  'aws-access-key'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g,                                        'github-token'],
  [/\bBearer\s+[A-Za-z0-9._\-]{10,}/gi,                                  'bearer'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, 'jwt'],
  [/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,        'secret'],
];
function redact(text) {
  if (!text) return text;
  let out = text;
  for (const [re, name] of REDACT) out = out.replace(re, `[REDACTED:${name}]`);
  return out;
}

// ── Git file-change stats ─────────────────────────────────────────────────────
const _gitCache = new Map();
function gitDiffStat(workspace) {
  if (!workspace || _gitCache.has(workspace)) return _gitCache.get(workspace) || [];
  try {
    const raw = execSync('git diff --numstat HEAD', {
      cwd: workspace, timeout: 5000, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const changes = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (m) changes.push({ file: m[3].trim(), added: +m[1], removed: +m[2] });
    }
    // Also include files from recent commits (since yesterday)
    try {
      const since = new Date(Date.now() - 86400_000).toISOString();
      const log = execSync(`git log --since="${since}" --numstat --format=|`, {
        cwd: workspace, timeout: 5000, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
      for (const line of log.split('\n')) {
        if (line.startsWith('|')) continue;
        const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const existing = changes.find(c => c.file === m[3].trim());
        if (existing) { existing.added += +m[1]; existing.removed += +m[2]; }
        else changes.push({ file: m[3].trim(), added: +m[1], removed: +m[2] });
      }
    } catch {}
    _gitCache.set(workspace, changes);
    return changes;
  } catch {
    _gitCache.set(workspace, []);
    return [];
  }
}

// ── Parse Claude Code session logs ───────────────────────────────────────────
function claudeText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    for (const b of content)
      if (b && b.type === 'text') { const t = String(b.text || '').trim(); if (t) return t; }
  }
  return null;
}

function parseClaude(file) {
  let parsed;
  try {
    parsed = fs.readFileSync(file, 'utf8').split('\n')
      .map(l => { try { return l.trim() ? JSON.parse(l.trim()) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
  if (!parsed.length) return [];

  const sessionId = (parsed.find(o => o.sessionId) || {}).sessionId || null;
  const workspace = (parsed.find(o => o.cwd)       || {}).cwd       || null;
  const gitBranch = (parsed.find(o => o.gitBranch) || {}).gitBranch || null;
  const results   = [];

  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i];
    if (o.type !== 'user' || o.promptSource === 'command') continue;
    if (!o.message || typeof o.message !== 'object') continue;
    const p = claudeText(o.message.content);
    if (!p || p.startsWith('<')) continue;

    const tokens = emptyTok();
    let model = null;
    for (let j = i + 1; j < parsed.length; j++) {
      const nxt = parsed[j];
      if (nxt.type === 'user') break;
      if (nxt.type !== 'assistant' || !nxt.message) continue;
      const nm = nxt.message;
      if (nm.model && nm.model !== '<synthetic>' && !nm.model.startsWith('<') && !model) model = String(nm.model);
      const u = nm.usage || {};
      tokens.input       += u.input_tokens                   || 0;
      tokens.output      += u.output_tokens                  || 0;
      tokens.cacheRead   += u.cache_read_input_tokens        || 0;
      tokens.cacheCreate += u.cache_creation_input_tokens    || 0;
    }
    results.push({ agent: 'claude_code', model, prompt: p, workspace, gitBranch, sessionId, timestamp: o.timestamp || null, tokens, modelConfidence: 'authoritative' });
  }
  return results;
}

function readClaude() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const res = [];
  try {
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      try {
        for (const f of fs.readdirSync(dir))
          if (f.endsWith('.jsonl')) res.push(...parseClaude(path.join(dir, f)));
      } catch {}
    }
  } catch {}
  return res;
}

// ── Pure-JS SQLite3 binary reader (no external tools needed) ─────────────────
function parseSQLite(dbPath, wantTables) {
  const buf = fs.readFileSync(dbPath);
  if (buf.slice(0,15).toString('ascii') !== 'SQLite format 3') throw new Error('not sqlite3');

  const pageSize = buf.readUInt16BE(16) || 65536;
  const reserved = buf[20];
  const usable   = pageSize - reserved;

  // Load WAL: later frames override earlier for the same page number
  const walMap = new Map();
  try {
    const wal = fs.readFileSync(dbPath + '-wal');
    const magic = wal.readUInt32BE(0);
    if (magic === 0x377f0682 || magic === 0x377f0683) {
      let p = 32;
      while (p + 24 + pageSize <= wal.length) {
        const pgNo = wal.readUInt32BE(p);
        if (pgNo > 0) walMap.set(pgNo, wal.slice(p + 24, p + 24 + pageSize));
        p += 24 + pageSize;
      }
    }
  } catch {}

  const getPage = n => walMap.has(n) ? walMap.get(n)
    : buf.slice((n-1)*pageSize, n*pageSize);

  // Variable-length integer (big-endian, MSB = continuation)
  function varint(b, i) {
    let v = 0;
    for (let n = 0; n < 9; n++) {
      const byte = b[i+n];
      if (n < 8) { v = v*128 + (byte & 0x7f); if (!(byte & 0x80)) return [v, n+1]; }
      else { v = v*256 + byte; return [v, 9]; }
    }
    return [v, 9];
  }

  // Decode a record payload into an array of JS values
  function decodeRecord(b) {
    const [hLen, hs] = varint(b, 0);
    let p = hs; const types = [];
    while (p < hLen) { const [t,ts] = varint(b,p); types.push(t); p+=ts; }
    p = hLen; const row = [];
    for (const t of types) {
      if      (t===0)            { row.push(null); }
      else if (t===1)            { row.push(b.readInt8(p)); p+=1; }
      else if (t===2)            { row.push(b.readInt16BE(p)); p+=2; }
      else if (t===3)            { row.push(b.readIntBE(p,3)); p+=3; }
      else if (t===4)            { row.push(b.readInt32BE(p)); p+=4; }
      else if (t===5)            { row.push(b.readIntBE(p,6)); p+=6; }
      else if (t===6)            { row.push(b.readUInt32BE(p)*0x100000000+b.readUInt32BE(p+4)); p+=8; }
      else if (t===7)            { row.push(b.readDoubleBE(p)); p+=8; }
      else if (t===8)            { row.push(0); }
      else if (t===9)            { row.push(1); }
      else if (t>=12 && t%2===0) { const l=(t-12)/2; row.push(b.slice(p,p+l)); p+=l; }
      else if (t>=13 && t%2===1) { const l=(t-13)/2; row.push(b.slice(p,p+l).toString('utf8')); p+=l; }
      else                       { row.push(null); }
    }
    return row;
  }

  // Overflow payload assembly (SQLite spec §2.5)
  const maxLocal = usable - 35;
  const minLocal = Math.floor((usable-12)*32/255) - 23;

  function readPayload(pg, off, pSize) {
    if (pSize <= maxLocal) return pg.slice(off, off + pSize);
    const K = minLocal + (pSize - minLocal) % (usable - 4);
    const local = K <= maxLocal ? K : minLocal;
    const chunks = [pg.slice(off, off + local)];
    let rem = pSize - local;
    let ovp = pg.readUInt32BE(off + local);
    while (rem > 0 && ovp > 0) {
      const op = getPage(ovp); ovp = op.readUInt32BE(0);
      const take = Math.min(rem, usable - 4);
      chunks.push(op.slice(4, 4 + take)); rem -= take;
    }
    return Buffer.concat(chunks);
  }

  // Traverse a table B-tree and collect all [rowId, cols[]] rows
  function scan(pgNo, rows) {
    const pg = getPage(pgNo);
    const h = pgNo === 1 ? 100 : 0;
    const type = pg[h];
    const nCells = pg.readUInt16BE(h+3);
    if (type === 0x0d) {                         // leaf
      for (let i = 0; i < nCells; i++) {
        const ptr = pg.readUInt16BE(h+8+i*2);
        let p = ptr;
        const [pSize,ps] = varint(pg,p); p+=ps;
        const [rowId,rs] = varint(pg,p); p+=rs;
        try { rows.push([rowId, decodeRecord(readPayload(pg, p, pSize))]); } catch {}
      }
    } else if (type === 0x05) {                  // interior
      const right = pg.readUInt32BE(h+8);
      for (let i = 0; i < nCells; i++) scan(pg.readUInt32BE(pg.readUInt16BE(h+12+i*2)), rows);
      scan(right, rows);
    }
  }

  // Parse CREATE TABLE SQL to extract ordered column names
  function parseCols(sql) {
    if (!sql) return [];
    const m = sql.match(/\(([^]*)\)/);
    if (!m) return [];
    const cols = []; let depth=0, start=0;
    const body = m[1];
    for (let i=0;i<body.length;i++) {
      if (body[i]==='(') depth++;
      else if (body[i]===')') depth--;
      else if (body[i]===',' && depth===0) { cols.push(body.slice(start,i).trim()); start=i+1; }
    }
    cols.push(body.slice(start).trim());
    return cols.map(c=>{const nm=c.match(/^["'`]?(\w+)/); return nm?nm[1]:null;}).filter(n=>n&&!['PRIMARY','UNIQUE','FOREIGN','CHECK','CONSTRAINT'].includes(n.toUpperCase()));
  }

  // Read sqlite_master (root = page 1) to find requested tables
  const masterRows = [];
  scan(1, masterRows);
  const tableInfo = {};
  for (const [,cols] of masterRows) {
    if (cols[0]==='table' && wantTables.includes(cols[1])) {
      tableInfo[cols[1]] = { root: cols[3], cols: parseCols(cols[4]) };
    }
  }

  // Scan each table and return rows as objects keyed by column name
  const result = {};
  for (const [name, info] of Object.entries(tableInfo)) {
    const rows = [];
    scan(info.root, rows);
    result[name] = rows.map(([,vals]) => {
      const obj = {};
      info.cols.forEach((c,i) => { obj[c] = vals[i] ?? null; });
      return obj;
    });
  }
  return result;
}

function parseJSON(v) {
  if (!v) return {};
  try {
    return JSON.parse(typeof v === 'string' ? v : v.toString('utf8'));
  } catch { return {}; }
}

function readOpencodeDB(dbPath) {
  let data;
  try {
    data = parseSQLite(dbPath, ['session', 'message', 'part']);
  } catch(e) {
    console.log('[opencode] DB parse error:', e.message);
    return [];
  }

  // Index sessions by id
  const sessions = {};
  for (const s of (data.session || [])) {
    if (s.id) sessions[s.id] = s;
  }

  // Index parts by message_id
  const partsByMsg = {};
  for (const p of (data.part || [])) {
    if (!p.message_id) continue;
    if (!partsByMsg[p.message_id]) partsByMsg[p.message_id] = [];
    partsByMsg[p.message_id].push(p);
  }

  // Track how many user messages per session (to avoid double-counting session tokens)
  const sesMsgCount = {};
  for (const m of (data.message || [])) {
    const d = parseJSON(m.data);
    if (['user','human'].includes(d.role || '')) {
      sesMsgCount[m.session_id] = (sesMsgCount[m.session_id] || 0) + 1;
    }
  }

  const sesFirstSeen = new Set();
  const results = [];

  for (const m of (data.message || [])) {
    // All content lives in the data JSON column
    const mData = parseJSON(m.data);
    const role = mData.role || mData.type || mData.speaker || '';
    if (!['user','human'].includes(role)) continue;

    // Prompt text comes from associated part rows (data.type==='text')
    let prompt = '';
    for (const p of (partsByMsg[m.id] || [])) {
      const pData = parseJSON(p.data);
      if (pData.type === 'text' && pData.text) prompt += pData.text;
    }
    // Fallback: text may be directly in message data
    if (!prompt && mData.text) prompt = mData.text;
    prompt = prompt.trim();
    if (!prompt) continue;

    const sesId = m.session_id || null;
    const ses   = sessions[sesId] || {};

    // Model: session.model is JSON like {"id":"claude-haiku-...","providerID":"anthropic"}
    const sesModel = parseJSON(ses.model);
    const model = sesModel.id || sesModel.modelID || ses.model_id || null;

    // Token counts are stored at session level — assign to first message of each session
    let tokIn = 0, tokOut = 0, tokCR = 0, tokCW = 0;
    if (sesId && !sesFirstSeen.has(sesId)) {
      sesFirstSeen.add(sesId);
      tokIn  = Number(ses.tokens_input        || 0);
      tokOut = Number(ses.tokens_output       || 0);
      tokCR  = Number(ses.tokens_cache_read   || 0);
      tokCW  = Number(ses.tokens_cache_write  || 0);
    }

    let ts = m.time_created || mData.time?.created || null;
    if (typeof ts === 'number') ts = new Date(ts).toISOString();

    results.push({
      agent: 'opencode',
      model,
      prompt,
      workspace: ses.directory || ses.path || ses.cwd || null,
      gitBranch: null,
      sessionId: sesId || sha1(m.id || prompt).slice(0, 16),
      timestamp: ts,
      tokens: { input: tokIn, output: tokOut, cacheRead: tokCR, cacheCreate: tokCW },
      modelConfidence: 'authoritative',
    });
  }

  console.log(`[opencode] DB → ${results.length} user prompt(s)`);
  return results;
}

function debugOpencodeDB(dbPath) {
  console.log('\n=== OpenCode DB debug ===');
  console.log('File:', dbPath);
  let data;
  try { data = parseSQLite(dbPath, ['session', 'message', 'part']); }
  catch(e) { console.log('PARSE ERROR:', e.message, e.stack); return; }

  for (const [tbl, rows] of Object.entries(data)) {
    console.log(`\n-- table: ${tbl} (${rows.length} rows) --`);
    if (!rows.length) { console.log('  (empty)'); continue; }
    const cols = Object.keys(rows[0]);
    console.log('  columns:', cols.join(', '));
    for (const row of rows.slice(0, 3)) {
      const preview = {};
      for (const [k, v] of Object.entries(row)) {
        if (v instanceof Buffer) preview[k] = `<Buffer ${v.length}B>`;
        else if (typeof v === 'string' && v.length > 80) preview[k] = v.slice(0, 80) + '…';
        else preview[k] = v;
      }
      console.log(' ', JSON.stringify(preview));
    }
    if (rows.length > 3) console.log(`  ... and ${rows.length - 3} more rows`);
  }
  console.log('\n=========================\n');
}

function opencodeRoots() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || '';
  const local   = process.env.LOCALAPPDATA || '';
  const roots = [
    process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'opencode') : null,
    path.join(home, '.local', 'share', 'opencode'),
    path.join(home, '.config', 'opencode'),
    path.join(home, '.opencode'),
    appdata ? path.join(appdata, 'opencode') : null,
    appdata ? path.join(appdata, 'OpenCode') : null,
    local   ? path.join(local,   'opencode') : null,
    local   ? path.join(local,   'OpenCode') : null,
  ].filter(Boolean);
  // Also check snap/flatpak VS Code variants (Linux)
  try {
    const snap = path.join(home, 'snap');
    if (fs.existsSync(snap)) {
      for (const pkg of fs.readdirSync(snap)) {
        try {
          for (const ver of fs.readdirSync(path.join(snap, pkg))) {
            roots.push(path.join(snap, pkg, ver, '.local', 'share', 'opencode'));
          }
        } catch {}
      }
    }
  } catch {}
  return roots;
}

function scanOpencodeFiles(dir, out, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scanOpencodeFiles(full, out, depth + 1); continue; }
    if (!e.isFile()) continue;
    try {
      const stat = fs.statSync(full);
      const head = fs.readFileSync(full).slice(0, 120).toString('utf8').replace(/\n/g,' ');
      out.push({ path: full, size: stat.size, head });
    } catch { out.push({ path: full, size: -1, head: '(unreadable)' }); }
  }
}

function readOpencode() {
  const roots = opencodeRoots();
  const res = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // Prefer SQLite database
    const dbPath = path.join(root, 'opencode.db');
    if (fs.existsSync(dbPath)) {
      console.log(`[opencode] found DB: ${dbPath}`);
      res.push(...readOpencodeDB(dbPath));
      return res; // only read first found DB
    }
  }
  if (!res.length) console.log('[opencode] opencode.db not found in any known location');
  return res;
}

function runScan() {
  const roots = opencodeRoots();
  console.log('\n=== OpenCode directory scan ===');
  let any = false;
  for (const root of roots) {
    if (!fs.existsSync(root)) { console.log(`  MISSING  ${root}`); continue; }
    console.log(`  FOUND    ${root}`);
    any = true;
    const files = [];
    scanOpencodeFiles(root, files, 0);
    if (!files.length) { console.log('    (empty)'); continue; }
    for (const f of files) {
      console.log(`    [${String(f.size).padStart(8)} B]  ${f.path}`);
      console.log(`              ${f.head.slice(0, 100)}`);
    }
  }
  if (!any) console.log('\nNo OpenCode directories found on this machine.');
  console.log('\nShare this output so the correct log format can be added to agent.js\n');
}

// ── Ship to backend ───────────────────────────────────────────────────────────
function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body, 'utf8');
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        'content-length': buf.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const ips          = localIps();
  const claudeAcct   = claudeAccountId();
  const opencodeAcct = opencodeAccountId();
  const raws         = [...readClaude(), ...readOpencode()];

  const records = raws.map(raw => {
    const cl   = classify(raw.prompt);
    const seed = `${CODER}|${raw.agent}|${raw.sessionId}|${raw.timestamp}`;
    return {
      interactionId:   sha1(seed).slice(0, 16),
      coder:           CODER,
      ips,
      agentAccountId:  raw.agent === 'claude_code' ? claudeAcct : opencodeAcct,
      agent:           raw.agent,
      model:           raw.model,
      prompt:          redact(raw.prompt),
      taskClass:       cl.taskClass,
      taskConfidence:  cl.confidence,
      workspace:       raw.workspace,
      gitBranch:       raw.gitBranch,
      sessionId:       raw.sessionId,
      timestamp:       raw.timestamp,
      tokens:          raw.tokens,
      modelConfidence: raw.modelConfidence,
      gitChanges:      raw.workspace ? gitDiffStat(raw.workspace) : [],
    };
  });

  console.log(`[${new Date().toISOString()}] coder="${CODER}" prompts=${records.length}`);

  const result = await post(INGEST_URL + '/ingest', INGEST_TOKEN, JSON.stringify({ records }));
  if (result.error) {
    console.error('Ingest error:', result.error);
    process.exit(1);
  }
  console.log(`Sent: received=${result.received}, newly stored=${result.stored}`);
}

if (process.argv.includes('--scan')) { runScan(); }
else if (process.argv.includes('--debug-opencode')) {
  const roots = opencodeRoots();
  let found = false;
  for (const r of roots) {
    const dbPath = path.join(r, 'opencode.db');
    if (fs.existsSync(dbPath)) { debugOpencodeDB(dbPath); found = true; break; }
  }
  if (!found) console.log('opencode.db not found. Run --scan to see all directories checked.');
}
else { main().catch(e => { console.error(String(e)); process.exit(1); }); }
