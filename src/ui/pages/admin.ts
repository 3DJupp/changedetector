/** Monitoring console: add, pause, force-crawl, inspect, tune. */
import { sitePath } from '../../lib/paths';
import type { MonitoredSite } from '../../types';
import { CATEGORIES, INTERVAL_PRESETS } from '../../types';
import { layout } from '../layout';
import type { SiteSuggestion } from '../../db/repo';
import { e, hostOf, stampShort, timeAgo } from '../components';
import { COLORS } from '../theme';

export interface AdminProps {
  baseUrl: string;
  sites: MonitoredSite[];
  total: number;
  stats: {
    sites: number;
    crawlSuccessPercent: number;
    browserFetchPercent: number;
    falsePositives: number;
    changes: number;
    crawls24h: number;
  };
  queue: { mode: string; due: number };
  logs: Record<string, unknown>[];
  message?: string;
  error?: string;
  authed: boolean;
  suggestions?: SiteSuggestion[];
}

function statusPill(status: string): string {
  const map: Record<string, string> = {
    ACTIVE: `background:rgba(63,191,127,.13);color:${COLORS.green}`,
    ERROR: `background:rgba(242,84,91,.13);color:${COLORS.red}`,
    PAUSED: `background:rgba(255,255,255,.07);color:${COLORS.muted}`,
    ARCHIVED: `background:rgba(255,255,255,.07);color:${COLORS.muted}`,
  };
  return `<span class="mono" style="font-size:8.5px;padding:4px 7px;border-radius:5px;${map[status] ?? map.PAUSED}">${e(status)}</span>`;
}

export function adminPage(props: AdminProps): string {
  const login = !props.authed
    ? `<div class="panel panel-pad" style="margin:24px 0">
    <div class="label">ADMIN ACCESS</div>
    <p class="muted" style="font-size:13.5px;line-height:1.5;margin:10px 0 14px">The console is read-only until you present the admin token. Set it with <code class="mono">wrangler secret put ADMIN_TOKEN</code>, then sign in here or send it as <code class="mono">Authorization: Bearer &lt;token&gt;</code>.</p>
    <form method="post" action="/admin/login" class="formrow">
      <input class="field" type="password" name="token" placeholder="admin token" style="flex:2 1 220px" required>
      <button class="btn btn-primary" type="submit">Sign in</button>
    </form>
  </div>`
    : '';

  const addForm = props.authed
    ? `<div class="panel panel-pad" style="margin:16px 0 0">
    <div class="label" style="margin-bottom:13px">ADD MONITORED URL</div>
    <form method="post" action="/admin/sites" class="formrow">
      <input class="field mono" name="url" required placeholder="https://example.com/pricing" style="flex:3 1 260px;font-size:11.5px">
      <select class="field" name="category" style="flex:1 1 130px">
        ${CATEGORIES.map((category) => `<option value="${e(category)}">${e(category)}</option>`).join('')}
      </select>
      <select class="field" name="interval" style="flex:1 1 120px">
        ${Object.keys(INTERVAL_PRESETS)
          .map((key) => `<option value="${key}"${key === '6h' ? ' selected' : ''}>${key}</option>`)
          .join('')}
      </select>
      <button class="btn btn-primary" type="submit">Add</button>
    </form>
    <div style="font-size:11.5px;color:#93A0B0;margin-top:11px">URLs are validated against private IP ranges, cloud metadata endpoints, non-HTTP protocols and DNS answers before the first fetch. robots.txt is respected.</div>
  </div>

  <div class="panel panel-pad" style="margin:16px 0 0">
    <div class="label" style="margin-bottom:13px">BULK OPERATIONS</div>
    <div class="formrow">
      <form method="post" action="/admin/seed"><button class="btn btn-ghost btn-sm" type="submit">Load curated seed list</button></form>
      <form method="post" action="/admin/demo"><button class="btn btn-ghost btn-sm" type="submit">Generate demo data</button></form>
      <form method="post" action="/admin/sweep"><button class="btn btn-ghost btn-sm" type="submit">Run scheduler sweep now</button></form>
      <form method="post" action="/admin/digest"><button class="btn btn-ghost btn-sm" type="submit">Rebuild today's digest</button></form>
      <form method="post" action="/admin/notifications"><button class="btn btn-ghost btn-sm" type="submit">Flush notification outbox</button></form>
    </div>
  </div>`
    : '';

  const suggestions = props.authed && props.suggestions?.length
    ? `<div class="panel panel-pad" style="margin:16px 0 0">
    <div class="label" style="margin-bottom:13px">SUGGESTED BY VISITORS · ${props.suggestions.length} PENDING</div>
    ${props.suggestions
      .map(
        (suggestion) => `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:12px 0;border-top:1px solid rgba(255,255,255,.07)">
      <div style="flex:1 1 280px;min-width:0">
        <a class="mono" style="font-size:11.5px;word-break:break-all" href="${e(suggestion.url)}" rel="nofollow noopener noreferrer" target="_blank">${e(suggestion.canonical_url)}</a>
        <div style="font-size:12px;color:#8892A0;margin-top:4px">${suggestion.votes} vote${suggestion.votes === 1 ? '' : 's'}${suggestion.category ? ` · ${e(suggestion.category)}` : ''}${suggestion.reason ? ` · “${e(suggestion.reason)}”` : ''}</div>
      </div>
      <form method="post" action="/admin/suggestions/${e(suggestion.id)}/approve" class="formrow" style="flex:0 0 auto">
        <select class="field" name="category" style="width:auto">${CATEGORIES.map((category) => `<option value="${e(category)}"${category === suggestion.category ? ' selected' : ''}>${e(category)}</option>`).join('')}</select>
        <select class="field" name="interval" style="width:auto">${Object.keys(INTERVAL_PRESETS).map((key) => `<option value="${key}"${key === '6h' ? ' selected' : ''}>${key}</option>`).join('')}</select>
        <button class="btn btn-primary btn-sm" type="submit">Approve</button>
      </form>
      <form method="post" action="/admin/suggestions/${e(suggestion.id)}/reject"><button class="btn btn-ghost btn-sm" type="submit">Reject</button></form>
    </div>`,
      )
      .join('')}
  </div>`
    : '';

  const rows = props.sites
    .map(
      (site) => `<div class="row">
    <span class="mono" style="flex:1 1 240px;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="${e(sitePath(site))}">${e(hostOf(site.canonical_url))}${e(new URL(site.canonical_url).pathname)}</a></span>
    <span style="flex:0 0 88px">${statusPill(site.status)}</span>
    <span style="flex:0 0 88px;font-size:12px;color:#8892A0">${Math.round(site.crawl_interval_s / 60)} min</span>
    <span style="flex:0 0 100px;font-size:12px;color:#8892A0">${site.last_checked_at ? e(timeAgo(site.last_checked_at)) : 'never'}</span>
    <span class="mono" style="flex:0 0 64px;font-size:11px">${site.change_count}</span>
    <span style="flex:0 0 190px;display:flex;gap:6px;flex-wrap:wrap">
      ${
        props.authed
          ? `<form method="post" action="/admin/sites/${e(site.id)}/crawl"><button class="btn btn-ghost btn-sm" type="submit">Crawl</button></form>
             <form method="post" action="/admin/sites/${e(site.id)}/toggle"><button class="btn btn-ghost btn-sm" type="submit">${site.status === 'PAUSED' ? 'Resume' : 'Pause'}</button></form>
             <form method="post" action="/admin/sites/${e(site.id)}/delete" onsubmit="return confirm('Remove this site and all of its history?')"><button class="btn btn-ghost btn-sm" type="submit">Remove</button></form>`
          : `<a class="btn btn-ghost btn-sm" href="${e(sitePath(site))}">Inspect</a>`
      }
    </span>
    ${site.last_error ? `<span style="flex:1 1 100%;font-size:11.5px;color:${COLORS.red}">${e(site.last_error)}</span>` : ''}
  </div>`,
    )
    .join('');

  const logRows = props.logs
    .map((log) => {
      const outcome = String(log.outcome);
      const color = outcome === 'CHANGED' ? COLORS.red : outcome === 'ERROR' ? COLORS.amber : COLORS.dim;
      return `<div class="ledger">
      <span style="flex:0 0 150px;color:#93A0B0">${e(stampShort(Number(log.started_at)))}</span>
      <span style="flex:0 0 44px;color:${Number(log.http_status) < 400 ? COLORS.green : COLORS.amber}">${log.http_status ?? '—'}</span>
      <span style="flex:1 1 220px;min-width:0;color:#93A0B0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e(String(log.url ?? ''))}</span>
      <span style="flex:0 0 90px;color:${color}">${e(outcome)}</span>
      <span style="flex:0 0 70px;color:#93A0B0">${log.duration_ms ?? 0}ms</span>
    </div>`;
    })
    .join('');

  const body = `<div class="wrap" style="padding-top:34px">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap">
    <div>
      <h1 style="margin:0;font-size:28px;letter-spacing:-.04em;font-weight:800">Monitoring console</h1>
      <p style="margin:8px 0 0;font-size:13.5px;color:#8892A0">${props.stats.sites.toLocaleString()} pages · ${props.stats.crawlSuccessPercent}% crawl success in the last 24 hours</p>
    </div>
    ${props.authed ? '<form method="post" action="/admin/logout"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>' : ''}
  </div>

  ${props.message ? `<div class="notice" style="margin-top:16px;border-color:rgba(63,191,127,.3);background:rgba(63,191,127,.08);color:#8FE3B6">${e(props.message)}</div>` : ''}
  ${props.error ? `<div class="notice" style="margin-top:16px;border-color:rgba(242,84,91,.3);background:rgba(242,84,91,.08);color:#FF9BA0">${e(props.error)}</div>` : ''}
  ${login}

  <div style="margin:24px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px">
    <div class="panel panel-pad"><div class="label">CRAWL QUEUE</div><div class="mono" style="font-size:25px;letter-spacing:-.07em;margin-top:9px">${props.queue.due}</div><div style="font-size:11.5px;color:#8892A0;margin-top:5px">due now · ${e(props.queue.mode)} mode</div></div>
    <div class="panel panel-pad"><div class="label">BROWSER FALLBACK</div><div class="mono" style="font-size:25px;letter-spacing:-.07em;margin-top:9px">${props.stats.browserFetchPercent}%</div><div style="font-size:11.5px;color:#8892A0;margin-top:5px">of fetches in 24h</div></div>
    <div class="panel panel-pad"><div class="label">FALSE POSITIVES</div><div class="mono" style="font-size:25px;letter-spacing:-.07em;margin-top:9px">${props.stats.falsePositives}</div><div style="font-size:11.5px;color:#8892A0;margin-top:5px">flagged by reviewers</div></div>
    <div class="panel panel-pad"><div class="label">CRAWLS · 24H</div><div class="mono" style="font-size:25px;letter-spacing:-.07em;margin-top:9px">${props.stats.crawls24h}</div><div style="font-size:11.5px;color:#8892A0;margin-top:5px">${props.stats.changes} changes all-time</div></div>
  </div>

  ${suggestions}
  ${addForm}

  <div class="rowlist" style="margin:16px 0 0">
    <div class="rowhead">
      <span style="flex:1 1 240px;min-width:0">URL</span><span style="flex:0 0 88px">STATUS</span>
      <span style="flex:0 0 88px">INTERVAL</span><span style="flex:0 0 100px">LAST CHECK</span>
      <span style="flex:0 0 64px">EVENTS</span><span style="flex:0 0 190px"></span>
    </div>
    ${rows || '<div class="empty">No sites yet. Load the curated seed list to get started.</div>'}
  </div>

  <div style="margin:24px 0 0">
    <div class="label" style="margin-bottom:12px">RECENT CRAWL LOG</div>
    <div class="rowlist">${logRows || '<div class="empty">No crawls recorded yet.</div>'}</div>
  </div>
</div>`;

  return layout({
    title: 'Monitoring console',
    description: 'Internal console for managing monitored URLs, crawl status and detection quality.',
    path: '/admin',
    baseUrl: props.baseUrl,
    active: 'admin',
    noindex: true,
    body,
  });
}
