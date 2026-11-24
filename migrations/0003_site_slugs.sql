-- Readable site URLs (/sites/openai-api-pricing). Filled in for new sites on
-- creation and backfilled for existing ones by the scheduler sweep; until a
-- site has one, its id keeps working as the URL key.
ALTER TABLE monitored_sites ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_sites_slug ON monitored_sites(slug) WHERE slug IS NOT NULL;
