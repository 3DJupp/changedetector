/** The public JSON API. */
import type { ChangeEvent, MonitoredSite } from '../types';
import { CATEGORIES } from '../types';
import { Ctx, json, problem, readBody, Router } from '../router';
import { isAdmin } from './auth';
import { addSite, updateSite } from './sites-service';
import { enqueue } from '../pipeline/scheduler';
import { rawR2Store, createContentStore } from '../store';
import { sha256Hex } from '../lib/hash';
import { buildDigest } from '../pipeline/digest';

const CACHE_SHORT = 60;
const CACHE_LONG = 3600;

function siteDto(site: MonitoredSite) {
  return {
    id: site.id,
    url: site.canonical_url,
    title: site.title,
    category: site.category,
    status: site.status,
    priority: site.priority,
    crawlIntervalSeconds: site.crawl_interval_s,
    renderMode: site.render_mode,
    robotsAllowed: Boolean(site.robots_allowed),
    lastCheckedAt: site.last_checked_at ? new Date(site.last_checked_at * 1000).toISOString() : null,
    lastChangedAt: site.last_changed_at ? new Date(site.last_changed_at * 1000).toISOString() : null,
    lastStatus: site.last_status,
    lastError: site.last_error,
    snapshotCount: site.snapshot_count,
    changeCount: site.change_count,
    createdAt: new Date(site.created_at * 1000).toISOString(),
  };
}

export function changeDto(
  change: ChangeEvent & { site?: Partial<MonitoredSite> },
  baseUrl: string,
  extra: { previousCid?: string | null; currentCid?: string | null; capturedAt?: string | null } = {},
) {
  return {
    id: change.id,
    slug: change.slug,
    site: {
      id: change.site?.id ?? change.site_id,
      url: change.site?.canonical_url,
      title: change.site?.title,
      category: change.site?.category,
    },
    detectedAt: new Date(change.detected_at * 1000).toISOString(),
    changeType: change.change_type,
    severity: change.severity,
    score: change.interestingness_score,
    magnitude: change.change_score,
    headline: change.headline,
    summary: change.summary,
    label: change.label,
    before: change.before_value,
    after: change.after_value,
    delta: change.delta,
    deltaNote: change.delta_note,
    published: Boolean(change.published),
    previousSnapshot: { id: change.previous_snapshot_id, cid: extra.previousCid ?? null },
    currentSnapshot: { id: change.current_snapshot_id, cid: extra.currentCid ?? null, capturedAt: extra.capturedAt ?? null },
    url: `${baseUrl}/changes/${change.slug}`,
    ogImage: `${baseUrl}/changes/${change.slug}/og.png`,
  };
}

async function requireAdmin(ctx: Ctx): Promise<Response | null> {
  if (await isAdmin(ctx.request, ctx.env)) return null;
  return problem(401, 'Admin token required');
}

export function registerApiRoutes(router: Router): void {
  // --- changes ------------------------------------------------------------
  router.get('/api/changes', async (ctx) => {
    const p = ctx.url.searchParams;
    const { changes, total } = await ctx.repo.listChanges({
      category: p.get('category') ?? undefined,
      changeType: p.get('type') ?? undefined,
      severity: p.get('severity') ?? undefined,
      minScore: p.get('minScore') ? Number.parseInt(p.get('minScore')!, 10) : undefined,
      since: p.get('since') ? Math.floor(Date.parse(p.get('since')!) / 1000) || undefined : undefined,
      order: p.get('order') === 'recent' ? 'recent' : 'interesting',
      limit: Number.parseInt(p.get('limit') ?? '24', 10),
      offset: Number.parseInt(p.get('offset') ?? '0', 10),
    });
    return json(
      {
        total,
        count: changes.length,
        changes: changes.map((change) =>
          changeDto(change, ctx.baseUrl, {
            currentCid: (change as unknown as Record<string, unknown>).current_cid as string | null,
            previousCid: (change as unknown as Record<string, unknown>).previous_cid as string | null,
          }),
        ),
      },
      {},
      CACHE_SHORT,
    );
  });

  router.get('/api/changes/:id', async (ctx) => {
    const change = await ctx.repo.getChange(ctx.params.id);
    if (!change) return problem(404, 'Change not found');
    const [site, previous, current] = await Promise.all([
      ctx.repo.getSite(change.site_id),
      change.previous_snapshot_id ? ctx.repo.getSnapshot(change.previous_snapshot_id) : Promise.resolve(null),
      ctx.repo.getSnapshot(change.current_snapshot_id),
    ]);
    return json(
      {
        ...changeDto({ ...change, site: site ?? undefined }, ctx.baseUrl, {
          previousCid: previous?.cid ?? null,
          currentCid: current?.cid ?? null,
          capturedAt: current ? new Date(current.captured_at * 1000).toISOString() : null,
        }),
        signals: safeParse(change.signals),
        suppressed: safeParse(change.suppressed),
        aiModel: change.ai_model,
        diff: safeParse(change.diff),
      },
      {},
      CACHE_LONG,
    );
  });

  router.get('/api/changes/:id/diff', async (ctx) => {
    const change = await ctx.repo.getChange(ctx.params.id);
    if (!change) return problem(404, 'Change not found');
    return json(safeParse(change.diff), {}, CACHE_LONG);
  });

  // --- sites --------------------------------------------------------------
  router.get('/api/sites', async (ctx) => {
    const p = ctx.url.searchParams;
    const { sites, total } = await ctx.repo.listSites({
      category: p.get('category') ?? undefined,
      status: p.get('status') ?? undefined,
      q: p.get('q') ?? undefined,
      limit: Number.parseInt(p.get('limit') ?? '100', 10),
      offset: Number.parseInt(p.get('offset') ?? '0', 10),
    });
    return json({ total, count: sites.length, sites: sites.map(siteDto) }, {}, CACHE_SHORT);
  });

  router.get('/api/sites/:id', async (ctx) => {
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return problem(404, 'Site not found');
    const latest = await ctx.repo.latestSnapshot(site.id);
    return json(
      {
        ...siteDto(site),
        latestSnapshot: latest
          ? { id: latest.id, cid: latest.cid, capturedAt: new Date(latest.captured_at * 1000).toISOString(), httpStatus: latest.http_status }
          : null,
      },
      {},
      CACHE_SHORT,
    );
  });

  router.get('/api/sites/:id/changes', async (ctx) => {
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return problem(404, 'Site not found');
    const { changes, total } = await ctx.repo.listChanges({
      siteId: site.id,
      order: 'recent',
      limit: Number.parseInt(ctx.url.searchParams.get('limit') ?? '50', 10),
      includeUnpublished: ctx.url.searchParams.get('all') === '1' && (await isAdmin(ctx.request, ctx.env)),
    });
    if (ctx.url.searchParams.get('format') === 'csv') {
      const header = 'detected_at,change_type,severity,score,headline,before,after,delta,url\n';
      const rows = changes
        .map((change) =>
          [
            new Date(change.detected_at * 1000).toISOString(),
            change.change_type,
            change.severity,
            String(change.interestingness_score),
            change.headline,
            change.before_value ?? '',
            change.after_value ?? '',
            change.delta ?? '',
            `${ctx.baseUrl}/changes/${change.slug}`,
          ]
            .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
            .join(','),
        )
        .join('\n');
      return new Response(header + rows, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="changes-${site.host}.csv"`,
        },
      });
    }
    return json({ total, changes: changes.map((change) => changeDto(change, ctx.baseUrl)) }, {}, CACHE_SHORT);
  });

  router.get('/api/sites/:id/snapshots', async (ctx) => {
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return problem(404, 'Site not found');
    const snapshots = await ctx.repo.listSnapshots(site.id, Number.parseInt(ctx.url.searchParams.get('limit') ?? '50', 10));
    return json(
      {
        snapshots: snapshots.map((snapshot) => ({
          id: snapshot.id,
          capturedAt: new Date(snapshot.captured_at * 1000).toISOString(),
          httpStatus: snapshot.http_status,
          cid: snapshot.cid,
          contentHash: snapshot.content_hash,
          duplicate: Boolean(snapshot.is_duplicate),
          method: snapshot.fetch_method,
          bytes: snapshot.raw_bytes,
        })),
      },
      {},
      CACHE_SHORT,
    );
  });

  router.post('/api/sites', async (ctx) => {
    const denied = await requireAdmin(ctx);
    if (denied) return denied;
    const body = await readBody(ctx.request);
    if (!body.url) return problem(400, 'url is required');
    const result = await addSite(ctx.env, ctx.repo, body);
    if (!result.ok) return problem(result.reason === 'duplicate' ? 409 : 400, result.error ?? 'Rejected', { reason: result.reason });
    await enqueue(ctx.env, { type: 'crawl', siteId: result.site!.id, reason: 'manual' }, ctx.executionCtx);
    return json({ site: siteDto(result.site!) }, { status: 201 });
  });

  router.patch('/api/sites/:id', async (ctx) => {
    const denied = await requireAdmin(ctx);
    if (denied) return denied;
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return problem(404, 'Site not found');
    await updateSite(ctx.repo, site, await readBody(ctx.request));
    return json({ site: siteDto((await ctx.repo.getSite(site.id))!) });
  });

  router.delete('/api/sites/:id', async (ctx) => {
    const denied = await requireAdmin(ctx);
    if (denied) return denied;
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return problem(404, 'Site not found');
    await ctx.repo.deleteSite(site.id);
    return json({ deleted: site.id });
  });

  router.post('/api/sites/:id/crawl', async (ctx) => {
    const denied = await requireAdmin(ctx);
    if (denied) return denied;
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return problem(404, 'Site not found');
    const mode = await enqueue(ctx.env, { type: 'crawl', siteId: site.id, reason: 'manual' }, ctx.executionCtx);
    return json({ queued: true, mode, siteId: site.id }, { status: 202 });
  });

  // --- snapshots ----------------------------------------------------------
  router.get('/api/snapshots/:id', async (ctx) => {
    const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
    if (!snapshot) return problem(404, 'Snapshot not found');
    const store = createContentStore(ctx.env);
    return json(
      {
        id: snapshot.id,
        siteId: snapshot.site_id,
        capturedAt: new Date(snapshot.captured_at * 1000).toISOString(),
        httpStatus: snapshot.http_status,
        contentType: snapshot.content_type,
        finalUrl: snapshot.final_url,
        fetchMethod: snapshot.fetch_method,
        bytes: snapshot.raw_bytes,
        contentHash: snapshot.content_hash,
        rawHash: snapshot.raw_hash,
        cid: snapshot.cid,
        pageCid: snapshot.page_cid,
        textCid: snapshot.text_cid,
        duplicate: Boolean(snapshot.is_duplicate),
        headers: safeParse(snapshot.headers),
        gateway: snapshot.cid ? store.gatewayUrl(snapshot.cid) : null,
        artifact: snapshot.cid ? `${ctx.baseUrl}/api/snapshots/${snapshot.id}/artifact.car` : null,
      },
      {},
      CACHE_LONG,
    );
  });

  router.get('/api/snapshots/:id/verify', async (ctx) => {
    const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
    if (!snapshot) return problem(404, 'Snapshot not found');
    if (!snapshot.page_cid) return problem(409, 'Snapshot has no stored artifact');
    const store = createContentStore(ctx.env);
    const bytes = await store.get(snapshot.page_cid);
    if (!bytes) return problem(404, 'Artifact bytes unavailable from any replica');
    const actual = await sha256Hex(bytes);
    const { rawBlock } = await import('../lib/cid');
    const recomputed = await rawBlock(bytes);
    return json({
      snapshotId: snapshot.id,
      cidMatches: recomputed.cid === snapshot.page_cid,
      recomputedCid: recomputed.cid,
      recordedCid: snapshot.page_cid,
      rawHashMatches: snapshot.raw_hash === actual,
      recomputedRawHash: actual,
      recordedRawHash: snapshot.raw_hash,
      checkedAt: new Date().toISOString(),
    });
  });

  router.get('/api/snapshots/:id/artifact.car', async (ctx) => {
    const snapshot = await ctx.repo.getSnapshot(ctx.params.id);
    if (!snapshot?.cid) return problem(404, 'Snapshot artifact not found');
    const car = await rawR2Store(ctx.env).getCar(snapshot.cid);
    if (!car) return problem(404, 'CAR archive not available for this snapshot');
    return new Response(car, {
      headers: {
        'content-type': 'application/vnd.ipld.car',
        'content-disposition': `attachment; filename="${snapshot.cid}.car"`,
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });

  // --- search, stats, digest ---------------------------------------------
  router.get('/api/search', async (ctx) => {
    const query = ctx.url.searchParams.get('q') ?? '';
    const { changes } = await ctx.repo.searchChanges(query, {
      category: ctx.url.searchParams.get('category') ?? undefined,
      limit: Number.parseInt(ctx.url.searchParams.get('limit') ?? '40', 10),
    });
    return json({ query, count: changes.length, changes: changes.map((change) => changeDto(change, ctx.baseUrl)) }, {}, CACHE_SHORT);
  });

  router.get('/api/stats', async (ctx) => {
    const [stats, categories] = await Promise.all([ctx.repo.stats(), ctx.repo.categoryCounts()]);
    return json({ ...stats, categories, toolVersion: ctx.env.TOOL_VERSION }, {}, CACHE_SHORT);
  });

  router.get('/api/digest/:day', async (ctx) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.day) ? ctx.params.day : new Date().toISOString().slice(0, 10);
    let digest = await ctx.repo.getDigest(day);
    if (!digest && day === new Date().toISOString().slice(0, 10)) {
      await buildDigest(ctx.env, ctx.repo, day);
      digest = await ctx.repo.getDigest(day);
    }
    if (!digest) return problem(404, 'No digest for that day');
    const ids = safeParse(digest.change_ids) as string[];
    const changes = await Promise.all(ids.map((id) => ctx.repo.getChange(id)));
    return json(
      {
        day,
        intro: digest.intro,
        stats: safeParse(digest.stats),
        changes: changes.filter(Boolean).map((change) => changeDto(change as ChangeEvent, ctx.baseUrl)),
      },
      {},
      CACHE_SHORT,
    );
  });

  router.get('/api/categories', async (ctx) => {
    const counts = await ctx.repo.categoryCounts();
    return json({ categories: CATEGORIES.map((category) => ({ name: category, changes: counts[category] ?? 0 })) }, {}, CACHE_SHORT);
  });

  // --- subscriptions ------------------------------------------------------
  router.post('/api/subscriptions', async (ctx) => {
    const body = await readBody(ctx.request);
    const email = (body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 190) {
      return wantsHtml(ctx.request)
        ? redirectBack(ctx, 'Enter a valid email address')
        : problem(400, 'A valid email address is required');
    }
    const user = await ctx.repo.upsertUser(email);
    const siteId = body.siteId || null;
    const category = body.category && CATEGORIES.includes(body.category as never) ? body.category : null;
    if (siteId) {
      const site = await ctx.repo.getSite(siteId);
      if (!site) return problem(404, 'Site not found');
    }
    await ctx.repo.createSubscription({
      userId: user.id,
      siteId,
      category: siteId ? null : category,
      minScore: Number.parseInt(body.minScore ?? '40', 10) || 40,
      channel: 'EMAIL',
    });
    if (wantsHtml(ctx.request)) {
      return redirectBack(ctx, 'Subscribed. You will get an email when something meaningful changes.');
    }
    return json({ subscribed: true, email, siteId, category }, { status: 201 });
  });
}

function safeParse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

function redirectBack(ctx: Ctx, message: string): Response {
  const referer = ctx.request.headers.get('referer');
  const target = referer && referer.startsWith(ctx.baseUrl) ? referer : `${ctx.baseUrl}/`;
  const url = new URL(target);
  url.searchParams.set('notice', message);
  return new Response(null, { status: 303, headers: { location: url.toString() } });
}
