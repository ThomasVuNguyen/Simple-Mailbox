import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_MAX, IP_MAX, LOCK_MS, checkPin, hashPin, randomPin } from '../src/worker/auth';
import type { Env } from '../src/worker/env';
import { testDb } from './d1';

const GOOD = '482913';
let env: Env;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
  env = { DB: testDb(), APP_SECRET: 'test-secret-that-is-at-least-32-characters' } as Env;
  await env.DB.prepare("INSERT INTO pins (id, label, pin_hash, created_at) VALUES ('p1', 'Me', ?, 0)").bind(await hashPin(env, GOOD)).run();
});
afterEach(() => vi.useRealTimers());

const wrong = (n: number) => String(100000 + n);

describe('checkPin', () => {
  it('accepts the right PIN', async () => {
    expect(await checkPin(env, GOOD, '1.1.1.1')).toEqual({ id: 'p1', label: 'Me' });
  });

  it('counts down, then locks for 15 minutes after the 5th wrong PIN', async () => {
    for (let i = 1; i < IP_MAX; i++) expect(await checkPin(env, wrong(i), 'ip')).toEqual({ error: 'Wrong PIN.', attemptsLeft: IP_MAX - i });
    const fifth = await checkPin(env, wrong(5), 'ip');
    expect(fifth).toMatchObject({ attemptsLeft: 0, lockedUntil: Date.now() + LOCK_MS });
    // Even the right PIN is refused while locked.
    expect(await checkPin(env, GOOD, 'ip')).toMatchObject({ error: expect.stringContaining('locked') });
    // Another IP is not affected.
    expect(await checkPin(env, GOOD, 'other')).toEqual({ id: 'p1', label: 'Me' });
  });

  it('unlocks after 15 minutes', async () => {
    for (let i = 1; i <= IP_MAX; i++) await checkPin(env, wrong(i), 'ip');
    vi.setSystemTime(Date.now() + LOCK_MS + 1);
    expect(await checkPin(env, GOOD, 'ip')).toEqual({ id: 'p1', label: 'Me' });
  });

  it('a right PIN on the 5th try still works, and clears the count', async () => {
    for (let i = 1; i < IP_MAX; i++) await checkPin(env, wrong(i), 'ip');
    expect(await checkPin(env, GOOD, 'ip')).toEqual({ id: 'p1', label: 'Me' });
    expect(await checkPin(env, wrong(9), 'ip')).toEqual({ error: 'Wrong PIN.', attemptsLeft: IP_MAX - 1 });
  });

  it('forgets old failures after 15 minutes without a lock', async () => {
    for (let i = 1; i < IP_MAX; i++) await checkPin(env, wrong(i), 'ip');
    vi.setSystemTime(Date.now() + LOCK_MS + 1);
    expect(await checkPin(env, wrong(9), 'ip')).toEqual({ error: 'Wrong PIN.', attemptsLeft: IP_MAX - 1 });
  });

  it('locks everyone after too many wrong PINs across many IPs', async () => {
    for (let i = 0; i < GLOBAL_MAX; i++) await checkPin(env, wrong(i), `ip-${i}`);
    expect(await checkPin(env, GOOD, 'fresh-ip')).toMatchObject({ attemptsLeft: 0, lockedUntil: expect.any(Number) });
  });

  it('agents using the right PIN on every request never lock themselves out', async () => {
    for (let i = 0; i < GLOBAL_MAX * 2; i++) expect(await checkPin(env, GOOD, 'agent')).toEqual({ id: 'p1', label: 'Me' });
  });

  it('a locked IP does not use up the global limit', async () => {
    for (let i = 0; i < GLOBAL_MAX * 2; i++) await checkPin(env, wrong(i), 'attacker');
    expect(await checkPin(env, GOOD, 'me')).toEqual({ id: 'p1', label: 'Me' });
  });

  it('rejects input that is not 6 digits without crashing', async () => {
    expect(await checkPin(env, '12345', 'ip')).toMatchObject({ error: 'Wrong PIN.' });
    expect(await checkPin(env, 'abcdef', 'ip')).toMatchObject({ error: 'Wrong PIN.' });
  });
});

describe('randomPin', () => {
  it('is always 6 digits', () => {
    for (let i = 0; i < 2000; i++) expect(randomPin()).toMatch(/^\d{6}$/);
  });
});
