import { describe, expect, it } from 'vitest';
import { pinHash, seal, unseal } from '../src/worker/crypto';

const SECRET = 'a-test-app-secret-of-at-least-32-chars';
const KEY = 're_live_Abc123_secret_value';

describe('seal / unseal', () => {
  it('round-trips, and the stored value does not contain the key', async () => {
    const sealed = await seal(SECRET, 'resend_api_key', KEY);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('Abc123');
    expect(await unseal(SECRET, 'resend_api_key', sealed)).toBe(KEY);
  });

  it('uses a fresh IV each time', async () => {
    expect(await seal(SECRET, 'x', KEY)).not.toBe(await seal(SECRET, 'x', KEY));
  });

  it('cannot be read with another secret, another context, or after tampering', async () => {
    const sealed = await seal(SECRET, 'resend_api_key', KEY);
    expect(await unseal('another-secret-that-is-32-chars-long!!', 'resend_api_key', sealed)).toBeNull();
    expect(await unseal(SECRET, 'something_else', sealed)).toBeNull();
    const [v, iv, ct] = sealed.split('.');
    const flipped = ct.slice(0, 5) + (ct[5] === 'A' ? 'B' : 'A') + ct.slice(6);
    expect(await unseal(SECRET, 'resend_api_key', `${v}.${iv}.${flipped}`)).toBeNull();
    expect(await unseal(SECRET, 'resend_api_key', KEY)).toBeNull(); // a plaintext value is not accepted
  });

  it('refuses to run without a real secret', async () => {
    await expect(seal(undefined, 'x', KEY)).rejects.toThrow('APP_SECRET');
    await expect(seal('short', 'x', KEY)).rejects.toThrow('APP_SECRET');
  });
});

describe('pinHash', () => {
  it('is stable for one secret and differs across secrets', async () => {
    expect(await pinHash(SECRET, '482913')).toBe(await pinHash(SECRET, '482913'));
    expect(await pinHash(SECRET, '482913')).not.toBe(await pinHash(SECRET, '482914'));
    expect(await pinHash(SECRET, '482913')).not.toBe(await pinHash('another-secret-that-is-32-chars-long!!', '482913'));
  });
});
