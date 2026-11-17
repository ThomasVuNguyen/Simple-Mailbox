-- Mail received through Resend Inbound: Resend's email id, so a webhook retry or a backfill never stores it twice.
ALTER TABLE messages ADD COLUMN resend_id TEXT;
CREATE UNIQUE INDEX messages_resend ON messages(mailbox_id, resend_id) WHERE resend_id IS NOT NULL;
