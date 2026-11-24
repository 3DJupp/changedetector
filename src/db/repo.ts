/**
 * Data access. Thin, explicit SQL over D1 — no ORM, no surprises.
 */
import type { ChangeEvent, Env, MonitoredSite, Snapshot } from '../types';
import { newId, newSlug } from '../lib/hash';
import { siteSlugBase } from '../lib/paths';

export const now = () => Math.floor(Date.now() / 1000);

export class Repo {
  constructor(private readonly db: D1Database) {}

  // --- sites --------------------------------------------------------------

  async createSite(input: {
    url: string;
    canonicalUrl: string;
    host: string;
    title?: string | null;
    description?: string | null;
    category: string;
    crawlIntervalS: number;
    priority: string;
    renderMode?: string;
    normalization?: string | null;
    robotsAllowed?: boolean;
  }): Promise<MonitoredSite> {
    const id = newId('site');
    const ts = now();
    await this.db
      .prepare(
        `INSERT INTO monitored_sites
         (id, url, canonical_url, host, title, description, category, status, crawl_interval_s,
          priority, render_mode, normalization, robots_allowed, next_check_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id, input.url, input.canonicalUrl, input.host, input.title ?? null, input.description ?? null,
        input.category, input.crawlIntervalS, input.priority, input.renderMode ?? 'AUTO',
        input.normalization ?? null, input.robotsAllowed === false ? 0 : 1, ts, ts, ts,
      )
      .run();
    const created = (await this.getSite(id))!;
    created.slug = await this.ensureSiteSlug(created);
    return created;
  }

  /** Looks a site up by id or by its readable slug. */
  async getSite(idOrSlug: string): Promise<MonitoredSite | null> {
    return this.db
      .prepare('SELECT * FROM monitored_sites WHERE id = ? OR slug = ? LIMIT 1')
      .bind(idOrSlug, idOrSlug)
      .first<MonitoredSite>();
  }

  /** Gives a site a unique readable slug if it has none. Returns the slug. */
  async ensureSiteSlug(site: Pick<MonitoredSite, 'id' | 'slug' | 'title' | 'canonical_url'>): Promise<string> {
    if (site.slug) return site.slug;
    const base = siteSlugBase(site);
    for (let attempt = 1; attempt <= 50; attempt++) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`;
      // Never let a slug look like an id, or lookups by id could be shadowed.
      if (/^site_[0-9a-f]+$/.test(candidate)) continue;
      const result = await this.db
        .prepare('UPDATE monitored_sites SET slug = ? WHERE id = ? AND slug IS NULL AND NOT EXISTS (SELECT 1 FROM monitored_sites WHERE slug = ?)')
        .bind(candidate, site.id, candidate)
        .run();
      if ((result.meta?.changes ?? 0) > 0) return candidate;
      const current = await this.db.prepare('SELECT slug FROM monitored_sites WHERE id = ?').bind(site.id).first<{ slug: string | null }>();
      if (current?.slug) return current.slug;
    }
    return site.id;
  }

  async backfillSiteSlugs(limit = 50): Promise<number> {
    const rows = await this.db
      .prepare('SELECT id, slug, title, canonical_url FROM monitored_sites WHERE slug IS NULL LIMIT ?')
      .bind(limit)
      .all<Pick<MonitoredSite, 'id' | 'slug' | 'title' | 'canonical_url'>>();
    for (const row of rows.results ?? []) await this.ensureSiteSlug(row);
    return rows.results?.length ?? 0;
  }

  async getSiteByCanonical(canonicalUrl: string): Promise<MonitoredSite | null> {
    return this.db
      .prepare('SELECT * FROM monitored_sites WHERE canonical_url = ?')
      .bind(canonicalUrl)
      .first<MonitoredSite>();
  }

  async listSites(options: { category?: string; status?: string; limit?: number; offset?: number; q?: string } = {}) {
    const clauses: string[] = [];
    const binds: unknown[] = [];
    if (options.category && options.category !== 'All') {
      clauses.push('category = ?');
      binds.push(options.category);
    }
    if (options.status) {
      clauses.push('status = ?');
      binds.push(options.status);
    }
    if (options.q) {
      clauses.push('(url LIKE ? OR title LIKE ?)');
      binds.push(`%${options.q}%`, `%${options.q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(options.limit ?? 100, 500);
    const offset = options.offset ?? 0;
    const rows = await this.db
      .prepare(`SELECT * FROM monitored_sites ${where} ORDER BY last_changed_at DESC NULLS LAST, created_at DESC LIMIT ? OFFSET ?`)
      .bind(...binds, limit, offset)
      .all<MonitoredSite>();
    const total = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM monitored_sites ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    return { sites: rows.results ?? [], total: total?.c ?? 0 };
  }

  /** Sites whose next_check_at has passed, highest priority first. */
  async dueSites(limit: number): Promise<MonitoredSite[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM monitored_sites
         WHERE status = 'ACTIVE' AND next_check_at <= ?
         ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END, next_check_at ASC
         LIMIT ?`,
      )
      .bind(now(), limit)
      .all<MonitoredSite>();
    return rows.results ?? [];
  }

  async updateSite(id: string, patch: Partial<Record<string, unknown>>): Promise<void> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    await this.db
      .prepare(`UPDATE monitored_sites SET ${assignments}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((key) => patch[key] as never), now(), id)
      .run();
  }

  async deleteSite(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM change_events WHERE site_id = ?').bind(id),
      this.db.prepare('DELETE FROM snapshots WHERE site_id = ?').bind(id),
      this.db.prepare('DELETE FROM crawl_logs WHERE site_id = ?').bind(id),
      this.db.prepare('DELETE FROM monitored_sites WHERE id = ?').bind(id),
    ]);
  }

  // --- snapshots ----------------------------------------------------------

  async createSnapshot(input: Omit<Snapshot, 'id' | 'created_at'>): Promise<Snapshot> {
    const id = newId('snap');
    const ts = now();
    await this.db
      .prepare(
        `INSERT INTO snapshots
         (id, site_id, captured_at, http_status, content_type, final_url, fetch_method, fetch_ms,
          raw_bytes, content_hash, raw_hash, cid, page_cid, text_cid, raw_storage_ref,
          normalized_content, text_content, title, headers, previous_snapshot_id, is_duplicate, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id, input.site_id, input.captured_at, input.http_status, input.content_type, input.final_url,
        input.fetch_method, input.fetch_ms, input.raw_bytes, input.content_hash, input.raw_hash,
        input.cid, input.page_cid, input.text_cid, input.raw_storage_ref, input.normalized_content,
        input.text_content, input.title, input.headers, input.previous_snapshot_id, input.is_duplicate, ts,
      )
      .run();
    return { ...input, id, created_at: ts } as Snapshot;
  }

  async getSnapshot(id: string): Promise<Snapshot | null> {
    return this.db.prepare('SELECT * FROM snapshots WHERE id = ?').bind(id).first<Snapshot>();
  }

  async getSnapshotByCid(cid: string): Promise<Snapshot | null> {
    return this.db.prepare('SELECT * FROM snapshots WHERE cid = ? ORDER BY captured_at DESC').bind(cid).first<Snapshot>();
  }

  async latestSnapshot(siteId: string): Promise<Snapshot | null> {
    return this.db
      .prepare('SELECT * FROM snapshots WHERE site_id = ? ORDER BY captured_at DESC LIMIT 1')
      .bind(siteId)
      .first<Snapshot>();
  }

  /** Most recent snapshot whose content differed, i.e. the real "previous version". */
  async latestDistinctSnapshot(siteId: string): Promise<Snapshot | null> {
    return this.db
      .prepare('SELECT * FROM snapshots WHERE site_id = ? AND is_duplicate = 0 ORDER BY captured_at DESC LIMIT 1')
      .bind(siteId)
      .first<Snapshot>();
  }

  async listSnapshots(siteId: string, limit = 50): Promise<Snapshot[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, site_id, captured_at, http_status, content_type, fetch_method, cid, content_hash,
                is_duplicate, raw_bytes, title FROM snapshots
         WHERE site_id = ? ORDER BY captured_at DESC LIMIT ?`,
      )
      .bind(siteId, Math.min(limit, 200))
      .all<Snapshot>();
    return rows.results ?? [];
  }

  async setSnapshotArtifact(id: string, cid: string, pageCid: string, textCid: string): Promise<void> {
    await this.db
      .prepare('UPDATE snapshots SET cid = ?, page_cid = ?, text_cid = ? WHERE id = ?')
      .bind(cid, pageCid, textCid, id)
      .run();
  }

  // --- change events ------------------------------------------------------

  async createChange(input: Omit<ChangeEvent, 'id' | 'slug' | 'created_at' | 'views' | 'shares'>): Promise<ChangeEvent> {
    const id = newId('chg');
    const slug = newSlug();
    const ts = now();
    await this.db
      .prepare(
        `INSERT INTO change_events
         (id, slug, site_id, previous_snapshot_id, current_snapshot_id, detected_at, change_type, severity,
          change_score, interestingness_score, headline, summary, label, before_value, after_value, delta,
          delta_note, diff, signals, suppressed, ai_model, ai_analysis, published, false_positive, views, shares, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)`,
      )
      .bind(
        id, slug, input.site_id, input.previous_snapshot_id, input.current_snapshot_id, input.detected_at,
        input.change_type, input.severity, input.change_score, input.interestingness_score, input.headline,
        input.summary, input.label, input.before_value, input.after_value, input.delta, input.delta_note,
        input.diff, input.signals, input.suppressed, input.ai_model, input.ai_analysis,
        input.published, input.false_positive, ts,
      )
      .run();
    return { ...input, id, slug, created_at: ts, views: 0, shares: 0 } as ChangeEvent;
  }

  async indexChange(change: ChangeEvent, site: MonitoredSite): Promise<void> {
    await this.db
      .prepare('DELETE FROM changes_fts WHERE change_id = ?')
      .bind(change.id)
      .run()
      .catch(() => {});
    await this.db
      .prepare(
        `INSERT INTO changes_fts (change_id, headline, summary, site_title, url, category, change_type)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(
        change.id, change.headline, change.summary, site.title ?? site.host,
        site.canonical_url, site.category, change.change_type,
      )
      .run();
  }

  async getChange(idOrSlug: string): Promise<ChangeEvent | null> {
    return this.db
      .prepare('SELECT * FROM change_events WHERE id = ? OR slug = ? LIMIT 1')
      .bind(idOrSlug, idOrSlug)
      .first<ChangeEvent>();
  }

  async updateChange(id: string, patch: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    await this.db
      .prepare(`UPDATE change_events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...keys.map((k) => patch[k] as never), id)
      .run();
  }

  async listChanges(options: {
    category?: string;
    siteId?: string;
    changeType?: string;
    severity?: string;
    minScore?: number;
    since?: number;
    includeUnpublished?: boolean;
    order?: 'recent' | 'interesting';
    limit?: number;
    offset?: number;
  } = {}): Promise<{ changes: (ChangeEvent & { site: Partial<MonitoredSite> })[]; total: number }> {
    const clauses = ['c.false_positive = 0'];
    const binds: unknown[] = [];
    if (!options.includeUnpublished) clauses.push('c.published = 1');
    if (options.category && options.category !== 'All') {
      clauses.push('s.category = ?');
      binds.push(options.category);
    }
    if (options.siteId) {
      clauses.push('c.site_id = ?');
      binds.push(options.siteId);
    }
    if (options.changeType) {
      clauses.push('c.change_type = ?');
      binds.push(options.changeType);
    }
    if (options.severity) {
      clauses.push('c.severity = ?');
      binds.push(options.severity);
    }
    if (options.minScore !== undefined) {
      clauses.push('c.interestingness_score >= ?');
      binds.push(options.minScore);
    }
    if (options.since !== undefined) {
      clauses.push('c.detected_at >= ?');
      binds.push(options.since);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const order =
      options.order === 'interesting'
        ? 'ORDER BY c.interestingness_score DESC, c.detected_at DESC'
        : 'ORDER BY c.detected_at DESC';
    const limit = Math.min(options.limit ?? 24, 100);
    const offset = options.offset ?? 0;

    const rows = await this.db
      .prepare(
        `SELECT c.*, s.title AS site_title, s.canonical_url AS site_url, s.category AS site_category,
                s.host AS site_host, s.id AS site_pk,
                cur.cid AS current_cid, cur.captured_at AS current_captured_at, prev.cid AS previous_cid
         FROM change_events c
         JOIN monitored_sites s ON s.id = c.site_id
         LEFT JOIN snapshots cur ON cur.id = c.current_snapshot_id
         LEFT JOIN snapshots prev ON prev.id = c.previous_snapshot_id
         ${where} ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all<ChangeEvent & Record<string, string>>();

    const total = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM change_events c JOIN monitored_sites s ON s.id = c.site_id ${where}`)
      .bind(...binds)
      .first<{ c: number }>();

    return {
      changes: (rows.results ?? []).map((row) => ({
        ...row,
        site: {
          id: row.site_pk,
          title: row.site_title,
          canonical_url: row.site_url,
          category: row.site_category,
          host: row.site_host,
        },
      })),
      total: total?.c ?? 0,
    };
  }

  async searchChanges(query: string, options: { category?: string; limit?: number } = {}) {
    const cleaned = query.replace(/["'*]/g, ' ').trim();
    if (!cleaned) return { changes: [], total: 0 };
    const fts = cleaned
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((term) => `"${term}"*`)
      .join(' OR ');
    const limit = Math.min(options.limit ?? 40, 100);
    const rows = await this.db
      .prepare(
        `SELECT c.*, s.title AS site_title, s.canonical_url AS site_url, s.category AS site_category,
                s.host AS site_host, s.id AS site_pk, cur.cid AS current_cid, bm25(changes_fts) AS rank
         FROM changes_fts f
         JOIN change_events c ON c.id = f.change_id
         JOIN monitored_sites s ON s.id = c.site_id
         LEFT JOIN snapshots cur ON cur.id = c.current_snapshot_id
         WHERE changes_fts MATCH ? AND c.published = 1 AND c.false_positive = 0
         ${options.category && options.category !== 'All' ? 'AND s.category = ?' : ''}
         ORDER BY rank LIMIT ?`,
      )
      .bind(...(options.category && options.category !== 'All' ? [fts, options.category, limit] : [fts, limit]))
      .all<ChangeEvent & Record<string, string>>();

    return {
      changes: (rows.results ?? []).map((row) => ({
        ...row,
        site: {
          id: row.site_pk,
          title: row.site_title,
          canonical_url: row.site_url,
          category: row.site_category,
          host: row.site_host,
        },
      })),
      total: rows.results?.length ?? 0,
    };
  }

  /** Published changes by id, in the order given. Used to hydrate semantic search hits. */
  async changesByIds(ids: string[], category?: string) {
    if (!ids.length) return [];
    const byCategory = category && category !== 'All';
    const rows = await this.db
      .prepare(
        `SELECT c.*, s.title AS site_title, s.canonical_url AS site_url, s.category AS site_category,
                s.host AS site_host, s.id AS site_pk, cur.cid AS current_cid
         FROM change_events c
         JOIN monitored_sites s ON s.id = c.site_id
         LEFT JOIN snapshots cur ON cur.id = c.current_snapshot_id
         WHERE c.id IN (${ids.map(() => '?').join(',')}) AND c.published = 1 AND c.false_positive = 0
         ${byCategory ? 'AND s.category = ?' : ''}`,
      )
      .bind(...ids, ...(byCategory ? [category] : []))
      .all<ChangeEvent & Record<string, string>>();
    const order = new Map(ids.map((id, index) => [id, index]));
    return (rows.results ?? [])
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((row) => ({
        ...row,
        site: { id: row.site_pk, title: row.site_title, canonical_url: row.site_url, category: row.site_category, host: row.site_host },
      }));
  }

  // --- sitemap ------------------------------------------------------------

  async countPublishedChanges(): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS c FROM change_events WHERE published = 1 AND false_positive = 0')
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async sitemapChanges(offset: number, limit: number) {
    const rows = await this.db
      .prepare(
        `SELECT slug, headline, detected_at FROM change_events
         WHERE published = 1 AND false_positive = 0
         ORDER BY detected_at ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .bind(limit, offset)
      .all<{ slug: string; headline: string; detected_at: number }>();
    return rows.results ?? [];
  }

  async sitemapSites() {
    const rows = await this.db
      .prepare(
        `SELECT id, slug, category, COALESCE(last_changed_at, updated_at, created_at) AS lastmod
         FROM monitored_sites WHERE status != 'ARCHIVED' ORDER BY created_at LIMIT 50000`,
      )
      .all<{ id: string; slug: string | null; category: string; lastmod: number }>();
    return rows.results ?? [];
  }

  async sitemapDigests() {
    const rows = await this.db
      .prepare(`SELECT day, created_at FROM digests WHERE change_ids != '[]' ORDER BY day DESC LIMIT 50000`)
      .all<{ day: string; created_at: number }>();
    return rows.results ?? [];
  }

  /** Last published change per category, for category lastmod. */
  async categoryLastChanged(): Promise<Record<string, number>> {
    const rows = await this.db
      .prepare(
        `SELECT s.category AS category, MAX(c.detected_at) AS last FROM change_events c
         JOIN monitored_sites s ON s.id = c.site_id
         WHERE c.published = 1 AND c.false_positive = 0 GROUP BY s.category`,
      )
      .all<{ category: string; last: number }>();
    return Object.fromEntries((rows.results ?? []).map((row) => [row.category, row.last]));
  }

  // --- crawl logs & metrics ----------------------------------------------

  async logCrawl(input: {
    siteId: string;
    startedAt: number;
    durationMs: number;
    httpStatus: number | null;
    outcome: string;
    method?: string;
    bytes?: number;
    error?: string | null;
    snapshotId?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO crawl_logs (id, site_id, started_at, duration_ms, http_status, outcome, method, bytes, error, snapshot_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        newId('crawl'), input.siteId, input.startedAt, input.durationMs, input.httpStatus, input.outcome,
        input.method ?? 'HTTP', input.bytes ?? 0, input.error ?? null, input.snapshotId ?? null,
      )
      .run();
  }

  async recentCrawlLogs(limit = 50) {
    const rows = await this.db
      .prepare(
        `SELECT l.*, s.canonical_url AS url, s.title AS site_title FROM crawl_logs l
         JOIN monitored_sites s ON s.id = l.site_id ORDER BY l.started_at DESC LIMIT ?`,
      )
      .bind(Math.min(limit, 200))
      .all();
    return rows.results ?? [];
  }

  async bumpMetric(field: string, amount = 1, day = new Date().toISOString().slice(0, 10)): Promise<void> {
    const allowed = new Set([
      'crawls', 'crawl_errors', 'snapshots', 'changes', 'published_changes',
      'false_positives', 'browser_fetches', 'views', 'shares',
    ]);
    if (!allowed.has(field)) return;
    await this.db
      .prepare(
        `INSERT INTO metrics_daily (day, ${field}) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + ?`,
      )
      .bind(day, amount, amount)
      .run();
  }

  async stats() {
    const [sites, changes, week, snapshots, crawl] = await Promise.all([
      this.db.prepare("SELECT COUNT(*) AS c FROM monitored_sites WHERE status != 'ARCHIVED'").first<{ c: number }>(),
      this.db.prepare('SELECT COUNT(*) AS c FROM change_events WHERE false_positive = 0').first<{ c: number }>(),
      this.db
        .prepare('SELECT COUNT(*) AS c FROM change_events WHERE detected_at >= ? AND false_positive = 0')
        .bind(now() - 604800)
        .first<{ c: number }>(),
      this.db.prepare('SELECT COUNT(*) AS c FROM snapshots').first<{ c: number }>(),
      this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN outcome = 'ERROR' THEN 0 ELSE 1 END) AS ok,
             COUNT(*) AS total,
             SUM(CASE WHEN method = 'BROWSER' THEN 1 ELSE 0 END) AS browser
           FROM crawl_logs WHERE started_at >= ?`,
        )
        .bind(now() - 86400)
        .first<{ ok: number; total: number; browser: number }>(),
    ]);
    const pinned = await this.db
      .prepare('SELECT COUNT(*) AS c FROM snapshots WHERE cid IS NOT NULL')
      .first<{ c: number }>();
    const published = await this.db
      .prepare('SELECT COUNT(*) AS c FROM change_events WHERE published = 1 AND false_positive = 0')
      .first<{ c: number }>();
    const falsePositives = await this.db
      .prepare('SELECT COUNT(*) AS c FROM change_events WHERE false_positive = 1')
      .first<{ c: number }>();

    return {
      sites: sites?.c ?? 0,
      changes: changes?.c ?? 0,
      changesThisWeek: week?.c ?? 0,
      snapshots: snapshots?.c ?? 0,
      publishedChanges: published?.c ?? 0,
      falsePositives: falsePositives?.c ?? 0,
      pinnedPercent: snapshots?.c ? Math.round(((pinned?.c ?? 0) / snapshots.c) * 1000) / 10 : 0,
      crawlSuccessPercent: crawl?.total ? Math.round(((crawl.ok ?? 0) / crawl.total) * 1000) / 10 : 100,
      browserFetchPercent: crawl?.total ? Math.round(((crawl.browser ?? 0) / crawl.total) * 1000) / 10 : 0,
      crawls24h: crawl?.total ?? 0,
    };
  }

  async categoryCounts(): Promise<Record<string, number>> {
    const rows = await this.db
      .prepare(
        `SELECT s.category AS category, COUNT(*) AS c FROM change_events c
         JOIN monitored_sites s ON s.id = c.site_id
         WHERE c.published = 1 AND c.false_positive = 0 GROUP BY s.category`,
      )
      .all<{ category: string; c: number }>();
    const out: Record<string, number> = {};
    for (const row of rows.results ?? []) out[row.category] = row.c;
    return out;
  }

  /** Weekly change counts for a site's sparkline. */
  async weeklyChangeCounts(siteId: string, weeks = 26): Promise<number[]> {
    const since = now() - weeks * 604800;
    const rows = await this.db
      .prepare('SELECT detected_at FROM change_events WHERE site_id = ? AND detected_at >= ?')
      .bind(siteId, since)
      .all<{ detected_at: number }>();
    const buckets = new Array(weeks).fill(0);
    for (const row of rows.results ?? []) {
      const index = Math.min(weeks - 1, Math.floor((row.detected_at - since) / 604800));
      buckets[index]++;
    }
    return buckets;
  }

  // --- users, subscriptions, notifications --------------------------------

  async upsertUser(email: string): Promise<SubscriberUser & { created: boolean }> {
    const existing = await this.db
      .prepare('SELECT id, email, token, verified, digest_optin, confirm_sent_at FROM users WHERE email = ?')
      .bind(email)
      .first<SubscriberUser>();
    if (existing) return { ...existing, created: false };
    const id = newId('usr');
    const token = newId('tok').replace('tok_', '');
    await this.db
      .prepare('INSERT INTO users (id, email, verified, token, digest_optin, created_at) VALUES (?,?,0,?,0,?)')
      .bind(id, email, token, now())
      .run();
    return { id, email, token, verified: 0, digest_optin: 0, confirm_sent_at: null, created: true };
  }

  async getUserByToken(token: string): Promise<SubscriberUser | null> {
    if (!/^[0-9a-f]{16,64}$/.test(token)) return null;
    return this.db
      .prepare('SELECT id, email, token, verified, digest_optin, confirm_sent_at FROM users WHERE token = ?')
      .bind(token)
      .first<SubscriberUser>();
  }

  /** Marks the digest as requested; it switches on when the address is confirmed. */
  async requestDigest(userId: string): Promise<void> {
    await this.db.prepare('UPDATE users SET digest_optin = 2 WHERE id = ? AND digest_optin = 0').bind(userId).run();
  }

  async markConfirmSent(userId: string): Promise<void> {
    await this.db.prepare('UPDATE users SET confirm_sent_at = ? WHERE id = ?').bind(now(), userId).run();
  }

  /** Confirms the address and activates everything it requested so far. */
  async confirmUser(userId: string): Promise<{ activated: number }> {
    const results = await this.db.batch([
      this.db.prepare('UPDATE users SET verified = 1, digest_optin = CASE WHEN digest_optin = 2 THEN 1 ELSE digest_optin END WHERE id = ?').bind(userId),
      this.db.prepare('UPDATE subscriptions SET pending = 0 WHERE user_id = ? AND pending = 1').bind(userId),
    ]);
    return { activated: results[1]?.meta?.changes ?? 0 };
  }

  /** Removes every subscription and the digest opt-in. The address row stays so the token keeps working. */
  async unsubscribeAll(userId: string): Promise<number> {
    const result = await this.db.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(userId).run();
    await this.db.prepare('UPDATE users SET digest_optin = 0 WHERE id = ?').bind(userId).run();
    await this.db
      .prepare("UPDATE notifications SET status = 'SKIPPED', error = 'unsubscribed' WHERE user_id = ? AND status = 'PENDING'")
      .bind(userId)
      .run();
    return result.meta?.changes ?? 0;
  }

  async subscriptionsFor(userId: string) {
    const rows = await this.db
      .prepare(
        `SELECT sub.id, sub.site_id, sub.category, sub.min_score, sub.pending, s.title AS site_title, s.canonical_url
         FROM subscriptions sub LEFT JOIN monitored_sites s ON s.id = sub.site_id
         WHERE sub.user_id = ? ORDER BY sub.created_at`,
      )
      .bind(userId)
      .all<{ id: string; site_id: string | null; category: string | null; min_score: number; pending: number; site_title: string | null; canonical_url: string | null }>();
    return rows.results ?? [];
  }

  /** Queues one digest email per confirmed, opted-in address. Idempotent per day. */
  async queueDigestNotifications(day: string): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO notifications (id, user_id, change_id, channel, status, created_at, payload)
         SELECT 'ntf_' || lower(hex(randomblob(12))), u.id, NULL, 'DIGEST', 'PENDING', ?, ?
         FROM users u
         WHERE u.verified = 1 AND u.digest_optin = 1
           AND NOT EXISTS (
             SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.channel = 'DIGEST' AND n.payload = ?
           )`,
      )
      .bind(now(), day, day)
      .run();
    return result.meta?.changes ?? 0;
  }

  async createSubscription(input: {
    userId: string;
    siteId?: string | null;
    category?: string | null;
    minScore?: number;
    channel?: string;
    target?: string | null;
  }): Promise<string> {
    const id = newId('sub');
    await this.db
      .prepare(
        `INSERT INTO subscriptions (id, user_id, site_id, category, min_score, channel, target, created_at, pending)
         VALUES (?,?,?,?,?,?,?,?,1)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        id, input.userId, input.siteId ?? null, input.category ?? null,
        input.minScore ?? 40, input.channel ?? 'EMAIL', input.target ?? null, now(),
      )
      .run();
    return id;
  }

  async subscribersFor(siteId: string, category: string, score: number) {
    const rows = await this.db
      .prepare(
        `SELECT DISTINCT u.id AS user_id, u.email, u.token, sub.channel, sub.target
         FROM subscriptions sub JOIN users u ON u.id = sub.user_id
         WHERE ((sub.site_id = ?) OR (sub.category = ?)) AND sub.min_score <= ? AND sub.pending = 0 AND u.verified = 1`,
      )
      .bind(siteId, category, score)
      .all<{ user_id: string; email: string; token: string; channel: string; target: string | null }>();
    return rows.results ?? [];
  }

  async queueNotification(userId: string | null, changeId: string, channel: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO notifications (id, user_id, change_id, channel, status, created_at) VALUES (?,?,?,?,?,?)')
      .bind(newId('ntf'), userId, changeId, channel, 'PENDING', now())
      .run();
  }

  async pendingNotifications(limit = 50) {
    const rows = await this.db
      .prepare(
        `SELECT n.*, u.email, u.token, u.verified, c.headline, c.slug, c.summary
         FROM notifications n
         LEFT JOIN users u ON u.id = n.user_id
         LEFT JOIN change_events c ON c.id = n.change_id
         WHERE n.status = 'PENDING' AND n.attempts < 5 ORDER BY n.created_at LIMIT ?`,
      )
      .bind(limit)
      .all();
    return rows.results ?? [];
  }

  async markNotification(id: string, status: string, error?: string): Promise<void> {
    await this.db
      .prepare('UPDATE notifications SET status = ?, attempts = attempts + 1, error = ?, sent_at = ? WHERE id = ?')
      .bind(status, error ?? null, status === 'SENT' ? now() : null, id)
      .run();
  }

  // --- digests ------------------------------------------------------------

  async saveDigest(day: string, changeIds: string[], intro: string, stats: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO digests (day, change_ids, intro, stats, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(day) DO UPDATE SET change_ids = excluded.change_ids, intro = excluded.intro, stats = excluded.stats`,
      )
      .bind(day, JSON.stringify(changeIds), intro, JSON.stringify(stats), now())
      .run();
  }

  async getDigest(day: string) {
    return this.db.prepare('SELECT * FROM digests WHERE day = ?').bind(day).first<{
      day: string;
      change_ids: string;
      intro: string;
      stats: string;
    }>();
  }
}

export interface SubscriberUser {
  id: string;
  email: string;
  token: string;
  verified: number;
  digest_optin: number;
  confirm_sent_at: number | null;
}

export function repo(env: Env): Repo {
  return new Repo(env.DB);
}
