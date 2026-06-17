import { randomBytes } from 'crypto';
import * as http from 'http';
import { ADMIN_TOKEN } from './config';

/**
 * Auth for the dashboard. Two paths:
 *  - API clients (the capture agents) use the bearer INGEST_TOKEN (see server).
 *  - Humans log in once (POST /login with the admin token) and get an HttpOnly
 *    session cookie; subsequent dashboard calls are authorized by that cookie.
 *
 * SSO plug-in point: in production, replace `login()` with an OIDC flow — verify
 * the IdP id_token, map the user's group to the "admin/viewer" role, then create
 * the same session. The rest of the server is unchanged. See README.
 */

interface Session {
  id: string;
  actor: string; // who this session belongs to (for §7 access logging)
  role: 'admin';
  expires: number;
}

const SESSIONS = new Map<string, Session>();
const TTL_MS = 8 * 3600 * 1000;

/** Returns a session id if the supplied credential is valid, else null. */
export function login(token: string, actor = 'admin'): string | null {
  if (token !== ADMIN_TOKEN) {
    return null;
  }
  const id = randomBytes(24).toString('hex');
  SESSIONS.set(id, { id, actor, role: 'admin', expires: Date.now() + TTL_MS });
  return id;
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return out;
}

/** Authorize a dashboard request via session cookie OR bearer admin token. */
export function authorize(req: http.IncomingMessage): Session | null {
  const sid = parseCookies(req).sid;
  if (sid) {
    const s = SESSIONS.get(sid);
    if (s && s.expires > Date.now()) {
      return s;
    }
    if (s) {
      SESSIONS.delete(sid);
    }
  }
  // Fallback: direct bearer admin token (for curl / scripts).
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '');
  if (m && m[1] === ADMIN_TOKEN) {
    return { id: 'bearer', actor: 'admin(bearer)', role: 'admin', expires: Date.now() + TTL_MS };
  }
  return null;
}
