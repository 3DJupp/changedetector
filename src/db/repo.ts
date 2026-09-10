/**
 * Data access. Thin, explicit SQL over D1 — no ORM, no surprises.
 */
import type { ChangeEvent, Env, MonitoredSite, Snapshot } from '../types';
import { newId, newSlug } from '../lib/hash';

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
    return (await this.getSite(id))!;
  }

  async getSite(id: string): Promise<MonitoredSite | null> {
    return this.db.prepare('SELECT * FROM monitored_sites WHERE id = ?').bind(id).first<MonitoredSite>();
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

  async upsertUser(email: string): Promise<{ id: string; token: string; created: boolean }> {
    const existing = await this.db
      .prepare('SELECT id, token FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string; token: string }>();
    if (existing) return { ...existing, created: false };
    const id = newId('usr');
    const token = newId('tok').replace('tok_', '');
    await this.db
      .prepare('INSERT INTO users (id, email, verified, token, digest_optin, created_at) VALUES (?,?,0,?,1,?)')
      .bind(id, email, token, now())
      .run();
    return { id, token, created: true };
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
        `INSERT INTO subscriptions (id, user_id, site_id, category, min_score, channel, target, created_at)
         VALUES (?,?,?,?,?,?,?,?)
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
         WHERE ((sub.site_id = ?) OR (sub.category = ?)) AND sub.min_score <= ?`,
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
        `SELECT n.*, u.email, u.token, c.headline, c.slug, c.summary
         FROM notifications n
         LEFT JOIN users u ON u.id = n.user_id
         JOIN change_events c ON c.id = n.change_id
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

export function repo(env: Env): Repo {
  return new Repo(env.DB);
}
