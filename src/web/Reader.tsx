import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCode } from '../shared/extract';
import type { Message } from '../shared/types';
import { api, copy, errorText } from './api';
import { clock, longTime } from './format';

export interface Draft {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

/** The email's own HTML, sandboxed: no scripts, and no remote images until asked, since those track opens. */
function originalDoc(html: string, images: boolean): string {
  const csp = images
    ? "default-src 'none'; img-src https: http: data: cid:; style-src 'unsafe-inline' https:; font-src https: data:"
    : "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;font:15px/1.5 sans-serif;color:#1B1A17}</style></head><body>${html}</body></html>`;
}

export function Reader({ id, onOpened, onReply, onDeleted }: {
  id: string;
  onOpened: (id: string) => void;
  onReply: (m: Message) => void;
  onDeleted: () => void;
}) {
  const [m, setM] = useState<Message | null>(null);
  const [error, setError] = useState('');
  const [original, setOriginal] = useState(false);
  const [images, setImages] = useState(false);
  const [copied, setCopied] = useState(false);
  const top = useRef<HTMLElement>(null);

  useEffect(() => {
    api<Message>(`/messages/${id}`)
      .then((msg) => { setM(msg); onOpened(id); })
      .catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const doc = useMemo(() => (m?.html ? originalDoc(m.html, images) : ''), [m, images]);

  // On a phone the email sits below the list, so bring it into view.
  useEffect(() => {
    if (m && matchMedia('(max-width: 960px)').matches) top.current?.scrollIntoView({ behavior: 'smooth' });
  }, [m]);

  if (error) return <article className="read"><p className="meta accent">{error}</p></article>;
  if (!m) return <article className="read" />;

  async function remove() {
    await api(`/messages/${m!.id}`, { method: 'DELETE' });
    onDeleted();
  }

  const from = m.fromName ? `${m.fromName}, ${m.fromAddress}` : m.fromAddress;

  return (
    <article className="read" ref={top}>
      <div className="fields meta">
        <span className="quiet">From</span><span>{from}</span>
        <span className="quiet">To</span><span>{m.toAddress}</span>
        <span className="quiet">{m.direction === 'out' ? 'Sent' : 'Received'}</span><span>{longTime(m.createdAt)}</span>
      </div>

      <h1 className="display subject">{m.subject || '(no subject)'}</h1>

      {m.code ? (
        <div className="code">
          <span className="display accent">{formatCode(m.code)}</span>
          <button className="meta quiet" onClick={() => { copy(m.code!); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      ) : m.link ? (
        <div className="code">
          <a className="meta accent" href={m.link} target="_blank" rel="noopener noreferrer">Open verification link</a>
          <button className="meta quiet" onClick={() => { copy(m.link!); setCopied(true); }}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
      ) : null}

      {m.html && (
        <div className="row-actions meta view-toggle">
          <button className={original ? 'quiet' : 'ink'} onClick={() => setOriginal(false)}>Text</button>
          <button className={original ? 'ink' : 'quiet'} onClick={() => setOriginal(true)}>Original</button>
          {original && !images && <button className="quiet" onClick={() => setImages(true)}>Load images</button>}
        </div>
      )}

      {original && m.html ? (
        <iframe className="original" title="Original email" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} />
      ) : (
        <div className="text body">{m.text?.trim() || '(empty)'}</div>
      )}

      <div className="row-actions meta">
        <button onClick={() => onReply(m)}>Reply</button>
        <button onClick={remove}>Delete</button>
      </div>
      {m.readBy && m.readAt && m.direction === 'in' && (
        <p className="meta quiet after">Read by {m.readBy} at {clock(m.readAt)}</p>
      )}
    </article>
  );
}

export function Compose({ draft, onClose, onSent }: { draft: Draft; onClose: () => void; onSent: () => void }) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/mailboxes/${encodeURIComponent(d.from)}/send`, { body: { to: d.to, subject: d.subject, text: d.text, replyTo: d.replyTo } });
      onSent();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="read compose" onSubmit={send}>
      <div className="fields meta">
        <span className="quiet">From</span><span>{d.from}</span>
      </div>
      <h1 className="display subject">{d.replyTo ? 'Reply' : 'New message'}</h1>
      <div className="stack">
        <input className="field body" value={d.to} onChange={set('to')} placeholder="To" aria-label="To" type="email" required autoFocus={!d.to} />
        <input className="field body" value={d.subject} onChange={set('subject')} placeholder="Subject" aria-label="Subject" required />
        <textarea className="field body" value={d.text} onChange={set('text')} placeholder="Write something" aria-label="Message" autoFocus={!!d.to} />
      </div>
      <div className="row-actions meta">
        <button type="submit" className="accent" disabled={busy}>{busy ? 'Sending' : 'Send'}</button>
        <button type="button" className="quiet" onClick={onClose}>Discard</button>
      </div>
      {error && <p className="meta accent err">{error}</p>}
    </form>
  );
}
