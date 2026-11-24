/**
 * Scheduling.
 *
 * A cron sweep picks the sites whose next_check_at has passed and pushes crawl
 * jobs onto the queue. The crawler never runs inside an HTTP request; when no
 * queue binding is configured (local dev, free plan) a small, bounded number of
 * jobs is processed inline instead so the system still works end to end.
 */
import type { Env, Job } from '../types';
import { Repo } from '../db/repo';
import { crawlSite } from './crawl';

/** Ceiling per sweep, keeping each cron invocation inside its CPU budget. */
const MAX_JOBS_PER_SWEEP = 60;
const MAX_INLINE_JOBS = 6;

export interface SweepResult {
  due: number;
  enqueued: number;
  processedInline: number;
  mode: 'queue' | 'inline';
}

export async function sweep(env: Env, repo: Repo, ctx?: ExecutionContext): Promise<SweepResult> {
  const due = await repo.dueSites(MAX_JOBS_PER_SWEEP);
  if (due.length === 0) return { due: 0, enqueued: 0, processedInline: 0, mode: env.JOBS ? 'queue' : 'inline' };

  if (env.JOBS) {
    const messages = due.map((site) => ({
      body: { type: 'crawl', siteId: site.id, reason: 'scheduled' } as Job,
    }));
    // Claim the sites immediately so a slow queue cannot cause double-enqueue.
    await Promise.all(
      due.map((site) => repo.updateSite(site.id, { next_check_at: Math.floor(Date.now() / 1000) + 300 })),
    );
    for (let i = 0; i < messages.length; i += 100) {
      await env.JOBS.sendBatch(messages.slice(i, i + 100));
    }
    return { due: due.length, enqueued: messages.length, processedInline: 0, mode: 'queue' };
  }

  const batch = due.slice(0, MAX_INLINE_JOBS);
  const run = async () => {
    for (const site of batch) {
      try {
        await crawlSite(env, repo, site, 'scheduled');
      } catch (error) {
        console.error('inline crawl failed', site.canonical_url, error instanceof Error ? error.message : error);
      }
    }
  };
  if (ctx) ctx.waitUntil(run());
  else await run();

  return { due: due.length, enqueued: 0, processedInline: batch.length, mode: 'inline' };
}

/** Enqueue one job, falling back to inline execution when no queue exists. */
export async function enqueue(env: Env, job: Job, ctx?: ExecutionContext): Promise<'queued' | 'inline'> {
  if (env.JOBS) {
    await env.JOBS.send(job);
    return 'queued';
  }
  const { handleJob } = await import('./worker-jobs');
  const run = handleJob(env, job);
  if (ctx) ctx.waitUntil(run.catch((error) => console.error('inline job failed', error)));
  else await run;
  return 'inline';
}
