/**
 * Semantic search over published change events.
 *
 * Optional on two levels: without a Vectorize binding (VECTORS) or without an
 * embedding model, every function here is a no-op and search stays full-text
 * only. Full-text hits always rank first; semantic hits fill in what keyword
 * matching misses ("price hike" finding "Pro plan $19 → $24").
 */
import type { ChangeEvent, Env, MonitoredSite } from '../types';
import type { Repo } from '../db/repo';
import { embed } from '../ai/analyze';

/** Cosine similarity below which a semantic hit is considered unrelated. */
const MIN_SCORE = 0.62;

export function semanticEnabled(env: Env): boolean {
  return Boolean(env.VECTORS && env.AI && env.AI_EMBEDDING_MODEL);
}

export function embeddingText(change: Pick<ChangeEvent, 'headline' | 'summary'>, site: Pick<MonitoredSite, 'title' | 'category'>): string {
  return [change.headline, change.summary, site.title ?? '', site.category].filter(Boolean).join('\n');
}

export async function indexChangeVector(env: Env, change: ChangeEvent, site: MonitoredSite): Promise<boolean> {
  if (!semanticEnabled(env) || change.published !== 1) return false;
  const values = await embed(env, embeddingText(change, site));
  if (!values) return false;
  await env.VECTORS!.upsert([
    { id: change.id, values, metadata: { category: site.category, detected_at: change.detected_at } },
  ]);
  return true;
}

export async function removeChangeVector(env: Env, changeId: string): Promise<void> {
  if (!env.VECTORS) return;
  await env.VECTORS.deleteByIds([changeId]).catch(() => undefined);
}

type SearchRow = Awaited<ReturnType<Repo['searchChanges']>>['changes'][number];

/** Full-text first, then semantic neighbours that full-text did not find. */
export async function hybridSearch(
  env: Env,
  repo: Repo,
  query: string,
  options: { category?: string; limit?: number } = {},
): Promise<{ changes: SearchRow[]; semantic: number }> {
  const limit = Math.min(options.limit ?? 40, 100);
  const { changes } = await repo.searchChanges(query, { ...options, limit });
  if (!semanticEnabled(env) || changes.length >= limit || query.trim().length < 3) {
    return { changes, semantic: 0 };
  }
  try {
    const vector = await embed(env, query);
    if (!vector) return { changes, semantic: 0 };
    const result = await env.VECTORS!.query(vector, { topK: 20 });
    const seen = new Set(changes.map((change) => change.id));
    const ids = result.matches.filter((match) => match.score >= MIN_SCORE && !seen.has(match.id)).map((match) => match.id);
    const extra = (await repo.changesByIds(ids, options.category)) as unknown as SearchRow[];
    return { changes: [...changes, ...extra].slice(0, limit), semantic: extra.length };
  } catch (error) {
    console.error('semantic search failed', error);
    return { changes, semantic: 0 };
  }
}
