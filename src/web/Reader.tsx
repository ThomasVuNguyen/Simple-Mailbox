import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCode, splitQuoted } from '../shared/extract';
import type { Message, Thread } from '../shared/types';
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

const replySubject = (s: string) => (/^re:/i.test(s) ? s : `Re: ${s}`);

/** One email inside a conversation. Older ones are quieter so the newest reads first. */
function Entry({ m, latest }: { m: Message; latest: boolean }) {
  const [original, setOriginal] = useState(false);
  const [images, setImages] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = useMemo(() => splitQuoted(m.text ?? ''), [m.text]);
  const doc = useMemo(() => (m.html && original ? originalDoc(m.html, images) : ''), [m.html, original, images]);
  const who = m.direction === 'out' ? `You, ${m.fromAddress}` : m.fromName ? `${m.fromName}, ${m.fromAddress}` : m.fromAddress;

  return (
    <div className="entry">
      <div className="entry-head meta">
        <span className={latest ? 'ink' : 'quiet'}>{who}</span>
        <span className="quiet">{longTime(m.createdAt)}</span>
      </div>
      {original && m.html ? (
        <iframe className="original" title="Original email" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} />
      ) : (
        <div className={`text body${latest ? '' : ' quiet'}`}>
          {main || '(empty)'}
          {quoted && showQuoted && <div className="quiet quoted">{quoted}</div>}
        </div>
      )}
      {(quoted || m.html) && (
        <div className="row-actions meta entry-tools">
          {quoted && !original && (
            <button className="quiet" onClick={() => setShowQuoted(!showQuoted)}>{showQuoted ? 'Hide quoted text' : 'Show quoted text'}</button>
          )}
          {m.html && <button className="quiet" onClick={() => setOriginal(!original)}>{original ? 'Text' : 'Original'}</button>}
          {original && !images && <button className="quiet" onClick={() => setImages(true)}>Load images</button>}
        </div>
      )}
    </div>
  );
}

export function ThreadReader({ id, mailboxAddress, revision, onOpened, onSent, onDeleted }: {
  id: string;
  mailboxAddress: string;
  revision: number;
  onOpened: (id: string) => void;
  onSent: (threadId: string) => void;
  onDeleted: () => void;
}) {
  const [t, setT] = useState<Thread | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [replying, setReplying] = useState(false);
  const top = useRef<HTMLElement>(null);

  useEffect(() => {
    api<Thread>(`/threads/${id}`)
      .then((thread) => { setT(thread); onOpened(id); })
      .catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, revision]);

  // On a phone the conversation sits below the list, so bring it into view.
  useEffect(() => {
    if (t && matchMedia('(max-width: 960px)').matches) top.current?.scrollIntoView({ behavior: 'smooth' });
  }, [t?.id]);

  if (error) return <article className="read"><p className="meta accent">{error}</p></article>;
  if (!t) return <article className="read" />;

  const latest = t.messages[t.messages.length - 1];
  const lastIn = [...t.messages].reverse().find((m) => m.direction === 'in');
  const counterpart = lastIn ? lastIn.fromAddress : latest.toAddress;
  const withCode = [...t.messages].reverse().find((m) => m.code || m.link);
  const count = t.messages.length;

  async function remove() {
    if (count > 1 && !confirm(`Delete this conversation and its ${count} emails?`)) return;
    await api(`/threads/${t!.id}`, { method: 'DELETE' });
    onDeleted();
  }

  return (
    <article className="read" ref={top}>
      <p className="meta quiet thread-meta">
        {count > 1 ? `${count} emails with ${counterpart}` : latest.direction === 'out' ? `To ${latest.toAddress}` : `From ${counterpart}`}
      </p>
      <h1 className="display subject">{t.subject || '(no subject)'}</h1>

      {withCode?.code ? (
        <div className="code">
          <span className="display accent">{formatCode(withCode.code)}</span>
          <button className="meta quiet" onClick={() => { copy(withCode.code!); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      ) : withCode?.link ? (
        <div className="code">
          <a className="meta accent" href={withCode.link} target="_blank" rel="noopener noreferrer">Open verification link</a>
          <button className="meta quiet" onClick={() => { copy(withCode.link!); setCopied(true); }}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
      ) : null}

      {t.messages.map((m) => <Entry key={m.id} m={m} latest={m.id === latest.id} />)}

      {replying ? (
        <Compose
          inline
          draft={{ from: mailboxAddress, to: counterpart, subject: replySubject(latest.subject || t.subject), text: '', replyTo: latest.id }}
          onClose={() => setReplying(false)}
          onSent={(threadId) => { setReplying(false); onSent(threadId); }}
        />
      ) : (
        <>
          <div className="row-actions meta">
            <button onClick={() => setReplying(true)}>Reply</button>
            <button onClick={remove}>{count > 1 ? 'Delete conversation' : 'Delete'}</button>
          </div>
          {lastIn?.readBy && lastIn.readAt && (
            <p className="meta quiet after">Read by {lastIn.readBy} at {clock(lastIn.readAt)}</p>
          )}
        </>
      )}
    </article>
  );
}

export function Compose({ draft, inline, onClose, onSent }: {
  draft: Draft;
  /** Under a conversation, rather than in place of it. */
  inline?: boolean;
  onClose: () => void;
  onSent: (threadId: string) => void;
}) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ id: string; threadId: string }>(`/mailboxes/${encodeURIComponent(d.from)}/send`, {
        body: { to: d.to, subject: d.subject, text: d.text, replyTo: d.replyTo },
      });
      onSent(res.threadId);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const fields = (
    <>
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
    </>
  );

  if (inline) {
    return (
      <form className="compose reply" onSubmit={send}>
        <p className="meta quiet entry-head">Reply from {d.from}</p>
        {fields}
      </form>
    );
  }

  return (
    <form className="read compose" onSubmit={send}>
      <div className="fields meta">
        <span className="quiet">From</span><span>{d.from}</span>
      </div>
      <h1 className="display subject">New message</h1>
      {fields}
    </form>
  );
}
