/** Homepage: what changed on the internet, most interesting first. */
import { CATEGORIES } from '../../types';
import { layout } from '../layout';
import { changeCard, ChangeCardModel, chips, e, emptyState, statCells } from '../components';

export interface FeedProps {
  baseUrl: string;
  changes: (ChangeCardModel & { cid?: string | null })[];
  total: number;
  category: string;
  order: 'recent' | 'interesting';
  stats: {
    changesThisWeek: number;
    sites: number;
    publishedChanges: number;
    pinnedPercent: number;
    crawlSuccessPercent: number;
  };
  lastSweep: string;
}

export function feedPage(props: FeedProps): string {
  const categoryChips = chips(
    ['All', ...CATEGORIES].map((category) => ({
      label: category.toUpperCase(),
      href: category === 'All' ? '/' : `/?category=${encodeURIComponent(category)}`,
      on: props.category === category,
    })),
  );

  const orderLinks = `<a class="chip${props.order === 'interesting' ? ' on' : ''}" href="/?${new URLSearchParams({
    category: props.category === 'All' ? '' : props.category,
    order: 'interesting',
  })}">RANKED</a><a class="chip${props.order === 'recent' ? ' on' : ''}" href="/?${new URLSearchParams({
    category: props.category === 'All' ? '' : props.category,
    order: 'recent',
  })}">NEWEST</a>`;

  const body = `<div class="wrap">
  <section class="hero">
    <div>
      <div class="eyebrow">${props.stats.sites.toLocaleString()} PAGES UNDER OBSERVATION · LAST SWEEP ${e(props.lastSweep)}</div>
      <h1>The internet changes.<br>We keep receipts.</h1>
      <p class="sub">Track important websites and see exactly what changed, when it changed, and what the previous version looked like. Every snapshot is hashed, content-addressed and verifiable.</p>
      <div style="display:flex;gap:10px;margin-top:28px;flex-wrap:wrap">
        <a class="btn btn-primary" href="/admin">Monitor a page</a>
        <a class="btn btn-ghost" href="${props.changes[0] ? `/changes/${e(props.changes[0].slug)}/diff` : '/sites'}">See a diff</a>
      </div>
    </div>
    ${statCells([
      { value: props.stats.changesThisWeek.toLocaleString(), label: 'Changes detected this week' },
      { value: props.stats.sites.toLocaleString(), label: 'Pages under observation' },
      { value: props.stats.publishedChanges.toLocaleString(), label: 'Flagged as meaningful' },
      { value: `${props.stats.pinnedPercent}%`, label: 'Snapshots content-addressed' },
    ])}
  </section>

  <section class="chips">
    <span class="label" style="margin-right:5px">FILTER</span>
    ${categoryChips}
    <span style="flex:1"></span>
    ${orderLinks}
  </section>

  <section style="padding:22px 0 0">
    <div class="sec-head">
      <h2>Latest changes</h2>
      <div class="label">${props.total} EVENT${props.total === 1 ? '' : 'S'} · ${props.order === 'interesting' ? 'RANKED BY INTERESTINGNESS' : 'NEWEST FIRST'}</div>
    </div>
    ${
      props.changes.length
        ? `<div class="cards">${props.changes.map((change) => changeCard(change)).join('')}</div>`
        : emptyState('No published changes yet. The scheduler is warming up — first snapshots become comparable on the second crawl.')
    }
  </section>

  <section style="margin:36px 0 0;padding:32px;border:1px solid rgba(255,255,255,.09);border-radius:12px;background:#151A21;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:28px;align-items:center">
    <div>
      <div class="mono" style="font-size:9px;color:#E9A13B">DAILY DIGEST</div>
      <h3 style="margin:10px 0 0;font-size:26px;letter-spacing:-.04em;font-weight:800">The Internet Changed Today</h3>
      <p style="margin:9px 0 0;font-size:14px;line-height:1.5;color:#8892A0;max-width:42ch">Five changes worth knowing about, every morning. Email or RSS, no account needed.</p>
    </div>
    <form class="formrow" method="post" action="/api/subscriptions">
      <input class="field" type="email" name="email" required placeholder="you@company.com" style="flex:1 1 190px">
      <input type="hidden" name="digest" value="1">
      <button class="btn btn-primary" type="submit">Subscribe</button>
    </form>
  </section>
</div>`;

  return layout({
    title: 'The Internet Change Detector — see what changed, when, and what it looked like before',
    description:
      'Continuous monitoring of important public web pages. Every change is diffed, scored, timestamped and backed by a content-addressed snapshot you can verify.',
    path: '/',
    baseUrl: props.baseUrl,
    active: 'feed',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'The Internet Change Detector',
      url: props.baseUrl,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${props.baseUrl}/search?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
  });
}
