import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { RETENTION_DAYS } from './config';

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'monitor.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY,
    coder TEXT NOT NULL,
    ips TEXT,
    agent TEXT,
    model TEXT,
    prompt TEXT,
    task_class TEXT,
    task_confidence REAL,
    workspace TEXT,
    git_branch TEXT,
    session_id TEXT,
    ts TEXT,
    received_at TEXT NOT NULL,
    tokens_in INTEGER, tokens_out INTEGER,
    tokens_cache_read INTEGER, tokens_cache_create INTEGER,
    model_confidence TEXT,
    agent_account_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_coder      ON interactions(coder);
  CREATE INDEX IF NOT EXISTS idx_received   ON interactions(received_at);
  CREATE INDEX IF NOT EXISTS idx_ts         ON interactions(ts);
  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT,
    action TEXT,
    detail TEXT
  );
`);

try { db.exec('ALTER TABLE interactions ADD COLUMN agent_account_id TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE interactions ADD COLUMN git_changes TEXT'); } catch { /* exists */ }

// ── helpers ─────────────────────────────────────────────────────────────────

export interface Filters {
  from?:   string;   // ISO date string (inclusive)
  to?:     string;   // ISO date string (inclusive, treated as end-of-day)
  coders?: string[]; // empty = all
}

function where(f: Filters, alias = ''): { sql: string; params: (string | number)[] } {
  // Filter by actual session timestamp (ts) when available, fall back to received_at.
  const tsCol  = alias ? `COALESCE(${alias}.ts, ${alias}.received_at)` : 'COALESCE(ts, received_at)';
  const cdrCol = alias ? `${alias}.coder` : 'coder';
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (f.from) { parts.push(`${tsCol} >= ?`); params.push(f.from); }
  if (f.to)   { parts.push(`${tsCol} <= ?`); params.push(f.to); }
  if (f.coders?.length) {
    parts.push(`${cdrCol} IN (${f.coders.map(() => '?').join(',')})`);
    params.push(...f.coders);
  }
  return { sql: parts.length ? 'WHERE ' + parts.join(' AND ') : '', params };
}

// ── ingest ───────────────────────────────────────────────────────────────────

export interface GitChange { file: string; added: number; removed: number; }

export interface IngestRow {
  interactionId: string;
  coder: string;
  ips: string[];
  agent: string;
  model: string | null;
  prompt: string | null;
  taskClass: string;
  taskConfidence: number;
  workspace: string | null;
  gitBranch: string | null;
  sessionId: string | null;
  timestamp: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  modelConfidence: string;
  agentAccountId?: string | null;
  gitChanges?: GitChange[] | null;
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO interactions
  (interaction_id, coder, ips, agent, model, prompt, task_class, task_confidence,
   workspace, git_branch, session_id, ts, received_at,
   tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, model_confidence, agent_account_id, git_changes)
  VALUES (@interaction_id,@coder,@ips,@agent,@model,@prompt,@task_class,@task_confidence,
   @workspace,@git_branch,@session_id,@ts,@received_at,
   @tokens_in,@tokens_out,@tokens_cache_read,@tokens_cache_create,@model_confidence,@agent_account_id,@git_changes)
`);

export function ingestMany(rows: IngestRow[]): number {
  const now = new Date().toISOString();
  const tx = db.transaction((items: IngestRow[]) => {
    let n = 0;
    for (const r of items) {
      const info = insert.run({
        interaction_id: r.interactionId,
        coder: r.coder,
        ips: JSON.stringify(r.ips ?? []),
        agent: r.agent,
        model: r.model,
        prompt: r.prompt,
        task_class: r.taskClass,
        task_confidence: r.taskConfidence,
        workspace: r.workspace,
        git_branch: r.gitBranch,
        session_id: r.sessionId,
        ts: r.timestamp,
        received_at: now,
        tokens_in: r.tokens.input,
        tokens_out: r.tokens.output,
        tokens_cache_read: r.tokens.cacheRead,
        tokens_cache_create: r.tokens.cacheCreate,
        model_confidence: r.modelConfidence,
        agent_account_id: r.agentAccountId ?? null,
        git_changes: r.gitChanges?.length ? JSON.stringify(r.gitChanges) : null,
      });
      n += info.changes;
    }
    return n;
  });
  return tx(rows);
}

// ── queries ───────────────────────────────────────────────────────────────────

export interface CoderSummary {
  coder: string;
  sessions: number;
  prompts: number;
  claude: number;
  opencode: number;
  tokens_in: number;
  tokens_out: number;
  simple_on_opus: number;
  ips: string[];
  agent_accounts: string[];
  projects: string[];
}

export function summaryByCoder(f: Filters = {}): CoderSummary[] {
  const { sql, params } = where(f);
  const rows = db.prepare(`
    SELECT coder,
           COUNT(DISTINCT COALESCE(session_id, interaction_id)) sessions,
           COUNT(*) prompts,
           SUM(agent='claude_code') claude,
           SUM(agent='opencode') opencode,
           SUM(COALESCE(tokens_in,0)) tokens_in,
           SUM(COALESCE(tokens_out,0)) tokens_out,
           SUM(task_class='simple' AND model LIKE 'claude-opus%') simple_on_opus
    FROM interactions ${sql} GROUP BY coder ORDER BY coder
  `).all(...params) as any[];

  return rows.map((r) => {
    const ipRows = db.prepare(
      'SELECT DISTINCT ips FROM interactions WHERE coder=?'
    ).all(r.coder) as any[];
    const ips = new Set<string>();
    for (const ir of ipRows) {
      try { for (const ip of JSON.parse(ir.ips) as string[]) if (ip.startsWith('192.168.')) ips.add(ip); } catch { /* skip */ }
    }
    const acctRows = db.prepare(
      'SELECT DISTINCT agent_account_id FROM interactions WHERE coder=? AND agent_account_id IS NOT NULL'
    ).all(r.coder) as any[];
    const { sql: pSql, params: pParams } = where({ ...f, coders: [r.coder] });
    const projRows = db.prepare(
      `SELECT DISTINCT workspace FROM interactions ${pSql}${pSql ? ' AND' : ' WHERE'} workspace IS NOT NULL ORDER BY workspace`
    ).all(...pParams) as any[];
    return { ...r, ips: [...ips], agent_accounts: acctRows.map((a: any) => a.agent_account_id), projects: projRows.map((p: any) => p.workspace as string) } as CoderSummary;
  });
}

export interface TokensByModel {
  coder: string;
  agent: string;
  model: string;
  sessions: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_create: number;
}

export function tokensByModel(f: Filters = {}): TokensByModel[] {
  const { sql, params } = where(f);
  return db.prepare(`
    SELECT coder,
           COALESCE(agent, 'unknown') agent,
           COALESCE(model, 'unknown') model,
           COUNT(*) sessions,
           SUM(COALESCE(tokens_in,0)) tokens_in,
           SUM(COALESCE(tokens_out,0)) tokens_out,
           SUM(COALESCE(tokens_cache_read,0)) tokens_cache_read,
           SUM(COALESCE(tokens_cache_create,0)) tokens_cache_create
    FROM interactions ${sql}
    GROUP BY coder, agent, model
    HAVING model IS NOT NULL OR (tokens_in > 0 OR tokens_out > 0)
    ORDER BY coder, tokens_in DESC
  `).all(...params) as TokensByModel[];
}

export interface DailyActivity {
  date: string;
  sessions: number;
  active_coders: number;
  tokens_in: number;
  tokens_out: number;
}

export function activityOverTime(f: Filters = {}): DailyActivity[] {
  const { sql, params } = where(f);
  return db.prepare(`
    SELECT date(COALESCE(ts, received_at)) date,
           COUNT(*) sessions,
           COUNT(DISTINCT coder) active_coders,
           SUM(COALESCE(tokens_in,0)) tokens_in,
           SUM(COALESCE(tokens_out,0)) tokens_out
    FROM interactions ${sql}
    GROUP BY date(COALESCE(ts, received_at))
    ORDER BY date(COALESCE(ts, received_at))
  `).all(...params) as DailyActivity[];
}

export interface TaskClassBreakdown {
  task_class: string;
  sessions: number;
}

/** ISO date string for the most recent Monday (UTC). */
function mondayISO(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

export interface CoderLimitUsage {
  coder: string;
  claude_today:    number;
  claude_week:     number;
  opencode_today:  number;
  opencode_week:   number;
}

/**
 * Per-coder session counts for today and this week (Mon–Sun UTC).
 * Used to show % of account-level daily/weekly limits.
 */
export function coderLimitUsage(): CoderLimitUsage[] {
  const today  = new Date().toISOString().slice(0, 10);
  const monday = mondayISO();
  return db.prepare(`
    SELECT coder,
      SUM(CASE WHEN date(COALESCE(ts,received_at))  =  ? AND agent='claude_code' THEN 1 ELSE 0 END) claude_today,
      SUM(CASE WHEN date(COALESCE(ts,received_at)) >= ? AND agent='claude_code' THEN 1 ELSE 0 END) claude_week,
      SUM(CASE WHEN date(COALESCE(ts,received_at))  =  ? AND agent='opencode'   THEN 1 ELSE 0 END) opencode_today,
      SUM(CASE WHEN date(COALESCE(ts,received_at)) >= ? AND agent='opencode'    THEN 1 ELSE 0 END) opencode_week
    FROM interactions
    GROUP BY coder ORDER BY coder
  `).all(today, monday, today, monday) as CoderLimitUsage[];
}

export function taskClassBreakdown(f: Filters = {}): TaskClassBreakdown[] {
  const { sql, params } = where(f);
  return db.prepare(`
    SELECT COALESCE(task_class,'unknown') task_class, COUNT(*) sessions
    FROM interactions ${sql}
    GROUP BY task_class
  `).all(...params) as TaskClassBreakdown[];
}

export interface ProjectSummary {
  workspace: string;
  sessions: number;
  claude: number;
  opencode: number;
  coders: number;
  tokens_in: number;
  tokens_out: number;
}

export function projectSummary(f: Filters = {}): ProjectSummary[] {
  const { sql, params } = where(f);
  return db.prepare(`
    SELECT COALESCE(workspace,'(unknown)') workspace,
           COUNT(*) sessions,
           SUM(CASE WHEN agent='claude_code' THEN 1 ELSE 0 END) claude,
           SUM(CASE WHEN agent='opencode'    THEN 1 ELSE 0 END) opencode,
           COUNT(DISTINCT coder) coders,
           SUM(COALESCE(tokens_in,0))  tokens_in,
           SUM(COALESCE(tokens_out,0)) tokens_out
    FROM interactions ${sql}
    GROUP BY workspace ORDER BY sessions DESC
  `).all(...params) as ProjectSummary[];
}

export interface FileChangeSummary {
  workspace: string;
  file: string;
  total_added: number;
  total_removed: number;
  claude_added: number;
  claude_removed: number;
  opencode_added: number;
  opencode_removed: number;
  occurrences: number;
}

export function fileChangesByProject(f: Filters = {}): FileChangeSummary[] {
  const { sql, params } = where(f);
  const rows = db.prepare(`
    SELECT workspace, agent, git_changes FROM interactions
    ${sql ? sql + ' AND git_changes IS NOT NULL' : 'WHERE git_changes IS NOT NULL'}
  `).all(...params) as { workspace: string; agent: string; git_changes: string }[];

  interface FileStat { added: number; removed: number; claude_added: number; claude_removed: number; opencode_added: number; opencode_removed: number; count: number; }
  const map = new Map<string, Map<string, FileStat>>();
  for (const row of rows) {
    let changes: { file: string; added: number; removed: number }[];
    try { changes = JSON.parse(row.git_changes); } catch { continue; }
    const ws = row.workspace || '(unknown)';
    const isClaude = row.agent === 'claude_code';
    const isOpencode = row.agent === 'opencode';
    if (!map.has(ws)) map.set(ws, new Map());
    const wmap = map.get(ws)!;
    for (const c of changes) {
      const cur = wmap.get(c.file) ?? { added: 0, removed: 0, claude_added: 0, claude_removed: 0, opencode_added: 0, opencode_removed: 0, count: 0 };
      cur.added   += c.added;
      cur.removed += c.removed;
      if (isClaude)   { cur.claude_added   += c.added; cur.claude_removed   += c.removed; }
      if (isOpencode) { cur.opencode_added  += c.added; cur.opencode_removed += c.removed; }
      cur.count += 1;
      wmap.set(c.file, cur);
    }
  }

  const result: FileChangeSummary[] = [];
  for (const [workspace, files] of map) {
    for (const [file, s] of files) {
      result.push({ workspace, file, total_added: s.added, total_removed: s.removed, claude_added: s.claude_added, claude_removed: s.claude_removed, opencode_added: s.opencode_added, opencode_removed: s.opencode_removed, occurrences: s.count });
    }
  }
  return result.sort((a, b) => (b.total_added + b.total_removed) - (a.total_added + a.total_removed));
}

export interface CoderDailyActivity {
  date: string;
  sessions: number;
  prompts: number;
  claude: number;
  opencode: number;
  tokens_in: number;
  tokens_out: number;
}

export function coderDailyActivity(coder: string, f: Filters = {}): CoderDailyActivity[] {
  const { sql, params } = where({ ...f, coders: [coder] });
  return db.prepare(`
    SELECT date(COALESCE(ts, received_at)) date,
           COUNT(DISTINCT COALESCE(session_id, interaction_id)) sessions,
           COUNT(*) prompts,
           SUM(CASE WHEN agent='claude_code' THEN 1 ELSE 0 END) claude,
           SUM(CASE WHEN agent='opencode'    THEN 1 ELSE 0 END) opencode,
           SUM(COALESCE(tokens_in,0))  tokens_in,
           SUM(COALESCE(tokens_out,0)) tokens_out
    FROM interactions ${sql}
    GROUP BY date(COALESCE(ts, received_at))
    ORDER BY date(COALESCE(ts, received_at)) DESC
  `).all(...params) as CoderDailyActivity[];
}

/** All distinct coders (for the filter dropdown). */
export function allCoders(): string[] {
  return (db.prepare('SELECT DISTINCT coder FROM interactions ORDER BY coder').all() as any[])
    .map((r) => r.coder as string);
}

/** Per-coder prompt drill-down (§7 role-gated; caller must be admin). */
export function interactionsForCoder(coder: string, limit = 100, f: Filters = {}): any[] {
  const { sql, params } = where({ ...f, coders: [coder] });
  return db.prepare(`
    SELECT interaction_id, session_id, ts, agent, model, agent_account_id, task_class, prompt, git_branch,
           COALESCE(tokens_in,0) tokens_in, COALESCE(tokens_out,0) tokens_out
    FROM interactions ${sql} ORDER BY COALESCE(ts, received_at) DESC LIMIT ?
  `).all(...params, limit);
}

export function logAccess(actor: string, action: string, detail = ''): void {
  db.prepare('INSERT INTO access_log (at, actor, action, detail) VALUES (?,?,?,?)').run(
    new Date().toISOString(), actor, action, detail
  );
}

export function pruneRetention(): number {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  return db.prepare('DELETE FROM interactions WHERE received_at < ?').run(cutoff).changes;
}
