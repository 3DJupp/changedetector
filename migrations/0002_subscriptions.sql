-- Double opt-in and digest delivery.
--
-- users.confirm_sent_at    rate-limits confirmation emails per address.
-- users.digest_optin       0 = off, 1 = on, 2 = requested but not yet confirmed.
-- subscriptions.pending    1 until the owner of the address clicks the
--                          confirmation link, so nobody can attach
--                          subscriptions to someone else's confirmed address.
-- notifications.payload    lets an outbox row carry something other than a
--                          change event (the daily digest stores its day here).
ALTER TABLE users ADD COLUMN confirm_sent_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN payload TEXT;
