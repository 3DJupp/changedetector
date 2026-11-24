/** The HTML document shell: metadata, Open Graph, navigation, footer. */
import { escapeHtml } from '../lib/html';
import { CSS } from './theme';

export interface LayoutOptions {
  title: string;
  description: string;
  path: string;
  baseUrl: string;
  body: string;
  ogImage?: string;
  ogType?: string;
  canonical?: string;
  active?: string;
  query?: string;
  /** One JSON-LD object or several; each becomes its own script tag. */
  jsonLd?: unknown;
  narrow?: boolean;
  /** true means "noindex,nofollow"; a string is used as the robots value. */
  noindex?: boolean | string;
  prev?: string;
  next?: string;
  /** Extra RSS feed for this page, e.g. a category or site feed. */
  rssPath?: string;
  rssTitle?: string;
}

const NAV = [
  { key: 'feed', label: 'Feed', href: '/' },
  { key: 'digest', label: 'Digest', href: '/digest' },
  { key: 'sites', label: 'Sites', href: '/sites' },
  { key: 'search', label: 'Search', href: '/search' },
  { key: 'api', label: 'API', href: '/api' },
  { key: 'admin', label: 'Admin', href: '/admin' },
];

const FONTS =
  'https://fonts.googleapis.com/css2?family=Public+Sans:wght@300..800&family=Martian+Mono:wght@300;400;500;600&display=swap';

export function layout(options: LayoutOptions): string {
  const e = escapeHtml;
  const canonical = options.canonical ?? `${options.baseUrl}${options.path}`;
  const ogImage = options.ogImage ?? `${options.baseUrl}/og/default.png`;
  const robots = options.noindex === true ? 'noindex,nofollow' : options.noindex || '';
  const jsonLd = options.jsonLd === undefined ? [] : Array.isArray(options.jsonLd) ? options.jsonLd : [options.jsonLd];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(options.title)}</title>
<meta name="description" content="${e(options.description)}">
${robots ? `<meta name="robots" content="${e(robots)}">` : ''}
<link rel="canonical" href="${e(canonical)}">
${options.prev ? `<link rel="prev" href="${e(options.prev)}">` : ''}
${options.next ? `<link rel="next" href="${e(options.next)}">` : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="alternate" type="application/rss+xml" title="The Internet Change Detector" href="${e(options.baseUrl)}/rss.xml">
${options.rssPath ? `<link rel="alternate" type="application/rss+xml" title="${e(options.rssTitle ?? options.title)}" href="${e(options.baseUrl)}${e(options.rssPath)}">` : ''}
<meta property="og:site_name" content="The Internet Change Detector">
<meta property="og:type" content="${e(options.ogType ?? 'website')}">
<meta property="og:title" content="${e(options.title)}">
<meta property="og:description" content="${e(options.description)}">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:image" content="${e(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${e(options.title)}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(options.title)}">
<meta name="twitter:description" content="${e(options.description)}">
<meta name="twitter:image" content="${e(ogImage)}">
<meta name="theme-color" content="#0E1116">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="${e(FONTS)}">
<link rel="stylesheet" href="${e(FONTS)}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="${e(FONTS)}"></noscript>
<style>${CSS}</style>
${jsonLd.map((item) => `<script type="application/ld+json">${JSON.stringify(item).replace(/</g, '\\u003c')}</script>`).join('\n')}
</head>
<body>
<header class="site">
  <div class="bar">
    <a class="brand" href="/"><span class="dot"></span><span>CHANGE&#8203;DETECTOR</span></a>
    <nav class="main">
      ${NAV.map((item) => `<a href="${item.href}" class="${options.active === item.key ? 'on' : ''}">${item.label}</a>`).join('')}
    </nav>
    <form class="searchbox" action="/search" method="get" role="search">
      <span style="font-size:12px;color:#93A0B0">⌕</span>
      <input name="q" value="${e(options.query ?? '')}" placeholder="pricing changes…" aria-label="Search changes">
    </form>
  </div>
</header>
<main>
${options.body}
</main>
<footer class="site">
  <div class="${options.narrow ? 'wrap-narrow' : 'wrap'} inner">
    <div>The internet changes. We keep receipts.<br>
      <span class="dim" style="font-size:11.5px">Snapshots are content-addressed and hash-verifiable. Availability depends on pinned replicas, not on IPFS alone.</span>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <a href="/rss.xml">RSS</a><a href="/api">API</a><a href="/about">About</a><a href="/digest">Daily digest</a>
    </div>
  </div>
</footer>
</body>
</html>`;
}

export function html(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...extraHeaders,
    },
  });
}
