import { HTTPException } from 'hono/http-exception';

// Everything secret in D1 is protected by APP_SECRET, a Worker secret that never touches the database.
// Two keys are derived from it: one encrypts the Resend key, the other hashes PINs.
// A copy of the database alone reveals neither the Resend key nor the PINs.
//
// Changing APP_SECRET makes the stored Resend key unreadable and every PIN invalid.
// To recover, see "Lost APP_SECRET" in the README.

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface Keys { aes: CryptoKey; hmac: CryptoKey }
const cache = new Map<string, Promise<Keys>>();

function keys(secret: string | undefined): Promise<Keys> {
  if (!secret || secret.length < 32) {
    throw new HTTPException(500, { message: 'APP_SECRET is missing or too short. Set it with: wrangler secret put APP_SECRET' });
  }
  let k = cache.get(secret);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
      const params = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
      return {
        aes: await crypto.subtle.deriveKey(params('bmail settings encryption v1'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
        hmac: await crypto.subtle.deriveKey(params('bmail pin hashing v1'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
      };
    })();
    cache.set(secret, k);
  }
  return k;
}

/** Encrypts a setting. `context` names what it is, so a value can't be moved to another setting. */
export async function seal(secret: string | undefined, context: string, plaintext: string): Promise<string> {
  const { aes } = await keys(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, aes, enc.encode(plaintext));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

/** Decrypts a value from seal(). Returns null when it can't be read, for example after APP_SECRET changed. */
export async function unseal(secret: string | undefined, context: string, sealed: string): Promise<string | null> {
  const { aes } = await keys(secret);
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(context) }, aes, unb64(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** Keyed hash of a PIN. Unique per PIN, so sign-in can look it up directly. */
export async function pinHash(secret: string | undefined, pin: string): Promise<string> {
  const { hmac } = await keys(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, enc.encode(pin)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
