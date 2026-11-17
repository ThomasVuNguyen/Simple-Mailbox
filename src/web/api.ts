export class ApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : 'Something went wrong.');
  }
}

let onSignedOut = () => {};
/** Called when the session has ended, so the app can show the PIN screen. */
export function whenSignedOut(fn: () => void) {
  onSignedOut = fn;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) onSignedOut();
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard can be blocked; the text is on screen to copy by hand.
  }
}
