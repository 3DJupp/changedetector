-- Everything added after the initial schema, in one step.

-- Double opt-in and digest delivery.
--   users.confirm_sent_at   rate-limits confirmation emails per address.
--   users.digest_optin      0 = off, 1 = on, 2 = requested, not yet confirmed.
--   subscriptions.pending   1 until the owner of the address clicks the
--                           confirmation link, so nobody can attach
--                           subscriptions to someone else's address.
--   notifications.payload   extra delivery data: the digest day, or the
--                           webhook target URL.
ALTER TABLE users ADD COLUMN confirm_sent_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN payload TEXT;

-- Readable site URLs (/sites/openai-api-pricing). Set on creation and
-- backfilled for existing sites by the scheduler sweep; until a site has one,
-- its id keeps working as the URL key.
ALTER TABLE monitored_sites ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_sites_slug ON monitored_sites(slug) WHERE slug IS NOT NULL;

-- Public "watch this page" suggestions, moderated in the admin console.
-- One row per canonical URL; repeat suggestions add a vote instead.
CREATE TABLE site_suggestions (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  canonical_url  TEXT NOT NULL,
  category       TEXT,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED
  votes          INTEGER NOT NULL DEFAULT 1,
  site_id        TEXT REFERENCES monitored_sites(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER
);
CREATE UNIQUE INDEX idx_suggestions_canonical ON site_suggestions(canonical_url);
CREATE INDEX idx_suggestions_queue ON site_suggestions(status, votes DESC, created_at);
