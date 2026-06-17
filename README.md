# Agent Monitor

Internal dashboard for observing how your engineering team uses AI coding agents — **Claude Code** and **OpenCode** — across all their projects. Captures usage in the background, classifies task complexity, and shows aggregate trends in a web UI.

> **Monitoring only.** This tool observes and reports aggregate usage trends. It must never flag, score, warn, block, or take any punitive action against an individual engineer — in v1 or any future version. Every feature must stay on the "observe and report in aggregate" side of that line.

---

## What it tracks

- Sessions and prompts per coder, per agent, per project
- Token consumption by model (input / output / cache)
- Task complexity classification (simple / moderate / critical)
- Which files each agent modified (`git diff --numstat`)
- Daily and weekly activity timelines
- Shared account limits (daily/weekly session caps for Claude and OpenCode accounts)

---

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐
│  Coder's PC         │        │  Server (Docker)         │
│                     │        │                          │
│  monitor/agent.js   │──POST──▶  backend (Node + SQLite) │
│  (runs every 15min) │        │  port 4319               │
└─────────────────────┘        └────────────┬─────────────┘
                                            │
                                     browser dashboard
```

- **agent.js** — zero-npm-dependency capture script; reads Claude Code JSONL logs and OpenCode SQLite DB, POSTs new interactions to the backend
- **backend** — TypeScript + better-sqlite3, serves the dashboard and ingest API; SQLite database auto-created on first run
- **Dashboard** — main view (KPIs + charts + coder table) + per-coder drilldown

---

## Backend installation

### Option A — Docker (recommended)

```bash
git clone https://github.com/your-org/ai-agent-monitor.git
cd ai-agent-monitor
cp .env.example .env
# Edit .env: set INGEST_TOKEN and ADMIN_TOKEN to strong random secrets
docker compose up -d
```

Dashboard → `http://<server>:4319` (login with `ADMIN_TOKEN`)

### Option B — Run directly with Node.js

Requires Node.js 18+.

```bash
git clone https://github.com/your-org/ai-agent-monitor.git
cd ai-agent-monitor
cp .env.example .env
# Edit .env: set INGEST_TOKEN and ADMIN_TOKEN

cd backend
npm install
npm run build       # compiles TypeScript → out/
node out/server.js
```

The SQLite database is created automatically at `backend/data/monitor.db` on first run. Dashboard is at `http://localhost:4319`.

---

## Agent deployment

The capture agent (`monitor/agent.js`) is a **zero-npm-dependency** Node.js script. Deploy it on each coder's machine.

### 1. Copy the monitor folder

Copy the `monitor/` directory to each coder's machine (any location works).

### 2. Create the .env config

Inside the copied `monitor/` folder, create a `.env` file (use `agent.env.example` as a template):

```
INGEST_URL=http://192.168.x.x:4319
INGEST_TOKEN=<same token as backend INGEST_TOKEN>
CODER_NAME=alice
CLAUDE_ACCOUNT_EMAIL=alice@company.com      # optional
OPENCODE_ACCOUNT_EMAIL=alice@company.com    # optional
```

`CODER_NAME` defaults to the OS login username if not set.

### 3. Test manually

```bash
node monitor/agent.js
```

### 4. Schedule automatic captures

**Linux / macOS** — add to cron (runs every 15 minutes):

```bash
# Run start.sh once to verify it works
bash monitor/start.sh

# Then add to crontab
*/15 * * * * /path/to/monitor/start.sh
```

**Windows** — run `monitor/start.bat` once to verify, then add it to Task Scheduler set to repeat every 15 minutes.

### 5. Optional: terminal hook

Automatically captures after each `claude` or `opencode` session (no cron needed):

```bash
bash monitor/setup-terminal-hook.sh
```

This wraps the `claude`/`opencode` commands in your shell profile to trigger `agent.js` after each session ends.

---

## OpenCode support

`agent.js` reads OpenCode's SQLite database directly using a **built-in pure-JS binary parser** — no `sqlite3` CLI or npm packages required. It parses `.db` and `.db-wal` files and extracts sessions, prompts, model info, and token counts.

Default DB paths searched automatically:

| OS | Path |
|---|---|
| Linux | `~/.local/share/opencode/opencode.db` |
| Windows | `C:\Users\<name>\.local\share\opencode\opencode.db` |
| Snap | `~/snap/opencode/current/.local/share/opencode/opencode.db` |

---

## Dashboard pages

### Main dashboard (`/`)

- KPI cards: active coders, projects, sessions, tokens, complexity signal
- Activity timeline, model distribution, task complexity breakdown, agent split charts
- Coder table with sessions, prompts, token spend, IPs — click any row for drilldown

### Coder detail (`/coder.html?coder=name`)

KPI cards (left to right): **Projects · Sessions · Prompts · Input tokens · Output tokens**

- **Sessions** = distinct conversation sessions per day (not prompt count)
- **Prompts** = total user turns sent to the agent per day
- Token spend table by model (excludes incomplete sessions where the agent never responded)
- Daily activity table: sessions, prompts, Claude/OpenCode split, tokens
- Projects list with file-change breakdown (which agent modified which file)
- Full prompt history with date filter

---

## API endpoints

All endpoints except `/ingest` require a session cookie obtained via `POST /login` with `{ token: ADMIN_TOKEN }`.

| Endpoint | Auth | Description |
|---|---|---|
| `POST /ingest` | Bearer token | Receive interactions from agent.js |
| `POST /login` | — | Authenticate with ADMIN_TOKEN, sets session cookie |
| `GET /api/report` | Session | Coder summary table data |
| `GET /api/tokens` | Session | Token spend by model |
| `GET /api/activity` | Session | Daily activity timeline |
| `GET /api/complexity` | Session | Task class breakdown |
| `GET /api/coder/:name` | Session | Full drilldown for one coder |
| `GET /api/limits` | Session | Shared account limit config + per-coder usage |

---

## Environment variables

### Backend (root `.env`)

| Variable | Required | Description |
|---|---|---|
| `INGEST_TOKEN` | Yes | Secret token agents use to POST data to `/ingest` |
| `ADMIN_TOKEN` | Yes | Dashboard login token |
| `RETENTION_DAYS` | No | Days of data to retain (default: 90) |
| `CLAUDE_DAILY_LIMIT` | No | Claude account daily session cap (0 = hidden) |
| `CLAUDE_WEEKLY_LIMIT` | No | Claude account weekly session cap (0 = hidden) |
| `OPENCODE_DAILY_LIMIT` | No | OpenCode account daily session cap (0 = hidden) |
| `OPENCODE_WEEKLY_LIMIT` | No | OpenCode account weekly session cap (0 = hidden) |

### Capture agent (`monitor/.env`)

| Variable | Required | Description |
|---|---|---|
| `INGEST_URL` | Yes | URL of the backend, e.g. `http://192.168.1.10:4319` |
| `INGEST_TOKEN` | Yes | Must match the backend `INGEST_TOKEN` |
| `CODER_NAME` | No | Display name (defaults to OS login username) |
| `CLAUDE_ACCOUNT_EMAIL` | No | Shown in dashboard Account column |
| `OPENCODE_ACCOUNT_EMAIL` | No | Shown in dashboard Account column |

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

Pull requests are welcome. Keep all new features on the "observe and report in aggregate" side — no individual scoring, flagging, or enforcement, ever. The `monitor/agent.js` capture script must remain zero-npm-dependency.
