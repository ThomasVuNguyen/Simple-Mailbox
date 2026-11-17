import { useCallback, useEffect, useState } from 'react';
import { formatCode } from '../shared/extract';
import type { Domain, PinInfo } from '../shared/types';
import { api, copy, errorText } from './api';
import { shortTime } from './format';

function KeyForm({ onSaved, onCancel }: { onSaved: (domains: Domain[]) => void; onCancel?: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ domains: Domain[] }>('/settings/resend', { method: 'PUT', body: { key } });
      onSaved(res.domains);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="inline-form">
        <input className="field body" value={key} onChange={(e) => setKey(e.target.value)} placeholder="re_..." aria-label="Resend API key" autoFocus spellCheck={false} autoComplete="off" />
        <div className="row-actions meta">
          <button type="submit" className="accent" disabled={busy || !key.trim()}>{busy ? 'Checking' : 'Save'}</button>
          {onCancel && <button type="button" className="quiet" onClick={onCancel}>Cancel</button>}
        </div>
      </div>
      {error && <p className="meta accent err">{error}</p>}
    </form>
  );
}

/** Shown in place of the inbox until there is a Resend API key. */
export function ResendPrompt({ onSaved }: { onSaved: () => void }) {
  return (
    <section className="wide">
      <div className="section">
        <p className="meta quiet">One more step</p>
        <h1 className="display" style={{ marginTop: 12 }}>Add your Resend API key</h1>
        <p className="body quiet" style={{ maxWidth: '56ch' }}>
          bmail finds your domains and sends mail through Resend. Make a key with Full access at resend.com/api-keys and paste it here.
        </p>
        <KeyForm onSaved={onSaved} />
      </div>
    </section>
  );
}

export function Settings({ pinLabel, onKeySaved, onDomains }: {
  pinLabel: string | null;
  onKeySaved: () => void;
  onDomains: (d: Domain[]) => void;
}) {
  const [resendKey, setResendKey] = useState<string | null | undefined>(undefined);
  const [replacing, setReplacing] = useState(false);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [pins, setPins] = useState<PinInfo[]>([]);

  const load = useCallback(async () => {
    const s = await api<{ resendKey: string | null }>('/settings');
    setResendKey(s.resendKey);
    setPins(await api<PinInfo[]>('/pins'));
    if (s.resendKey) api<Domain[]>('/domains').then(setDomains).catch(() => setDomains([]));
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  return (
    <section className="wide">
      <div className="section">
        <p className="meta quiet">Resend</p>
        {resendKey === undefined ? null : replacing || !resendKey ? (
          <KeyForm
            onCancel={resendKey ? () => setReplacing(false) : undefined}
            onSaved={(d) => { setReplacing(false); setDomains(d); onDomains(d); load(); onKeySaved(); }}
          />
        ) : (
          <div className="row-actions" style={{ alignItems: 'baseline' }}>
            <span className="body">API key {resendKey}</span>
            <button className="meta quiet" onClick={() => setReplacing(true)}>Replace</button>
          </div>
        )}
        {domains && (
          <div style={{ marginTop: 28 }}>
            {domains.length === 0 && <p className="body quiet">No domains in this Resend account yet.</p>}
            {domains.map((d) => (
              <div className="domain-row" key={d.name}>
                <span className="body">{d.name}</span>
                <span className={`meta ${d.status === 'verified' ? 'ink' : 'quiet'}`}>{d.status === 'verified' ? 'Can send' : `Sending ${d.status}`}</span>
              </div>
            ))}
            <p className="body quiet" style={{ marginTop: 20, maxWidth: '60ch' }}>
              To receive mail, route each domain to bmail in Cloudflare: Email, Email Routing, Routing rules, Catch-all address, Send to a Worker, simple-mailbox.
            </p>
          </div>
        )}
      </div>

      <Pins pins={pins} onChange={load} />

      <AgentAccess />

      <div className="section">
        <p className="meta quiet">Signed in as {pinLabel}</p>
      </div>
    </section>
  );
}

function Pins({ pins, onChange }: { pins: PinInfo[]; onChange: () => void }) {
  const [label, setLabel] = useState('');
  const [made, setMade] = useState<{ pin: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  async function make(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await api<{ pin: string; label: string }>('/pins', { body: { label } });
      setMade(res);
      setCopied(false);
      setLabel('');
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function remove(p: PinInfo) {
    if (!confirm(`Remove the PIN for ${p.label}? Anything using it is signed out.`)) return;
    try {
      await api(`/pins/${p.id}`, { method: 'DELETE' });
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="section">
      <p className="meta quiet">PINs</p>
      {pins.map((p) => (
        <div className="pin-row" key={p.id}>
          <div>
            <div className="body">{p.label}</div>
            <div className="meta quiet">
              Made {shortTime(p.createdAt)}{p.lastUsedAt ? `, last used ${shortTime(p.lastUsedAt)}` : ', never used'}
              {p.current ? ', this session' : ''}
            </div>
          </div>
          {!p.current && <button className="meta quiet" onClick={() => remove(p)}>Remove</button>}
        </div>
      ))}

      {made ? (
        <div style={{ marginTop: 40 }}>
          <p className="meta quiet">PIN for {made.label}</p>
          <p className="display accent" style={{ marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>{formatCode(made.pin)}</p>
          <p className="body quiet" style={{ marginTop: 8 }}>Copy it now. bmail can't show it again.</p>
          <div className="row-actions meta" style={{ marginTop: 20 }}>
            <button className="quiet" onClick={() => { copy(made.pin); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
            <button onClick={() => setMade(null)}>Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={make}>
          <div className="inline-form">
            <input className="field body" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Who is it for? Claude, my phone" aria-label="PIN name" maxLength={40} />
            <button type="submit" className="meta accent" disabled={!label.trim()}>Make PIN</button>
          </div>
        </form>
      )}
      {error && <p className="meta accent err">{error}</p>}
    </div>
  );
}

function agentInstructions(origin: string) {
  return `bmail: disposable mailboxes on my domains.
Base URL: ${origin}/api
Auth: send the header "Authorization: Bearer <PIN>" on every request.

GET  /domains                          domains you can use
GET  /mailboxes                        existing mailboxes
POST /mailboxes                        {"domain": "<domain>"} makes a random address,
                                       add "name" to choose it
GET  /mailboxes/<address>/wait?timeout=60
                                       waits for the next email, returns it
                                       with "code" and "link" already found
GET  /mailboxes/<address>/messages     newest first
GET  /messages/<id>                    the full email
POST /mailboxes/<address>/send         {"to", "subject", "text"}
DELETE /mailboxes/<address>            when you are done with it

To sign up somewhere: make a mailbox, note the time in ms,
submit the form, then call /wait?after=<that time>.`;
}

function AgentAccess() {
  const [copied, setCopied] = useState(false);
  const text = agentInstructions(location.origin);
  return (
    <div className="section">
      <p className="meta quiet">Agent access</p>
      <p className="body" style={{ maxWidth: '60ch' }}>
        Make your agent its own PIN above, then give it these instructions with the PIN.
      </p>
      <pre className="meta snippet">{text}</pre>
      <div className="row-actions meta" style={{ marginTop: 20 }}>
        <button className="accent" onClick={() => { copy(text); setCopied(true); }}>{copied ? 'Copied' : 'Copy instructions'}</button>
      </div>
    </div>
  );
}
