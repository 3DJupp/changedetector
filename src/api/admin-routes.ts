/** The monitoring console: form-driven admin actions. */
import seedSites from '../../seed/sites.json';
import { Ctx, readBody, redirect, Router } from '../router';
import { html } from '../ui/layout';
import { adminPage } from '../ui/pages/admin';
import { isAdmin, loginCookie, logoutCookie } from './auth';
import { addSite, updateSite } from './sites-service';
import { enqueue, sweep } from '../pipeline/scheduler';
import { buildDigest } from '../pipeline/digest';
import { deliverPending } from '../pipeline/notify';
import { seedDemo } from '../pipeline/demo';
import { now } from '../db/repo';

interface SeedEntry {
  url: string;
  title?: string;
  category?: string;
  priority?: string;
}

async function guard(ctx: Ctx): Promise<Response | null> {
  if (await isAdmin(ctx.request, ctx.env)) return null;
  return redirect(`/admin?error=${encodeURIComponent('Admin token required for that action')}`);
}

function back(message: string, error = false): Response {
  return redirect(`/admin?${error ? 'error' : 'message'}=${encodeURIComponent(message)}`);
}

export function registerAdminRoutes(router: Router): void {
  router.get('/admin', async (ctx) => {
    const authed = await isAdmin(ctx.request, ctx.env);
    const [{ sites, total }, stats, logs, due] = await Promise.all([
      ctx.repo.listSites({ limit: 200, q: ctx.url.searchParams.get('q') ?? undefined }),
      ctx.repo.stats(),
      ctx.repo.recentCrawlLogs(25),
      ctx.repo.dueSites(500),
    ]);
    return html(
      adminPage({
        baseUrl: ctx.baseUrl,
        sites,
        total,
        stats,
        queue: { mode: ctx.env.JOBS ? 'queue' : 'inline', due: due.length },
        logs: logs as Record<string, unknown>[],
        message: ctx.url.searchParams.get('message') ?? undefined,
        error: ctx.url.searchParams.get('error') ?? undefined,
        authed,
      }),
      200,
      { 'cache-control': 'no-store' },
    );
  });

  router.post('/admin/login', async (ctx) => {
    const body = await readBody(ctx.request);
    if (!ctx.env.ADMIN_TOKEN) return back('ADMIN_TOKEN is not configured on this deployment', true);
    if (body.token !== ctx.env.ADMIN_TOKEN) return back('Incorrect token', true);
    return redirect('/admin?message=' + encodeURIComponent('Signed in'), 303, {
      'set-cookie': await loginCookie(ctx.env, ctx.url.protocol === 'https:'),
    });
  });

  router.post('/admin/logout', async () =>
    redirect('/admin', 303, { 'set-cookie': logoutCookie() }),
  );

  router.post('/admin/sites', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const body = await readBody(ctx.request);
    const result = await addSite(ctx.env, ctx.repo, body);
    if (!result.ok) return back(result.error ?? 'Could not add that URL', true);
    await enqueue(ctx.env, { type: 'crawl', siteId: result.site!.id, reason: 'manual' }, ctx.executionCtx);
    return back(`Added ${result.site!.canonical_url} and queued the first capture`);
  });

  router.post('/admin/sites/:id/crawl', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return back('Site not found', true);
    await ctx.repo.updateSite(site.id, { next_check_at: now() });
    const mode = await enqueue(ctx.env, { type: 'crawl', siteId: site.id, reason: 'manual' }, ctx.executionCtx);
    return back(`Crawl ${mode === 'queued' ? 'queued' : 'started'} for ${site.host}`);
  });

  router.post('/admin/sites/:id/toggle', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return back('Site not found', true);
    const status = site.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
    await updateSite(ctx.repo, site, { status });
    return back(`${site.host} is now ${status.toLowerCase()}`);
  });

  router.post('/admin/sites/:id/update', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return back('Site not found', true);
    await updateSite(ctx.repo, site, await readBody(ctx.request));
    return back(`Updated ${site.host}`);
  });

  router.post('/admin/sites/:id/delete', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const site = await ctx.repo.getSite(ctx.params.id);
    if (!site) return back('Site not found', true);
    await ctx.repo.deleteSite(site.id);
    return back(`Removed ${site.host} and its history`);
  });

  router.post('/admin/changes/:id/false-positive', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const change = await ctx.repo.getChange(ctx.params.id);
    if (!change) return back('Change not found', true);
    await ctx.repo.updateChange(change.id, { false_positive: 1, published: 0 });
    await ctx.repo.bumpMetric('false_positives');
    return back('Marked as a false positive and unpublished');
  });

  router.post('/admin/seed', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const entries = seedSites as SeedEntry[];
    let added = 0;
    let skipped = 0;
    // Bounded per request so one invocation never runs long; re-run to continue.
    for (const entry of entries.slice(0, 60)) {
      const existing = await ctx.repo.getSiteByCanonical(entry.url.replace(/\/$/, ''));
      if (existing) {
        skipped++;
        continue;
      }
      const result = await addSite(ctx.env, ctx.repo, {
        url: entry.url,
        title: entry.title,
        category: entry.category,
        priority: entry.priority,
        interval: entry.priority === 'HIGH' ? '30m' : entry.priority === 'LOW' ? '24h' : '6h',
      });
      if (result.ok) added++;
      else skipped++;
    }
    return back(`Seed run complete: ${added} added, ${skipped} skipped (already present, or blocked by robots.txt). Run again to continue.`);
  });

  router.post('/admin/demo', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const result = await seedDemo(ctx.env, ctx.repo);
    return back(`Demo data generated: ${result.sites} fixture pages, ${result.changes} change events`);
  });

  router.post('/admin/sweep', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const result = await sweep(ctx.env, ctx.repo, ctx.executionCtx);
    return back(`Sweep: ${result.due} due, ${result.enqueued} queued, ${result.processedInline} processed inline (${result.mode} mode)`);
  });

  router.post('/admin/digest', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const digest = await buildDigest(ctx.env, ctx.repo);
    return back(`Digest rebuilt for ${digest.day} with ${digest.changeIds.length} change(s)`);
  });

  router.post('/admin/notifications', async (ctx) => {
    const denied = await guard(ctx);
    if (denied) return denied;
    const result = await deliverPending(ctx.env, ctx.repo, 50);
    return back(`Outbox flushed: ${result.sent} sent, ${result.failed} retried`);
  });
}
