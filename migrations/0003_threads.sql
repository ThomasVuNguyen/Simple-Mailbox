-- Conversations. Existing rows get a thread_id the first time their mailbox is listed (see threads.ts).
ALTER TABLE messages ADD COLUMN thread_id TEXT;
ALTER TABLE messages ADD COLUMN in_reply_to TEXT;  -- Message-ID this email answers
ALTER TABLE messages ADD COLUMN refs TEXT;         -- References: earlier Message-IDs, space separated
ALTER TABLE messages ADD COLUMN subject_key TEXT;  -- subject without "Re:" / "Fwd:", lowercased
ALTER TABLE messages ADD COLUMN counterpart TEXT;  -- the other person's address
CREATE INDEX messages_thread ON messages(thread_id, created_at);
CREATE INDEX messages_message_id ON messages(mailbox_id, message_id);
