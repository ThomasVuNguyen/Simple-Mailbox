import PostalMime from 'postal-mime';
import { extractCode, extractLink, htmlToText } from '../shared/extract';
import type { Env } from './env';
import { getReceivedEmail, getResendKey, listReceivedEmails, type ReceivedSummary, type ResendTarget } from './resend';
import { findThread, parseIds, subjectKey } from './threads';

const MAX_HTML = 500_000;
const MAX_TEXT = 200_000;

/** "signups+linear@beenex.company" is delivered to "signups@beenex.company". */
export function mailboxAddress(to: string): string {
  const [local, domain] = to.trim().toLowerCase().split('@');
  return `${local.split('+')[0]}@${domain}`;
}

/** "Linear <no-reply@linear.app>" becomes { name: "Linear", address: "no-reply@linear.app" }. */
export function parseAddress(s: string): { name: string | null; address: string } {
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || null, address: m[2].trim().toLowerCase() } : { name: null, address: s.trim().toLowerCase() };
}

interface Mailbox { id: string; address: string }

interface Parsed {
  fromName: string | null;
  fromAddress: string;
  subject: string;
  text: string | null;
  html: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  refs: string[];
  createdAt: number;
  resendId?: string;
}

/** Stores one received email in one mailbox, in its conversation. Returns false if it was already stored (same Resend id). */
async function store(env: Env, mailbox: Mailbox, p: Parsed, resend?: ResendTarget | null): Promise<boolean> {
  const html = p.html ? p.html.slice(0, MAX_HTML) : null;
  const text = (p.text?.trim() ? p.text : html ? htmlToText(html) : '').slice(0, MAX_TEXT);
  const subject = p.subject.trim();
  const id = crypto.randomUUID();
  const thread = await findThread(env, { mailboxId: mailbox.id, subject, counterpart: p.fromAddress, inReplyTo: p.inReplyTo, refs: p.refs }, resend);
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, mailbox_id, direction, from_name, from_address, to_address, subject, text, html, code, link,
       message_id, created_at, resend_id, thread_id, in_reply_to, refs, subject_key, counterpart)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, mailbox.id, p.fromName, p.fromAddress, mailbox.address, subject, text, html,
    extractCode(subject, text), extractLink(subject, text, html), p.messageId, p.createdAt, p.resendId ?? null,
    thread ?? id, p.inReplyTo, p.refs.length ? p.refs.join(' ') : null, subjectKey(subject), p.fromAddress,
  ).run();
  return res.meta.changes > 0;
}

/** Header lookup that ignores case: Resend may send "In-Reply-To" or "in-reply-to". */
function header(headers: Record<string, string> | null | undefined, name: string): string | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

async function mailboxesFor(env: Env, recipients: string[]): Promise<Mailbox[]> {
  const addresses = [...new Set(recipients.filter((r) => r.includes('@')).map((r) => mailboxAddress(parseAddress(r).address)))];
  if (!addresses.length) return [];
  const { results } = await env.DB.prepare(`SELECT id, address FROM mailboxes WHERE address IN (${addresses.map(() => '?').join(',')})`)
    .bind(...addresses).all<Mailbox>();
  return results;
}

const recipientsOf = (e: Pick<ReceivedSummary, 'to' | 'cc' | 'received_for'>) => [...(e.to ?? []), ...(e.cc ?? []), ...(e.received_for ?? [])];

// ---------- Cloudflare Email Routing ----------

export interface Incoming {
  to: string;
  raw: ArrayBuffer | ReadableStream;
}

/** Stores an email that Cloudflare Email Routing delivered. Returns false when no mailbox has that address. */
export async function receiveEmail(env: Env, mail: Incoming): Promise<boolean> {
  const [mailbox] = await mailboxesFor(env, [mail.to]);
  if (!mailbox) return false;
  const raw = mail.raw instanceof ArrayBuffer ? mail.raw : await new Response(mail.raw).arrayBuffer();
  const email = await PostalMime.parse(raw);
  const key = await getResendKey(env).catch(() => null);
  await store(env, mailbox, {
    fromName: email.from?.name || null,
    fromAddress: (email.from?.address ?? 'unknown').toLowerCase(),
    subject: email.subject ?? '',
    text: email.text ?? null,
    html: email.html ?? null,
    messageId: email.messageId ?? null,
    inReplyTo: parseIds(email.inReplyTo)[0] ?? null,
    refs: parseIds(email.references),
    createdAt: Date.now(),
  }, key ? { key, base: env.RESEND_API_BASE } : null);
  return true;
}

// ---------- Resend Inbound ----------

/**
 * Stores an email Resend received, in every bmail mailbox it was addressed to.
 * Returns how many mailboxes got a new copy. Mail for addresses without a mailbox is ignored.
 */
export async function receiveFromResend(env: Env, resend: ResendTarget, summary: Pick<ReceivedSummary, 'id' | 'to' | 'cc' | 'received_for'>): Promise<number> {
  const boxes = await mailboxesFor(env, recipientsOf(summary));
  if (!boxes.length) return 0;
  const already = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE resend_id = ? AND mailbox_id IN (${boxes.map(() => '?').join(',')})`,
  ).bind(summary.id, ...boxes.map((b) => b.id)).first<{ n: number }>();
  if (already && already.n >= boxes.length) return 0;

  const email = await getReceivedEmail(resend, summary.id);
  const from = parseAddress(header(email.headers, 'from') ?? email.from);
  const parsed: Parsed = {
    fromName: from.name,
    fromAddress: from.address,
    subject: email.subject ?? '',
    text: email.text,
    html: email.html,
    messageId: email.message_id,
    inReplyTo: parseIds(header(email.headers, 'in-reply-to'))[0] ?? null,
    refs: parseIds(header(email.headers, 'references')),
    createdAt: Date.parse(email.created_at) || Date.now(),
    resendId: email.id,
  };
  let stored = 0;
  for (const box of boxes) if (await store(env, box, parsed, resend)) stored++;
  return stored;
}

/** Imports recent mail Resend already received for existing mailboxes. Safe to run again. */
export async function backfillFromResend(env: Env, resend: ResendTarget): Promise<number> {
  const { data } = await listReceivedEmails(resend, 100);
  let stored = 0;
  for (const summary of data) stored += await receiveFromResend(env, resend, summary);
  return stored;
}
