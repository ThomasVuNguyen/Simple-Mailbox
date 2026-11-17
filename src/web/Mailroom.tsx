import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCode } from '../shared/extract';
import type { AppState, Domain, Mailbox, ThreadSummary } from '../shared/types';
import { api, copy, errorText } from './api';
import { shortTime } from './format';
import { Compose, ThreadReader, type Draft } from './Reader';
import { ResendPrompt, Settings } from './Settings';

const POLL_MS = 10_000;

const selectedFromHash = () => decodeURIComponent(location.hash.slice(1)) || null;

export function Mailroom({ state, onStateChange }: { state: AppState; onStateChange: () => void }) {
  const [view, setView] = useState<'mail' | 'settings'>('mail');
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [address, setAddress] = useState<string | null>(selectedFromHash);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Bumped when the open conversation should reload, for example after new mail arrives in it.
  const [revision, setRevision] = useState(0);

  const mailbox = mailboxes?.find((m) => m.address === address) ?? null;

  const loadMailboxes = useCallback(async () => {
    const list = await api<Mailbox[]>('/mailboxes');
    setMailboxes(list);
    setAddress((a) => (a && list.some((m) => m.address === a) ? a : list[0]?.address ?? null));
  }, []);

  const loadThreads = useCallback(async (addr: string) => {
    const list = await api<ThreadSummary[]>(`/mailboxes/${encodeURIComponent(addr)}/threads`);
    if (addr !== selectedFromHash()) return;
    setThreads((prev) => {
      // New mail in the open conversation: reload it.
      const before = prev?.find((t) => t.id === openRef.current);
      const after = list.find((t) => t.id === openRef.current);
      if (before && after && after.count !== before.count) setRevision((r) => r + 1);
      return list;
    });
  }, []);

  const openRef = useRef<string | null>(null);
  openRef.current = openId;

  useEffect(() => {
    loadMailboxes().catch(() => {});
    if (state.hasResendKey) api<Domain[]>('/domains').then(setDomains).catch(() => setDomains([]));
  }, [loadMailboxes, state.hasResendKey]);

  // A Resend key without receiving connected: connect it now, which also imports mail that already arrived.
  const connecting = useRef(false);
  useEffect(() => {
    if (!state.hasResendKey || state.receiving || connecting.current) return;
    connecting.current = true;
    api<{ connected: boolean }>('/settings/receiving', { method: 'POST' })
      .then((r) => {
        if (!r.connected) return;
        loadMailboxes().catch(() => {});
        if (address) loadThreads(address).catch(() => {});
        onStateChange();
      })
      .catch(() => {});
  }, [state.hasResendKey, state.receiving, loadMailboxes, loadThreads, address, onStateChange]);

  // The open mailbox lives in the URL hash, so a reload or a shared link opens it again.
  useEffect(() => {
    if (address && location.hash.slice(1) !== encodeURIComponent(address)) history.replaceState(null, '', `#${encodeURIComponent(address)}`);
    setThreads(null);
    setOpenId(null);
    setDraft(null);
    if (address) loadThreads(address).catch(() => {});
  }, [address, loadThreads]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      loadMailboxes().catch(() => {});
      if (address) loadThreads(address).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [address, loadMailboxes, loadThreads]);

  // Open the newest conversation when a mailbox is opened on a wide screen.
  useEffect(() => {
    if (threads && threads.length && !openId && !draft && matchMedia('(min-width: 961px)').matches) setOpenId(threads[0].id);
  }, [threads, openId, draft]);

  function opened(id: string) {
    setThreads((list) => list?.map((t) => (t.id === id ? { ...t, unread: 0 } : t)) ?? list);
    loadMailboxes().catch(() => {});
  }

  async function refreshAfterSend(threadId: string) {
    if (!mailbox) return;
    await loadThreads(mailbox.address).catch(() => {});
    setOpenId(threadId);
    setRevision((r) => r + 1);
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
          <ThreadList
            mailbox={mailbox}
            hasMailboxes={!!mailboxes?.length}
            threads={threads}
            openId={draft ? null : openId}
            onOpen={(id) => { setDraft(null); setOpenId(id); }}
            onWrite={() => mailbox && setDraft({ from: mailbox.address, to: '', subject: '', text: '' })}
            onDeleted={async () => { setAddress(null); await loadMailboxes(); }}
          />
          {draft && mailbox ? (
            <Compose
              draft={draft}
              onClose={() => setDraft(null)}
              onSent={(threadId) => { setDraft(null); refreshAfterSend(threadId); }}
            />
          ) : openId && mailbox ? (
            <ThreadReader
              key={openId}
              id={openId}
              mailboxAddress={mailbox.address}
              revision={revision}
              onOpened={opened}
              onSent={refreshAfterSend}
              onDeleted={async () => { setOpenId(null); await loadThreads(mailbox.address); loadMailboxes(); }}
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

function ThreadList(props: {
  mailbox: Mailbox | null;
  hasMailboxes: boolean;
  threads: ThreadSummary[] | null;
  openId: string | null;
  onOpen: (id: string) => void;
  onWrite: () => void;
  onDeleted: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { mailbox, threads } = props;

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
    if (!mailbox || !confirm(`Delete ${mailbox.address} and its ${mailbox.total} emails? Mail sent to it afterwards is ignored.`)) return;
    try {
      await api(`/mailboxes/${encodeURIComponent(mailbox.address)}`, { method: 'DELETE' });
      props.onDeleted();
    } catch (e) {
      alert(errorText(e));
    }
  }

  const count = threads?.length ?? 0;

  return (
    <section className="list">
      <div className="list-head">
        <div className="body">{mailbox.address}</div>
        <div className="meta quiet">
          {count} {count === 1 ? 'conversation' : 'conversations'}{mailbox.unread ? `, ${mailbox.unread} unread` : ''}
        </div>
        <div className="row-actions meta">
          <button className="quiet" onClick={() => { copy(mailbox.address); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <button className="quiet" onClick={props.onWrite}>Write</button>
        </div>
      </div>

      {threads?.length === 0 && (
        <p className="body quiet">Nothing yet. Mail sent to this address shows up here within a few seconds.</p>
      )}
      {threads?.map((t) => (
        <button key={t.id} className={`msg${t.unread ? ' unread' : ''}${t.id === props.openId ? ' on' : ''}`} onClick={() => props.onOpen(t.id)}>
          <span className="body one from">
            {t.counterpartName || t.counterpart}
            {t.count > 1 && <span className="meta quiet">&nbsp;&nbsp;{t.count}</span>}
          </span>
          <span className={`meta right${t.unread ? ' ink' : ''}`}>{shortTime(t.lastAt)}</span>
          <span className="body one subj">{t.subject || '(no subject)'}</span>
          <span className="meta right accent">{t.code ? formatCode(t.code) : t.link ? 'Link' : ''}</span>
        </button>
      ))}

      <div className="list-foot">
        <button className="meta quiet" onClick={remove}>Delete mailbox</button>
      </div>
    </section>
  );
}
