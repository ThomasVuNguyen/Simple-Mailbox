// Groups email into conversations the way mail apps do:
// 1. By headers: a reply's In-Reply-To / References name earlier Message-IDs.
// 2. For replies whose headers match nothing we know (older mail, or a Message-ID we never learned):
//    the same subject without "Re:" / "Fwd:", with the same other person.
// Anything else starts a new conversation. Separate notifications with the same subject
// ("Your Linear login code") stay separate, because they are not replies.

import type { Env } from './env';
import { sentMessageId, type ResendTarget } from './resend';

const PREFIX = /^\s*((re|fw|fwd|aw|sv|antw)(\[\d+\])?\s*:\s*)+/i;

/** "Re: Fwd: Hi friend " becomes "hi friend". */
export function subjectKey(subject: string): string {
  return subject.replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const isReplySubject = (subject: string) => PREFIX.test(subject);

/** Message-IDs in a header value: "<a@x> <b@y>" becomes ["<a@x>", "<b@y>"]. */
export function parseIds(header: string | null | undefined): string[] {
  if (!header) return [];
  const ids = header.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  const bare = header.trim();
  return bare && !/\s/.test(bare) ? [`<${bare.replace(/^<|>$/g, '')}>`] : [];
}

export interface ThreadKeys {
  mailboxId: string;
  subject: string;
  counterpart: string;
  inReplyTo: string | null;
  refs: string[];
}

async function byHeaders(env: Env, mailboxId: string, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const row = await env.DB.prepare(
    `SELECT thread_id FROM messages WHERE mailbox_id = ? AND thread_id IS NOT NULL AND message_id IN (${ids.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(mailboxId, ...ids).first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

/** Learns the Message-IDs Resend gave recently sent emails that we don't know yet. */
async function learnSentIds(env: Env, resend: ResendTarget, mailboxId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, resend_id FROM messages WHERE mailbox_id = ? AND direction = 'out' AND message_id IS NULL AND resend_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 5`,
  ).bind(mailboxId).all<{ id: string; resend_id: string }>();
  let learned = 0;
  for (const r of results) {
    const mid = await sentMessageId(resend, r.resend_id).catch(() => null);
    if (mid) {
      await env.DB.prepare('UPDATE messages SET message_id = ? WHERE id = ?').bind(mid, r.id).run();
      learned++;
    }
  }
  return learned;
}

/** The conversation an email belongs to, or null if it starts a new one. */
export async function findThread(env: Env, k: ThreadKeys, resend?: ResendTarget | null): Promise<string | null> {
  const ids = [...new Set([...(k.inReplyTo ? [k.inReplyTo] : []), ...[...k.refs].reverse()])];
  let thread = await byHeaders(env, k.mailboxId, ids);
  if (!thread && ids.length && resend && (await learnSentIds(env, resend, k.mailboxId))) {
    thread = await byHeaders(env, k.mailboxId, ids);
  }
  if (thread) return thread;
  if (!ids.length && !isReplySubject(k.subject)) return null;
  const key = subjectKey(k.subject);
  if (!key) return null;
  const row = await env.DB.prepare(
    `SELECT thread_id FROM messages WHERE mailbox_id = ? AND subject_key = ? AND counterpart = ? AND thread_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(k.mailboxId, key, k.counterpart).first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

/** Gives every email in a mailbox that predates threading a conversation, oldest first. */
export async function fillMissingThreads(env: Env, mailboxId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, direction, from_address, to_address, subject, in_reply_to, refs FROM messages
     WHERE mailbox_id = ? AND thread_id IS NULL ORDER BY created_at LIMIT 500`,
  ).bind(mailboxId).all<{
    id: string; direction: 'in' | 'out'; from_address: string; to_address: string; subject: string; in_reply_to: string | null; refs: string | null;
  }>();
  for (const r of results) {
    const counterpart = r.direction === 'in' ? r.from_address : r.to_address;
    const thread = await findThread(env, {
      mailboxId, subject: r.subject, counterpart, inReplyTo: r.in_reply_to, refs: parseIds(r.refs),
    });
    await env.DB.prepare('UPDATE messages SET thread_id = ?, subject_key = ?, counterpart = ? WHERE id = ?')
      .bind(thread ?? r.id, subjectKey(r.subject), counterpart, r.id).run();
  }
}
