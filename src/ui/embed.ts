/**
 * Embeddable pieces for other sites: an iframe card for one change event and
 * an SVG "last change" badge for one monitored page. Both link back here.
 */
import { escapeHtml as e } from '../lib/html';
import type { ChangeEvent, MonitoredSite } from '../types';
import { hostOf, stampShort, timeAgo } from './components';
import { changePath, sitePath } from '../lib/paths';

const SEVERITY_COLOR: Record<string, string> = {
  MAJOR: '#C6332F',
  SIGNIFICANT: '#A6721B',
  MODERATE: '#A6721B',
  MINOR: '#2A78D6',
  TRIVIAL: '#7A8089',
};

export const EMBED_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors *",
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cache-control': 'public, max-age=600, s-maxage=3600',
};

export function embedSnippet(baseUrl: string, change: Pick<ChangeEvent, 'slug' | 'headline'>): string {
  return `<iframe src="${baseUrl}/changes/${change.slug}/embed" title="${e(change.headline)}" width="100%" height="190" style="max-width:520px;border:0" loading="lazy"></iframe>`;
}

export function embedCard(props: { baseUrl: string; change: ChangeEvent; site: MonitoredSite; dark: boolean }): string {
  const { change, site } = props;
  const accent = SEVERITY_COLOR[change.severity] ?? SEVERITY_COLOR.TRIVIAL;
  const url = `${props.baseUrl}${changePath(change)}`;
  const paper = props.dark ? '#151A21' : '#FFFFFF';
  const ink = props.dark ? '#E8ECF1' : '#16181C';
  const muted = props.dark ? '#8892A0' : '#6B7078';
  const rule = props.dark ? 'rgba(255,255,255,.1)' : '#E5E2DA';
  const values =
    change.before_value && change.after_value
      ? `<div class="values"><s>${e(change.before_value)}</s> <span class="arrow">→</span> <b>${e(change.after_value)}</b>${change.delta ? ` <span class="delta">${e(change.delta)}</span>` : ''}</div>`
      : change.delta
        ? `<div class="values"><span class="delta">${e(change.delta)}</span></div>`
        : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(change.headline)}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:${ink}}
a{color:inherit;text-decoration:none}
.card{display:block;background:${paper};border:1px solid ${rule};border-left:3px solid ${accent};border-radius:10px;padding:16px 18px;max-width:520px}
.top{display:flex;justify-content:space-between;gap:10px;font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;color:${muted}}
.sev{color:${accent}}
h1{font-size:16px;line-height:1.3;margin:10px 0 0;letter-spacing:-.01em}
.values{font:500 15px ui-monospace,Menlo,monospace;margin-top:8px}
.values s{color:${muted}}.arrow{color:${muted}}.delta{color:${accent}}
.foot{display:flex;justify-content:space-between;gap:10px;margin-top:12px;padding-top:10px;border-top:1px solid ${rule};font:10px ui-monospace,Menlo,monospace;color:${muted}}
.card:hover h1{text-decoration:underline}
</style></head>
<body><a class="card" href="${e(url)}" target="_blank" rel="noopener">
<div class="top"><span class="sev">${e(change.severity)}</span><span>${e(hostOf(site.canonical_url).toUpperCase())}</span></div>
<h1>${e(change.headline)}</h1>
${values}
<div class="foot"><span>Detected ${e(stampShort(change.detected_at))}</span><span>The Internet Change Detector ↗</span></div>
</a></body></html>`;
}

/** Rough Verdana 11px advance, the same approximation shields.io-style badges use. */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[il.,:;'|!]/.test(char) ? 3.5 : /[mwMW]/.test(char) ? 9.5 : /[A-Z0-9]/.test(char) ? 7.5 : 6.5;
  return Math.round(width);
}

export function badgeSvg(site: MonitoredSite, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const label = 'last change';
  const value = site.last_changed_at ? timeAgo(site.last_changed_at, nowSeconds) : 'none yet';
  const age = site.last_changed_at ? nowSeconds - site.last_changed_at : Infinity;
  const color = age < 86400 ? '#C6332F' : age < 7 * 86400 ? '#A6721B' : '#4A4F57';
  const left = textWidth(label) + 12;
  const right = textWidth(value) + 12;
  const width = left + right;
  const title = `${site.title ?? hostOf(site.canonical_url)}: ${label} ${value}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${e(title)}">
<title>${e(title)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#16181C"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${width}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${left / 2}" y="14">${e(label)}</text><text x="${left + right / 2}" y="14">${e(value)}</text>
</g></svg>`;
}

export function badgeMarkdown(baseUrl: string, site: MonitoredSite): string {
  return `[![Last change](${baseUrl}/sites/${site.slug ?? site.id}/badge.svg)](${baseUrl}${sitePath(site)})`;
}
