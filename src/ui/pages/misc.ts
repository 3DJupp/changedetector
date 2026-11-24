/** Sites index, about page and the public API reference. */
import { sitePath } from '../../lib/paths';
import type { MonitoredSite } from '../../types';
import { CATEGORIES } from '../../types';
import { layout } from '../layout';
import { chips, e, hostOf, timeAgo } from '../components';
import { COLORS } from '../theme';

export function sitesPage(props: {
  baseUrl: string;
  sites: MonitoredSite[];
  total: number;
  category: string;
}): string {
  const body = `<div class="wrap">
  <section style="padding:34px 0 18px">
    <div class="label">UNDER OBSERVATION</div>
    <h1 style="margin:12px 0 0;font-size:32px;letter-spacing:-.04em;font-weight:800">${props.total.toLocaleString()} monitored pages</h1>
    <p class="muted" style="font-size:14px;margin:10px 0 0;max-width:60ch">A curated list, not a crawl of the whole web. Each page is fetched on its own cadence, normalized, hashed and compared against its previous capture.</p>
  </section>
  <section class="chips">
    ${chips(['All', ...CATEGORIES].map((category) => ({
      label: category.toUpperCase(),
      href: category === 'All' ? '/sites' : `/sites?category=${encodeURIComponent(category)}`,
      on: props.category === category,
    })))}
  </section>
  <div class="rowlist" style="margin-top:18px">
    <div class="rowhead">
      <span style="flex:1 1 240px">PAGE</span><span style="flex:0 0 120px">CATEGORY</span>
      <span style="flex:0 0 90px">CHANGES</span><span style="flex:0 0 110px">LAST CHANGE</span><span style="flex:0 0 110px">LAST CHECK</span>
    </div>
    ${
      props.sites.length
        ? props.sites
            .map(
              (site) => `<a class="row" href="${e(sitePath(site))}">
      <span style="flex:1 1 240px;min-width:0">
        <span style="font-weight:600;font-size:14px">${e(site.title ?? hostOf(site.canonical_url))}</span>
        <span class="mono dim" style="display:block;font-size:9.5px;margin-top:3px;word-break:break-all">${e(site.canonical_url)}</span>
      </span>
      <span style="flex:0 0 120px;font-size:12.5px;color:${COLORS.muted}">${e(site.category)}</span>
      <span class="mono" style="flex:0 0 90px;font-size:12px">${site.change_count}</span>
      <span style="flex:0 0 110px;font-size:12px;color:${COLORS.muted}">${site.last_changed_at ? e(timeAgo(site.last_changed_at)) : '—'}</span>
      <span style="flex:0 0 110px;font-size:12px;color:${COLORS.muted}">${site.last_checked_at ? e(timeAgo(site.last_checked_at)) : 'never'}</span>
    </a>`,
            )
            .join('')
        : '<div class="empty">No sites are being monitored yet.</div>'
    }
  </div>
</div>`;

  return layout({
    title: 'Monitored pages',
    description: 'Every public page currently under observation, with its cadence and change history.',
    path: '/sites',
    baseUrl: props.baseUrl,
    active: 'sites',
    body,
  });
}

export function aboutPage(baseUrl: string): string {
  const body = `<div class="wrap-narrow">
  <section style="padding:44px 0 24px">
    <div class="label">ABOUT</div>
    <h1 style="margin:14px 0 0;font-size:38px;letter-spacing:-.045em;font-weight:800;line-height:1.05">A radar for changes on the internet</h1>
    <p style="font-size:16.5px;line-height:1.6;color:#8892A0;margin-top:18px">Web pages change quietly. Prices go up, free tiers shrink, terms gain clauses, features disappear, repositories vanish. This service watches a curated set of public pages and turns each meaningful change into a timestamped, verifiable event.</p>
  </section>

  <section class="panel panel-pad" style="margin-top:8px">
    <div class="label">HOW A CHANGE IS DETECTED</div>
    <ol style="font-size:14px;line-height:1.75;color:#C9D2DE;padding-left:20px;margin:14px 0 0">
      <li><b>Fetch</b> — plain HTTP first, with timeouts, size caps and per-domain rate limits. robots.txt is respected. A headless browser is used only when a page demonstrably renders nothing without JavaScript.</li>
      <li><b>Normalize</b> — scripts, styles, cookie banners, rotating promos, chat widgets, analytics attributes, randomized class names, timestamps, dates and build hashes are removed or replaced with stable tokens. What survives is visible text, headings, links, images, prices and structure.</li>
      <li><b>Hash</b> — the canonical representation is hashed with SHA-256. An identical hash ends processing immediately; nothing is stored twice.</li>
      <li><b>Diff</b> — a semantic line diff, then word-level and structural diffs: sections added or removed, headings changed, links and images changed, metadata changed.</li>
      <li><b>Score</b> — a magnitude score and an <i>interestingness</i> score. Price movements, disappearing pages, title and heading changes, terms changes and high-signal wording score high; cosmetic edits score near zero and are never published.</li>
      <li><b>Explain</b> — a language model reviews the diff and writes the headline and summary. It is a second opinion on significance, bounded by the heuristic score, and the system produces complete events without it.</li>
    </ol>
  </section>

  <section class="panel panel-pad" style="margin-top:14px">
    <div class="label">WHAT "VERIFIABLE" MEANS HERE</div>
    <p style="font-size:14px;line-height:1.7;color:#C9D2DE;margin:12px 0 0">Each meaningful capture is packed into an artifact directory — <code class="mono">metadata.json</code>, <code class="mono">page.html</code>, <code class="mono">content.txt</code>, <code class="mono">normalized.json</code> — and addressed by a CIDv1 computed from the bytes themselves, exactly as IPFS would compute it. The database records <i>that we observed this URL at this time</i>; the artifact records <i>these exact bytes</i>.</p>
    <p style="font-size:14px;line-height:1.7;color:#C9D2DE;margin:12px 0 0">Bytes are held in object storage and, when a pinning endpoint is configured, mirrored to IPFS as a CAR archive. Content addressing guarantees <b>integrity</b>: anyone can re-hash the artifact and confirm it is the capture we published. It does not guarantee <b>permanence</b> — availability comes from the replicas listed on each snapshot page, and we say how many there are rather than implying the network keeps things forever.</p>
  </section>

  <section class="panel panel-pad" style="margin-top:14px">
    <div class="label">WHAT WE DO NOT DO</div>
    <ul style="font-size:14px;line-height:1.75;color:#C9D2DE;padding-left:20px;margin:12px 0 0">
      <li>No private, authenticated or paywalled pages, and no attempt to work around any technical access control.</li>
      <li>No bypassing of CAPTCHAs, bot protection or rate limits — a 403 or 429 is treated as a stop sign with exponential backoff.</li>
      <li>No requests to private networks: URLs resolving to loopback, link-local, private or cloud-metadata addresses are rejected before a socket opens, on the first request and on every redirect.</li>
      <li>No crawling of the whole web. The list is curated and small on purpose.</li>
    </ul>
  </section>
</div>`;

  return layout({
    title: 'About — The Internet Change Detector',
    description: 'How changes are detected, scored and made verifiable, and the limits we work within.',
    path: '/about',
    baseUrl: baseUrl,
    narrow: true,
    body,
  });
}

export function apiPage(baseUrl: string): string {
  const endpoints: [string, string, string][] = [
    ['GET', '/api/changes', 'Published change events. Filters: category, type, severity, minScore, since, order, limit, offset.'],
    ['GET', '/api/changes/:idOrSlug', 'One change event with site, snapshot CIDs, scores, diff payload and signals.'],
    ['GET', '/api/changes/:idOrSlug/diff', 'Full stored diff payload for one event.'],
    ['GET', '/api/sites', 'Monitored sites. Filters: category, status, q, limit, offset.'],
    ['GET', '/api/sites/:id', 'One site with cadence, counters and latest snapshot.'],
    ['GET', '/api/sites/:id/changes', 'Change history for one site. Add format=csv for a spreadsheet export.'],
    ['GET', '/api/sites/:id/snapshots', 'Snapshot ledger for one site — every capture, changed or not.'],
    ['GET', '/api/snapshots/:id', 'Snapshot record: hashes, CIDs, status, headers.'],
    ['GET', '/api/snapshots/:id/verify', 'Re-hash the stored artifact and compare against the recorded content address.'],
    ['GET', '/api/snapshots/:id/artifact.car', 'The artifact as a CARv1 archive, importable into any IPFS node.'],
    ['GET', '/api/search?q=', 'Full-text search across headlines, summaries, sites, URLs and categories.'],
    ['GET', '/api/stats', 'Aggregate counters: sites, snapshots, changes, crawl success, pinning coverage.'],
    ['GET', '/api/digest/:day', 'The daily digest for a given YYYY-MM-DD.'],
    ['POST', '/api/subscriptions', 'Follow a site, a category or the daily digest. Body: {email, siteId?, category?, digest?, webhook?, minScore?}. With webhook (https), changes go to Slack, Discord or your endpoint. Returns 202; nothing is sent until the emailed link is confirmed.'],
    ['POST', '/api/sites', 'Add a monitored URL. Requires the admin token.'],
    ['POST', '/api/sites/:id/crawl', 'Force a crawl of one site. Requires the admin token.'],
    ['PATCH', '/api/sites/:id', 'Update category, cadence, status, render mode or normalization rules. Admin token.'],
    ['DELETE', '/api/sites/:id', 'Remove a site and its history. Admin token.'],
  ];

  const body = `<div class="wrap-narrow">
  <section style="padding:44px 0 20px">
    <div class="label">PUBLIC API</div>
    <h1 style="margin:14px 0 0;font-size:34px;letter-spacing:-.045em;font-weight:800">Every change, as JSON</h1>
    <p class="muted" style="font-size:15px;line-height:1.6;margin-top:14px">Read endpoints are public and cached at the edge. Write endpoints need <code class="mono">Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code>.</p>
  </section>
  <div class="rowlist">
    ${endpoints
      .map(
        ([method, path, description]) => `<div class="row" style="align-items:flex-start">
      <span class="mono" style="flex:0 0 64px;font-size:10px;color:${method === 'GET' ? COLORS.green : COLORS.amber}">${method}</span>
      <span class="mono" style="flex:0 0 260px;min-width:0;font-size:11.5px;word-break:break-all">${e(path)}</span>
      <span style="flex:1 1 240px;min-width:0;font-size:13px;color:${COLORS.muted};line-height:1.5">${e(description)}</span>
    </div>`,
      )
      .join('')}
  </div>

  <section style="margin-top:26px">
    <div class="label" style="margin-bottom:10px">EXAMPLE EVENT</div>
    <pre class="panel panel-pad mono" style="font-size:11.5px;line-height:1.7;overflow-x:auto;margin:0;color:#C9D2DE">${e(`{
  "id": "chg_9a1c…",
  "slug": "8f21ac3d",
  "site": { "id": "site_…", "url": "https://example.com/pricing", "title": "Example Pricing" },
  "detectedAt": "2026-09-09T18:42:00Z",
  "changeType": "PRICE",
  "severity": "MAJOR",
  "score": 87,
  "magnitude": 62,
  "summary": "Pro pricing increased from $19 to $24 per month.",
  "delta": "+26.3%",
  "previousSnapshot": { "cid": "bafybei…", "capturedAt": "2026-09-09T06:12:00Z" },
  "currentSnapshot":  { "cid": "bafybei…", "capturedAt": "2026-09-09T18:42:00Z" },
  "url": "${baseUrl}/changes/8f21ac3d"
}`)}</pre>
  </section>

  <section style="margin-top:26px">
    <div class="label" style="margin-bottom:10px">FEEDS</div>
    <div class="rowlist">
      <div class="row"><span class="mono" style="flex:0 0 260px;font-size:11.5px">/rss.xml</span><span class="muted" style="font-size:13px">All published changes</span></div>
      <div class="row"><span class="mono" style="flex:0 0 260px;font-size:11.5px">/rss.xml?category=Pricing</span><span class="muted" style="font-size:13px">One category</span></div>
      <div class="row"><span class="mono" style="flex:0 0 260px;font-size:11.5px">/sites/:id/rss.xml</span><span class="muted" style="font-size:13px">One monitored page</span></div>
      <div class="row"><span class="mono" style="flex:0 0 260px;font-size:11.5px">/digest.xml</span><span class="muted" style="font-size:13px">Daily digest</span></div>
    </div>
  </section>
</div>`;

  return layout({
    title: 'API — The Internet Change Detector',
    description: 'Public JSON API and RSS feeds for detected web changes.',
    path: '/api',
    baseUrl,
    active: 'api',
    narrow: true,
    body,
  });
}
