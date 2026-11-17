import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { api, whenSignedOut } from './api';
import { SignIn, Setup } from './Gate';
import { Mailroom } from './Mailroom';

export function App() {
  const [state, setState] = useState<AppState | null>(null);

  const refresh = useCallback(async () => {
    setState(await api<AppState>('/state'));
  }, []);

  useEffect(() => {
    whenSignedOut(() => setState((s) => (s ? { ...s, signedIn: false } : s)));
    refresh();
  }, [refresh]);

  if (!state) return null;
  if (state.setup) return <Setup onDone={refresh} />;
  if (!state.signedIn) return <SignIn onSignedIn={refresh} />;
  return <Mailroom state={state} onStateChange={refresh} />;
}
