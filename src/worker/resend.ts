import { HTTPException } from 'hono/http-exception';
import type { Domain } from '../shared/types';
import { seal, unseal } from './crypto';
import type { Env } from './env';

const KEY_SETTING = 'resend_api_key';

/** The Resend key, decrypted. Null when none is saved, or when it can no longer be decrypted. */
export async function getResendKey(env: Env): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY_SETTING).first<{ value: string }>();
  return row ? unseal(env.APP_SECRET, KEY_SETTING, row.value) : null;
}

/** Stores the Resend key encrypted with APP_SECRET. */
export async function saveResendKey(env: Env, key: string) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(KEY_SETTING, await seal(env.APP_SECRET, KEY_SETTING, key)).run();
}

export async function requireResend(env: Env): Promise<ResendTarget> {
  const key = await getResendKey(env);
  if (!key) throw new HTTPException(409, { message: 'Add a Resend API key in Settings first.' });
  return { key, base: env.RESEND_API_BASE };
}

/** Where Resend lives. Set RESEND_API_BASE only to test against a mock server locally. */
export interface ResendTarget { key: string; base?: string }

async function call<T>({ key, base }: ResendTarget, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch((base || 'https://api.resend.com') + path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string } & T;
  if (res.ok) return body;
  if (body.name === 'restricted_api_key') {
    throw new HTTPException(400, { message: 'This Resend key can only send. Create a Full access key so bmail can list your domains.' });
  }
  if (res.status === 401 || res.status === 403) throw new HTTPException(400, { message: 'Resend rejected this API key.' });
  throw new HTTPException(502, { message: `Resend: ${body.message ?? res.statusText}` });
}

export async function listDomains(resend: ResendTarget): Promise<Domain[]> {
  const { data } = await call<{ data: { name: string; status: string }[] }>(resend, '/domains');
  return data.map((d) => ({ name: d.name.toLowerCase(), status: d.status })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface Outgoing {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Message-ID of the email being answered. */
  inReplyTo?: string | null;
  /** Earlier Message-IDs in the conversation, oldest first. */
  references?: string[];
}

export async function sendEmail(resend: ResendTarget, mail: Outgoing): Promise<{ id: string }> {
  const refs = [...(mail.references ?? []), ...(mail.inReplyTo ? [mail.inReplyTo] : [])];
  return call<{ id: string }>(resend, '/emails', {
    method: 'POST',
    body: JSON.stringify({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      headers: mail.inReplyTo ? { 'In-Reply-To': mail.inReplyTo, References: [...new Set(refs)].join(' ') } : undefined,
    }),
  });
}

/** The Message-ID Resend gave a sent email. Null until Resend has assigned it. */
export async function sentMessageId(resend: ResendTarget, id: string): Promise<string | null> {
  const email = await call<{ message_id?: string | null }>(resend, `/emails/${encodeURIComponent(id)}`);
  return email.message_id || null;
}

// ---------- receiving (Resend Inbound) ----------

export interface ReceivedSummary {
  id: string;
  from: string;
  to: string[];
  cc?: string[] | null;
  received_for?: string[] | null;
  subject: string | null;
  message_id: string | null;
  created_at: string;
}

export interface ReceivedEmail extends ReceivedSummary {
  html: string | null;
  text: string | null;
  headers?: Record<string, string> | null;
}

export const getReceivedEmail = (resend: ResendTarget, id: string) =>
  call<ReceivedEmail>(resend, `/emails/receiving/${encodeURIComponent(id)}`);

export const listReceivedEmails = (resend: ResendTarget, limit = 100) =>
  call<{ data: ReceivedSummary[] }>(resend, `/emails/receiving?limit=${limit}`);

interface Webhook { id: string; endpoint: string; events: string[]; status?: string; signing_secret?: string }

const WEBHOOK_SETTING = 'resend_webhook';

export interface StoredWebhook { id: string; endpoint: string; secret: string }

export async function getStoredWebhook(env: Env): Promise<StoredWebhook | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(WEBHOOK_SETTING).first<{ value: string }>();
  const plain = row ? await unseal(env.APP_SECRET, WEBHOOK_SETTING, row.value) : null;
  return plain ? (JSON.parse(plain) as StoredWebhook) : null;
}

/**
 * Makes sure Resend sends "email.received" to this app. Reuses bmail's own webhook if it exists,
 * creates it otherwise, and stores its signing secret encrypted. Other webhooks in the account are left alone.
 */
export async function connectReceiving(env: Env, origin: string): Promise<StoredWebhook> {
  if (!origin.startsWith('https://')) throw new HTTPException(400, { message: 'Receiving through Resend needs the app on https.' });
  const resend = await requireResend(env);
  const endpoint = `${origin}/api/webhooks/resend`;
  const { data } = await call<{ data: Webhook[] }>(resend, '/webhooks');
  let hook: Webhook | undefined = data.find((w) => w.endpoint === endpoint && w.events.includes('email.received'));
  if (!hook) {
    hook = await call<Webhook>(resend, '/webhooks', { method: 'POST', body: JSON.stringify({ endpoint, events: ['email.received'] }) });
  }
  if (!hook.signing_secret) hook = await call<Webhook>(resend, `/webhooks/${encodeURIComponent(hook.id)}`);
  if (!hook.signing_secret) throw new HTTPException(502, { message: 'Resend did not return the webhook signing secret.' });
  const stored: StoredWebhook = { id: hook.id, endpoint, secret: hook.signing_secret };
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(WEBHOOK_SETTING, await seal(env.APP_SECRET, WEBHOOK_SETTING, JSON.stringify(stored))).run();
  return stored;
}
