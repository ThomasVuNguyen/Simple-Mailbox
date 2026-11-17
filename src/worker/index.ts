import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppState, Mailbox, Message, MessageSummary, PinInfo, Thread, ThreadSummary } from '../shared/types';
import {
  MAX_PINS, checkPin, clientIp, endSession, hashPin, identify, randomPin, requirePin, startSession,
} from './auth';
import type { AppEnv, Env } from './env';
import { backfillFromResend, receiveEmail, receiveFromResend } from './inbound';
import {
  connectReceiving, getResendKey, getStoredWebhook, listDomains, requireResend, saveResendKey, sendEmail, sentMessageId,
} from './resend';
import { fillMissingThreads, parseIds, subjectKey } from './threads';
import { verifyWebhook } from './webhook';

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something went wrong. Check the Worker logs.' }, 500);
});

async function json<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: 'Send a JSON body.' });
  }
}

const bad = (message: string) => new HTTPException(400, { message });

// ---------- public: state, first-run setup, sign in ----------

app.get('/api/state', async (c) => {
  const hasPins = await c.env.DB.prepare('SELECT 1 FROM pins LIMIT 1').first();
  // Only look at a session here; a PIN sent as a bearer token is checked by the API routes.
  const who = c.req.header('Authorization') ? null : await identify(c);
  const signedIn = !!who && !('error' in who);
  return c.json({
    setup: !hasPins,
    signedIn,
    hasResendKey: signedIn ? !!(await getResendKey(c.env)) : false,
    receiving: signedIn ? !!(await getStoredWebhook(c.env)) : false,
    pinLabel: signedIn ? (who as { label: string }).label : null,
  } satisfies AppState);
});

/** First run: makes the first PIN and signs in with it. Works only while no PIN exists. */
app.post('/api/setup', async (c) => {
  const pin = randomPin();
  const id = crypto.randomUUID();
  const now = Date.now();
  const res = await c.env.DB.prepare(
    "INSERT INTO pins (id, label, pin_hash, created_at, last_used_at) SELECT ?, 'Me', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM pins)",
  ).bind(id, await hashPin(c.env, pin), now, now).run();
  if (!res.meta.changes) throw new HTTPException(409, { message: 'bmail is already set up. Sign in with your PIN.' });
  await startSession(c, id);
  return c.json({ pin, label: 'Me' });
});

/** Exchanges a PIN for a session. Browsers get a cookie; agents can use the returned token. */
app.post('/api/auth/pin', async (c) => {
  const { pin } = await json<{ pin?: string }>(c);
  const who = await checkPin(c.env, String(pin ?? ''), clientIp(c));
  if ('error' in who) return c.json(who, who.lockedUntil ? 429 : 401);
  const token = await startSession(c, who.id);
  return c.json({ token, label: who.label });
});

/** Resend calls this when an email arrives. Signed with the webhook's secret; anything unsigned is refused. */
app.post('/api/webhooks/resend', async (c) => {
  const body = await c.req.text();
  const hook = await getStoredWebhook(c.env);
  if (!hook) return c.json({ error: 'Receiving is not connected.' }, 409);
  const ok = await verifyWebhook(hook.secret, {
    id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature'),
  }, body);
  if (!ok) return c.json({ error: 'Bad signature.' }, 401);
  const event = JSON.parse(body) as { type?: string; data?: { email_id?: string; to?: string[]; cc?: string[]; received_for?: string[] } };
  if (event.type !== 'email.received' || !event.data?.email_id) return c.json({ ignored: true });
  const stored = await receiveFromResend(c.env, await requireResend(c.env), {
    id: event.data.email_id, to: event.data.to ?? [], cc: event.data.cc, received_for: event.data.received_for,
  });
  return c.json({ stored });
});

app.post('/api/auth/logout', async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

// ---------- everything below needs a PIN ----------

const api = new Hono<AppEnv>();
api.use('*', requirePin);

// Settings

api.get('/settings', async (c) => {
  const key = await getResendKey(c.env);
  const hook = await getStoredWebhook(c.env);
  return c.json({ resendKey: key ? `${key.slice(0, 3)}...${key.slice(-4)}` : null, receiving: hook ? { endpoint: hook.endpoint } : null });
});

/** Connects Resend receiving (finds or creates bmail's webhook) and imports mail that already arrived. */
async function connectAndBackfill(c: Context<AppEnv>) {
  try {
    await connectReceiving(c.env, new URL(c.req.url).origin);
    return { connected: true, imported: await backfillFromResend(c.env, await requireResend(c.env)) };
  } catch (e) {
    return { connected: false, imported: 0, error: e instanceof Error ? e.message : 'Could not connect receiving.' };
  }
}

api.post('/settings/receiving', async (c) => c.json(await connectAndBackfill(c)));

api.put('/settings/resend', async (c) => {
  const { key } = await json<{ key?: string }>(c);
  const k = String(key ?? '').trim();
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(k)) throw bad('A Resend API key starts with "re_".');
  const domains = await listDomains({ key: k, base: c.env.RESEND_API_BASE }); // proves the key works and can list domains
  await saveResendKey(c.env, k);
  return c.json({ ok: true, domains, receiving: await connectAndBackfill(c) });
});

api.get('/domains', async (c) => c.json(await listDomains(await requireResend(c.env))));

// PINs

api.get('/pins', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, label, created_at, last_used_at FROM pins ORDER BY created_at').all<{
    id: string; label: string; created_at: number; last_used_at: number | null;
  }>();
  return c.json(results.map((p): PinInfo => ({
    id: p.id, label: p.label, createdAt: p.created_at, lastUsedAt: p.last_used_at, current: p.id === c.get('pinId'),
  })));
});

/** Makes a new PIN, for an agent or another device. The PIN is returned once and never again. */
api.post('/pins', async (c) => {
  const { label } = await json<{ label?: string }>(c);
  const name = String(label ?? '').trim();
  if (!name || name.length > 40) throw bad('Give the PIN a name of 1 to 40 characters, like "Claude".');
  const count = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM pins').first<{ n: number }>())!.n;
  if (count >= MAX_PINS) throw bad(`You can have up to ${MAX_PINS} PINs. Remove one first.`);
  for (let i = 0; i < 5; i++) {
    const pin = randomPin();
    const id = crypto.randomUUID();
    const res = await c.env.DB.prepare('INSERT OR IGNORE INTO pins (id, label, pin_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, name, await hashPin(c.env, pin), Date.now()).run();
    if (res.meta.changes) return c.json({ pin, id, label: name }, 201);
  }
  throw new HTTPException(500, { message: 'Could not make a unique PIN. Try again.' });
});

api.delete('/pins/:id', async (c) => {
  const id = c.req.param('id');
  if (id === c.get('pinId')) throw bad("You're signed in with this PIN. Sign in with another one to remove it.");
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE pin_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM pins WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// Mailboxes

const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function randomName(): string {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => abc[b % abc.length]).join('');
}

async function findMailbox(c: Context<AppEnv>): Promise<{ id: string; address: string }> {
  const ref = decodeURIComponent(c.req.param('mb') ?? '').toLowerCase();
  const row = await c.env.DB.prepare('SELECT id, address FROM mailboxes WHERE id = ? OR address = ?')
    .bind(ref, ref).first<{ id: string; address: string }>();
  if (!row) throw new HTTPException(404, { message: 'No such mailbox.' });
  return row;
}

api.get('/mailboxes', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT m.id, m.address, m.domain,
      (SELECT COUNT(*) FROM messages WHERE mailbox_id = m.id) AS total,
      (SELECT COUNT(*) FROM messages WHERE mailbox_id = m.id AND direction = 'in' AND read_at IS NULL) AS unread,
      (SELECT MAX(created_at) FROM messages WHERE mailbox_id = m.id) AS last_at
    FROM mailboxes m ORDER BY m.domain, m.address`).all<{
    id: string; address: string; domain: string; total: number; unread: number; last_at: number | null;
  }>();
  return c.json(results.map((m): Mailbox => ({
    id: m.id, address: m.address, domain: m.domain, total: m.total, unread: m.unread, lastAt: m.last_at,
  })));
});

/** Makes a mailbox. Leave out "name" for a random one, handy for one-off signups. */
api.post('/mailboxes', async (c) => {
  const body = await json<{ domain?: string; name?: string }>(c);
  const domain = String(body.domain ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim().toLowerCase() || randomName();
  if (!NAME.test(name)) throw bad('Use letters, numbers, dots, dashes or underscores for the name.');
  const domains = await listDomains(await requireResend(c.env));
  if (!domains.some((d) => d.name === domain)) throw bad(`${domain || 'That domain'} is not in your Resend account.`);
  const address = `${name}@${domain}`;
  const id = crypto.randomUUID();
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO mailboxes (id, address, domain, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind(id, address, domain, Date.now(), c.get('pinLabel')).run();
  if (!res.meta.changes) throw new HTTPException(409, { message: `${address} already exists.` });
  return c.json({ id, address, domain, total: 0, unread: 0, lastAt: null } satisfies Mailbox, 201);
});

api.delete('/mailboxes/:mb', async (c) => {
  const mb = await findMailbox(c);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mb.id),
    c.env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mb.id),
  ]);
  return c.json({ ok: true });
});

// Messages

type Row = {
  id: string; mailbox_id: string; thread_id: string | null; direction: 'in' | 'out'; from_name: string | null; from_address: string;
  to_address: string; subject: string; text: string | null; html: string | null; code: string | null;
  link: string | null; created_at: number; read_at: number | null; read_by: string | null;
};
const SUMMARY_COLS = 'id, mailbox_id, thread_id, direction, from_name, from_address, to_address, subject, substr(text, 1, 400) AS text, code, link, created_at, read_at, read_by';

function summary(r: Row): MessageSummary {
  return {
    id: r.id, mailboxId: r.mailbox_id, threadId: r.thread_id ?? r.id, direction: r.direction, fromName: r.from_name, fromAddress: r.from_address,
    toAddress: r.to_address, subject: r.subject, snippet: (r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    code: r.code, link: r.link, createdAt: r.created_at, readAt: r.read_at, readBy: r.read_by,
  };
}

const full = (r: Row): Message => ({ ...summary(r), text: r.text, html: r.html });

api.get('/mailboxes/:mb/messages', async (c) => {
  const mb = await findMailbox(c);
  await fillMissingThreads(c.env, mb.id);
  const after = Number(c.req.query('after') ?? 0) || 0;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
  const { results } = await c.env.DB.prepare(
    `SELECT ${SUMMARY_COLS} FROM messages WHERE mailbox_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(mb.id, after, limit).all<Row>();
  return c.json(results.map(summary));
});

/** Conversations in a mailbox, newest activity first. */
api.get('/mailboxes/:mb/threads', async (c) => {
  const mb = await findMailbox(c);
  await fillMissingThreads(c.env, mb.id);
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
  const { results } = await c.env.DB.prepare(`
    WITH t AS (
      SELECT thread_id, COUNT(*) AS count,
        SUM(CASE WHEN direction = 'in' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread,
        MAX(created_at) AS last_at
      FROM messages WHERE mailbox_id = ?1 GROUP BY thread_id
    )
    SELECT t.thread_id, t.count, t.unread, t.last_at,
      (SELECT subject FROM messages m WHERE m.thread_id = t.thread_id ORDER BY created_at LIMIT 1) AS subject,
      (SELECT counterpart FROM messages m WHERE m.thread_id = t.thread_id ORDER BY created_at DESC LIMIT 1) AS counterpart,
      (SELECT from_name FROM messages m WHERE m.thread_id = t.thread_id AND direction = 'in' AND from_name IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS counterpart_name,
      (SELECT direction FROM messages m WHERE m.thread_id = t.thread_id ORDER BY created_at DESC LIMIT 1) AS last_direction,
      (SELECT substr(text, 1, 400) FROM messages m WHERE m.thread_id = t.thread_id ORDER BY created_at DESC LIMIT 1) AS last_text,
      (SELECT code FROM messages m WHERE m.thread_id = t.thread_id AND (code IS NOT NULL OR link IS NOT NULL) ORDER BY created_at DESC LIMIT 1) AS code,
      (SELECT link FROM messages m WHERE m.thread_id = t.thread_id AND (code IS NOT NULL OR link IS NOT NULL) ORDER BY created_at DESC LIMIT 1) AS link
    FROM t ORDER BY t.last_at DESC LIMIT ?2`).bind(mb.id, limit).all<{
    thread_id: string; count: number; unread: number; last_at: number; subject: string; counterpart: string;
    counterpart_name: string | null; last_direction: 'in' | 'out'; last_text: string | null; code: string | null; link: string | null;
  }>();
  return c.json(results.map((t): ThreadSummary => ({
    id: t.thread_id, mailboxId: mb.id, subject: t.subject, counterpart: t.counterpart, counterpartName: t.counterpart_name,
    count: t.count, unread: t.unread, lastAt: t.last_at, lastDirection: t.last_direction,
    snippet: (t.last_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160), code: t.code, link: t.link,
  })));
});

/** A whole conversation, oldest first. Opening it marks its emails read, with the name of the PIN that opened them. */
api.get('/threads/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("UPDATE messages SET read_at = ?, read_by = ? WHERE thread_id = ? AND direction = 'in' AND read_at IS NULL")
    .bind(Date.now(), c.get('pinLabel'), id).run();
  const { results } = await c.env.DB.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at').bind(id).all<Row>();
  if (!results.length) throw new HTTPException(404, { message: 'No such conversation.' });
  return c.json({ id, mailboxId: results[0].mailbox_id, subject: results[0].subject, messages: results.map(full) } satisfies Thread);
});

api.delete('/threads/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM messages WHERE thread_id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

/** Waits for the next email to arrive in a mailbox (up to 90 seconds) and returns it, or null. */
api.get('/mailboxes/:mb/wait', async (c) => {
  const mb = await findMailbox(c);
  const after = Number(c.req.query('after') ?? 0) || Date.now();
  const timeout = Math.min(Math.max(Number(c.req.query('timeout') ?? 60) || 60, 1), 90) * 1000;
  const deadline = Date.now() + timeout;
  const stmt = c.env.DB.prepare(
    `SELECT ${SUMMARY_COLS} FROM messages WHERE mailbox_id = ? AND direction = 'in' AND created_at > ? ORDER BY created_at LIMIT 1`,
  ).bind(mb.id, after);
  for (;;) {
    const row = await stmt.first<Row>();
    if (row) return c.json({ message: summary(row) });
    const left = deadline - Date.now();
    if (left <= 0) return c.json({ message: null });
    await new Promise((r) => setTimeout(r, Math.min(2000, left)));
  }
});

/** The whole email. The first open marks it read, with the name of the PIN that opened it. */
api.get('/messages/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('UPDATE messages SET read_at = ?, read_by = ? WHERE id = ? AND read_at IS NULL')
    .bind(Date.now(), c.get('pinLabel'), id).run();
  const r = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<Row>();
  if (!r) throw new HTTPException(404, { message: 'No such message.' });
  return c.json(full(r));
});

api.delete('/messages/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

/** Sends plain-text email from a mailbox. Pass "replyTo" with a message id to reply in that conversation. */
api.post('/mailboxes/:mb/send', async (c) => {
  const mb = await findMailbox(c);
  const body = await json<{ to?: string; subject?: string; text?: string; replyTo?: string }>(c);
  const to = String(body.to ?? '').trim();
  const subject = String(body.subject ?? '').trim();
  const text = String(body.text ?? '');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw bad('Enter one email address to send to.');
  if (!subject) throw bad('Add a subject.');
  const original = body.replyTo
    ? await c.env.DB.prepare('SELECT id, message_id, refs, thread_id FROM messages WHERE id = ? AND mailbox_id = ?')
      .bind(body.replyTo, mb.id).first<{ id: string; message_id: string | null; refs: string | null; thread_id: string | null }>()
    : null;
  if (body.replyTo && !original) throw bad('The email to reply to is not in this mailbox.');
  const references = parseIds(original?.refs);
  const resend = await requireResend(c.env);
  const sent = await sendEmail(resend, { from: mb.address, to, subject, text, inReplyTo: original?.message_id, references });

  const now = Date.now();
  const id = crypto.randomUUID();
  const counterpart = to.toLowerCase();
  const thread = original ? original.thread_id ?? original.id : id;
  const refs = [...new Set([...references, ...(original?.message_id ? [original.message_id] : [])])];
  await c.env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, from_address, to_address, subject, text, created_at, read_at, read_by,
       resend_id, thread_id, in_reply_to, refs, subject_key, counterpart)
     VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, mb.id, mb.address, counterpart, subject, text, now, now, c.get('pinLabel'),
    sent.id, thread, original?.message_id ?? null, refs.length ? refs.join(' ') : null, subjectKey(subject), counterpart,
  ).run();

  // Learn the Message-ID Resend gave this email, so the other person's reply lands in this conversation.
  c.executionCtx.waitUntil((async () => {
    for (const wait of [1500, 4000, 10000]) {
      await new Promise((r) => setTimeout(r, wait));
      const mid = await sentMessageId(resend, sent.id).catch(() => null);
      if (mid) return void (await c.env.DB.prepare('UPDATE messages SET message_id = ? WHERE id = ?').bind(mid, id).run());
    }
  })());
  return c.json({ id, threadId: thread }, 201);
});

app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

export default {
  fetch: app.fetch,

  /** Cloudflare Email Routing hands every email for a routed domain to this handler. */
  async email(message: ForwardableEmailMessage, env: Env) {
    const stored = await receiveEmail(env, { to: message.to, raw: message.raw });
    if (!stored) message.setReject('There is no mailbox at this address.');
  },

  async scheduled(_event: ScheduledController, env: Env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM auth_failures WHERE COALESCE(locked_until, first_at + 900000) < ?').bind(now - 3600_000),
    ]);
  },
} satisfies ExportedHandler<Env>;
