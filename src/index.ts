/**
 * The Internet Change Detector — Cloudflare Worker entry point.
 *
 * One Worker serves three roles:
 *   fetch()     the public site and the JSON API
 *   scheduled() the crawl scheduler and the daily digest
 *   queue()     the crawl / notify / digest job consumers
 */
import type { Env, Job } from './types';
import { Router, Ctx, problem } from './router';
import { Repo } from './db/repo';
import { notFound, registerUiRoutes } from './ui/routes';
import { registerApiRoutes } from './api/routes';
import { registerAdminRoutes } from './api/admin-routes';
import { sweep } from './pipeline/scheduler';
import { handleJob } from './pipeline/worker-jobs';
import { buildDigest } from './pipeline/digest';
import { deliverPending } from './pipeline/notify';

const router = new Router();
registerUiRoutes(router);
registerApiRoutes(router);
registerAdminRoutes(router);

function baseUrlFor(request: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL && !env.PUBLIC_BASE_URL.includes('localhost')) return env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
          'access-control-max-age': '86400',
        },
      });
    }

    const matched = router.match(request.method, url.pathname);
    if (!matched) {
      if (url.pathname.startsWith('/api/')) return problem(404, 'No such endpoint');
      return notFound({ url, baseUrl: baseUrlFor(request, env) }, 'There is nothing at this address');
    }

    const ctx: Ctx = {
      request,
      env,
      executionCtx,
      url,
      params: matched.params,
      repo: new Repo(env.DB),
      baseUrl: baseUrlFor(request, env),
    };

    try {
      const response = await matched.handler(ctx);
      if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
      return response;
    } catch (error) {
      console.error('request failed', url.pathname, error instanceof Error ? error.stack : error);
      if (url.pathname.startsWith('/api/')) {
        return problem(500, 'Internal error', error instanceof Error ? error.message : undefined);
      }
      return new Response('Something went wrong rendering this page.', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },

  async scheduled(event: ScheduledController, env: Env, executionCtx: ExecutionContext): Promise<void> {
    const repo = new Repo(env.DB);
    const run = async () => {
      // 07:00 UTC: build and send the daily digest. Every sweep: crawl what is due.
      const isDigestHour = event.cron === '0 7 * * *';
      if (isDigestHour) {
        try {
          const digest = await buildDigest(env, repo);
          if (digest.changeIds.length) {
            const queued = await repo.queueDigestNotifications(digest.day);
            console.log('digest queued', digest.day, queued);
          }
        } catch (error) {
          console.error('digest failed', error);
        }
      }
      await repo.backfillSiteSlugs(50).catch((error) => console.error('slug backfill failed', error));
      const result = await sweep(env, repo, executionCtx);
      console.log('sweep', JSON.stringify(result));
      await deliverPending(env, repo, 25).catch((error) => console.error('notify failed', error));
    };
    executionCtx.waitUntil(run());
  },

  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleJob(env, message.body);
        message.ack();
      } catch (error) {
        console.error('job failed', JSON.stringify(message.body), error instanceof Error ? error.message : error);
        message.retry({ delaySeconds: Math.min(3600, 60 * Math.pow(2, message.attempts)) });
      }
    }
  },
};
