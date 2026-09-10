/** RSS 2.0 feeds: everything, per category, per site, and the daily digest. */
import type { ChangeEvent, MonitoredSite } from '../types';
import { escapeHtml } from '../lib/html';

function rfc822(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toUTCString();
}

export function rssFeed(options: {
  baseUrl: string;
  title: string;
  description: string;
  selfPath: string;
  items: (ChangeEvent & { site: Partial<MonitoredSite> })[];
}): string {
  const e = escapeHtml;
  const items = options.items
    .map(
      (change) => `  <item>
    <title>${e(change.headline)}</title>
    <link>${options.baseUrl}/changes/${e(change.slug)}</link>
    <guid isPermaLink="true">${options.baseUrl}/changes/${e(change.slug)}</guid>
    <pubDate>${rfc822(change.detected_at)}</pubDate>
    <category>${e(change.site.category ?? 'Companies')}</category>
    <description>${e(
      `${change.summary} [${change.severity} · score ${change.interestingness_score}/100 · ${change.change_type}]`,
    )}</description>
  </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${e(options.title)}</title>
  <link>${options.baseUrl}</link>
  <atom:link href="${options.baseUrl}${e(options.selfPath)}" rel="self" type="application/rss+xml"/>
  <description>${e(options.description)}</description>
  <language>en</language>
  <lastBuildDate>${rfc822(Math.floor(Date.now() / 1000))}</lastBuildDate>
${items}
</channel>
</rss>`;
}

export function xml(body: string, cacheSeconds = 300): Response {
  return new Response(body, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': `public, max-age=60, s-maxage=${cacheSeconds}`,
    },
  });
}
