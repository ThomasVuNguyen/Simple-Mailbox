import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCode } from '../shared/extract';
import type { AppState, Domain, Mailbox, MessageSummary } from '../shared/types';
import { api, copy, errorText } from './api';
import { shortTime } from './format';
import { Compose, Reader, type Draft } from './Reader';
import { ResendPrompt, Settings } from './Settings';

const POLL_MS = 10_000;

const selectedFromHash = () => decodeURIComponent(location.hash.slice(1)) || null;

export function Mailroom({ state, onStateChange }: { state: AppState; onStateChange: () => void }) {
  const [view, setView] = useState<'mail' | 'settings'>('mail');
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [address, setAddress] = useState<string | null>(selectedFromHash);
  const [messages, setMessages] = useState<MessageSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const mailbox = mailboxes?.find((m) => m.address === address) ?? null;

  const loadMailboxes = useCallback(async () => {
    const list = await api<Mailbox[]>('/mailboxes');
    setMailboxes(list);
    setAddress((a) => (a && list.some((m) => m.address === a) ? a : list[0]?.address ?? null));
  }, []);

  const loadMessages = useCallback(async (addr: string) => {
    const list = await api<MessageSummary[]>(`/mailboxes/${encodeURIComponent(addr)}/messages`);
    setMessages((prev) => (addr === selectedFromHash() || prev === null ? list : prev));
  }, []);

  useEffect(() => {
    loadMailboxes().catch(() => {});
    if (state.hasResendKey) api<Domain[]>('/domains').then(setDomains).catch(() => setDomains([]));
  }, [loadMailboxes, state.hasResendKey]);

  // The open mailbox lives in the URL hash, so a reload or a shared link opens it again.
  useEffect(() => {
    if (address && location.hash.slice(1) !== encodeURIComponent(address)) history.replaceState(null, '', `#${encodeURIComponent(address)}`);
    setMessages(null);
    setOpenId(null);
    setDraft(null);
    if (address) loadMessages(address).catch(() => {});
  }, [address, loadMessages]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      loadMailboxes().catch(() => {});
      if (address) loadMessages(address).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [address, loadMailboxes, loadMessages]);

  // Open the newest email when a mailbox is opened on a wide screen.
  useEffect(() => {
    if (messages && messages.length && !openId && !draft && matchMedia('(min-width: 961px)').matches) setOpenId(messages[0].id);
  }, [messages, openId, draft]);

  function opened(id: string) {
    setMessages((list) => list?.map((m) => (m.id === id && !m.readAt ? { ...m, readAt: Date.now() } : m)) ?? list);
    loadMailboxes().catch(() => {});
  }

  async function lock() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    onStateChange();
  }

  const showPrompt = !state.hasResendKey && view === 'mail';

  return (
    <main className="app">
      <Sidebar
        mailboxes={mailboxes ?? []}
        domains={domains}
        address={view === 'mail' ? address : null}
        settingsOn={view === 'settings'}
        canCreate={state.hasResendKey}
        onPick={(a) => { setView('mail'); setAddress(a); }}
        onCreated={async (m) => { await loadMailboxes(); setView('mail'); setAddress(m.address); }}
        onSettings={() => setView('settings')}
        onLock={lock}
      />

      {view === 'settings' ? (
        <Settings
          pinLabel={state.pinLabel}
          onKeySaved={() => { onStateChange(); }}
          onDomains={setDomains}
        />
      ) : showPrompt ? (
        <ResendPrompt onSaved={onStateChange} />
      ) : (
        <>
          <MessageList
            mailbox={mailbox}
            hasMailboxes={!!mailboxes?.length}
            messages={messages}
            openId={draft ? null : openId}
            onOpen={(id) => { setDraft(null); setOpenId(id); }}
            onWrite={() => mailbox && setDraft({ from: mailbox.address, to: '', subject: '', text: '' })}
            onDeleted={async () => { setAddress(null); await loadMailboxes(); }}
          />
          {draft && mailbox ? (
            <Compose
              draft={draft}
              onClose={() => setDraft(null)}
              onSent={async () => { setDraft(null); await loadMessages(mailbox.address); }}
            />
          ) : openId ? (
            <Reader
              key={openId}
              id={openId}
              onOpened={opened}
              onReply={(m) => setDraft({
                from: m.direction === 'in' ? m.toAddress : m.fromAddress,
                to: m.direction === 'in' ? m.fromAddress : m.toAddress,
                subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
                text: '',
                replyTo: m.id,
              })}
              onDeleted={async () => { setOpenId(null); if (mailbox) await loadMessages(mailbox.address); loadMailboxes(); }}
            />
          ) : (
            <section className="read" />
          )}
        </>
      )}
    </main>
  );
}

function Sidebar(props: {
  mailboxes: Mailbox[];
  domains: Domain[];
  address: string | null;
  settingsOn: boolean;
  canCreate: boolean;
  onPick: (address: string) => void;
  onCreated: (m: Mailbox) => void;
  onSettings: () => void;
  onLock: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const groups = useMemo(() => {
    const by = new Map<string, Mailbox[]>();
    for (const m of props.mailboxes) by.set(m.domain, [...(by.get(m.domain) ?? []), m]);
    return [...by.entries()];
  }, [props.mailboxes]);

  return (
    <nav className="side">
      <div className="brand meta">bmail</div>
      {groups.map(([domain, boxes]) => (
        <div className="group" key={domain}>
          <div className="meta quiet">{domain}</div>
          {boxes.map((m) => (
            <button key={m.id} className={`box body${m.address === props.address ? ' on' : ''}`} onClick={() => props.onPick(m.address)}>
              <span>{m.address.split('@')[0]}</span>
              <span className="meta">{m.unread || ''}</span>
            </button>
          ))}
        </div>
      ))}

      {creating ? (
        <NewMailbox domains={props.domains} onCancel={() => setCreating(false)} onCreated={(m) => { setCreating(false); props.onCreated(m); }} />
      ) : (
        props.canCreate && (
          <div className="new-box">
            <button className="meta accent" onClick={() => setCreating(true)}>+ New mailbox</button>
          </div>
        )
      )}

      <div className="side-foot meta">
        <button className={props.settingsOn ? 'ink' : 'quiet'} onClick={props.onSettings}>Settings</button>
        <button className="quiet" onClick={props.onLock}>Lock</button>
      </div>
    </nav>
  );
}

function NewMailbox({ domains, onCancel, onCreated }: { domains: Domain[]; onCancel: () => void; onCreated: (m: Mailbox) => void }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState(() => (domains.find((d) => d.status === 'verified') ?? domains[0])?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!domain && domains.length) setDomain((domains.find((d) => d.status === 'verified') ?? domains[0]).name);
  }, [domains, domain]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onCreated(await api<Mailbox>('/mailboxes', { body: { domain, name: name.trim() || undefined } }));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (!domains.length) {
    return (
      <div className="new-box stack">
        <p className="body quiet">No domains in your Resend account yet. Add one at resend.com/domains.</p>
        <button className="meta quiet" onClick={onCancel}>Close</button>
      </div>
    );
  }

  return (
    <form className="new-box stack" onSubmit={create}>
      <div className="meta quiet">New mailbox</div>
      <input className="field body" value={name} onChange={(e) => setName(e.target.value)} placeholder="name, or leave blank" autoFocus aria-label="Name" />
      <select className="field body" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
        {domains.map((d) => <option key={d.name} value={d.name}>@{d.name}</option>)}
      </select>
      <div className="row-actions meta" style={{ marginTop: 20 }}>
        <button type="submit" className="accent" disabled={busy}>Create</button>
        <button type="button" className="quiet" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="meta accent">{error}</p>}
    </form>
  );
}

function MessageList(props: {
  mailbox: Mailbox | null;
  hasMailboxes: boolean;
  messages: MessageSummary[] | null;
  openId: string | null;
  onOpen: (id: string) => void;
  onWrite: () => void;
  onDeleted: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { mailbox, messages } = props;

  if (!mailbox) {
    return (
      <section className="list">
        <div className="list-head">
          <div className="body">{props.hasMailboxes ? 'Pick a mailbox' : 'No mailboxes yet'}</div>
          <div className="meta quiet">{props.hasMailboxes ? '' : 'Make one on the left'}</div>
        </div>
      </section>
    );
  }

  async function remove() {
    if (!mailbox || !confirm(`Delete ${mailbox.address} and its ${mailbox.total} emails? Mail sent to it afterwards bounces.`)) return;
    await api(`/mailboxes/${encodeURIComponent(mailbox.address)}`, { method: 'DELETE' });
    props.onDeleted();
  }

  return (
    <section className="list">
      <div className="list-head">
        <div className="body">{mailbox.address}</div>
        <div className="meta quiet">
          {mailbox.total} {mailbox.total === 1 ? 'message' : 'messages'}{mailbox.unread ? `, ${mailbox.unread} unread` : ''}
        </div>
        <div className="row-actions meta">
          <button className="quiet" onClick={() => { copy(mailbox.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <button className="quiet" onClick={props.onWrite}>Write</button>
        </div>
      </div>

      {messages?.length === 0 && (
        <p className="body quiet">Nothing yet. Mail sent to this address shows up here within a few seconds.</p>
      )}
      {messages?.map((m) => {
        const unread = m.direction === 'in' && !m.readAt;
        return (
          <button key={m.id} className={`msg${unread ? ' unread' : ''}${m.id === props.openId ? ' on' : ''}`} onClick={() => props.onOpen(m.id)}>
            <span className="body one from">{m.direction === 'out' ? `To ${m.toAddress}` : m.fromName || m.fromAddress}</span>
            <span className={`meta right${unread ? ' ink' : ''}`}>{shortTime(m.createdAt)}</span>
            <span className="body one subj">{m.subject || '(no subject)'}</span>
            <span className="meta right accent">{m.code ? formatCode(m.code) : m.link ? 'Link' : ''}</span>
          </button>
        );
      })}

      <div className="list-foot">
        <button className="meta quiet" onClick={remove}>Delete mailbox</button>
      </div>
    </section>
  );
}
