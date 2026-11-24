-- The Internet Change Detector — core schema (Cloudflare D1 / SQLite).
--
-- Architectural note: this database is NOT the source of truth for content.
-- It records "we observed this URL at this time". The bytes themselves live in
-- the ContentStore (IPFS / R2) and are addressed by their content hash (CID).

-- ---------------------------------------------------------------------------
-- Monitored sites
-- ---------------------------------------------------------------------------
CREATE TABLE monitored_sites (
  id                 TEXT PRIMARY KEY,
  slug               TEXT,                             -- readable URL key; set on creation, backfilled by the sweep
  url                TEXT NOT NULL,
  canonical_url      TEXT NOT NULL,
  host               TEXT NOT NULL,
  title              TEXT,
  description        TEXT,
  category           TEXT NOT NULL DEFAULT 'Companies',
  status             TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE | PAUSED | ERROR | ARCHIVED
  crawl_interval_s   INTEGER NOT NULL DEFAULT 21600,   -- seconds between crawls
  priority           TEXT NOT NULL DEFAULT 'NORMAL',   -- HIGH | NORMAL | LOW
  render_mode        TEXT NOT NULL DEFAULT 'AUTO',     -- AUTO | HTTP | BROWSER
  normalization      TEXT,                             -- JSON: per-site normalization overrides
  robots_allowed     INTEGER NOT NULL DEFAULT 1,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  next_check_at      INTEGER NOT NULL DEFAULT 0,       -- unix seconds; scheduler ordering key
  last_checked_at    INTEGER,
  last_changed_at    INTEGER,
  last_status        INTEGER,
  last_error         TEXT,
  snapshot_count     INTEGER NOT NULL DEFAULT 0,
  change_count       INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_sites_canonical ON monitored_sites(canonical_url);
CREATE INDEX idx_sites_due ON monitored_sites(status, next_check_at);
CREATE INDEX idx_sites_category ON monitored_sites(category, last_changed_at DESC);
CREATE INDEX idx_sites_host ON monitored_sites(host);
CREATE UNIQUE INDEX idx_sites_slug ON monitored_sites(slug) WHERE slug IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Snapshots — one row per capture, changed or not.
-- ---------------------------------------------------------------------------
CREATE TABLE snapshots (
  id                   TEXT PRIMARY KEY,
  site_id              TEXT NOT NULL REFERENCES monitored_sites(id) ON DELETE CASCADE,
  captured_at          INTEGER NOT NULL,
  http_status          INTEGER,
  content_type         TEXT,
  final_url            TEXT,
  fetch_method         TEXT NOT NULL DEFAULT 'HTTP',   -- HTTP | BROWSER
  fetch_ms             INTEGER,
  raw_bytes            INTEGER,
  content_hash         TEXT NOT NULL,                  -- sha-256 of normalized content
  raw_hash             TEXT,                           -- sha-256 of raw response body
  cid                  TEXT,                           -- artifact directory CID
  page_cid             TEXT,                           -- page.html CID
  text_cid             TEXT,                           -- content.txt CID
  raw_storage_ref      TEXT,                           -- R2 object key for the raw body
  normalized_content   TEXT,                           -- canonical structural JSON
  text_content         TEXT,                           -- extracted visible text
  title                TEXT,
  headers              TEXT,                           -- JSON of retained response headers
  previous_snapshot_id TEXT REFERENCES snapshots(id),
  is_duplicate         INTEGER NOT NULL DEFAULT 0,     -- identical to previous capture
  created_at           INTEGER NOT NULL
);

CREATE INDEX idx_snapshots_site ON snapshots(site_id, captured_at DESC);
CREATE INDEX idx_snapshots_hash ON snapshots(site_id, content_hash);
CREATE INDEX idx_snapshots_cid ON snapshots(cid);

-- ---------------------------------------------------------------------------
-- Change events — the public artefact of the whole system.
-- ---------------------------------------------------------------------------
CREATE TABLE change_events (
  id                     TEXT PRIMARY KEY,
  slug                   TEXT NOT NULL,
  site_id                TEXT NOT NULL REFERENCES monitored_sites(id) ON DELETE CASCADE,
  previous_snapshot_id   TEXT REFERENCES snapshots(id),
  current_snapshot_id    TEXT NOT NULL REFERENCES snapshots(id),
  detected_at            INTEGER NOT NULL,
  change_type            TEXT NOT NULL,   -- CONTENT TEXT PRICE LINK IMAGE STRUCTURE METADATA TITLE STATUS_CODE
  severity               TEXT NOT NULL,   -- TRIVIAL MINOR MODERATE SIGNIFICANT MAJOR
  change_score           INTEGER NOT NULL DEFAULT 0,        -- 0-100 magnitude
  interestingness_score  INTEGER NOT NULL DEFAULT 0,        -- 0-100 editorial value
  headline               TEXT NOT NULL,
  summary                TEXT NOT NULL,
  label                  TEXT,            -- e.g. "Pro plan"
  before_value           TEXT,            -- e.g. "$19"
  after_value            TEXT,            -- e.g. "$24"
  delta                  TEXT,            -- e.g. "+26.3%"
  delta_note             TEXT,
  diff                   TEXT NOT NULL,   -- JSON: line/word/structural diff payload
  signals                TEXT,            -- JSON: scoring breakdown
  suppressed             TEXT,            -- JSON: noise suppression counters
  ai_model               TEXT,
  ai_analysis            TEXT,            -- JSON: model output
  published              INTEGER NOT NULL DEFAULT 0,
  false_positive         INTEGER NOT NULL DEFAULT 0,
  views                  INTEGER NOT NULL DEFAULT 0,
  shares                 INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_changes_slug ON change_events(slug);
CREATE INDEX idx_changes_feed ON change_events(published, false_positive, detected_at DESC);
CREATE INDEX idx_changes_ranked ON change_events(published, interestingness_score DESC, detected_at DESC);
CREATE INDEX idx_changes_site ON change_events(site_id, detected_at DESC);
CREATE INDEX idx_changes_type ON change_events(change_type, detected_at DESC);

-- Full-text search over the public change corpus.
CREATE VIRTUAL TABLE changes_fts USING fts5(
  change_id UNINDEXED,
  headline,
  summary,
  site_title,
  url,
  category,
  change_type,
  tokenize = 'porter unicode61'
);

-- ---------------------------------------------------------------------------
-- Crawl log — reliability analytics and per-domain backoff bookkeeping.
-- ---------------------------------------------------------------------------
CREATE TABLE crawl_logs (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES monitored_sites(id) ON DELETE CASCADE,
  started_at   INTEGER NOT NULL,
  duration_ms  INTEGER,
  http_status  INTEGER,
  outcome      TEXT NOT NULL,   -- CHANGED | IDENTICAL | ERROR | SKIPPED | BLOCKED
  method       TEXT,
  bytes        INTEGER,
  error        TEXT,
  snapshot_id  TEXT
);

CREATE INDEX idx_crawl_logs_site ON crawl_logs(site_id, started_at DESC);
CREATE INDEX idx_crawl_logs_time ON crawl_logs(started_at DESC);

-- ---------------------------------------------------------------------------
-- Users, subscriptions and the notification outbox.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  token         TEXT NOT NULL,          -- opaque confirm/unsubscribe token
  digest_optin  INTEGER NOT NULL DEFAULT 0,   -- 0 off, 1 on, 2 requested but not yet confirmed
  confirm_sent_at INTEGER,              -- rate-limits confirmation emails per address
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_token ON users(token);

CREATE TABLE subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id     TEXT REFERENCES monitored_sites(id) ON DELETE CASCADE,
  category    TEXT,
  min_score   INTEGER NOT NULL DEFAULT 40,
  channel     TEXT NOT NULL DEFAULT 'EMAIL',   -- EMAIL | WEBHOOK | RSS
  target      TEXT,                            -- webhook URL when channel = WEBHOOK
  pending     INTEGER NOT NULL DEFAULT 1,      -- 1 until the address owner clicks the confirmation link
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_subs_site ON subscriptions(site_id);
CREATE INDEX idx_subs_category ON subscriptions(category);
CREATE UNIQUE INDEX idx_subs_unique ON subscriptions(user_id, IFNULL(site_id,''), IFNULL(category,''), channel);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  change_id   TEXT REFERENCES change_events(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | SENT | FAILED | SKIPPED
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  payload     TEXT,                            -- digest day, or webhook target URL
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX idx_notifications_status ON notifications(status, created_at);

-- ---------------------------------------------------------------------------
-- Product analytics (aggregate counters, no personal data).
-- ---------------------------------------------------------------------------
CREATE TABLE metrics_daily (
  day               TEXT PRIMARY KEY,          -- YYYY-MM-DD
  crawls            INTEGER NOT NULL DEFAULT 0,
  crawl_errors      INTEGER NOT NULL DEFAULT 0,
  snapshots         INTEGER NOT NULL DEFAULT 0,
  changes           INTEGER NOT NULL DEFAULT 0,
  published_changes INTEGER NOT NULL DEFAULT 0,
  false_positives   INTEGER NOT NULL DEFAULT 0,
  browser_fetches   INTEGER NOT NULL DEFAULT 0,
  views             INTEGER NOT NULL DEFAULT 0,
  shares            INTEGER NOT NULL DEFAULT 0
);

-- Cached daily digests so the public page and email share one artefact.
CREATE TABLE digests (
  day        TEXT PRIMARY KEY,
  change_ids TEXT NOT NULL,     -- JSON array
  intro      TEXT,
  stats      TEXT,              -- JSON
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Public "watch this page" suggestions, moderated in the admin console.
-- One row per canonical URL; repeat suggestions add a vote instead.
-- ---------------------------------------------------------------------------
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
