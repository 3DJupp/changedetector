/**
 * Public URL shapes. Every link to a change, site or category page goes
 * through here, so the readable form is used everywhere and the routes can
 * redirect any other spelling to it.
 *
 *   /changes/2e8711f2-orbital-sync-disappeared   (the short slug is the key)
 *   /sites/openai-api-pricing                     (falls back to the id)
 *   /category/open-source
 */
import { CATEGORIES } from '../types';

/** Lowercase ASCII words joined by dashes, cut at a word boundary. */
export function kebab(text: string, max = 60): string {
  const words = text
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out || (words[0] ?? '').slice(0, max);
}

export function changePath(change: { slug: string; headline: string }): string {
  const words = kebab(change.headline);
  return `/changes/${change.slug}${words ? `-${words}` : ''}`;
}

/** The lookup key inside a change URL segment: everything before the first dash. */
export function changeKey(segment: string): string {
  return segment.split('-')[0];
}

export function sitePath(site: { id: string; slug?: string | null }): string {
  return `/sites/${site.slug || site.id}`;
}

/** A readable slug for a site, before de-duplication. */
export function siteSlugBase(site: { title?: string | null; canonical_url: string }): string {
  if (site.title) {
    const fromTitle = kebab(site.title, 70);
    if (fromTitle) return fromTitle;
  }
  const url = new URL(site.canonical_url);
  return kebab(`${url.host.replace(/^www\./, '')} ${url.pathname}`, 70) || 'site';
}

export function categoryPath(category: string): string {
  return category === 'All' ? '/' : `/category/${kebab(category)}`;
}

export function categoryFromSlug(slug: string): string | null {
  return CATEGORIES.find((category) => kebab(category) === slug) ?? null;
}
