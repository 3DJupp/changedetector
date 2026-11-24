/** Queue job dispatch, shared by the queue consumer and the inline fallback. */
import type { Env, Job } from '../types';
import { Repo } from '../db/repo';
import { crawlSite } from './crawl';
import { deliverPending } from './notify';
import { buildDigest } from './digest';

export async function handleJob(env: Env, job: Job): Promise<void> {
  const repo = new Repo(env.DB);
  switch (job.type) {
    case 'crawl': {
      const site = await repo.getSite(job.siteId);
      if (!site) return;
      if (site.status === 'PAUSED' || site.status === 'ARCHIVED') return;
      await crawlSite(env, repo, site, job.reason);
      return;
    }
    case 'notify': {
      await deliverPending(env, repo, 25);
      return;
    }
    case 'digest': {
      await buildDigest(env, repo, job.day);
      return;
    }
    case 'analyze':
    case 'artifact':
    default:
      return;
  }
}
