/**
 * The crawl pipeline: fetch → normalize → hash → store → detect → publish.
 *
 * Runs inside a queue consumer, never inside a user-facing HTTP request.
 */
import type { Env, MonitoredSite, Snapshot } from '../types';
import { indexChangeVector } from '../lib/semantic';
import { Repo, now } from '../db/repo';
import { computeBackoffSeconds, fetchPage, FetchFailure, parseRetryAfter, throttleDomain } from '../lib/fetcher';
import { UrlNotAllowed } from '../lib/urlguard';
import { getRobots, isAllowed } from '../lib/robots';
import {
  canonicalPayload,
  extractDocumentPrices,
  needsBrowserRendering,
  NormalizationConfig,
  NormalizedDocument,
  normalizeHtml,
  normalizePlainText,
} from '../lib/normalize';
import { sha256Hex } from '../lib/hash';
import { buildDiffPayload, detectChange } from '../lib/detect';
import { createContentStore } from '../store';
import { analyzeChange, blendScores } from '../ai/analyze';
import { createRenderer } from './renderer';
import { queueForSubscribers } from './notify';

/** A captured response, however it was obtained (HTTP, browser, or a fixture). */
export interface Capture {
  status: number;
  contentType: string;
  body: Uint8Array;
  finalUrl: string;
  headers: Record<string, string>;
  durationMs: number;
  method: 'HTTP' | 'BROWSER';
  bytes: number;
}

export interface CrawlOutcome {
  outcome: 'CHANGED' | 'IDENTICAL' | 'ERROR' | 'SKIPPED' | 'BLOCKED';
  snapshotId?: string;
  changeId?: string;
  detail?: string;
  httpStatus?: number;
}

/** Decode a response body using the charset the server (or the document) declares. */
export function decodeBody(body: Uint8Array, contentType: string): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (!charset) {
    const head = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(body.subarray(0, 2048));
    charset = /charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  const normalized = charset === 'utf8' ? 'utf-8' : charset;
  try {
    return new TextDecoder(normalized ?? 'utf-8', { fatal: false, ignoreBOM: false }).decode(body);
  } catch {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(body);
  }
}

function parseNormalizationConfig(site: MonitoredSite): NormalizationConfig {
  if (!site.normalization) return {};
  try {
    return JSON.parse(site.normalization) as NormalizationConfig;
  } catch {
    return {};
  }
}

function nextCheck(site: MonitoredSite, override?: number): number {
  const jitter = Math.round(site.crawl_interval_s * (Math.random() * 0.1 - 0.05));
  return now() + (override ?? site.crawl_interval_s + jitter);
}

export async function crawlSite(env: Env, repo: Repo, site: MonitoredSite, reason: string): Promise<CrawlOutcome> {
  const startedAt = now();
  const startedMs = Date.now();
  const timeoutMs = Number.parseInt(env.FETCH_TIMEOUT_MS, 10) || 15000;
  const maxBytes = Number.parseInt(env.MAX_RESPONSE_BYTES, 10) || 2097152;
  const minInterval = Number.parseInt(env.DOMAIN_MIN_INTERVAL_S, 10) || 20;

  const fail = async (detail: string, httpStatus: number | null, retryAfterS?: number): Promise<CrawlOutcome> => {
    const errors = site.consecutive_errors + 1;
    const backoff = retryAfterS ?? computeBackoffSeconds(errors, Math.max(300, site.crawl_interval_s / 4));
    await repo.updateSite(site.id, {
      consecutive_errors: errors,
      last_error: detail.slice(0, 400),
      last_checked_at: startedAt,
      last_status: httpStatus,
      next_check_at: now() + backoff,
      status: errors >= 8 ? 'ERROR' : site.status,
    });
    await repo.logCrawl({
      siteId: site.id,
      startedAt,
      durationMs: Date.now() - startedMs,
      httpStatus,
      outcome: 'ERROR',
      error: detail.slice(0, 400),
    });
    await repo.bumpMetric('crawls');
    await repo.bumpMetric('crawl_errors');
    return { outcome: 'ERROR', detail, httpStatus: httpStatus ?? undefined };
  };

  // --- politeness ---------------------------------------------------------
  const origin = (() => {
    try {
      return new URL(site.canonical_url).origin;
    } catch {
      return null;
    }
  })();
  if (!origin) return fail('invalid canonical URL', null);

  const robots = await getRobots(origin, env.USER_AGENT, env.CACHE);
  const target = new URL(site.canonical_url);
  const decision = isAllowed(robots, env.USER_AGENT, target.pathname + target.search);
  if (!decision.allowed) {
    await repo.updateSite(site.id, {
      robots_allowed: 0,
      status: 'PAUSED',
      last_error: `robots.txt disallows this path (${decision.matchedRule ?? 'disallow'})`,
      last_checked_at: startedAt,
      next_check_at: now() + 86400,
    });
    await repo.logCrawl({
      siteId: site.id, startedAt, durationMs: Date.now() - startedMs, httpStatus: null,
      outcome: 'BLOCKED', error: 'robots.txt disallow',
    });
    return { outcome: 'BLOCKED', detail: 'robots.txt disallows this path' };
  }

  const effectiveMinInterval = Math.max(minInterval, Math.ceil(decision.crawlDelay ?? 0));
  const throttle = await throttleDomain(env.CACHE, site.host, effectiveMinInterval);
  if (!throttle.allowed) {
    await repo.updateSite(site.id, { next_check_at: now() + throttle.waitS + 5 });
    return { outcome: 'SKIPPED', detail: `domain throttled for ${throttle.waitS}s` };
  }

  // --- fetch --------------------------------------------------------------
  const previousSnapshot = await repo.latestSnapshot(site.id);
  const previousHeaders = previousSnapshot?.headers ? (JSON.parse(previousSnapshot.headers) as Record<string, string>) : {};

  let result;
  try {
    result = await fetchPage(site.canonical_url, {
      userAgent: env.USER_AGENT,
      timeoutMs,
      maxBytes,
      cache: env.CACHE,
      etag: previousSnapshot?.is_duplicate === 0 ? previousHeaders['etag'] ?? null : null,
      lastModified: previousSnapshot?.is_duplicate === 0 ? previousHeaders['last-modified'] ?? null : null,
    });
  } catch (error) {
    if (error instanceof UrlNotAllowed) {
      await repo.updateSite(site.id, {
        status: 'PAUSED',
        last_error: `blocked: ${error.message}`,
        last_checked_at: startedAt,
        next_check_at: now() + 86400,
      });
      await repo.logCrawl({
        siteId: site.id, startedAt, durationMs: Date.now() - startedMs, httpStatus: null,
        outcome: 'BLOCKED', error: error.message,
      });
      return { outcome: 'BLOCKED', detail: error.message };
    }
    const failure = error as FetchFailure;
    return fail(`${failure.reason ?? 'network'}: ${failure.message}`, null);
  }

  if (result.notModified) {
    await repo.updateSite(site.id, {
      consecutive_errors: 0, last_error: null, last_checked_at: startedAt,
      last_status: 304, next_check_at: nextCheck(site),
    });
    await repo.logCrawl({
      siteId: site.id, startedAt, durationMs: Date.now() - startedMs, httpStatus: 304, outcome: 'IDENTICAL',
    });
    await repo.bumpMetric('crawls');
    return { outcome: 'IDENTICAL', detail: 'not modified (ETag)' };
  }

  // Retryable server-side conditions.
  if (result.status === 429 || result.status >= 500) {
    const retryAfter = parseRetryAfter(result.headers['retry-after']);
    return fail(`HTTP ${result.status}`, result.status, retryAfter ?? undefined);
  }

  // 401/403 mean the crawler is being turned away, not that the page vanished.
  // Back off hard and never publish it as a disappearance.
  if (result.status === 401 || result.status === 403) {
    return fail(`HTTP ${result.status} — access refused, backing off`, result.status, 21600);
  }

  return processCapture(
    env,
    repo,
    site,
    {
      status: result.status,
      contentType: result.contentType,
      body: result.body,
      finalUrl: result.finalUrl,
      headers: result.headers,
      durationMs: result.durationMs,
      method: 'HTTP',
      bytes: result.bytes,
    },
    startedAt,
    startedMs,
  );
}

/**
 * Everything after the bytes arrive: normalize, hash, dedupe, store the
 * artifact, diff against the previous distinct capture, score it and publish.
 *
 * Kept separate from fetching so the same code path runs for an HTTP capture,
 * a browser-rendered capture, or a local fixture.
 */
export async function processCapture(
  env: Env,
  repo: Repo,
  site: MonitoredSite,
  capture: Capture,
  startedAt: number = now(),
  startedMs: number = Date.now(),
): Promise<CrawlOutcome> {
  const publishThreshold = Number.parseInt(env.PUBLISH_THRESHOLD, 10) || 25;
  const timeoutMs = Number.parseInt(env.FETCH_TIMEOUT_MS, 10) || 15000;
  const previousSnapshot = await repo.latestSnapshot(site.id);

  // --- normalize ----------------------------------------------------------
  const config = parseNormalizationConfig(site);
  const isHtml = /html|xml/i.test(capture.contentType) || capture.body.length === 0;
  let bodyText = decodeBody(capture.body, capture.contentType);
  let method: 'HTTP' | 'BROWSER' = capture.method;

  let doc: NormalizedDocument = isHtml
    ? normalizeHtml(bodyText, capture.finalUrl, config)
    : normalizePlainText(bodyText, capture.contentType);

  if (
    capture.status < 400 &&
    isHtml &&
    site.render_mode !== 'HTTP' &&
    (site.render_mode === 'BROWSER' || needsBrowserRendering(bodyText, doc))
  ) {
    const renderer = createRenderer(env);
    const rendered = renderer ? await renderer.render(site.canonical_url, timeoutMs * 2) : null;
    if (rendered) {
      bodyText = rendered.html;
      doc = normalizeHtml(bodyText, rendered.finalUrl, config);
      method = 'BROWSER';
      await repo.bumpMetric('browser_fetches');
    }
  }

  const canonical = canonicalPayload(doc);
  const contentHash = await sha256Hex(`${capture.status}\n${canonical}`);
  const rawHash = await sha256Hex(capture.body);

  // --- layer 1: identical? stop here --------------------------------------
  const previousDistinct = await repo.latestDistinctSnapshot(site.id);
  if (previousDistinct && previousDistinct.content_hash === contentHash) {
    const snapshot = await repo.createSnapshot({
      site_id: site.id,
      captured_at: startedAt,
      http_status: capture.status,
      content_type: capture.contentType.slice(0, 120),
      final_url: capture.finalUrl,
      fetch_method: method,
      fetch_ms: capture.durationMs,
      raw_bytes: capture.bytes,
      content_hash: contentHash,
      raw_hash: rawHash,
      cid: previousDistinct.cid,
      page_cid: previousDistinct.page_cid,
      text_cid: previousDistinct.text_cid,
      raw_storage_ref: null,
      normalized_content: null,
      text_content: null,
      title: doc.title || previousDistinct.title,
      headers: JSON.stringify(capture.headers),
      previous_snapshot_id: previousSnapshot?.id ?? null,
      is_duplicate: 1,
    });
    await repo.updateSite(site.id, {
      consecutive_errors: 0, last_error: null, last_checked_at: startedAt,
      last_status: capture.status, next_check_at: nextCheck(site),
      snapshot_count: site.snapshot_count + 1,
    });
    await repo.logCrawl({
      siteId: site.id, startedAt, durationMs: Date.now() - startedMs, httpStatus: capture.status,
      outcome: 'IDENTICAL', method, bytes: capture.bytes, snapshotId: snapshot.id,
    });
    await repo.bumpMetric('crawls');
    await repo.bumpMetric('snapshots');
    return { outcome: 'IDENTICAL', snapshotId: snapshot.id, httpStatus: capture.status };
  }

  // --- store the immutable artifact ---------------------------------------
  const store = createContentStore(env);
  const capturedAt = new Date(startedAt * 1000).toISOString();
  const metadata = {
    url: site.canonical_url,
    finalUrl: capture.finalUrl,
    capturedAt,
    httpStatus: capture.status,
    contentType: capture.contentType,
    contentHash,
    rawHash,
    previousContentHash: previousDistinct?.content_hash ?? null,
    previousCid: previousDistinct?.cid ?? null,
    fetchMethod: method,
    responseHeaders: capture.headers,
    toolVersion: env.TOOL_VERSION,
    normalization: config,
    suppressed: doc.suppressed,
  };

  const encoder = new TextEncoder();
  let artifact: Awaited<ReturnType<typeof store.putDirectory>> | null = null;
  try {
    artifact = await store.putDirectory(
      [
        { name: 'metadata.json', content: encoder.encode(JSON.stringify(metadata, null, 2)) },
        { name: 'page.html', content: capture.body },
        { name: 'content.txt', content: encoder.encode(doc.text) },
        { name: 'normalized.json', content: encoder.encode(canonical) },
      ],
      { url: site.canonical_url, capturedAt },
    );
  } catch (error) {
    console.error('artifact storage failed', error instanceof Error ? error.message : error);
  }

  const snapshot = await repo.createSnapshot({
    site_id: site.id,
    captured_at: startedAt,
    http_status: capture.status,
    content_type: capture.contentType.slice(0, 120),
    final_url: capture.finalUrl,
    fetch_method: method,
    fetch_ms: capture.durationMs,
    raw_bytes: capture.bytes,
    content_hash: contentHash,
    raw_hash: rawHash,
    cid: artifact?.cid ?? null,
    page_cid: artifact?.entries.find((e) => e.name === 'page.html')?.cid ?? null,
    text_cid: artifact?.entries.find((e) => e.name === 'content.txt')?.cid ?? null,
    raw_storage_ref: artifact ? `r2://content/${artifact.entries.find((e) => e.name === 'page.html')?.cid}` : null,
    normalized_content: canonical.length < 900000 ? canonical : null,
    text_content: doc.text.slice(0, 400000),
    title: doc.title.slice(0, 300) || null,
    headers: JSON.stringify(capture.headers),
    previous_snapshot_id: previousSnapshot?.id ?? null,
    is_duplicate: 0,
  });

  await repo.bumpMetric('crawls');
  await repo.bumpMetric('snapshots');

  // --- layers 2-5: detect, score, publish ---------------------------------
  const previousDoc = previousDistinct?.normalized_content
    ? (parseNormalized(previousDistinct.normalized_content) as NormalizedDocument | null)
    : null;

  const detection = detectChange({
    siteTitle: site.title || site.host,
    url: site.canonical_url,
    category: site.category,
    previous: previousDoc,
    current: doc,
    previousStatus: previousDistinct?.http_status ?? null,
    currentStatus: capture.status,
  });

  await repo.updateSite(site.id, {
    consecutive_errors: 0,
    last_error: null,
    last_checked_at: startedAt,
    last_status: capture.status,
    next_check_at: nextCheck(site),
    snapshot_count: site.snapshot_count + 1,
    title: site.title ?? (doc.title || null),
    status: site.status === 'ERROR' ? 'ACTIVE' : site.status,
  });

  if (!previousDistinct || !detection.changed) {
    await repo.logCrawl({
      siteId: site.id, startedAt, durationMs: Date.now() - startedMs, httpStatus: capture.status,
      outcome: previousDistinct ? 'IDENTICAL' : 'CHANGED', method, bytes: capture.bytes, snapshotId: snapshot.id,
    });
    return { outcome: previousDistinct ? 'IDENTICAL' : 'CHANGED', snapshotId: snapshot.id, httpStatus: capture.status };
  }

  // Second opinion from the model, for changes that already look meaningful.
  const ai = await analyzeChange(env, {
    siteTitle: site.title || site.host,
    url: site.canonical_url,
    category: site.category,
    changeType: detection.changeType,
    heuristicScore: detection.interestingness,
    heuristicHeadline: detection.headline,
    beforeLines: detection.rows.filter((r) => r.left && r.kind !== 'same').map((r) => r.left!),
    afterLines: detection.rows.filter((r) => r.right && r.kind !== 'same').map((r) => r.right!),
    priceChanges: detection.priceChanges,
    headingsAdded: detection.structural.headingsAdded,
    headingsRemoved: detection.structural.headingsRemoved,
    keywords: detection.keywords,
    statusBefore: previousDistinct.http_status,
    statusAfter: capture.status,
  }).catch(() => null);

  const finalScore = blendScores(detection.interestingness, ai);
  const severity = severityOf(finalScore);
  const published = finalScore >= publishThreshold && !(ai?.isNoise ?? false) ? 1 : 0;

  const change = await repo.createChange({
    site_id: site.id,
    previous_snapshot_id: previousDistinct.id,
    current_snapshot_id: snapshot.id,
    detected_at: startedAt,
    change_type: (ai?.changeType as never) ?? detection.changeType,
    severity,
    change_score: detection.changeScore,
    interestingness_score: finalScore,
    headline: ai?.headline ?? detection.headline,
    summary: ai?.summary ?? detection.summary,
    label: detection.label,
    before_value: detection.beforeValue,
    after_value: detection.afterValue,
    delta: detection.delta,
    delta_note: detection.deltaNote,
    diff: JSON.stringify(buildDiffPayload(detection)),
    signals: JSON.stringify(detection.signals),
    suppressed: JSON.stringify(doc.suppressed),
    ai_model: ai?.model ?? null,
    ai_analysis: ai ? JSON.stringify(ai) : null,
    published,
    false_positive: 0,
  });

  await repo.indexChange(change, site);
  await indexChangeVector(env, change, site).catch((error) => console.error('vector index failed', error));
  await repo.updateSite(site.id, {
    last_changed_at: startedAt,
    change_count: site.change_count + 1,
  });
  await repo.bumpMetric('changes');
  if (published) {
    await repo.bumpMetric('published_changes');
    await queueForSubscribers(env, repo, change, site).catch(() => 0);
  }

  await repo.logCrawl({
    siteId: site.id, startedAt, durationMs: Date.now() - startedMs, httpStatus: capture.status,
    outcome: 'CHANGED', method, bytes: capture.bytes, snapshotId: snapshot.id,
  });

  return { outcome: 'CHANGED', snapshotId: snapshot.id, changeId: change.id, httpStatus: capture.status };
}

function severityOf(score: number) {
  if (score >= 81) return 'MAJOR' as const;
  if (score >= 61) return 'SIGNIFICANT' as const;
  if (score >= 31) return 'MODERATE' as const;
  if (score >= 11) return 'MINOR' as const;
  return 'TRIVIAL' as const;
}

/** Rehydrate a stored canonical payload into the shape the detector expects. */
export function parseNormalized(json: string): NormalizedDocument | null {
  try {
    const parsed = JSON.parse(json) as {
      title: string;
      meta: Record<string, string>;
      headings: string[];
      blocks: string[];
      links: string[];
      images: string[];
      structure: string[];
    };
    const blocks = parsed.blocks ?? [];
    const text = blocks.join('\n');
    return {
      title: parsed.title ?? '',
      lang: null,
      meta: parsed.meta ?? {},
      headings: (parsed.headings ?? []).map((entry, index) => {
        const separator = entry.indexOf(':');
        return {
          level: Number.parseInt(entry.slice(0, separator), 10) || 2,
          text: entry.slice(separator + 1),
          index,
        };
      }),
      blocks,
      text,
      links: (parsed.links ?? []).map((href) => ({ href, text: '' })),
      images: (parsed.images ?? []).map((entry) => {
        const separator = entry.lastIndexOf('|');
        return { src: separator === -1 ? entry : entry.slice(0, separator), alt: separator === -1 ? '' : entry.slice(separator + 1) };
      }),
      prices: extractDocumentPrices(blocks, (parsed.headings ?? []).map((h) => h.slice(h.indexOf(':') + 1))),
      structure: parsed.structure ?? [],
      suppressed: {},
      stats: {
        textLength: text.length,
        blockCount: blocks.length,
        linkCount: parsed.links?.length ?? 0,
        imageCount: parsed.images?.length ?? 0,
        headingCount: parsed.headings?.length ?? 0,
        priceCount: 0,
      },
    };
  } catch {
    return null;
  }
}
