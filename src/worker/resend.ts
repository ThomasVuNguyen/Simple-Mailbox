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
  inReplyTo?: string | null;
}

export async function sendEmail(resend: ResendTarget, mail: Outgoing): Promise<{ id: string }> {
  return call<{ id: string }>(resend, '/emails', {
    method: 'POST',
    body: JSON.stringify({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      headers: mail.inReplyTo ? { 'In-Reply-To': mail.inReplyTo, References: mail.inReplyTo } : undefined,
    }),
  });
}
