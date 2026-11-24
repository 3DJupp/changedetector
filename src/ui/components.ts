/** Shared server-rendered UI pieces. */
import { changePath } from '../lib/paths';
import { escapeHtml } from '../lib/html';
import { COLORS, SEVERITY_COLORS } from './theme';

export const e = escapeHtml;

export function severityStyle(severity: string) {
  return SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.TRIVIAL;
}

export function badge(severity: string, large = false): string {
  const s = severityStyle(severity);
  return `<span class="badge${large ? ' lg' : ''}" style="background:${s.background};color:${s.color}">${e(severity)}</span>`;
}

export function deltaChip(delta: string | null, severity: string): string {
  if (!delta) return '';
  const s = severityStyle(severity);
  return `<span class="delta" style="background:${s.background};color:${s.color}">${e(delta)}</span>`;
}

export function timeAgo(unixSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const diff = Math.max(0, nowSeconds - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.floor(months / 12)} year${months >= 24 ? 's' : ''} ago`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function stamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${time} UTC`;
}

export function stampShort(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${time} UTC`;
}

export function shortCid(cid: string | null, length = 12): string {
  if (!cid) return '—';
  return cid.length <= length ? cid : `${cid.slice(0, length)}…`;
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' && !parsed.search ? parsed.host : parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export interface ChangeCardModel {
  slug: string;
  severity: string;
  interestingness_score: number;
  detected_at: number;
  headline: string;
  summary: string;
  label: string | null;
  before_value: string | null;
  after_value: string | null;
  delta: string | null;
  site: { title?: string | null; canonical_url?: string | null; host?: string | null };
  cid?: string | null;
}

export function changeCard(change: ChangeCardModel): string {
  const s = severityStyle(change.severity);
  const url = change.site.canonical_url ?? '';
  const values =
    change.before_value && change.after_value
      ? `<div class="bigrow">
           <span class="was">${e(change.before_value)}</span>
           <span class="arrow">→</span>
           <span class="now">${e(change.after_value)}</span>
           ${deltaChip(change.delta, change.severity)}
         </div>`
      : change.delta
        ? `<div class="bigrow"><span class="now">${e(change.delta)}</span></div>`
        : '';

  return `<a class="card" href="${e(changePath(change))}" style="border-left:3px solid ${s.color}">
  <div class="top">${badge(change.severity)}<span class="mono" style="font-size:9px;color:${COLORS.dim}">${e(timeAgo(change.detected_at))}</span></div>
  <div class="site">${e(change.site.title ?? hostOf(url))}</div>
  <div class="path">${e(pathOf(url))}</div>
  ${values}
  <div class="summary">${e(change.summary)}</div>
  <div class="foot">
    <span class="meter"><i style="width:${Math.max(3, change.interestingness_score)}%;background:${s.color}"></i></span>
    <span class="mono" style="font-size:9px;color:${COLORS.muted}">${change.interestingness_score}</span>
    <span class="mono" style="font-size:9px;color:${COLORS.dim}">${e(shortCid(change.cid ?? null))}</span>
  </div>
</a>`;
}

export function statCells(items: { value: string; label: string }[]): string {
  return `<div class="statgrid">${items
    .map((item) => `<div class="cell"><div class="v">${e(item.value)}</div><div class="l">${e(item.label)}</div></div>`)
    .join('')}</div>`;
}

export function chips(items: { label: string; href: string; on: boolean }[]): string {
  return items
    .map((item) => `<a class="chip${item.on ? ' on' : ''}" href="${e(item.href)}">${e(item.label)}</a>`)
    .join('');
}

export function emptyState(message: string): string {
  return `<div class="empty">${e(message)}</div>`;
}
