/**
 * HTML → canonical representation.
 *
 * False positives are the thing most likely to kill this product, so the
 * normalizer is aggressive: anything that routinely changes without meaning
 * anything (timestamps, cookie banners, rotating promos, build hashes, CSRF
 * nonces, analytics attributes, randomized class names) is replaced by a
 * stable token and counted, so the UI can show *what was ignored and why*.
 *
 * Every rule can be overridden per site via `NormalizationConfig`.
 */
import { Element, Node, parseHtml, textOf } from './html';
import { canonicalizeUrl } from './urlguard';
import { extractPrices, PriceMention } from './price';

export interface NormalizationConfig {
  /** Extra tag names to drop entirely. */
  dropTags?: string[];
  /** Extra class/id substrings that mark an element as noise. */
  noisePatterns?: string[];
  /** Include nav/aside/footer text in the main signal. Off by default. */
  includeChrome?: boolean;
  /** Suppress standalone large numbers (counters, view counts). */
  suppressCounters?: boolean;
  /** Keep query strings on extracted links. */
  keepLinkQuery?: boolean;
  /** Only consider content inside these ids/classes (simple substring match). */
  scope?: string[];
}

export interface Heading {
  level: number;
  text: string;
  index: number;
}

export interface LinkRef {
  href: string;
  text: string;
}

export interface NormalizedDocument {
  title: string;
  lang: string | null;
  meta: Record<string, string>;
  headings: Heading[];
  blocks: string[];
  text: string;
  links: LinkRef[];
  images: { src: string; alt: string }[];
  prices: PriceMention[];
  /** Tag/heading skeleton, used for structural diffing. */
  structure: string[];
  suppressed: Record<string, number>;
  stats: {
    textLength: number;
    blockCount: number;
    linkCount: number;
    imageCount: number;
    headingCount: number;
    priceCount: number;
  };
}

const DEFAULT_DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'template', 'link', 'video', 'audio', 'source', 'track', 'map', 'area', 'base',
]);

const CHROME_TAGS = new Set(['nav', 'aside', 'footer']);
const CHROME_ROLES = new Set(['banner', 'navigation', 'contentinfo', 'search', 'complementary']);

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'tr', 'td', 'th',
  'blockquote', 'pre', 'figcaption', 'summary', 'details', 'form', 'fieldset',
  'label', 'button', 'option', 'address', 'hr', 'br', 'table', 'ul', 'ol', 'dl',
]);

const NOISE_PATTERNS = [
  'cookie', 'consent', 'gdpr', 'ccpa', 'privacy-banner',
  'advert', 'adsense', 'adslot', 'ad-container', 'ad-wrapper', 'sponsored',
  'carousel', 'slider', 'marquee', 'ticker', 'rotator',
  'newsletter-popup', 'popup', 'modal', 'overlay-promo', 'lightbox',
  'chat-widget', 'intercom', 'drift-', 'livechat', 'zendesk', 'crisp-client',
  'toast', 'snackbar', 'flash-message', 'announcement-bar', 'promo-bar',
  'skip-link', 'visually-hidden', 'screen-reader', 'sr-only',
  'social-share', 'share-buttons', 'related-posts', 'recommended-for-you',
  'trending-now', 'live-count', 'visitor-count', 'weather-widget',
  'stock-ticker', 'countdown', 'back-to-top', 'scroll-progress',
];

/** Attributes that are pure machinery and never carry meaning. */
const NOISE_ATTR_PATTERNS = [
  /^data-(reactid|react-|v-|ng-|svelte-|astro-|qa|test|testid|tracking|analytics|gtm|ga-|segment|amplitude|hotjar|clarity)/i,
  /^(nonce|csrf|integrity|crossorigin)$/i,
  /^data-.*-(id|uid|uuid|hash|token|nonce|timestamp|ts)$/i,
];

const RANDOM_CLASS = /(^|\s)(css-[a-z0-9]{5,}|sc-[A-Za-z]{5,}|jsx-\d{6,}|[a-z]+_[a-z0-9]{5,}__[a-z0-9]{5,}|[a-zA-Z0-9]{2,}-[a-f0-9]{8,}|svelte-[a-z0-9]{6,}|emotion-[a-z0-9]+)(\s|$)/;

const SUPPRESSORS: { name: string; pattern: RegExp; token: string }[] = [
  { name: 'ISO timestamps', pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, token: '⟨ts⟩' },
  { name: 'Clock times', pattern: /\b\d{1,2}:\d{2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?|AM|PM)?\s?(UTC|GMT|EST|EDT|PST|PDT|CET|CEST)?\b/g, token: '⟨time⟩' },
  { name: 'Relative times', pattern: /\b(just now|a (few )?(second|minute|hour|day|week|month|year)s? ago|\d+\s?(sec|second|min|minute|hour|hr|day|week|month|year)s?\s+ago|yesterday|today at [^,.]{1,12})\b/gi, token: '⟨ago⟩' },
  { name: 'Long dates', pattern: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4}\b/gi, token: '⟨date⟩' },
  { name: 'Long dates', pattern: /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi, token: '⟨date⟩' },
  { name: 'Numeric dates', pattern: /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, token: '⟨date⟩' },
  { name: 'Numeric dates', pattern: /\b\d{4}-\d{2}-\d{2}\b/g, token: '⟨date⟩' },
  { name: 'Copyright years', pattern: /(©|\(c\)|copyright)\s*(19|20)\d{2}(\s*[–-]\s*(19|20)\d{2})?/gi, token: '© ⟨year⟩' },
  { name: 'Build hashes', pattern: /\b[0-9a-f]{16,64}\b/gi, token: '⟨hash⟩' },
  { name: 'UUIDs', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, token: '⟨uuid⟩' },
  { name: 'Cache-busted assets', pattern: /\.[0-9a-f]{6,12}\.(js|css|woff2?|png|jpe?g|svg|webp|avif)\b/gi, token: '.⟨hash⟩.$2' },
];

const COUNTER_PATTERN = /\b\d{1,3}(,\d{3}){2,}\b/g;

function attrClassId(element: Element): string {
  return `${element.attrs.class ?? ''} ${element.attrs.id ?? ''}`.toLowerCase();
}

function isNoiseElement(element: Element, patterns: string[]): boolean {
  if (element.attrs['aria-hidden'] === 'true') return true;
  if (element.attrs.hidden !== undefined) return true;
  const style = (element.attrs.style ?? '').replace(/\s/g, '').toLowerCase();
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  const haystack = attrClassId(element);
  if (!haystack.trim()) return false;
  return patterns.some((pattern) => haystack.includes(pattern));
}

function isChrome(element: Element): boolean {
  if (CHROME_TAGS.has(element.tag)) return true;
  const role = (element.attrs.role ?? '').toLowerCase();
  return CHROME_ROLES.has(role);
}

function collapse(value: string): string {
  return value.replace(/[  -​﻿]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Apply the suppression rules and count what each one removed. */
export function suppressNoise(
  input: string,
  suppressed: Record<string, number>,
  suppressCounters = false,
): string {
  let out = input;
  for (const rule of SUPPRESSORS) {
    let count = 0;
    out = out.replace(rule.pattern, (...args) => {
      count++;
      if (rule.token.includes('$2')) {
        const groups = args.slice(1, -2);
        return rule.token.replace('$2', String(groups[1] ?? ''));
      }
      return rule.token;
    });
    if (count > 0) suppressed[rule.name] = (suppressed[rule.name] ?? 0) + count;
  }
  if (suppressCounters) {
    let count = 0;
    out = out.replace(COUNTER_PATTERN, () => {
      count++;
      return '⟨count⟩';
    });
    if (count > 0) suppressed['Live counters'] = (suppressed['Live counters'] ?? 0) + count;
  }
  return out;
}

function normalizeLink(href: string, base: string, keepQuery: boolean, suppressed: Record<string, number>): string | null {
  const value = href.trim();
  if (!value || value.startsWith('#') || /^(javascript|mailto|tel|data|blob|about):/i.test(value)) return null;
  let absolute: URL;
  try {
    absolute = new URL(value, base);
  } catch {
    return null;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
  try {
    const canonical = canonicalizeUrl(absolute.toString());
    if (canonical !== absolute.toString().replace(/#.*$/, '')) {
      suppressed['Tracking parameters'] = (suppressed['Tracking parameters'] ?? 0) + 1;
    }
    if (!keepQuery) {
      const stripped = new URL(canonical);
      stripped.search = '';
      return stripped.toString();
    }
    return canonical;
  } catch {
    return absolute.toString();
  }
}

/**
 * Extract prices from the canonical block list, anchoring each price to the
 * nearest preceding heading. Deriving labels from blocks alone keeps this
 * deterministic: a document rehydrated from its stored canonical payload
 * produces exactly the same price mentions as the original capture.
 */
export function extractDocumentPrices(blocks: string[], headingTexts: string[]): PriceMention[] {
  const headingSet = new Set(headingTexts.map((text) => text.trim().toLowerCase()));
  const labels: { index: number; text: string }[] = [];
  let offset = 0;
  for (const block of blocks) {
    const key = block.trim().toLowerCase();
    if (key.length > 0 && key.length <= 80 && headingSet.has(key)) {
      labels.push({ index: offset, text: block.trim() });
    }
    offset += block.length + 1;
  }
  return extractPrices(blocks.join('\n'), labels);
}

/**
 * Turn a fetched HTML document into the canonical representation everything
 * downstream (hashing, diffing, scoring) operates on.
 */
export function normalizeHtml(
  html: string,
  baseUrl: string,
  config: NormalizationConfig = {},
): NormalizedDocument {
  const suppressed: Record<string, number> = {};
  const dropTags = new Set([...DEFAULT_DROP_TAGS, ...(config.dropTags ?? [])]);
  const noisePatterns = [...NOISE_PATTERNS, ...(config.noisePatterns ?? [])].map((p) => p.toLowerCase());

  const root = parseHtml(html);

  const meta: Record<string, string> = {};
  const headings: Heading[] = [];
  const links: LinkRef[] = [];
  const images: { src: string; alt: string }[] = [];
  const structure: string[] = [];
  const blocks: string[] = [];
  let title = '';
  let lang: string | null = null;
  let pendingText = '';

  const flush = () => {
    const value = collapse(pendingText);
    pendingText = '';
    if (!value) return;
    blocks.push(value);
  };

  const visit = (node: Node, inChrome: boolean, depth: number): void => {
    if (node.type === 'text') {
      if (!inChrome || config.includeChrome) pendingText += node.value;
      return;
    }

    const element = node;
    const tag = element.tag;

    if (tag === 'html' && element.attrs.lang) lang = element.attrs.lang.slice(0, 16);

    if (tag === 'title' && !title) {
      title = collapse(textOf(element)).slice(0, 300);
      return;
    }
    if (tag === 'meta') {
      const name = (element.attrs.name ?? element.attrs.property ?? '').toLowerCase();
      const content = element.attrs.content ?? '';
      const KEEP = ['description', 'og:title', 'og:description', 'og:image', 'og:type',
        'twitter:title', 'twitter:description', 'author', 'robots', 'article:modified_time'];
      if (KEEP.includes(name) && content) meta[name] = collapse(content).slice(0, 500);
      return;
    }
    if (dropTags.has(tag)) {
      if (tag === 'script' || tag === 'style') {
        suppressed['Scripts & styles'] = (suppressed['Scripts & styles'] ?? 0) + 1;
      }
      return;
    }
    if (isNoiseElement(element, noisePatterns)) {
      const haystack = attrClassId(element);
      const label = /cookie|consent|gdpr|ccpa/.test(haystack)
        ? 'Cookie notices'
        : /advert|adsense|adslot|sponsored|ad-/.test(haystack)
          ? 'Advertising'
          : /carousel|slider|ticker|rotator|marquee|countdown/.test(haystack)
            ? 'Rotating content'
            : /chat|intercom|drift|livechat|zendesk|crisp/.test(haystack)
              ? 'Chat widgets'
              : 'Hidden or decorative blocks';
      suppressed[label] = (suppressed[label] ?? 0) + 1;
      return;
    }

    for (const attribute of Object.keys(element.attrs)) {
      if (NOISE_ATTR_PATTERNS.some((pattern) => pattern.test(attribute))) {
        suppressed['Analytics attributes'] = (suppressed['Analytics attributes'] ?? 0) + 1;
      }
    }
    if (element.attrs.class && RANDOM_CLASS.test(element.attrs.class)) {
      suppressed['Randomized class names'] = (suppressed['Randomized class names'] ?? 0) + 1;
    }
    if (element.attrs.id && /^[a-z]*[-_]?[0-9a-f]{8,}$/i.test(element.attrs.id)) {
      suppressed['Randomized IDs'] = (suppressed['Randomized IDs'] ?? 0) + 1;
    }

    const chrome = inChrome || isChrome(element);
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();

    if (/^h[1-6]$/.test(tag) && !chrome) {
      const text = collapse(textOf(element));
      if (text && text.length < 400) {
        headings.push({ level: Number.parseInt(tag[1], 10), text, index: blocks.length });
        structure.push(`${tag}:${text.slice(0, 80).toLowerCase()}`);
      }
    } else if (isBlock && !chrome && depth < 40) {
      structure.push(tag);
    }

    if (tag === 'a' && element.attrs.href) {
      const href = normalizeLink(element.attrs.href, baseUrl, config.keepLinkQuery ?? false, suppressed);
      if (href && links.length < 3000) {
        links.push({ href, text: collapse(textOf(element)).slice(0, 200) });
      }
    }
    if (tag === 'img') {
      const src = element.attrs.src ?? element.attrs['data-src'] ?? '';
      const normalized = src ? normalizeLink(src, baseUrl, false, suppressed) : null;
      if (normalized && images.length < 1000) {
        images.push({ src: normalized, alt: collapse(element.attrs.alt ?? '').slice(0, 200) });
      }
    }

    for (const child of element.children) visit(child, chrome, depth + 1);
    if (isBlock) flush();
  };

  for (const child of root.children) visit(child, false, 0);
  flush();

  // Optional scoping: keep only blocks inside a configured region.
  let effectiveBlocks = blocks;
  if (config.scope?.length) {
    const scoped = blocks.filter((block) =>
      config.scope!.some((needle) => block.toLowerCase().includes(needle.toLowerCase())),
    );
    if (scoped.length > 0) effectiveBlocks = scoped;
  }

  const cleanedBlocks = effectiveBlocks
    .map((block) => suppressNoise(block, suppressed, config.suppressCounters ?? false))
    .filter((block) => block.length > 0)
    .filter((block, index, all) => index === 0 || block !== all[index - 1]);

  const text = cleanedBlocks.join('\n');
  const prices = extractDocumentPrices(cleanedBlocks, headings.map((h) => h.text));
  const cleanTitle = suppressNoise(title, suppressed, false);

  return {
    title: cleanTitle,
    lang,
    meta,
    headings: headings.map((h) => ({ ...h, text: suppressNoise(h.text, {}, false) })),
    blocks: cleanedBlocks,
    text,
    links,
    images,
    prices,
    structure: structure.slice(0, 4000),
    suppressed,
    stats: {
      textLength: text.length,
      blockCount: cleanedBlocks.length,
      linkCount: links.length,
      imageCount: images.length,
      headingCount: headings.length,
      priceCount: prices.length,
    },
  };
}

/** Plain-text and JSON responses get a much simpler pipeline. */
export function normalizePlainText(body: string, contentType: string): NormalizedDocument {
  const suppressed: Record<string, number> = {};
  let text = body;
  if (/json/i.test(contentType)) {
    try {
      text = JSON.stringify(JSON.parse(body), Object.keys(JSON.parse(body)).sort(), 2);
    } catch {
      /* fall through to raw text */
    }
  }
  const blocks = suppressNoise(text, suppressed, false)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
  const joined = blocks.join('\n');
  return {
    title: '',
    lang: null,
    meta: {},
    headings: [],
    blocks,
    text: joined,
    links: [],
    images: [],
    prices: extractPrices(joined),
    structure: [],
    suppressed,
    stats: {
      textLength: joined.length,
      blockCount: blocks.length,
      linkCount: 0,
      imageCount: 0,
      headingCount: 0,
      priceCount: 0,
    },
  };
}

/**
 * The canonical serialization that gets hashed. Only fields that carry meaning
 * are included, in a stable order.
 */
export function canonicalPayload(doc: NormalizedDocument): string {
  return JSON.stringify({
    title: doc.title,
    meta: Object.fromEntries(Object.entries(doc.meta).sort(([a], [b]) => (a < b ? -1 : 1))),
    headings: doc.headings.map((h) => `${h.level}:${h.text}`),
    blocks: doc.blocks,
    links: doc.links.map((l) => l.href).sort(),
    images: doc.images.map((i) => `${i.src}|${i.alt}`).sort(),
    structure: doc.structure,
  });
}

/**
 * Detect a page whose meaningful content only appears after JavaScript runs.
 * Used to decide, per fetch, whether the expensive browser path is warranted.
 */
export function needsBrowserRendering(html: string, doc: NormalizedDocument): boolean {
  if (doc.stats.textLength > 800) return false;
  const shell = /<div[^>]+id=["'](root|app|__next|__nuxt|application)["']/i.test(html);
  const noscript = /<noscript>[^<]*(enable\s+javascript|javascript\s+is\s+(required|disabled))/i.test(html);
  const frameworkPayload = /__NEXT_DATA__|window\.__NUXT__|window\.__INITIAL_STATE__|ng-version|data-reactroot/i.test(html);
  const bodyText = doc.stats.textLength;
  return (shell || noscript || frameworkPayload) && bodyText < 500;
}
