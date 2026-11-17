import PostalMime from 'postal-mime';
import { extractCode, extractLink, htmlToText } from '../shared/extract';
import type { Env } from './env';

const MAX_HTML = 500_000;
const MAX_TEXT = 200_000;

/** "signups+linear@beenex.company" is delivered to "signups@beenex.company". */
export function mailboxAddress(to: string): string {
  const [local, domain] = to.trim().toLowerCase().split('@');
  return `${local.split('+')[0]}@${domain}`;
}

export interface Incoming {
  to: string;
  raw: ArrayBuffer | ReadableStream;
}

/** Stores an email that Cloudflare Email Routing delivered. Returns false when no mailbox has that address. */
export async function receiveEmail(env: Env, mail: Incoming): Promise<boolean> {
  const mailbox = await env.DB.prepare('SELECT id, address FROM mailboxes WHERE address = ?')
    .bind(mailboxAddress(mail.to)).first<{ id: string; address: string }>();
  if (!mailbox) return false;

  const raw = mail.raw instanceof ArrayBuffer ? mail.raw : await new Response(mail.raw).arrayBuffer();
  const email = await PostalMime.parse(raw);
  const html = email.html ? email.html.slice(0, MAX_HTML) : null;
  const text = (email.text?.trim() ? email.text : html ? htmlToText(html) : '').slice(0, MAX_TEXT);
  const subject = (email.subject ?? '').trim();

  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, from_name, from_address, to_address, subject, text, html, code, link, message_id, created_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    mailbox.id,
    email.from?.name || null,
    (email.from?.address ?? 'unknown').toLowerCase(),
    mailbox.address,
    subject,
    text,
    html,
    extractCode(subject, text),
    extractLink(subject, text, html),
    email.messageId ?? null,
    Date.now(),
  ).run();
  return true;
}
