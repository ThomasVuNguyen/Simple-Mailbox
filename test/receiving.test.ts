import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/worker/env';
import { backfillFromResend, parseAddress, receiveFromResend } from '../src/worker/inbound';
import { verifyWebhook } from '../src/worker/webhook';
import { testDb } from './d1';

describe('verifyWebhook', () => {
  // Svix's published example; the same signature appears in Resend's docs.
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const headers = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' };
  const body = '{"test": 2432232314}';
  const at = 1614265330 * 1000;

  it('accepts a valid signature', async () => {
    expect(await verifyWebhook(secret, headers, body, at)).toBe(true);
    expect(await verifyWebhook(secret, { ...headers, signature: `v1,bogus ${headers.signature}` }, body, at)).toBe(true);
  });

  it('refuses a changed body, a wrong secret, missing headers, or an old timestamp', async () => {
    expect(await verifyWebhook(secret, headers, body.replace('2', '3'), at)).toBe(false);
    expect(await verifyWebhook('whsec_' + btoa('another key entirely!'), headers, body, at)).toBe(false);
    expect(await verifyWebhook(secret, { ...headers, signature: undefined }, body, at)).toBe(false);
    expect(await verifyWebhook(secret, headers, body, at + 10 * 60_000)).toBe(false);
  });
});

describe('parseAddress', () => {
  it.each([
    ['Linear <no-reply@linear.app>', 'Linear', 'no-reply@linear.app'],
    ['"Doe, Jane" <Jane@Example.com>', 'Doe, Jane', 'jane@example.com'],
    ['boymyc@gmail.com', null, 'boymyc@gmail.com'],
  ])('%s', (input, name, address) => expect(parseAddress(input)).toEqual({ name, address }));
});

describe('receiving through Resend', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const env = { DB: testDb() } as Env;
    for (const [id, address] of [['mb1', 'thomas@beenex.company'], ['mb2', 'signups@beenex.company']]) {
      await env.DB.prepare('INSERT INTO mailboxes (id, address, domain, created_at) VALUES (?, ?, ?, 0)').bind(id, address, 'beenex.company').run();
    }
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname;
      fetched.push(path);
      if (path === '/emails/receiving') {
        return Response.json({ data: [
          { id: 'r1', to: ['thomas@beenex.company'], from: 'boymyc@gmail.com', subject: 'Re: hi friend', created_at: '2026-11-17T17:44:00Z' },
          { id: 'r2', to: ['someone-else@beenex.company'], from: 'x@y.com', subject: 'Not ours', created_at: '2026-11-17T17:00:00Z' },
        ] });
      }
      const id = path.split('/').pop();
      return Response.json({
        id, from: 'boymyc@gmail.com', to: ['thomas@beenex.company', 'Signups+Linear@beenex.company'], subject: 'Re: hi friend',
        html: '<p>howdy</p>', text: null, message_id: '<abc@mail.gmail.com>', created_at: '2026-11-17T17:44:00Z',
        headers: { from: 'Boy M <boymyc@gmail.com>' },
      });
    });
    return { env, fetched, resend: { key: 're_test', base: 'https://resend.test' } };
  }

  it('stores the email in each addressed mailbox, once, even if Resend retries', async () => {
    const { env, resend, fetched } = await setup();
    const summary = { id: 'r1', to: ['thomas@beenex.company', 'signups+linear@beenex.company'] };
    expect(await receiveFromResend(env, resend, summary)).toBe(2);
    expect(await receiveFromResend(env, resend, summary)).toBe(0);
    expect(fetched.filter((p) => p === '/emails/receiving/r1')).toHaveLength(1); // the retry doesn't fetch again
    const { results } = await env.DB.prepare('SELECT mailbox_id, from_name, from_address, subject, text, created_at FROM messages ORDER BY mailbox_id').all();
    expect(results).toEqual([
      { mailbox_id: 'mb1', from_name: 'Boy M', from_address: 'boymyc@gmail.com', subject: 'Re: hi friend', text: 'howdy', created_at: Date.parse('2026-11-17T17:44:00Z') },
      { mailbox_id: 'mb2', from_name: 'Boy M', from_address: 'boymyc@gmail.com', subject: 'Re: hi friend', text: 'howdy', created_at: Date.parse('2026-11-17T17:44:00Z') },
    ]);
  });

  it('ignores mail for addresses without a mailbox, without fetching it', async () => {
    const { env, resend, fetched } = await setup();
    expect(await receiveFromResend(env, resend, { id: 'r9', to: ['nobody@beenex.company'] })).toBe(0);
    expect(fetched).toEqual([]);
  });

  it('backfill imports mail that arrived before receiving was connected, and is safe to repeat', async () => {
    const { env, resend } = await setup();
    expect(await backfillFromResend(env, resend)).toBe(1); // r1 is for thomas@; r2 has no mailbox
    expect(await backfillFromResend(env, resend)).toBe(0);
  });
});
