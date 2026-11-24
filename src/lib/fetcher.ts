/**
 * The HTTP fetcher.
 *
 * Treats every remote server as hostile: bounded time, bounded bytes, bounded
 * redirects, and every redirect hop re-validated against the SSRF guard.
 */
import { assertFetchable, UrlNotAllowed } from './urlguard';

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  cache?: KVNamespace;
  /** Value of If-None-Match from the previous capture, enabling 304 handling. */
  etag?: string | null;
  lastModified?: string | null;
  checkDns?: boolean;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  headers: Record<string, string>;
  body: Uint8Array;
  bytes: number;
  truncated: boolean;
  durationMs: number;
  notModified: boolean;
  redirects: string[];
  error?: string;
  errorReason?: string;
}

/** Response headers worth preserving in the snapshot record. */
const KEEP_HEADERS = [
  'content-type',
  'content-language',
  'etag',
  'last-modified',
  'cache-control',
  'server',
  'x-powered-by',
  'content-encoding',
  'location',
];

export class FetchFailure extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'FetchFailure';
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ body: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { body: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { body, truncated };
}

export async function fetchPage(target: string, options: FetchOptions): Promise<FetchResult> {
  const started = Date.now();
  const maxRedirects = options.maxRedirects ?? 5;
  const redirects: string[] = [];
  let current = target;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-validate on every hop: a 302 into 127.0.0.1 is the classic SSRF.
    const url = await assertFetchable(current, { cache: options.cache, checkDns: options.checkDns });

    const headers: Record<string, string> = {
      'user-agent': options.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate',
    };
    if (hop === 0 && options.etag) headers['if-none-match'] = options.etag;
    if (hop === 0 && options.lastModified) headers['if-modified-since'] = options.lastModified;

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = /timeout|aborted|timed out/i.test(message);
      throw new FetchFailure(message, isTimeout ? 'timeout' : 'network');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new FetchFailure(`redirect ${response.status} without Location`, 'bad-redirect', response.status);
      }
      const next = new URL(location, url).toString();
      redirects.push(next);
      current = next;
      continue;
    }

    const kept: Record<string, string> = {};
    for (const name of KEEP_HEADERS) {
      const value = response.headers.get(name);
      if (value) kept[name] = value.slice(0, 512);
    }

    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      return {
        ok: true,
        status: 304,
        finalUrl: url.toString(),
        contentType: kept['content-type'] ?? '',
        headers: kept,
        body: new Uint8Array(0),
        bytes: 0,
        truncated: false,
        durationMs: Date.now() - started,
        notModified: true,
        redirects,
      };
    }

    const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes * 8) {
      await response.body?.cancel().catch(() => {});
      throw new FetchFailure(`response too large (${declaredLength} bytes)`, 'too-large', response.status);
    }

    const { body, truncated } = await readCapped(response, options.maxBytes);
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: url.toString(),
      contentType: kept['content-type'] ?? 'application/octet-stream',
      headers: kept,
      body,
      bytes: body.length,
      truncated,
      durationMs: Date.now() - started,
      notModified: false,
      redirects,
    };
  }

  throw new FetchFailure(`too many redirects (>${maxRedirects})`, 'redirect-loop');
}

/**
 * Exponential backoff with full jitter, capped at 6 hours.
 * Used for transient errors, 429 and 5xx.
 */
export function computeBackoffSeconds(attempt: number, baseSeconds = 60, capSeconds = 21600): number {
  const exponential = Math.min(capSeconds, baseSeconds * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.random();
  return Math.max(baseSeconds, Math.round(exponential * (0.5 + jitter * 0.5)));
}

/** Honour Retry-After (seconds or HTTP date) when a server sends one. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && String(seconds) === value.trim()) return Math.min(seconds, 86400);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(86400, Math.round((date - now) / 1000)));
  return null;
}

/**
 * Best-effort per-domain spacing. KV is eventually consistent, so this is a
 * politeness floor rather than a hard limit; queue concurrency provides the
 * hard ceiling.
 */
export async function throttleDomain(
  cache: KVNamespace | undefined,
  host: string,
  minIntervalS: number,
): Promise<{ allowed: boolean; waitS: number }> {
  if (!cache || minIntervalS <= 0) return { allowed: true, waitS: 0 };
  const key = `throttle:${host}`;
  const now = Math.floor(Date.now() / 1000);
  const last = await cache.get(key).catch(() => null);
  const lastAt = last ? Number.parseInt(last, 10) : 0;
  if (Number.isFinite(lastAt) && now - lastAt < minIntervalS) {
    return { allowed: false, waitS: minIntervalS - (now - lastAt) };
  }
  await cache.put(key, String(now), { expirationTtl: Math.max(60, minIntervalS * 2) }).catch(() => {});
  return { allowed: true, waitS: 0 };
}

export { UrlNotAllowed };
