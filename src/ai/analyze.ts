/**
 * AI analysis layer.
 *
 * Optional by design: the detector produces a complete, publishable change
 * event on heuristics alone. The model improves the *wording* and provides a
 * second opinion on significance — it never becomes a hard dependency, and it
 * only runs for changes that already look meaningful (cost control).
 */
import type { Env } from '../types';
import { ANALYSIS_SYSTEM, AnalysisContext, buildAnalysisPrompt, buildDigestPrompt, DIGEST_SYSTEM } from './prompts';
import { CHANGE_TYPES } from '../types';
import { newSlug } from '../lib/hash';

export interface AiAnalysis {
  headline: string;
  summary: string;
  significance: number;
  changeType: string;
  isNoise: boolean;
  tags: string[];
  model: string;
}

const MIN_SCORE_FOR_AI = 20;

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runModel(env: Env, system: string, prompt: string, maxTokens = 480): Promise<string | null> {
  if (env.AI && env.AI_MODEL) {
    try {
      const result = await env.AI.run(env.AI_MODEL, {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
      });
      const text = typeof result === 'string' ? result : (result?.response ?? result?.result?.response ?? '');
      if (typeof text === 'string' && text.trim()) return text;
    } catch (error) {
      console.warn('workers-ai failed', error instanceof Error ? error.message : error);
    }
  }

  // Optional hosted fallback, used only when explicitly configured.
  if (env.ANTHROPIC_API_KEY) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        const body = (await response.json()) as { content?: { text?: string }[] };
        const text = body.content?.map((part) => part.text ?? '').join('') ?? '';
        if (text.trim()) return text;
      }
    } catch (error) {
      console.warn('anthropic fallback failed', error instanceof Error ? error.message : error);
    }
  }
  return null;
}

export async function analyzeChange(env: Env, context: AnalysisContext): Promise<AiAnalysis | null> {
  if (context.heuristicScore < MIN_SCORE_FOR_AI) return null;
  const nonce = newSlug();
  const text = await runModel(env, ANALYSIS_SYSTEM, buildAnalysisPrompt(context, nonce));
  if (!text) return null;

  const parsed = extractJson(text);
  if (!parsed) return null;

  const headline = typeof parsed.headline === 'string' ? parsed.headline.trim().slice(0, 220) : '';
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 600) : '';
  if (!headline || !summary) return null;

  const rawSignificance = Number(parsed.significance);
  const significance = Number.isFinite(rawSignificance)
    ? Math.max(0, Math.min(100, Math.round(rawSignificance)))
    : context.heuristicScore;

  const changeType =
    typeof parsed.change_type === 'string' && (CHANGE_TYPES as readonly string[]).includes(parsed.change_type)
      ? parsed.change_type
      : context.changeType;

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase().slice(0, 24)).slice(0, 4)
    : [];

  return {
    headline,
    summary,
    significance,
    changeType,
    isNoise: parsed.is_noise === true,
    tags,
    model: env.AI_MODEL || 'anthropic-fallback',
  };
}

/**
 * Blend the heuristic and model scores. The heuristic anchors the result; the
 * model can move it, but not run away with it, and a "this is noise" verdict
 * is capped rather than obeyed blindly.
 */
export function blendScores(heuristic: number, ai: AiAnalysis | null): number {
  if (!ai) return heuristic;
  if (ai.isNoise) return Math.min(heuristic, 12);
  const blended = Math.round(heuristic * 0.6 + ai.significance * 0.4);
  const bounded = Math.max(heuristic - 25, Math.min(heuristic + 25, blended));
  return Math.max(0, Math.min(100, bounded));
}

export async function writeDigestIntro(
  env: Env,
  headlines: string[],
  stats: { detected: number; published: number; sites: number },
): Promise<string> {
  const fallback = `${stats.detected} changes detected in the last 24 hours across ${stats.sites} monitored pages; ${stats.published} were significant enough to publish.`;
  if (headlines.length === 0) return fallback;
  const text = await runModel(env, DIGEST_SYSTEM, buildDigestPrompt(headlines, stats), 160);
  if (!text) return fallback;
  const line = text.trim().split('\n').find((l) => l.trim().length > 20);
  return (line ?? fallback).replace(/^["']|["']$/g, '').slice(0, 220);
}

/** Optional embedding for semantic search. Silently unavailable is fine. */
export async function embed(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI || !env.AI_EMBEDDING_MODEL) return null;
  try {
    const result = await env.AI.run(env.AI_EMBEDDING_MODEL, { text: [text.slice(0, 2000)] });
    const vector = result?.data?.[0];
    return Array.isArray(vector) ? vector : null;
  } catch {
    return null;
  }
}
