/**
 * IndexNow: tells Bing, Yandex, Seznam, Naver and others about new URLs the
 * moment a change is published, instead of waiting for the next sitemap read.
 * Google does not take part; it reads the sitemap.
 *
 * Enabled by setting INDEXNOW_KEY (8-128 characters, letters, digits, dashes).
 * The key file is served at /<key>.txt to prove ownership of the host.
 */
import type { Env } from '../types';

const ENDPOINT = 'https://api.indexnow.org/indexnow';

export function indexNowKey(env: Env): string | null {
  const key = env.INDEXNOW_KEY?.trim();
  return key && /^[A-Za-z0-9-]{8,128}$/.test(key) ? key : null;
}

export function indexNowEnabled(env: Env): boolean {
  if (!indexNowKey(env)) return false;
  try {
    const host = new URL(env.PUBLIC_BASE_URL).hostname;
    return host !== 'localhost' && !host.endsWith('.local') && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** Submits absolute URLs on PUBLIC_BASE_URL. Never throws; returns the HTTP status or null. */
export async function pingIndexNow(env: Env, urls: string[]): Promise<number | null> {
  if (!indexNowEnabled(env) || !urls.length) return null;
  const base = new URL(env.PUBLIC_BASE_URL);
  const key = indexNowKey(env)!;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: base.host,
        key,
        keyLocation: `${base.origin}/${key}.txt`,
        urlList: urls.filter((url) => url.startsWith(base.origin)).slice(0, 10000),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (response.status >= 400) console.error('indexnow rejected', response.status);
    return response.status;
  } catch (error) {
    console.error('indexnow failed', error);
    return null;
  }
}
