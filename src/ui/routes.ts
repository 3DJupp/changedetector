/** Server-rendered page routes. */
import { Ctx, json, problem, redirect, Router } from '../router';
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

function notFound(ctx: Ctx, message = 'Not found'): Response {
  return html(
    layout({
      title: '404 — not found',
      description: message,
      path: ctx.url.pathname,
      baseUrl: ctx.baseUrl,
      narrow: true,
      noindex: true,
      body: `<div class="wrap-narrow" style="padding:80px 0"><div class="label">404</div>
        <h1 style="font-size:34px;letter-spacing:-.04em;margin:14px 0 0">${escapeHtml(message)}</h1>
        <p class="muted" style="margin-top:12px">The page you asked for is not here. <a href="/">Back to the feed</a>.</p></div>`,
    }),
    404,
  );
}

export function registerUiRoutes(router: Router): void {
  // --- feed ---------------------------------------------------------------
  router.get('/', async (ctx) => {
    const category = ctx.url.searchParams.get('category') || 'All';
    const order = ctx.url.searchParams.get('order') === 'recent' ? 'recent' : 'interesting';
    const [{ changes, total }, stats] = await Promise.all([
      ctx.repo.listChanges({ category, order, limit: 24 }),
      ctx.repo.stats(),
    ]);
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
        stats,
        lastSweep,
      }),
      200,
      { 'cache-control': 'public, max-age=30, s-maxage=120' },
    );
  });

  // --- change event -------------------------------------------------------
  router.get('/changes/:slug', async (ctx) => {
    const change = await ctx.repo.getChange(ctx.params.slug);
    if (!change) return notFound(ctx, 'That change event does not exist');
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
    const change = await ctx.repo.getChange(ctx.params.slug);
    if (!change) return notFound(ctx, 'That change event does not exist');
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
    const change = await ctx.repo.getChange(ctx.params.slug);
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

  router.get('/changes/:slug/card.svg', async (ctx) => {
    const change = await ctx.repo.getChange(ctx.params.slug);
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

  router.get('/robots.txt', async (ctx) =>
    new Response(
      `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /snapshots/*/raw\nDisallow: /search\nDisallow: /confirm\nDisallow: /unsubscribe\n\nSitemap: ${ctx.baseUrl}/sitemap.xml\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } },
    ),
  );

  router.get('/sitemap.xml', async (ctx) => {
    const [{ changes }, { sites }] = await Promise.all([
      ctx.repo.listChanges({ order: 'recent', limit: 500 }),
      ctx.repo.listSites({ limit: 500 }),
    ]);
    const urls = [
      `${ctx.baseUrl}/`,
      `${ctx.baseUrl}/about`,
      `${ctx.baseUrl}/api`,
      `${ctx.baseUrl}/sites`,
      `${ctx.baseUrl}/digest`,
      ...sites.map((site) => `${ctx.baseUrl}/sites/${site.id}`),
      ...changes.map((change) => `${ctx.baseUrl}/changes/${change.slug}`),
    ];
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
        .map((url) => `  <url><loc>${escapeHtml(url)}</loc></url>`)
        .join('\n')}\n</urlset>`,
      { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } },
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
