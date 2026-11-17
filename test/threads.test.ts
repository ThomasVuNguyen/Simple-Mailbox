import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitQuoted } from '../src/shared/extract';
import type { Env } from '../src/worker/env';
import { receiveFromResend } from '../src/worker/inbound';
import { fillMissingThreads, findThread, parseIds, subjectKey } from '../src/worker/threads';
import { testDb } from './d1';

describe('helpers', () => {
  it('subjectKey drops reply and forward prefixes', () => {
    expect(subjectKey('Re: RE: Fwd: Hi  friend ')).toBe('hi friend');
    expect(subjectKey('Re[2]: hi friend')).toBe('hi friend');
    expect(subjectKey('Regarding the plan')).toBe('regarding the plan');
  });

  it('parseIds reads Message-ID lists', () => {
    expect(parseIds('<a@x.com> <b@y.com>')).toEqual(['<a@x.com>', '<b@y.com>']);
    expect(parseIds('<a@x.com>\r\n <b@y.com>')).toEqual(['<a@x.com>', '<b@y.com>']);
    expect(parseIds('a@x.com')).toEqual(['<a@x.com>']);
    expect(parseIds(null)).toEqual([]);
  });

  it('splitQuoted separates a Gmail reply from what it quotes', () => {
    const text = 'howdy\n\nOn Tue, Nov 17, 2026 at 12:42 PM <thomas@beenex.company> wrote:\n> hello\n';
    expect(splitQuoted(text)).toEqual({ main: 'howdy', quoted: 'On Tue, Nov 17, 2026 at 12:42 PM <thomas@beenex.company> wrote:\n> hello' });
  });

  it('splitQuoted handles a wrapped "wrote:" line, ">" blocks, and plain mail', () => {
    expect(splitQuoted('ok\n\nOn Tue, Nov 17, 2026 at 12:42 PM Thomas <\nthomas@beenex.company> wrote:\n> hi').main).toBe('ok');
    expect(splitQuoted('sounds good\n\n> earlier\n> text')).toEqual({ main: 'sounds good', quoted: '> earlier\n> text' });
    expect(splitQuoted('Just a note.\nNo quotes here.')).toEqual({ main: 'Just a note.\nNo quotes here.', quoted: '' });
    expect(splitQuoted('> only a quote').main).toBe('> only a quote');
  });
});

async function db() {
  const env = { DB: testDb() } as Env;
  await env.DB.prepare("INSERT INTO mailboxes (id, address, domain, created_at) VALUES ('mb', 'thomas@beenex.company', 'beenex.company', 0)").run();
  return env;
}

let seq = 0;
async function insert(env: Env, m: {
  dir: 'in' | 'out'; other: string; subject: string; messageId?: string; inReplyTo?: string; thread?: string | null; resendId?: string; at?: number;
}) {
  const id = `m${++seq}`;
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, direction, from_address, to_address, subject, message_id, in_reply_to, thread_id, subject_key, counterpart, resend_id, created_at)
     VALUES (?, 'mb', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, m.dir, m.dir === 'in' ? m.other : 'thomas@beenex.company', m.dir === 'in' ? 'thomas@beenex.company' : m.other, m.subject,
    m.messageId ?? null, m.inReplyTo ?? null, m.thread === undefined ? id : m.thread, m.thread === null ? null : subjectKey(m.subject), m.other,
    m.resendId ?? null, m.at ?? seq,
  ).run();
  return id;
}

const threadOf = async (env: Env, id: string) =>
  (await env.DB.prepare('SELECT thread_id FROM messages WHERE id = ?').bind(id).first<{ thread_id: string }>())!.thread_id;

describe('findThread', () => {
  it('follows In-Reply-To and References', async () => {
    const env = await db();
    const first = await insert(env, { dir: 'out', other: 'a@b.com', subject: 'Plan', messageId: '<1@resend>' });
    expect(await findThread(env, { mailboxId: 'mb', subject: 'Re: Plan', counterpart: 'a@b.com', inReplyTo: '<1@resend>', refs: [] })).toBe(first);
    expect(await findThread(env, { mailboxId: 'mb', subject: 'whatever', counterpart: 'x@y.com', inReplyTo: '<zzz>', refs: ['<1@resend>'] })).toBe(first);
  });

  it('falls back to subject and person for replies only', async () => {
    const env = await db();
    const first = await insert(env, { dir: 'out', other: 'a@b.com', subject: 'Plan' });
    expect(await findThread(env, { mailboxId: 'mb', subject: 'RE: plan', counterpart: 'a@b.com', inReplyTo: null, refs: [] })).toBe(first);
    expect(await findThread(env, { mailboxId: 'mb', subject: 'Re: Plan', counterpart: 'someone@else.com', inReplyTo: null, refs: [] })).toBeNull();
  });

  it('keeps repeated notifications separate', async () => {
    const env = await db();
    await insert(env, { dir: 'in', other: 'no-reply@linear.app', subject: 'Your Linear login code' });
    expect(await findThread(env, { mailboxId: 'mb', subject: 'Your Linear login code', counterpart: 'no-reply@linear.app', inReplyTo: null, refs: [] })).toBeNull();
  });
});

describe('fillMissingThreads', () => {
  it('groups mail from before threading existed: "hi friend" and its reply', async () => {
    const env = await db();
    const sent = await insert(env, { dir: 'out', other: 'boymyc@gmail.com', subject: 'hi friend', thread: null });
    const reply = await insert(env, { dir: 'in', other: 'boymyc@gmail.com', subject: 'Re: hi friend', messageId: '<g1@mail.gmail.com>', thread: null });
    const other = await insert(env, { dir: 'in', other: 'no-reply@linear.app', subject: 'Your code', thread: null });
    await fillMissingThreads(env, 'mb');
    expect(await threadOf(env, reply)).toBe(await threadOf(env, sent));
    expect(await threadOf(env, other)).not.toBe(await threadOf(env, sent));
  });
});

describe('a back-and-forth through Resend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('learns the Message-ID Resend gave our email, so the reply joins the conversation', async () => {
    const env = await db();
    // We sent "Plan" through Resend, but have not learned its Message-ID yet.
    const sent = await insert(env, { dir: 'out', other: 'boymyc@gmail.com', subject: 'Plan', resendId: 'sent-1' });
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/emails/sent-1') return Response.json({ id: 'sent-1', message_id: '<sent-1@resend.dev>' });
      return Response.json({
        id: 'r1', from: 'boymyc@gmail.com', to: ['thomas@beenex.company'], subject: 'Totally different subject',
        text: 'yes\n\nOn Tue wrote:\n> Plan', html: null, message_id: '<g2@mail.gmail.com>', created_at: '2026-11-17T18:00:00Z',
        headers: { 'In-Reply-To': '<sent-1@resend.dev>', References: '<sent-1@resend.dev>' },
      });
    });
    const resend = { key: 're_test', base: 'https://resend.test' };
    expect(await receiveFromResend(env, resend, { id: 'r1', to: ['thomas@beenex.company'] })).toBe(1);
    const reply = await env.DB.prepare("SELECT id, thread_id, in_reply_to, refs FROM messages WHERE resend_id = 'r1'").first<Record<string, string>>();
    expect(reply).toMatchObject({ thread_id: await threadOf(env, sent), in_reply_to: '<sent-1@resend.dev>', refs: '<sent-1@resend.dev>' });
  });
});
