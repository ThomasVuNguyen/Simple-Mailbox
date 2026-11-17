import { useEffect, useRef, useState } from 'react';
import { formatCode } from '../shared/extract';
import type { SignInError } from '../shared/types';
import { ApiError, api, copy, errorText } from './api';
import { clock } from './format';

function PinSlots({ value, onChange, busy }: { value: string; onChange: (v: string) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [busy]);
  return (
    <div className={`pin${busy ? ' busy' : ''}`} onClick={() => input.current?.focus()}>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={i < value.length ? 'filled' : i === value.length && !busy ? 'next' : ''}>
          {i < value.length && <i />}
        </span>
      ))}
      <input
        ref={input}
        value={value}
        disabled={busy}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="PIN"
        maxLength={6}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </div>
  );
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; alert: boolean }>({
    text: '5 tries, then sign in locks for 15 minutes.',
    alert: false,
  });

  async function submit(value: string) {
    setBusy(true);
    try {
      await api('/auth/pin', { body: { pin: value } });
      onSignedIn();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as Partial<SignInError>) : {};
      if (body.lockedUntil) setStatus({ text: `Too many wrong PINs. Try again at ${clock(body.lockedUntil)}.`, alert: true });
      else if (body.attemptsLeft !== undefined) {
        setStatus({ text: `Wrong PIN. ${body.attemptsLeft} ${body.attemptsLeft === 1 ? 'try' : 'tries'} left.`, alert: true });
      } else setStatus({ text: errorText(e), alert: true });
      setPin('');
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <div className="meta">bmail</div>
      <div className="gate-main">
        <h1 className="display">Enter your PIN</h1>
        <PinSlots
          value={pin}
          busy={busy}
          onChange={(v) => {
            setPin(v);
            if (v.length === 6) submit(v);
          }}
        />
        <p className={`meta ${status.alert ? 'accent' : 'quiet'}`}>{status.text}</p>
      </div>
    </main>
  );
}

/** First run: make the first PIN, show it once, then go in. */
export function Setup({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function make() {
    setBusy(true);
    setError('');
    try {
      setPin((await api<{ pin: string }>('/setup', { method: 'POST' })).pin);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <div className="meta">bmail</div>
      <div className="gate-main">
        {!pin ? (
          <>
            <p className="meta quiet">First run</p>
            <h1 className="display" style={{ marginTop: 12 }}>Make your PIN</h1>
            <p className="body quiet">
              bmail signs in with a 6-digit PIN. This one is yours. Later you can make more, one for each agent.
            </p>
            <div className="row-actions meta" style={{ marginTop: 40 }}>
              <button className="accent" onClick={make} disabled={busy}>{busy ? 'Making your PIN' : 'Make my PIN'}</button>
            </div>
            {error && <p className="meta accent err">{error}</p>}
          </>
        ) : (
          <>
            <p className="meta quiet">Your PIN</p>
            <p className="display accent" style={{ marginTop: 12, fontVariantNumeric: 'tabular-nums' }}>{formatCode(pin)}</p>
            <p className="body">Write it down. bmail only keeps a hash of it, so this is the one time you'll see it.</p>
            <div className="row-actions meta" style={{ marginTop: 40 }}>
              <button className="quiet" onClick={() => { copy(pin); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="accent" onClick={onDone}>I saved it, continue</button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
