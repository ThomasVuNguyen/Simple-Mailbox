-- Settings: the Resend API key, encrypted with APP_SECRET (see src/worker/crypto.ts).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every PIN that can sign in. Only an HMAC of the PIN, keyed by APP_SECRET, is stored; the PIN itself is shown once.
CREATE TABLE pins (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  pin_hash     TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Browser sessions. Only a SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  pin_id     TEXT NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_pin ON sessions(pin_id);

-- Wrong-PIN counters: one row per client IP, plus one row keyed 'global'.
CREATE TABLE auth_failures (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  first_at     INTEGER NOT NULL,
  locked_until INTEGER
);

CREATE TABLE mailboxes (
  id         TEXT PRIMARY KEY,
  address    TEXT NOT NULL UNIQUE, -- always lowercase
  domain     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT                  -- label of the PIN that created it
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  from_name    TEXT,
  from_address TEXT NOT NULL,
  to_address   TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  text         TEXT,
  html         TEXT,
  code         TEXT,              -- verification code found in the email, if any
  link         TEXT,              -- verification link found in the email, if any
  message_id   TEXT,              -- RFC 5322 Message-ID, used to thread replies
  created_at   INTEGER NOT NULL,
  read_at      INTEGER,
  read_by      TEXT               -- label of the PIN that first opened it
);
CREATE INDEX messages_mailbox ON messages(mailbox_id, created_at DESC);
