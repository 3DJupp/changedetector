/** "The Internet Changed Today" — the daily digest, shared by page and email. */
import { breadcrumbJsonLd, metaDescription } from '../seo';
import { changePath } from '../../lib/paths';
import type { ChangeEvent, MonitoredSite } from '../../types';
import { layout } from '../layout';
import { e, stampShort } from '../components';

export interface DigestProps {
  baseUrl: string;
  day: string;
  intro: string;
  changes: (ChangeEvent & { site: Partial<MonitoredSite> })[];
  stats: { detected: number; published: number; sites: number };
  isToday: boolean;
}

export function digestBodyHtml(props: DigestProps, forEmail = false): string {
  const rows = props.changes
    .map(
      (change, index) => `<div class="row" style="display:flex;gap:20px;padding:20px 0;flex-wrap:wrap">
    <div class="mono" style="flex:0 0 34px;font-size:19px;letter-spacing:-.06em;color:#A8ADB4">${String(index + 1).padStart(2, '0')}</div>
    <div style="flex:1 1 240px;min-width:0">
      <div style="font-size:16.5px;font-weight:700;letter-spacing:-.028em;line-height:1.25"><a href="${props.baseUrl}${e(changePath(change))}" style="color:#16181C">${e(change.headline)}</a></div>
      <div style="font-size:13.5px;color:#5B6068;margin-top:5px;line-height:1.45">${e(change.summary)}</div>
    </div>
    <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
      <span class="mono" style="font-size:16px;letter-spacing:-.05em;color:${change.severity === 'MAJOR' ? '#C0332F' : change.severity === 'MODERATE' || change.severity === 'SIGNIFICANT' ? '#A6721B' : '#4A4F57'}">${e(change.delta ?? '')}</span>
      <span class="mono" style="font-size:8.5px;color:#7A8089">${e(stampShort(change.detected_at))}</span>
    </div>
  </div>`,
    )
    .join('');

  return `<div class="paper" style="${forEmail ? 'font-family:-apple-system,Segoe UI,sans-serif;background:#F4F2ED;color:#16181C;padding:40px 32px;border-radius:12px' : ''}">
  <div class="brandline"><span class="dot" style="display:inline-block;width:9px;height:9px;background:#D63B42"></span><span>THE INTERNET CHANGE DETECTOR</span></div>
  <h2>The internet changed today</h2>
  <p style="margin:14px 0 0;font-size:15px;line-height:1.5;color:#4A4F57;max-width:46ch">${e(props.intro)}</p>
  <div style="margin-top:34px;border-top:1px solid rgba(0,0,0,.14)">${rows || '<div style="padding:24px 0;color:#5B6068">No changes crossed the publication threshold in this window.</div>'}</div>
  <div style="margin-top:28px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <a href="${props.baseUrl}/" style="padding:12px 20px;background:#16181C;color:#F4F2ED;border-radius:8px;font-size:13.5px;font-weight:600;text-decoration:none">See all changes</a>
    <span style="font-size:12px;color:#7A8089">${e(props.day)} · ${props.stats.detected} changes detected, ${props.stats.published} above threshold</span>
  </div>
  <div class="mono" style="margin-top:30px;padding-top:16px;border-top:1px solid rgba(0,0,0,.12);font-size:9px;color:#7A8089;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <span>${e(props.baseUrl.replace(/^https?:\/\//, ''))}/digest/${e(props.day)}</span><span>RSS · MANAGE ALERTS</span>
  </div>
</div>`;
}

export function digestPage(props: DigestProps): string {
  const body = `<div class="wrap-narrow">
  <section style="padding:32px 0 20px;display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;align-items:flex-end">
    <div>
      <div class="label">DAILY DIGEST · ${e(props.day)}</div>
      <h1 style="margin:12px 0 0;font-size:28px;letter-spacing:-.04em;font-weight:800">The Internet Changed Today</h1>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="/digest.xml">RSS version</a>
      <a class="btn btn-ghost btn-sm" href="/api/digest/${e(props.day)}">JSON</a>
    </div>
  </section>
  ${digestBodyHtml(props)}
</div>`;

  const dayLabel = new Date(`${props.day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const url = `${props.baseUrl}/digest/${props.day}`;
  return layout({
    title: `The Internet Changed Today — ${dayLabel}`,
    description: metaDescription(props.intro || `The most meaningful web page changes detected on ${dayLabel}.`),
    rssPath: '/digest.xml',
    rssTitle: 'The Internet Changed Today',
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `The Internet Changed Today — ${dayLabel}`,
        url,
        datePublished: `${props.day}T07:00:00Z`,
        isPartOf: { '@id': `${props.baseUrl}/#website` },
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: props.changes.map((change, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: `${props.baseUrl}${changePath(change)}`,
            name: change.headline,
          })),
        },
      },
      breadcrumbJsonLd(props.baseUrl, [
        { name: 'Daily digest', path: '/digest' },
        { name: dayLabel, path: `/digest/${props.day}` },
      ]),
    ],
    path: `/digest/${props.day}`,
    baseUrl: props.baseUrl,
    active: 'digest',
    narrow: true,
    body,
    ogImage: `${props.baseUrl}/og/digest-${props.day}.png`,
  });
}
