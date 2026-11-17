export interface AppState {
  /** True until the first PIN exists. */
  setup: boolean;
  signedIn: boolean;
  hasResendKey: boolean;
  /** Resend sends received mail to this app's webhook. */
  receiving: boolean;
  /** Label of the PIN this session signed in with. */
  pinLabel: string | null;
}

export interface Domain {
  name: string;
  /** Resend's status for sending: "verified", "pending", "failed", ... */
  status: string;
}

export interface Mailbox {
  id: string;
  address: string;
  domain: string;
  total: number;
  unread: number;
  lastAt: number | null;
}

export interface MessageSummary {
  id: string;
  mailboxId: string;
  /** The conversation this email belongs to. */
  threadId: string;
  direction: 'in' | 'out';
  fromName: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string;
  snippet: string;
  code: string | null;
  link: string | null;
  createdAt: number;
  readAt: number | null;
  readBy: string | null;
}

export interface Message extends MessageSummary {
  text: string | null;
  html: string | null;
}

export interface ThreadSummary {
  id: string;
  mailboxId: string;
  /** Subject of the first email. */
  subject: string;
  /** The other person's address, and their name when they have written. */
  counterpart: string;
  counterpartName: string | null;
  count: number;
  unread: number;
  lastAt: number;
  lastDirection: 'in' | 'out';
  snippet: string;
  /** The newest verification code or link in the conversation. */
  code: string | null;
  link: string | null;
}

export interface Thread {
  id: string;
  mailboxId: string;
  subject: string;
  /** Oldest first. */
  messages: Message[];
}

export interface PinInfo {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** The PIN this session signed in with. */
  current: boolean;
}

export interface SignInError {
  error: string;
  attemptsLeft?: number;
  lockedUntil?: number;
}
