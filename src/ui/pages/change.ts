/** The public change event page — the most important surface in the product. */
import { breadcrumbJsonLd, metaDescription, organizationJsonLd, SITE_NAME } from '../seo';
import { categoryPath, changePath, sitePath } from '../../lib/paths';
import type { ChangeEvent, MonitoredSite, Snapshot } from '../../types';
import { layout } from '../layout';
import { badge, e, hostOf, pathOf, severityStyle, shortCid, stamp, stampShort } from '../components';

export interface ChangeProps {
  baseUrl: string;
  change: ChangeEvent;
  site: MonitoredSite;
  previous: Snapshot | null;
  current: Snapshot;
  signals: { name: string; points: number; detail?: string }[];
  suppressed: Record<string, number>;
  gatewayUrl: string | null;
  replicas: string[];
  aiModel: string | null;
}

export function changePage(props: ChangeProps): string {
  const { change, site, previous, current } = props;
  const s = severityStyle(change.severity);
  const shareUrl = `${props.baseUrl}${changePath(change)}`;
  const shareText = `${change.headline} — detected ${stampShort(change.detected_at)}`;

  const beforeAfter =
    change.before_value || change.after_value
      ? `<section class="split" style="margin:32px 0">
    <div>
      <div class="label" style="margin-bottom:18px">BEFORE</div>
      <div style="font-size:15px;font-weight:600;color:#8892A0">${e(change.label ?? 'Value')}</div>
      <div class="hero-num mono strike">${e(change.before_value ?? '—')}</div>
      <div style="font-size:12px;color:#93A0B0;margin-top:14px">Captured ${previous ? e(stampShort(previous.captured_at)) : 'n/a'}</div>
    </div>
    <div class="after">
      <div class="label" style="margin-bottom:18px;color:${s.color}">AFTER</div>
      <div style="font-size:15px;font-weight:600">${e(change.label ?? 'Value')}</div>
      <div class="hero-num mono" style="font-weight:500">${e(change.after_value ?? '—')}</div>
      <div style="font-size:12px;color:#93A0B0;margin-top:14px">Captured ${e(stampShort(current.captured_at))}</div>
    </div>
  </section>`
      : '';

  const suppressedRows = Object.entries(props.suppressed)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const proof = [
    { label: 'SNAPSHOT CID', value: current.cid ?? 'pending' },
    { label: 'SHA-256 (NORMALIZED)', value: current.content_hash },
    { label: 'CAPTURED', value: stampShort(current.captured_at) },
    {
      label: 'REPLICAS',
      value: props.replicas.length ? `${props.replicas.length} · ${props.replicas.join(', ')}` : 'pending',
    },
  ];

  const body = `<div class="wrap-narrow">
  <div style="padding:24px 0 0"><a class="label" href="/">← ALL CHANGES</a></div>

  <section style="padding:28px 0 30px;border-bottom:1px solid rgba(255,255,255,.09)">
    <div class="mono" style="font-size:10px;letter-spacing:.06em;color:${s.color}">CHANGE DETECTED</div>
    <h1 class="change">${e(change.headline)}</h1>
    <div class="meta-row">
      ${badge(change.severity, true)}
      <span class="mono" style="font-size:10px;color:#8892A0">${e(stamp(change.detected_at))}</span>
      <a class="mono" style="font-size:10px" href="${e(sitePath(site))}">${e(hostOf(site.canonical_url))}${e(pathOf(site.canonical_url) === hostOf(site.canonical_url) ? '' : pathOf(site.canonical_url))}</a>
      <span class="mono" style="font-size:10px;color:#93A0B0">${e(change.change_type)}</span>
    </div>
  </section>

  ${beforeAfter}

  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:26px;padding-bottom:34px;border-bottom:1px solid rgba(255,255,255,.08)">
    <div>
      <h2 style="margin:0 0 11px;font-size:12px;font-weight:700;letter-spacing:.02em;color:#8892A0">WHAT CHANGED?</h2>
      <p style="margin:0;font-size:16px;line-height:1.5;text-wrap:pretty">${e(change.summary)}</p>
      ${props.aiModel ? `<div class="label" style="margin-top:10px">SUMMARY REVIEWED BY ${e(props.aiModel.toUpperCase())}</div>` : ''}
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn btn-ghost btn-sm" href="${e(changePath(change))}/diff">View full diff →</a>
        ${previous ? `<a class="btn btn-ghost btn-sm" href="/snapshots/${e(previous.id)}">Previous version</a>` : ''}
        <a class="btn btn-ghost btn-sm" href="/snapshots/${e(current.id)}">Current version</a>
      </div>
    </div>
    <div>
      ${
        change.delta
          ? `<div style="display:inline-block;padding:18px 22px;border-radius:11px;background:${s.background};border:1px solid ${s.color}40;color:${s.color}">
               <div class="mono" style="font-size:34px;letter-spacing:-.07em">${e(change.delta)}</div>
               <div style="font-size:11.5px;color:#8892A0;margin-top:6px">${e(change.delta_note ?? '')}</div>
             </div>`
          : ''
      }
      <div class="label" style="margin-top:16px">INTERESTINGNESS ${change.interestingness_score}/100 · MAGNITUDE ${change.change_score}/100</div>
    </div>
  </section>

  <section style="margin:30px 0 0;border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:hidden">
    <div style="padding:14px 20px;background:#1B2129;display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.08)">
      <span class="mono" style="font-size:10px;letter-spacing:.04em">VERIFIED SNAPSHOT</span>
      <span style="font-size:11px;color:#93A0B0">content-addressed · hash-checked · ${props.replicas.length} replica${props.replicas.length === 1 ? '' : 's'}</span>
    </div>
    <div class="proof">
      ${proof.map((item) => `<div><div class="label">${e(item.label)}</div><div class="v">${e(item.value)}</div></div>`).join('')}
    </div>
    <div style="background:#151A21;padding:16px 20px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="/snapshots/${e(current.id)}/raw">View archived snapshot</a>
      <a class="btn btn-ghost btn-sm" href="/api/snapshots/${e(current.id)}/artifact.car">Download CAR artifact</a>
      <a class="btn btn-ghost btn-sm" href="/snapshots/${e(current.id)}/verify">Re-verify hash</a>
      ${props.gatewayUrl ? `<a class="btn btn-ghost btn-sm" href="${e(props.gatewayUrl)}" rel="nofollow noopener" target="_blank">Open via IPFS gateway</a>` : ''}
    </div>
  </section>

  <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;margin-top:24px">
    <div class="panel panel-pad">
      <div class="label">WHY THIS SCORED ${change.interestingness_score}</div>
      ${
        props.signals.length
          ? props.signals
              .map(
                (signal) => `<div class="signal-row"><span>${e(signal.name)}${signal.detail ? ` <span class="dim">· ${e(signal.detail)}</span>` : ''}</span><span class="mono" style="color:${signal.points >= 0 ? '#E6EAF0' : '#93A0B0'}">${signal.points >= 0 ? '+' : ''}${Math.round(signal.points)}</span></div>`,
              )
              .join('')
          : '<div class="signal-row"><span>No scoring signals recorded</span><span class="mono">0</span></div>'
      }
    </div>
    <div class="panel panel-pad">
      <div class="label">SUPPRESSED AS NOISE</div>
      ${
        suppressedRows.length
          ? suppressedRows
              .map(([name, count]) => `<div class="signal-row"><span>${e(name)}</span><span class="mono">${count}</span></div>`)
              .join('')
          : '<div class="signal-row"><span>Nothing suppressed on this capture</span><span class="mono">0</span></div>'
      }
      <div style="font-size:11px;color:#93A0B0;margin-top:12px;line-height:1.5">Suppression rules run before hashing, so noise never becomes a change event. They are configurable per site.</div>
    </div>
  </section>

  <section style="padding:40px 0 0">
    <div class="label" style="margin-bottom:12px">SHARE CARD · AUTO-GENERATED OG IMAGE</div>
    <div class="paper">
      <div class="brandline"><span class="dot"></span><span>THE INTERNET CHANGE DETECTOR</span></div>
      <h2>${e(change.headline)}</h2>
      ${
        change.before_value && change.after_value
          ? `<div style="display:flex;align-items:baseline;gap:18px;margin-top:26px;flex-wrap:wrap">
               <span class="mono" style="font-size:clamp(22px,5vw,32px);letter-spacing:-.07em;color:#9AA0A8;text-decoration:line-through">${e(change.before_value)}</span>
               <span class="mono" style="font-size:clamp(24px,5.6vw,38px);letter-spacing:-.07em">${e(change.after_value)}</span>
               ${change.delta ? `<span class="mono" style="font-size:17px;color:#C0332F">${e(change.delta)}</span>` : ''}
             </div>`
          : ''
      }
      <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:30px;padding-top:16px;border-top:1px solid rgba(0,0,0,.12)" class="mono">
        <span style="font-size:9px;color:#6B7078">DETECTED ${e(stampShort(change.detected_at))}</span>
        <span style="font-size:9px;color:#6B7078">${e(props.baseUrl.replace(/^https?:\/\//, ''))}/changes/${e(change.slug)}</span>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="https://x.com/intent/tweet?${new URLSearchParams({ text: shareText, url: shareUrl })}" target="_blank" rel="noopener">Share on X</a>
      <a class="btn btn-ghost btn-sm" href="https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url: shareUrl })}" target="_blank" rel="noopener">LinkedIn</a>
      <a class="btn btn-ghost btn-sm" href="https://news.ycombinator.com/submitlink?${new URLSearchParams({ u: shareUrl, t: change.headline })}" target="_blank" rel="noopener">Hacker News</a>
      <a class="btn btn-ghost btn-sm" href="/changes/${e(change.slug)}/og.png">Download card</a>
      <a class="btn btn-ghost btn-sm" href="/api/changes/${e(change.id)}">JSON</a>
    </div>
  </section>
</div>`;

  const ogDescription = metaDescription(`${change.summary} Detected ${stampShort(change.detected_at)}.`);
  const siteName = site.title ?? hostOf(site.canonical_url);
  const published = new Date(change.detected_at * 1000).toISOString();
  return layout({
    title: `${change.headline} — ${SITE_NAME}`,
    description: ogDescription,
    path: changePath(change),
    baseUrl: props.baseUrl,
    active: 'feed',
    narrow: true,
    ogType: 'article',
    ogImage: `${props.baseUrl}/changes/${change.slug}/og.png`,
    body,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: change.headline.slice(0, 110),
        description: change.summary,
        datePublished: published,
        dateModified: published,
        url: shareUrl,
        mainEntityOfPage: shareUrl,
        image: [`${props.baseUrl}/changes/${change.slug}/og.png`],
        articleSection: site.category,
        author: { '@type': 'Organization', name: SITE_NAME, url: `${props.baseUrl}/` },
        publisher: organizationJsonLd(props.baseUrl),
        about: { '@type': 'WebPage', url: site.canonical_url, name: siteName },
        isBasedOn: current.cid ? `ipfs://${current.cid}` : site.canonical_url,
        identifier: current.cid ?? undefined,
      },
      breadcrumbJsonLd(props.baseUrl, [
        { name: 'Changes', path: '/' },
        { name: site.category, path: categoryPath(site.category) },
        { name: siteName, path: sitePath(site) },
        { name: change.headline, path: changePath(change) },
      ]),
    ],
  });
}
