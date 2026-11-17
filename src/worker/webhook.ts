// Resend signs webhooks the Svix way: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>",
// keyed by the base64 part of the "whsec_..." secret. The header lists one or more "v1,<base64>" signatures.

const TOLERANCE_S = 5 * 60;

export async function verifyWebhook(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  body: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_S) return false;

  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));

  return signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && sig !== undefined && sameString(sig, expected);
  });
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
