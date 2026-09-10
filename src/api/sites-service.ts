/** Site creation and mutation, shared by the JSON API and the admin console. */
import type { Env, MonitoredSite } from '../types';
import { CATEGORIES, INTERVAL_PRESETS, MIN_CRAWL_INTERVAL_S } from '../types';
import { Repo, now } from '../db/repo';
import { assertFetchable, canonicalizeUrl, UrlNotAllowed } from '../lib/urlguard';
import { getRobots, isAllowed } from '../lib/robots';

export interface AddSiteInput {
  url?: string;
  category?: string;
  interval?: string;
  priority?: string;
  renderMode?: string;
  title?: string;
  normalization?: string;
}

export interface AddSiteResult {
  ok: boolean;
  site?: MonitoredSite;
  error?: string;
  reason?: string;
}

function resolveInterval(input: string | undefined, priority: string): number {
  if (input && INTERVAL_PRESETS[input]) return INTERVAL_PRESETS[input];
  const numeric = Number.parseInt(input ?? '', 10);
  if (Number.isFinite(numeric) && numeric > 0) return Math.max(MIN_CRAWL_INTERVAL_S, numeric);
  return priority === 'HIGH' ? 1800 : priority === 'LOW' ? 86400 : 21600;
}

export async function addSite(env: Env, repo: Repo, input: AddSiteInput): Promise<AddSiteResult> {
  if (!input.url) return { ok: false, error: 'url is required', reason: 'invalid' };
  let canonical: string;
  let parsed: URL;
  try {
    parsed = await assertFetchable(input.url.trim(), { cache: env.CACHE });
    canonical = canonicalizeUrl(parsed.toString());
  } catch (error) {
    if (error instanceof UrlNotAllowed) return { ok: false, error: error.message, reason: error.reason };
    return { ok: false, error: 'URL could not be validated', reason: 'invalid' };
  }

  const existing = await repo.getSiteByCanonical(canonical);
  if (existing) return { ok: false, error: 'This URL is already monitored', reason: 'duplicate', site: existing };

  const category = CATEGORIES.includes((input.category ?? '') as never) ? input.category! : 'Companies';
  const priority = ['HIGH', 'NORMAL', 'LOW'].includes(input.priority ?? '') ? input.priority! : 'NORMAL';
  const interval = resolveInterval(input.interval, priority);

  // Respect robots.txt from the very first request.
  const robots = await getRobots(parsed.origin, env.USER_AGENT, env.CACHE);
  const decision = isAllowed(robots, env.USER_AGENT, parsed.pathname + parsed.search);
  if (!decision.allowed) {
    return { ok: false, error: `robots.txt on ${parsed.host} disallows crawling this path`, reason: 'robots' };
  }

  const site = await repo.createSite({
    url: input.url!.trim(),
    canonicalUrl: canonical,
    host: parsed.host,
    title: input.title?.slice(0, 200) ?? null,
    category,
    crawlIntervalS: interval,
    priority,
    renderMode: ['AUTO', 'HTTP', 'BROWSER'].includes(input.renderMode ?? '') ? input.renderMode : 'AUTO',
    normalization: input.normalization ?? null,
  });
  return { ok: true, site };
}

export async function updateSite(repo: Repo, site: MonitoredSite, patch: Record<string, string>): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.category && CATEGORIES.includes(patch.category as never)) update.category = patch.category;
  if (patch.status && ['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(patch.status)) {
    update.status = patch.status;
    if (patch.status === 'ACTIVE') {
      update.consecutive_errors = 0;
      update.next_check_at = now();
    }
  }
  if (patch.interval) {
    const seconds = INTERVAL_PRESETS[patch.interval] ?? Number.parseInt(patch.interval, 10);
    if (Number.isFinite(seconds)) update.crawl_interval_s = Math.max(MIN_CRAWL_INTERVAL_S, seconds);
  }
  if (patch.priority && ['HIGH', 'NORMAL', 'LOW'].includes(patch.priority)) update.priority = patch.priority;
  if (patch.renderMode && ['AUTO', 'HTTP', 'BROWSER'].includes(patch.renderMode)) update.render_mode = patch.renderMode;
  if (patch.title !== undefined) update.title = patch.title.slice(0, 200) || null;
  if (patch.normalization !== undefined) {
    try {
      JSON.parse(patch.normalization);
      update.normalization = patch.normalization;
    } catch {
      /* ignore malformed rules rather than storing them */
    }
  }
  if (Object.keys(update).length) await repo.updateSite(site.id, update);
}
