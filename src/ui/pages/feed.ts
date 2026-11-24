/** Homepage: what changed on the internet, most interesting first. */
import { changePath, categoryPath } from '../../lib/paths';
import { CATEGORIES } from '../../types';
import { layout } from '../layout';
import { changeCard, ChangeCardModel, chips, e, emptyState, statCells } from '../components';
import { breadcrumbJsonLd, metaDescription, websiteJsonLd } from '../seo';

export interface FeedProps {
  baseUrl: string;
  changes: (ChangeCardModel & { cid?: string | null })[];
  total: number;
  category: string;
  order: 'recent' | 'interesting';
  page: number;
  pages: number;
  stats: {
    changesThisWeek: number;
    sites: number;
    publishedChanges: number;
    pinnedPercent: number;
    crawlSuccessPercent: number;
  };
  lastSweep: string;
}

/** Intro copy for category landing pages: what is watched and why it matters. */
export const CATEGORY_COPY: Record<string, string> = {
  Pricing: 'Price increases, new tiers, removed free plans and quietly changed limits on the pricing pages people actually pay attention to.',
  AI: 'Model pricing, usage policies, rate limits and product pages from AI companies, where the fine print moves fastest.',
  SaaS: 'Plans, feature tables and terms of the software tools businesses run on.',
  Startups: 'Landing pages, pricing and positioning of young companies, change by change.',
  'Open Source': 'Licences, governance pages and project homepages of open source projects, including the ones that disappear.',
  APIs: 'Rate limits, deprecations, quotas and pricing in API documentation, the changes that break integrations.',
  Security: 'Security advisories, disclosure policies and trust pages, tracked so silent edits do not go unnoticed.',
  Products: 'Product pages and spec sheets, from feature removals to renamed plans.',
  Documentation: 'Developer documentation that changes without a changelog entry.',
  Companies: 'Terms of service, privacy policies and about pages of companies, with every previous version preserved.',
  'Weird Internet': 'Odd, beloved and fragile corners of the web, watched before they vanish.',
};

function feedUrl(category: string, params: { order?: string; page?: number }): string {
  const query = new URLSearchParams();
  if (params.order === 'recent') query.set('order', 'recent');
  if (params.page && params.page > 1) query.set('page', String(params.page));
  const search = query.toString();
  return `${categoryPath(category)}${search ? `?${search}` : ''}`;
}

export function feedPage(props: FeedProps): string {
  const isHome = props.category === 'All';
  const categoryChips = chips(
    ['All', ...CATEGORIES].map((category) => ({
      label: category.toUpperCase(),
      href: categoryPath(category),
      on: props.category === category,
    })),
  );

  const orderLinks = `<a class="chip${props.order === 'interesting' ? ' on' : ''}" href="${e(feedUrl(props.category, { order: 'interesting' }))}">RANKED</a><a class="chip${props.order === 'recent' ? ' on' : ''}" href="${e(feedUrl(props.category, { order: 'recent' }))}">NEWEST</a>`;

  const pager =
    props.pages > 1
      ? `<nav class="pager" aria-label="Pages" style="display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:26px;flex-wrap:wrap">
      ${props.page > 1 ? `<a class="btn btn-ghost btn-sm" rel="prev" href="${e(feedUrl(props.category, { order: props.order, page: props.page - 1 }))}">← Newer</a>` : '<span></span>'}
      <span class="label">PAGE ${props.page} OF ${props.pages}</span>
      ${props.page < props.pages ? `<a class="btn btn-ghost btn-sm" rel="next" href="${e(feedUrl(props.category, { order: props.order, page: props.page + 1 }))}">Older →</a>` : '<span></span>'}
    </nav>`
      : '';

  const hero = isHome
    ? `<section class="hero">
    <div>
      <div class="eyebrow">${props.stats.sites.toLocaleString()} PAGES UNDER OBSERVATION · LAST SWEEP ${e(props.lastSweep)}</div>
      <h1>The internet changes.<br>We keep receipts.</h1>
      <p class="sub">Track important websites and see exactly what changed, when it changed, and what the previous version looked like. Every snapshot is hashed, content-addressed and verifiable.</p>
      <div style="display:flex;gap:10px;margin-top:28px;flex-wrap:wrap">
        <a class="btn btn-primary" href="#digest">Get the daily digest</a>
        <a class="btn btn-ghost" href="${props.changes[0] ? `${e(changePath(props.changes[0]))}/diff` : '/sites'}">See a diff</a>
      </div>
    </div>
    ${statCells([
      { value: props.stats.changesThisWeek.toLocaleString(), label: 'Changes detected this week' },
      { value: props.stats.sites.toLocaleString(), label: 'Pages under observation' },
      { value: props.stats.publishedChanges.toLocaleString(), label: 'Flagged as meaningful' },
      { value: `${props.stats.pinnedPercent}%`, label: 'Snapshots content-addressed' },
    ])}
  </section>`
    : `<section style="padding:34px 0 8px">
    <nav class="label" aria-label="Breadcrumb"><a href="/">ALL CHANGES</a> / ${e(props.category.toUpperCase())}</nav>
    <h1 style="margin:12px 0 0;font-size:34px;letter-spacing:-.04em;font-weight:800">${e(props.category)} changes</h1>
    <p class="muted" style="font-size:15px;line-height:1.55;margin:10px 0 0;max-width:62ch">${e(CATEGORY_COPY[props.category] ?? '')} ${props.total.toLocaleString()} meaningful change${props.total === 1 ? '' : 's'} on record.</p>
    <p style="margin:14px 0 0;display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-ghost btn-sm" href="/rss.xml?category=${encodeURIComponent(props.category)}">RSS for ${e(props.category)}</a><a class="btn btn-ghost btn-sm" href="/sites?category=${encodeURIComponent(props.category)}">Monitored pages</a></p>
  </section>`;

  const body = `<div class="wrap">
  ${hero}

  <section class="chips">
    <span class="label" style="margin-right:5px">FILTER</span>
    ${categoryChips}
    <span style="flex:1"></span>
    ${orderLinks}
  </section>

  <section style="padding:22px 0 0">
    <div class="sec-head">
      <h2>${isHome ? 'Latest changes' : `Latest in ${e(props.category)}`}</h2>
      <div class="label">${props.total} EVENT${props.total === 1 ? '' : 'S'} · ${props.order === 'interesting' ? 'RANKED BY INTERESTINGNESS' : 'NEWEST FIRST'}</div>
    </div>
    ${
      props.changes.length
        ? `<div class="cards">${props.changes.map((change) => changeCard(change)).join('')}</div>`
        : emptyState('No published changes yet. The scheduler is warming up — first snapshots become comparable on the second crawl.')
    }
    ${pager}
  </section>

  <section id="digest" style="margin:36px 0 0;padding:32px;border:1px solid rgba(255,255,255,.09);border-radius:12px;background:#151A21;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:28px;align-items:center">
    <div>
      <div class="mono" style="font-size:9px;color:#E9A13B">${isHome ? 'DAILY DIGEST' : `FOLLOW ${e(props.category.toUpperCase())}`}</div>
      <h3 style="margin:10px 0 0;font-size:26px;letter-spacing:-.04em;font-weight:800">${isHome ? 'The Internet Changed Today' : `Get ${e(props.category)} changes by email`}</h3>
      <p style="margin:9px 0 0;font-size:14px;line-height:1.5;color:#8892A0;max-width:42ch">${isHome ? 'Five changes worth knowing about, every morning. Email or RSS, no account needed.' : `One email per meaningful change in ${e(props.category)}. Confirm once, unsubscribe in one click.`}</p>
    </div>
    <form class="formrow" method="post" action="/api/subscriptions">
      <input class="field" type="email" name="email" required placeholder="you@company.com" aria-label="Email address" style="flex:1 1 190px">
      ${isHome ? '<input type="hidden" name="digest" value="1">' : `<input type="hidden" name="category" value="${e(props.category)}">`}
      <button class="btn btn-primary" type="submit">${isHome ? 'Subscribe' : 'Follow'}</button>
    </form>
  </section>
</div>`;

  const path = categoryPath(props.category);
  const canonicalPath = feedUrl(props.category, { page: props.page });
  const pageSuffix = props.page > 1 ? ` · page ${props.page}` : '';
  const title = isHome
    ? `The Internet Change Detector — see what changed, when, and what it looked like before${pageSuffix}`
    : `${props.category} changes${pageSuffix} — The Internet Change Detector`;
  const description = isHome
    ? 'Continuous monitoring of important public web pages. Every change is diffed, scored, timestamped and backed by a content-addressed snapshot you can verify.'
    : metaDescription(`${CATEGORY_COPY[props.category] ?? `${props.category} pages under observation.`} Every change is diffed and backed by a verifiable snapshot.`);

  const itemList = {
    '@type': 'ItemList',
    itemListElement: props.changes.slice(0, 10).map((change, index) => ({
      '@type': 'ListItem',
      position: (props.page - 1) * 24 + index + 1,
      url: `${props.baseUrl}${changePath(change)}`,
      name: change.headline,
    })),
  };

  return layout({
    title,
    description,
    path,
    canonical: `${props.baseUrl}${canonicalPath}`,
    baseUrl: props.baseUrl,
    active: 'feed',
    body,
    // Sorting is a view of the same list: keep it out of the index.
    noindex: props.order === 'recent' ? 'noindex,follow' : undefined,
    prev: props.page > 1 ? `${props.baseUrl}${feedUrl(props.category, { page: props.page - 1 })}` : undefined,
    next: props.page < props.pages ? `${props.baseUrl}${feedUrl(props.category, { page: props.page + 1 })}` : undefined,
    rssPath: isHome ? undefined : `/rss.xml?category=${encodeURIComponent(props.category)}`,
    jsonLd: isHome
      ? [
          websiteJsonLd(props.baseUrl),
          { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Latest changes', url: `${props.baseUrl}${canonicalPath}`, mainEntity: itemList },
        ]
      : [
          {
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: `${props.category} changes`,
            description,
            url: `${props.baseUrl}${canonicalPath}`,
            isPartOf: { '@id': `${props.baseUrl}/#website` },
            mainEntity: itemList,
          },
          breadcrumbJsonLd(props.baseUrl, [{ name: 'Changes', path: '/' }, { name: props.category, path }]),
        ],
  });
}
