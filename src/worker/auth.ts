import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { SignInError } from '../shared/types';
import { pinHash } from './crypto';
import type { AppEnv, Env } from './env';

export const SESSION_COOKIE = 'bm_session';
const SESSION_MS = 30 * 24 * 3600_000;
export const LOCK_MS = 15 * 60_000;
/** Wrong PINs allowed per IP before sign-in locks for 15 minutes. */
export const IP_MAX = 5;
/** Wrong PINs allowed from all IPs together in 15 minutes. Stops guessing spread over many IPs. */
export const GLOBAL_MAX = 50;
export const MAX_PINS = 20;

// ---------- small crypto helpers ----------

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** A uniformly random 6-digit PIN, "000000" to "999999". */
export function randomPin(): string {
  const limit = 4_294_000_000; // largest multiple of 1e6 below 2^32, so every PIN is equally likely
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < limit) return String(n % 1_000_000).padStart(6, '0');
  }
}

export const isPin = (s: unknown): s is string => typeof s === 'string' && /^\d{6}$/.test(s);

/** Keyed hash of a PIN (see crypto.ts). Makes PINs unique and lets sign-in look one up directly. */
export const hashPin = (env: Env, pin: string) => pinHash(env.APP_SECRET, pin);

// ---------- lockout ----------

// Counts an attempt BEFORE the PIN is checked, in one statement, so parallel guesses cannot all
// slip in before the lock. A counter starts fresh once its lock has passed, or 15 minutes after
// its first failure if it never locked. ?1 key, ?2 now, ?3 lock length, ?4 max.
const COUNT_ATTEMPT = `
INSERT INTO auth_failures (key, count, first_at, locked_until) VALUES (?1, 1, ?2, NULL)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN (locked_until IS NOT NULL AND locked_until <= ?2) OR (locked_until IS NULL AND ?2 - first_at > ?3)
               THEN 1 ELSE count + 1 END,
  first_at = CASE WHEN (locked_until IS NOT NULL AND locked_until <= ?2) OR (locked_until IS NULL AND ?2 - first_at > ?3)
                  THEN ?2 ELSE first_at END,
  locked_until = CASE
    WHEN (locked_until IS NOT NULL AND locked_until <= ?2) OR (locked_until IS NULL AND ?2 - first_at > ?3) THEN NULL
    WHEN locked_until IS NOT NULL THEN locked_until
    WHEN count + 1 >= ?4 THEN ?2 + ?3
    ELSE NULL END
RETURNING count, locked_until`;

interface Counter { count: number; locked_until: number | null }

/** Counts one attempt against `key`. The attempt may go ahead only if it is within the limit. */
export async function countAttempt(db: D1Database, key: string, now: number, max: number) {
  // With max = 5, attempt 5 still gets checked; it is the failure of attempt 5 that leaves the lock in place.
  const row = (await db.prepare(COUNT_ATTEMPT).bind(key, now, LOCK_MS, max).first<Counter>())!;
  return { allowed: row.count <= max, count: row.count, lockedUntil: row.locked_until };
}

/** A correct PIN: clear this IP's counter and give the global attempt back. */
async function forgiveAttempt(db: D1Database, ipKey: string) {
  await db.batch([
    db.prepare('DELETE FROM auth_failures WHERE key = ?').bind(ipKey),
    db.prepare(
      "UPDATE auth_failures SET count = MAX(count - 1, 0), locked_until = CASE WHEN count - 1 < ? THEN NULL ELSE locked_until END WHERE key = 'global'",
    ).bind(GLOBAL_MAX),
  ]);
}

export interface PinRow { id: string; label: string }

/** Checks a PIN under the lockout rules. Returns the PIN's row, or the error to show. */
export async function checkPin(env: Env, pin: string, ip: string): Promise<PinRow | SignInError> {
  const now = Date.now();
  const ipKey = `ip:${ip}`;
  // An IP that is already locked out does not count against everyone else's limit.
  const byIp = await countAttempt(env.DB, ipKey, now, IP_MAX);
  if (!byIp.allowed) return { error: 'Too many wrong PINs. Sign in is locked.', attemptsLeft: 0, lockedUntil: byIp.lockedUntil ?? undefined };
  const all = await countAttempt(env.DB, 'global', now, GLOBAL_MAX);
  if (!all.allowed) return { error: 'Too many wrong PINs. Sign in is locked.', attemptsLeft: 0, lockedUntil: all.lockedUntil ?? undefined };
  const row = isPin(pin)
    ? await env.DB.prepare('SELECT id, label FROM pins WHERE pin_hash = ?').bind(await hashPin(env, pin)).first<PinRow>()
    : null;
  if (!row) {
    const attemptsLeft = Math.max(0, Math.min(IP_MAX - byIp.count, GLOBAL_MAX - all.count));
    return attemptsLeft === 0
      ? { error: 'Wrong PIN. Sign in is locked.', attemptsLeft, lockedUntil: Math.max(byIp.lockedUntil ?? 0, all.lockedUntil ?? 0) || undefined }
      : { error: 'Wrong PIN.', attemptsLeft };
  }
  await forgiveAttempt(env.DB, ipKey);
  await env.DB.prepare('UPDATE pins SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
    .bind(now, row.id, now - 60_000).run();
  return row;
}

export const clientIp = (c: Context) => c.req.header('CF-Connecting-IP') ?? 'local';

// ---------- sessions ----------

export async function startSession(c: Context<AppEnv>, pinId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, pin_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), pinId, now, now + SESSION_MS).run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MS / 1000,
  });
  return token;
}

export async function endSession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE) ?? bearer(c);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

function bearer(c: Context): string | null {
  const h = c.req.header('Authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** The PIN behind this request's session token, or null. Extends sessions that are past half their life. */
async function sessionPin(env: Env, token: string): Promise<PinRow | null> {
  const now = Date.now();
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    'SELECT p.id, p.label, s.expires_at FROM sessions s JOIN pins p ON p.id = s.pin_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(hash, now).first<PinRow & { expires_at: number }>();
  if (!row) return null;
  if (row.expires_at - now < SESSION_MS / 2) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_MS, hash).run();
  }
  return { id: row.id, label: row.label };
}

/** Who is calling: a session cookie, a session token, or a PIN sent directly as the bearer token. */
export async function identify(c: Context<AppEnv>): Promise<PinRow | SignInError | null> {
  const token = bearer(c);
  if (token && isPin(token)) return checkPin(c.env, token, clientIp(c));
  const t = token ?? getCookie(c, SESSION_COOKIE);
  return t ? sessionPin(c.env, t) : null;
}

export async function requirePin(c: Context<AppEnv>, next: Next) {
  const who = await identify(c);
  if (!who) throw new HTTPException(401, { message: 'Sign in with your PIN.' });
  if ('error' in who) return c.json(who, who.lockedUntil ? 429 : 401);
  c.set('pinId', who.id);
  c.set('pinLabel', who.label);
  await next();
}
