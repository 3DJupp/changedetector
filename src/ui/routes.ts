/** Server-rendered page routes. */
import { Ctx, json, problem, readBody, redirect, Router } from '../router';
import { followPage, suggestPage, suggestResultPage } from './pages/forms';
import { overLimit } from '../lib/ratelimit';
import { assertFetchable, canonicalizeUrl, UrlNotAllowed } from '../lib/urlguard';
import { html, layout } from './layout';
import { feedPage } from './pages/feed';
import { changePage } from './pages/change';
import { diffPage } from './pages/diff';
import { sitePage } from './pages/site';
import { searchPage } from './pages/search';
import { digestPage, digestBodyHtml } from './pages/digest';
import { aboutPage, apiPage, sitesPage } from './pages/misc';
import { snapshotPage } from './pages/snapshot';
import { CARD_VERSION, renderCardPng, renderCardSvg } from './og';
import { rssFeed, xml } from './rss';
import { badgeSvg, EMBED_HEADERS, embedCard } from './embed';
import { FAVICON_SVG, icoFromPng, iconPng, webManifest } from './icons';
import { CATEGORIES } from '../types';
import type { ChangeEvent, MonitoredSite } from '../types';
import { DiffRow } from '../lib/diff';
import { createContentStore, rawR2Store } from '../store';
import { sanitizeArchivedHtml, ARCHIVE_HEADERS } from '../lib/sanitize';
import { rawBlock } from '../lib/cid';
import { sha256Hex } from '../lib/hash';
import { stampShort, timeAgo, hostOf } from './components';
import { buildDigest } from '../pipeline/digest';
import { diffLines, buildRows, buildHunks, computeStats } from '../lib/diff';
import { decodeBody } from '../pipeline/crawl';
import { escapeHtml } from '../lib/html';
import { categoryFromSlug, categoryPath, changeKey, changePath, sitePath } from '../lib/paths';
import { hybridSearch } from '../lib/semantic';

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function cachedPng(ctx: Ctx, key: string, maxAge: number, render: () => Promise<Uint8Array>): Promise<Response> {
  const headers = { 'content-type': 'image/png', 'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge * 4}` };
  const cached = await ctx.env.ARTIFACTS.get(key).catch(() => null);
  if (cached) return new Response(cached.body, { headers });
  const png = await render();
  ctx.executionCtx.waitUntil(
    ctx.env.ARTIFACTS.put(key, png as unknown as ArrayBuffer, {
      httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
    })
      .then(() => undefined)
      .catch(() => undefined),
  );
  return new Response(png as unknown as BodyInit, { headers });
}

const FEED_PAGE_SIZE = 24;
const SITEMAP_CHUNK = 5000;

function sitemapXml(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

export function notFound(ctx: Pick<Ctx, 'url' | 'baseUrl'>, message = 'Not found'): Response {
  return html(
    layout({
      title: '404 — not found',
      description: message,
      path: ctx.url.pathname,
      baseUrl: ctx.baseUrl,
      narrow: true,
      noindex: true,
      body: `<div class="wrap-narrow" style="padding-top:80px;padding-bottom:80px"><div class="label">404</div>
        <h1 style="font-size:34px;letter-spacing:-.04em;margin:14px 0 0">${escapeHtml(message)}</h1>
        <p class="muted" style="margin-top:12px">The page you asked for is not here. <a href="/">Back to the feed</a>.</p></div>`,
    }),
    404,
  );
}

export function registerUiRoutes(router: Router): void {
  // --- feed ---------------------------------------------------------------
  const feedHandler = async (ctx: Ctx, category: string): Promise<Response> => {
    const order = ctx.url.searchParams.get('order') === 'recent' ? 'recent' : 'interesting';
    const page = Math.max(1, Number.parseInt(ctx.url.searchParams.get('page') ?? '1', 10) || 1);
    const [{ changes, total }, stats] = await Promise.all([
      ctx.repo.listChanges({ category, order, limit: FEED_PAGE_SIZE, offset: (page - 1) * FEED_PAGE_SIZE }),
      ctx.repo.stats(),
    ]);
    const pages = Math.max(1, Math.ceil(total / FEED_PAGE_SIZE));
    if (page > pages) return notFound(ctx, 'There are no changes on that page');
    const latestCheck = await ctx.repo.recentCrawlLogs(1);
    const lastSweep = latestCheck.length
      ? timeAgo(Number((latestCheck[0] as Record<string, unknown>).started_at)).toUpperCase()
      : 'PENDING';

    return html(
      feedPage({
        baseUrl: ctx.baseUrl,
        changes: changes.map((change) => ({
          ...change,
          cid: ((change as unknown as Record<string, unknown>).current_cid as string | null) ?? null,
        })),
        total,
        category,
        order,
        page,
        pages,
        stats,
        lastSweep,
      }),
      200,
      { 'cache-control': 'public, max-age=30, s-maxage=120' },
    );
  };

  router.get('/', async (ctx) => {
    // Old filter URLs (/?category=Pricing) move to their own landing pages.
    const legacy = ctx.url.searchParams.get('category');
    if (legacy && legacy !== 'All' && CATEGORIES.includes(legacy as never)) {
      const target = new URL(categoryPath(legacy), ctx.baseUrl);
      for (const [key, value] of ctx.url.searchParams) if (key !== 'category') target.searchParams.set(key, value);
      return redirect(target.pathname + target.search, 301);
    }
    return feedHandler(ctx, 'All');
  });

  router.get('/category/:slug', async (ctx) => {
    const category = categoryFromSlug(ctx.params.slug);
    if (!category) return notFound(ctx, 'There is no such category');
    return feedHandler(ctx, category);
  });

  // --- change event -------------------------------------------------------
  router.get('/changes/:slug', async (ctx) => {
    const change = await ctx.repo.getChange(changeKey(ctx.params.slug));
    if (!change) return notFound(ctx, 'That change event does not exist');
    if (ctx.url.pathname !== changePath(change)) return redirect(changePath(change) + ctx.url.search, 301);
    const [site, previous, current] = await Promise.all([
      ctx.repo.getSite(change.site_id),
      change.previous_snapshot_id ? ctx.repo.getSnapshot(change.previous_snapshot_id) : Promise.resolve(null),
      ctx.repo.getSnapshot(change.current_snapshot_id),
    ]);
    if (!site || !current) return notFound(ctx, 'This change is missing its snapshot');

    ctx.executionCtx.waitUntil(
      Promise.all([
        ctx.repo.updateChange(change.id, { views: change.views + 1 }),
        ctx.repo.bumpMetric('views'),
      ]).catch(() => {}),
    );

    const store = createContentStore(ctx.env);
    const manifest = current.cid ? await rawR2Store(ctx.env).getManifest(current.cid).catch(() => null) : null;

    return html(
      changePage({
        baseUrl: ctx.baseUrl,
        change,
        site,
        previous,
        current,
        signals: safeParse(change.signals, [] as { name: string; points: number; detail?: string }[]),
        suppressed: safeParse(change.suppressed, {} as Record<string, number>),
        gatewayUrl: current.cid ? store.gatewayUrl(current.cid) : null,
        replicas: manifest ? ['r2', ...(ctx.env.IPFS_API_URL ? ['ipfs'] : [])] : [],
        aiModel: change.ai_model,
      }),
      200,
      { 'cache-control': 'public, max-age=60, s-maxage=600' },
    );
  });

  router.get('/changes/:slug/diff', async (ctx) => {
    const change = await ctx.repo.getChange(changeKey(ctx.params.slug));
    if (!change) return notFound(ctx, 'That change event does not exist');
    if (ctx.url.pathname !== `${changePath(change)}/diff`) return redirect(`${changePath(change)}/diff${ctx.url.search}`, 301);
    const [site, previous, current] = await Promise.all([
      ctx.repo.getSite(change.site_id),
      change.previous_snapshot_id ? ctx.repo.getSnapshot(change.previous_snapshot_id) : Promise.resolve(null),
      ctx.repo.getSnapshot(change.current_snapshot_id),
    ]);
    if (!site || !current) return notFound(ctx, 'This change is missing its snapshot');

    const stored = safeParse(change.diff, {
      hunks: [] as { header: string; rows: DiffRow[] }[],
      stats: { added: 0, removed: 0, changed: 0, ratio: 0 },
      truncated: false,
    });

    const requested = ctx.url.searchParams.get('mode');
    const mode: 'text' | 'words' | 'raw' = requested === 'words' || requested === 'raw' ? requested : 'text';

    let hunks = stored.hunks;
    let stats = stored.stats;
    let rawUnavailable: string | undefined;

    if (mode === 'raw') {
      const store = createContentStore(ctx.env);
      const [beforeBytes, afterBytes] = await Promise.all([
        previous?.page_cid ? store.get(previous.page_cid) : Promise.resolve(null),
        current.page_cid ? store.get(current.page_cid) : Promise.resolve(null),
      ]);
      if (!beforeBytes || !afterBytes) {
        rawUnavailable = 'Raw HTML is not available for both sides of this comparison.';
        hunks = [];
      } else {
        const beforeLines = decodeBody(beforeBytes, 'text/html')
          .replace(/></g, '>\n<')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 6000);
        const afterLines = decodeBody(afterBytes, 'text/html')
          .replace(/></g, '>\n<')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 6000);
        const rows = buildRows(diffLines(beforeLines, afterLines), false);
        stats = computeStats(rows);
        hunks = buildHunks(rows, 2).slice(0, 60);
      }
    }

    return html(
      diffPage({
        baseUrl: ctx.baseUrl,
        change,
        site,
        previous,
        current,
        hunks,
        stats,
        suppressed: safeParse(change.suppressed, {} as Record<string, number>),
        mode,
        truncated: Boolean(stored.truncated),
        rawUnavailable,
      }),
      200,
      { 'cache-control': 'public, max-age=60, s-maxage=600' },
    );
  });

  // --- share cards --------------------------------------------------------
  router.get('/changes/:slug/og.png', async (ctx) => {
    const change = await ctx.repo.getChange(changeKey(ctx.params.slug));
    if (!change) return new Response('not found', { status: 404 });
    const key = `og/v${CARD_VERSION}-${change.id}-${change.interestingness_score}.png`;
    return cachedPng(ctx, key, 86400, async () => {
      const site = await ctx.repo.getSite(change.site_id);
      return renderCardPng({
        kicker: site ? `${site.category} · ${hostOf(site.canonical_url)}` : undefined,
        headline: change.headline,
        before: change.before_value,
        after: change.after_value,
        delta: change.delta,
        severity: change.severity,
        detectedAt: stampShort(change.detected_at),
        url: `${ctx.baseUrl.replace(/^https?:\/\//, '')}/changes/${change.slug}`,
        category: site?.category,
      });
    });
  });

  router.get('/changes/:slug/embed', async (ctx) => {
    const change = await ctx.repo.getChange(changeKey(ctx.params.slug));
    if (!change || !change.published || change.false_positive) return new Response('not found', { status: 404, headers: EMBED_HEADERS });
    const site = await ctx.repo.getSite(change.site_id);
    if (!site) return new Response('not found', { status: 404, headers: EMBED_HEADERS });
    const dark = ctx.url.searchParams.get('theme') === 'dark';
    return new Response(embedCard({ baseUrl: ctx.baseUrl, change, site, dark }), { headers: EMBED_HEADERS });
  });

  router.get('/changes/:slug/card.svg', async (ctx) => {
    const change = await ctx.repo.getChange(changeKey(ctx.params.slug));
    if (!change) return new Response('not found', { status: 404 });
    const svg = renderCardSvg({
      headline: change.headline,
      before: change.before_value,
      after: change.after_value,
      delta: change.delta,
      severity: change.severity,
      detectedAt: stampShort(change.detected_at),
      url: `${ctx.baseUrl.replace(/^https?:\/\//, '')}/changes/${change.slug}`,
    });
    return new Response(svg, {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
    });
  });

  // Default, digest and per-site cards. Rendered once and kept in R2 under a
  // key that changes whenever what the card shows changes.
  router.get('/og/:name', async (ctx) => {
    const host = ctx.baseUrl.replace(/^https?:\/\//, '');
    const name = ctx.params.name;

    if (name === 'default.png') {
      const stats = await ctx.repo.stats();
      return cachedPng(ctx, `og/v${CARD_VERSION}-default-${stats.sites}-${stats.publishedChanges}.png`, 3600, () =>
        renderCardPng({
          headline: 'The internet changes. We keep receipts.',
          before: null,
          after: null,
          delta: `${stats.sites.toLocaleString('en-US')} pages watched`,
          severity: null,
          footer: `${stats.publishedChanges.toLocaleString('en-US')} changes on record`,
          url: host,
        }),
      );
    }

    const digestMatch = /^digest-(\d{4}-\d{2}-\d{2})\.png$/.exec(name);
    if (digestMatch) {
      const day = digestMatch[1];
      const digest = await ctx.repo.getDigest(day);
      if (!digest) return new Response('not found', { status: 404 });
      const ids = safeParse<string[]>(digest.change_ids, []);
      const top = ids.length ? await ctx.repo.getChange(ids[0]) : null;
      const stats = safeParse(digest.stats, { detected: 0, published: 0, sites: 0 });
      const label = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      return cachedPng(ctx, `og/v${CARD_VERSION}-digest-${day}-${ids.join('.').slice(0, 80)}.png`, 86400, () =>
        renderCardPng({
          kicker: `Daily digest · ${label}`,
          headline: top ? top.headline : 'The Internet Changed Today',
          before: top?.before_value ?? null,
          after: top?.after_value ?? null,
          delta: top ? top.delta : null,
          severity: null,
          footer: ids.length > 1 ? `+${ids.length - 1} more · ${stats.detected} detected` : `${stats.detected} changes detected`,
          url: `${host}/digest/${day}`,
        }),
      );
    }
    return new Response('not found', { status: 404 });
  });

  router.get('/sites/:id/badge.svg', async (ctx) => {
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return new Response('not found', { status: 404 });
    return new Response(badgeSvg(site), {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=900, s-maxage=1800' },
    });
  });

  router.get('/sites/:id/og.png', async (ctx) => {
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return new Response('not found', { status: 404 });
    const host = ctx.baseUrl.replace(/^https?:\/\//, '');
    const changes = site.change_count;
    return cachedPng(ctx, `og/v${CARD_VERSION}-site-${site.id}-${changes}-${site.last_changed_at ?? 0}.png`, 86400, () =>
      renderCardPng({
        kicker: `${site.category} · ${hostOf(site.canonical_url)}`,
        headline: site.title ?? hostOf(site.canonical_url),
        before: null,
        after: null,
        delta: changes === 1 ? '1 change on record' : `${changes.toLocaleString('en-US')} changes on record`,
        severity: null,
        footer: site.last_changed_at ? `Last change ${stampShort(site.last_changed_at)}` : `Watched since ${stampShort(site.created_at)}`,
        url: `${host}/sites/${site.id}`,
      }),
    );
  });

  // --- sites --------------------------------------------------------------
  router.get('/sites', async (ctx) => {
    const category = ctx.url.searchParams.get('category') || 'All';
    const { sites, total } = await ctx.repo.listSites({ category, limit: 300 });
    return html(sitesPage({ baseUrl: ctx.baseUrl, sites, total, category }), 200, {
      'cache-control': 'public, max-age=60, s-maxage=300',
    });
  });

  router.get('/sites/:id', async (ctx) => {
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return notFound(ctx, 'That monitored page does not exist');
    if (!site.slug) site.slug = await ctx.repo.ensureSiteSlug(site);
    if (ctx.params.id !== site.slug) return redirect(sitePath(site) + ctx.url.search, 301);
    const [{ changes }, snapshots, weekly] = await Promise.all([
      ctx.repo.listChanges({ siteId: site.id, order: 'recent', limit: 20, includeUnpublished: true }),
      ctx.repo.listSnapshots(site.id, 25),
      ctx.repo.weeklyChangeCounts(site.id, 26),
    ]);
    return html(
      sitePage({ baseUrl: ctx.baseUrl, site, changes, snapshots, weekly, following: false }),
      200,
      { 'cache-control': 'public, max-age=60, s-maxage=300' },
    );
  });

  // --- snapshots ----------------------------------------------------------
  router.get('/snapshots/:id', async (ctx) => renderSnapshot(ctx, null));
  router.get('/snapshots/:id/verify', async (ctx) => {
    const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
    if (!snapshot?.page_cid) return notFound(ctx, 'Snapshot has no stored artifact');
    const store = createContentStore(ctx.env);
    const bytes = await store.get(snapshot.page_cid);
    if (!bytes) return notFound(ctx, 'Artifact bytes are not available from any replica');
    const recomputed = await rawBlock(bytes);
    return renderSnapshot(ctx, {
      ok: recomputed.cid === snapshot.page_cid,
      expected: snapshot.page_cid,
      actual: recomputed.cid,
      checkedAt: new Date().toISOString(),
    });
  });

  router.get('/snapshots/:id/raw', async (ctx) => {
    const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
    if (!snapshot?.page_cid) return notFound(ctx, 'No archived HTML for this snapshot');
    const bytes = await createContentStore(ctx.env).get(snapshot.page_cid);
    if (!bytes) return notFound(ctx, 'Archived bytes are not available from any replica');
    const source = decodeBody(bytes, snapshot.content_type ?? 'text/html');
    const banner = `<div style="font:13px/1.5 system-ui;background:#0E1116;color:#E6EAF0;padding:12px 16px;border-bottom:2px solid #F2545B">
      Archived capture of ${escapeHtml(snapshot.final_url ?? '')} — ${escapeHtml(stampShort(snapshot.captured_at))} ·
      scripts, styles and remote resources are disabled. <a style="color:#5FA0E8" href="/snapshots/${escapeHtml(snapshot.id)}">Back to snapshot</a>
    </div>`;
    return new Response(banner + sanitizeArchivedHtml(source), {
      headers: { ...ARCHIVE_HEADERS, 'cache-control': 'public, max-age=31536000, immutable' },
    });
  });

  router.get('/snapshots/:id/text', async (ctx) => {
    const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
    if (!snapshot) return notFound(ctx, 'Snapshot not found');
    let text = snapshot.text_content ?? '';
    if (!text && snapshot.text_cid) {
      const bytes = await createContentStore(ctx.env).get(snapshot.text_cid);
      if (bytes) text = new TextDecoder().decode(bytes);
    }
    return new Response(text || 'No extracted text stored for this snapshot.', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
    });
  });

  router.get('/snapshots/:id/file/:name', async (ctx) => {
    const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
    if (!snapshot?.cid) return notFound(ctx, 'Snapshot artifact not found');
    const allowed = ['metadata.json', 'content.txt', 'normalized.json'];
    if (!allowed.includes(ctx.params.name)) return redirect(`/snapshots/${snapshot.id}/raw`);
    const bytes = await createContentStore(ctx.env).getPath(snapshot.cid, ctx.params.name);
    if (!bytes) return notFound(ctx, 'That artifact file is not available');
    const type = ctx.params.name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8';
    return new Response(bytes as unknown as BodyInit, {
      headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable' },
    });
  });

  // --- search -------------------------------------------------------------
  router.get('/search', async (ctx) => {
    const query = (ctx.url.searchParams.get('q') ?? '').slice(0, 120);
    const category = ctx.url.searchParams.get('category') || 'All';
    const results = query
      ? (await hybridSearch(ctx.env, ctx.repo, query, { category, limit: 40 })).changes
      : (await ctx.repo.listChanges({ category, order: 'recent', limit: 40 })).changes;
    const counts = await ctx.repo.categoryCounts();
    const facets = [
      { label: 'All', count: Object.values(counts).reduce((total, value) => total + value, 0) },
      ...CATEGORIES.map((name) => ({ label: name, count: counts[name] ?? 0 })).filter((facet) => facet.count > 0),
    ];
    return html(
      searchPage({
        baseUrl: ctx.baseUrl,
        query,
        category,
        results,
        facets,
        suggestions: ['pricing changes', 'deleted pages', 'terms of service', 'free tier', 'rate limit', 'AI'],
      }),
    );
  });

  // --- digest -------------------------------------------------------------
  const digestHandler = async (ctx: Ctx): Promise<Response> => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.day ?? '')
      ? ctx.params.day
      : new Date().toISOString().slice(0, 10);
    let digest = await ctx.repo.getDigest(day);
    if (!digest && day === new Date().toISOString().slice(0, 10)) {
      await buildDigest(ctx.env, ctx.repo, day);
      digest = await ctx.repo.getDigest(day);
    }
    if (!digest) return notFound(ctx, `No digest was published for ${day}`);
    const ids = safeParse<string[]>(digest.change_ids, []);
    const loaded = await Promise.all(ids.map((id) => ctx.repo.getChange(id)));
    const changes = loaded.filter(Boolean) as (ChangeEvent & { site: Partial<MonitoredSite> })[];
    for (const change of changes) {
      const site = await ctx.repo.getSite(change.site_id);
      change.site = site ?? {};
    }
    return html(
      digestPage({
        baseUrl: ctx.baseUrl,
        day,
        intro: digest.intro ?? '',
        changes,
        stats: safeParse(digest.stats, { detected: 0, published: 0, sites: 0 }),
        isToday: day === new Date().toISOString().slice(0, 10),
      }),
      200,
      { 'cache-control': 'public, max-age=300, s-maxage=1800' },
    );
  };
  router.get('/digest', digestHandler);
  router.get('/digest/:day', digestHandler);

  // --- feeds --------------------------------------------------------------
  router.get('/rss.xml', async (ctx) => {
    const category = ctx.url.searchParams.get('category') || 'All';
    const { changes } = await ctx.repo.listChanges({ category, order: 'recent', limit: 50 });
    return xml(
      rssFeed({
        baseUrl: ctx.baseUrl,
        title: category === 'All' ? 'The Internet Change Detector' : `Change Detector — ${category}`,
        description: 'Meaningful, verifiable changes detected on monitored public web pages.',
        selfPath: ctx.url.pathname + ctx.url.search,
        items: changes,
      }),
    );
  });

  router.get('/sites/:id/rss.xml', async (ctx) => {
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return new Response('not found', { status: 404 });
    const { changes } = await ctx.repo.listChanges({ siteId: site.id, order: 'recent', limit: 50 });
    return xml(
      rssFeed({
        baseUrl: ctx.baseUrl,
        title: `Changes — ${site.title ?? hostOf(site.canonical_url)}`,
        description: `Detected changes for ${site.canonical_url}`,
        selfPath: ctx.url.pathname,
        items: changes.map((change) => ({ ...change, site })),
      }),
    );
  });

  router.get('/digest.xml', async (ctx) => {
    const { changes } = await ctx.repo.listChanges({ order: 'interesting', limit: 20, since: Math.floor(Date.now() / 1000) - 604800 });
    return xml(
      rssFeed({
        baseUrl: ctx.baseUrl,
        title: 'The Internet Changed Today',
        description: 'The most significant changes detected each day.',
        selfPath: '/digest.xml',
        items: changes,
      }),
      1800,
    );
  });

  // --- static-ish ---------------------------------------------------------
  router.get('/about', async (ctx) => html(aboutPage(ctx.baseUrl), 200, { 'cache-control': 'public, max-age=3600' }));
  router.get('/api', async (ctx) => html(apiPage(ctx.baseUrl), 200, { 'cache-control': 'public, max-age=3600' }));

  // --- follow and suggest --------------------------------------------------
  router.get('/follow', async (ctx) => {
    const siteKey = ctx.url.searchParams.get('site');
    const site = siteKey ? await ctx.repo.getSite(siteKey) : null;
    if (siteKey && !site) return notFound(ctx, 'That monitored page does not exist');
    const category = ctx.url.searchParams.get('category');
    return html(
      followPage({ baseUrl: ctx.baseUrl, site, category: category && CATEGORIES.includes(category as never) ? category : null }),
    );
  });

  router.get('/suggest', (ctx) =>
    html(suggestPage({ baseUrl: ctx.baseUrl, url: (ctx.url.searchParams.get('url') ?? '').slice(0, 500) })),
  );

  router.post('/suggest', async (ctx) => {
    const body = await readBody(ctx.request);
    const again = (error: string, status = 400) => html(suggestPage({ baseUrl: ctx.baseUrl, url: String(body.url ?? '').slice(0, 500), error }), status);
    // Bots fill every field; people never see this one.
    if (body.website) return html(suggestResultPage({ baseUrl: ctx.baseUrl, outcome: 'received' }), 202);
    if (await overLimit(ctx.env.CACHE, ctx.request, 'suggest', 10)) {
      return again('Thanks, that is a lot of suggestions. Please try again in an hour.', 429);
    }
    let canonical: string;
    let url: URL;
    try {
      url = await assertFetchable(String(body.url ?? '').trim(), { cache: ctx.env.CACHE });
      canonical = canonicalizeUrl(url.toString());
    } catch (error) {
      return again(error instanceof UrlNotAllowed ? `That URL cannot be monitored: ${error.message}.` : 'Enter a complete public URL, starting with https://');
    }
    const existing = await ctx.repo.getSiteByCanonical(canonical);
    if (existing) return html(suggestResultPage({ baseUrl: ctx.baseUrl, outcome: 'monitored', sitePath: sitePath(existing) }));
    const category = body.category && CATEGORIES.includes(body.category as never) ? String(body.category) : null;
    const reason = String(body.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
    const result = await ctx.repo.suggestSite({ url: url.toString(), canonicalUrl: canonical, category, reason });
    const outcome = result.status === 'REJECTED' ? 'declined' : result.created ? 'received' : 'voted';
    return html(suggestResultPage({ baseUrl: ctx.baseUrl, outcome }), result.created ? 202 : 200);
  });

  // --- icons and manifest -------------------------------------------------
  const ICON_CACHE = { 'cache-control': 'public, max-age=604800, s-maxage=2592000' };
  router.get('/favicon.svg', () => new Response(FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', ...ICON_CACHE } }));
  router.get('/favicon.ico', async () =>
    new Response(icoFromPng(await iconPng(32), 32) as unknown as BodyInit, { headers: { 'content-type': 'image/x-icon', ...ICON_CACHE } }),
  );
  const pngIcon = (size: number, padding = 0) => async () =>
    new Response((await iconPng(size, padding)) as unknown as BodyInit, { headers: { 'content-type': 'image/png', ...ICON_CACHE } });
  router.get('/apple-touch-icon.png', pngIcon(180));
  router.get('/icon-192.png', pngIcon(192));
  router.get('/icon-512.png', pngIcon(512));
  // Maskable icons get cropped to a circle; keep the mark inside the safe zone.
  router.get('/icon-maskable-512.png', pngIcon(512, 52));
  router.get('/manifest.webmanifest', () =>
    new Response(webManifest(), { headers: { 'content-type': 'application/manifest+json', ...ICON_CACHE } }),
  );

  router.get('/robots.txt', async (ctx) =>
    new Response(
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /snapshots/*/raw\nDisallow: /search\nDisallow: /confirm\nDisallow: /unsubscribe\nDisallow: /follow\nDisallow: /changes/*/embed\n\nSitemap: ${ctx.baseUrl}/sitemap.xml\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } },
    ),
  );

  // Sitemap index plus sub-sitemaps, each well under the 50,000 URL limit.
  router.get('/sitemap.xml', async (ctx) => {
    const total = await ctx.repo.countPublishedChanges();
    const changeFiles = Math.max(1, Math.ceil(total / SITEMAP_CHUNK));
    const files = ['pages', 'sites', 'digests', ...Array.from({ length: changeFiles }, (_, i) => `changes-${i + 1}`)];
    return sitemapXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files
        .map((file) => `  <sitemap><loc>${escapeHtml(`${ctx.baseUrl}/sitemaps/${file}.xml`)}</loc></sitemap>`)
        .join('\n')}\n</sitemapindex>`,
    );
  });

  router.get('/sitemaps/:file', async (ctx) => {
    const file = ctx.params.file;
    const entries: { loc: string; lastmod?: number }[] = [];
    if (file === 'pages.xml') {
      const [latest, perCategory] = await Promise.all([ctx.repo.listChanges({ order: 'recent', limit: 1 }), ctx.repo.categoryLastChanged()]);
      const newest = latest.changes[0]?.detected_at;
      entries.push({ loc: '/', lastmod: newest }, { loc: '/sites' }, { loc: '/digest', lastmod: newest }, { loc: '/about' }, { loc: '/api' });
      for (const category of CATEGORIES) {
        if (perCategory[category]) entries.push({ loc: categoryPath(category), lastmod: perCategory[category] });
      }
    } else if (file === 'sites.xml') {
      for (const site of await ctx.repo.sitemapSites()) entries.push({ loc: sitePath(site), lastmod: site.lastmod });
    } else if (file === 'digests.xml') {
      for (const digest of await ctx.repo.sitemapDigests()) entries.push({ loc: `/digest/${digest.day}`, lastmod: digest.created_at });
    } else {
      const match = /^changes-(\d+)\.xml$/.exec(file);
      if (!match) return new Response('not found', { status: 404 });
      const index = Number.parseInt(match[1], 10);
      const rows = await ctx.repo.sitemapChanges((index - 1) * SITEMAP_CHUNK, SITEMAP_CHUNK);
      if (!rows.length && index > 1) return new Response('not found', { status: 404 });
      for (const row of rows) entries.push({ loc: changePath(row), lastmod: row.detected_at });
    }
    return sitemapXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
        .map(
          (entry) =>
            `  <url><loc>${escapeHtml(ctx.baseUrl + entry.loc)}</loc>${entry.lastmod ? `<lastmod>${new Date(entry.lastmod * 1000).toISOString()}</lastmod>` : ''}</url>`,
        )
        .join('\n')}\n</urlset>`,
    );
  });

  router.get('/health', async (ctx) => {
    const probe = await ctx.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>().catch(() => null);
    return json({
      ok: probe?.ok === 1,
      version: ctx.env.TOOL_VERSION,
      queue: ctx.env.JOBS ? 'queue' : 'inline',
      ai: Boolean(ctx.env.AI && ctx.env.AI_MODEL),
      contentStore: ctx.env.CONTENT_STORE,
      time: new Date().toISOString(),
    });
  });
}

async function renderSnapshot(
  ctx: Ctx,
  verification: { ok: boolean; expected: string; actual: string; checkedAt: string } | null,
): Promise<Response> {
  const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
  if (!snapshot) return notFound(ctx, 'That snapshot does not exist');
  const site = await ctx.repo.getSite(snapshot.site_id);
  if (!site) return notFound(ctx, 'The site for this snapshot is gone');

  const store = createContentStore(ctx.env);
  const manifest = snapshot.cid ? await rawR2Store(ctx.env).getManifest(snapshot.cid).catch(() => null) : null;
  let preview = snapshot.text_content ?? '';
  if (!preview && snapshot.text_cid) {
    const bytes = await store.get(snapshot.text_cid).catch(() => null);
    if (bytes) preview = new TextDecoder().decode(bytes);
  }

  return html(
    snapshotPage({
      baseUrl: ctx.baseUrl,
      snapshot,
      site,
      gatewayUrl: snapshot.cid ? store.gatewayUrl(snapshot.cid) : null,
      artifact: manifest?.entries ?? [],
      verification,
      textPreview: preview.slice(0, 4000) || 'No extracted text stored for this snapshot.',
    }),
    200,
    { 'cache-control': 'public, max-age=300' },
  );
}

export { sha256Hex, digestBodyHtml };
