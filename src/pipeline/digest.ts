/**
 * "The Internet Changed Today" — the daily digest artefact.
 *
 * One cached object per day, shared by the public page, the RSS feed and the
 * email, so everyone sees the same five changes.
 */
import type { Env } from '../types';
import { Repo, now } from '../db/repo';
import { writeDigestIntro } from '../ai/analyze';

export interface DigestPayload {
  day: string;
  intro: string;
  changeIds: string[];
  stats: { detected: number; published: number; sites: number };
}

export async function buildDigest(env: Env, repo: Repo, day?: string): Promise<DigestPayload> {
  const targetDay = day ?? new Date().toISOString().slice(0, 10);
  const since = now() - 86400;

  const { changes } = await repo.listChanges({ since, order: 'interesting', limit: 25 });
  const top = changes.filter((change) => change.published === 1).slice(0, 5);
  const stats = await repo.stats();
  const detected = (await repo.listChanges({ since, includeUnpublished: true, limit: 100 })).total;

  const digestStats = { detected, published: changes.length, sites: stats.sites };
  const intro = await writeDigestIntro(env, top.map((change) => change.headline), digestStats);

  await repo.saveDigest(targetDay, top.map((change) => change.id), intro, digestStats);
  return { day: targetDay, intro, changeIds: top.map((c) => c.id), stats: digestStats };
}
