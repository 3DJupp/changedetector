/** Site page: identity, cadence, sparkline, change history, snapshot ledger. */
import type { ChangeEvent, MonitoredSite, Snapshot } from '../../types';
import { layout } from '../layout';
import { badge, e, hostOf, severityStyle, stampShort } from '../components';
import { COLORS } from '../theme';

export interface SiteProps {
  baseUrl: string;
  site: MonitoredSite;
  changes: (ChangeEvent & { site: Partial<MonitoredSite> })[];
  snapshots: Snapshot[];
  weekly: number[];
  following: boolean;
}

function intervalLabel(seconds: number): string {
  if (seconds <= 900) return 'Every 15 min';
  if (seconds <= 1800) return 'Every 30 min';
  if (seconds < 7200) return `Every ${Math.round(seconds / 3600)} hour`;
  if (seconds < 86400) return `Every ${Math.round(seconds / 3600)} hours`;
  return 'Daily';
}

export function sitePage(props: SiteProps): string {
  const { site } = props;
  const max = Math.max(1, ...props.weekly);
  const tags = [
    { label: site.status, color: site.status === 'ACTIVE' ? COLORS.green : COLORS.muted },
    { label: intervalLabel(site.crawl_interval_s).toUpperCase(), color: COLORS.muted },
    { label: site.category.toUpperCase(), color: COLORS.muted },
    { label: site.robots_allowed ? 'ROBOTS OK' : 'ROBOTS BLOCKED', color: site.robots_allowed ? COLORS.muted : COLORS.red },
  ];

  const body = `<div class="wrap-mid">
  <div style="padding:24px 0 0"><a class="label" href="/">← ALL CHANGES</a></div>

  <section style="padding:22px 0 26px;border-bottom:1px solid rgba(255,255,255,.09);display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:24px;align-items:end">
    <div>
      <h1 style="margin:0;font-size:36px;letter-spacing:-.045em;font-weight:800">${e(site.title ?? hostOf(site.canonical_url))}</h1>
      <a class="mono" style="font-size:11px;display:inline-block;margin-top:9px;word-break:break-all" href="${e(site.canonical_url)}" rel="nofollow noopener" target="_blank">${e(site.canonical_url)}</a>
      <div style="display:flex;gap:7px;margin-top:16px;flex-wrap:wrap">
        ${tags
          .map(
            (tag) =>
              `<span class="mono" style="font-size:9px;padding:6px 9px;border-radius:6px;background:${tag.color === COLORS.green ? 'rgba(63,191,127,.13)' : 'rgba(255,255,255,.07)'};color:${tag.color}">${e(tag.label)}</span>`,
          )
          .join('')}
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <form method="post" action="/api/subscriptions" style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="hidden" name="siteId" value="${e(site.id)}">
        <input class="field" type="email" name="email" required placeholder="you@company.com" style="flex:1 1 170px">
        <button class="btn btn-primary" type="submit">Follow this page</button>
      </form>
      <a class="btn btn-ghost" href="/sites/${e(site.id)}/rss.xml">RSS</a>
      <a class="btn btn-ghost" href="/api/sites/${e(site.id)}/changes?format=csv">CSV</a>
    </div>
  </section>

  <section style="padding:28px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:28px;align-items:end">
    <div>
      <div class="label" style="margin-bottom:14px">CHANGES PER WEEK · LAST ${props.weekly.length} WEEKS</div>
      <div class="spark">
        ${props.weekly
          .map((count) => {
            const height = Math.max(4, Math.round((count / max) * 100));
            const color = count >= max * 0.66 && count > 0 ? COLORS.red : count > 0 ? COLORS.amber : 'rgba(255,255,255,.16)';
            return `<i style="height:${height}%;background:${color}" title="${count} change(s)"></i>`;
          })
          .join('')}
      </div>
    </div>
    <div class="statgrid">
      <div class="cell"><div class="v">${site.change_count}</div><div class="l">Changes recorded</div></div>
      <div class="cell"><div class="v">${site.snapshot_count}</div><div class="l">Snapshots captured</div></div>
      <div class="cell"><div class="v">${site.last_changed_at ? e(stampShort(site.last_changed_at).split(',')[0]) : '—'}</div><div class="l">Last change</div></div>
    </div>
  </section>

  <section style="padding:8px 0 0">
    <h2 style="margin:0;font-size:13px;font-weight:700;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.09)">History</h2>
    ${
      props.changes.length
        ? props.changes
            .map((change) => {
              const s = severityStyle(change.severity);
              return `<a class="timeline" href="/changes/${e(change.slug)}">
        <div class="mono" style="flex:0 0 118px;font-size:9.5px;color:#93A0B0;padding-top:4px">${e(stampShort(change.detected_at))}</div>
        <div style="flex:0 0 6px;padding-top:9px"><div style="width:6px;height:6px;background:${s.color}"></div></div>
        <div style="flex:1 1 260px;min-width:0">
          <div style="font-size:14.5px;font-weight:600;letter-spacing:-.02em">${e(change.headline)}</div>
          <div style="font-size:13px;color:#8892A0;margin-top:4px;line-height:1.45">${e(change.summary)}</div>
        </div>
        <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:5px;padding-top:3px">
          ${badge(change.severity)}
          <span class="mono" style="font-size:9px;color:#93A0B0">${e(change.change_type)}</span>
        </div>
      </a>`;
            })
            .join('')
        : '<div class="empty">No changes detected yet for this page.</div>'
    }
  </section>

  <section style="padding:34px 0 0">
    <div class="label" style="margin-bottom:12px">SNAPSHOT LEDGER · EVERY CAPTURE, CHANGED OR NOT</div>
    <div class="rowlist">
      ${
        props.snapshots.length
          ? props.snapshots
              .map((snapshot) => {
                const ok = (snapshot.http_status ?? 0) < 400;
                const result = snapshot.is_duplicate ? 'identical' : 'CHANGED';
                return `<div class="ledger">
          <span style="flex:0 0 150px;color:#93A0B0">${e(stampShort(snapshot.captured_at))}</span>
          <span style="flex:0 0 44px;color:${ok ? COLORS.green : COLORS.amber}">${snapshot.http_status ?? '—'}</span>
          <span style="flex:1 1 200px;min-width:0;color:#93A0B0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="/snapshots/${e(snapshot.id)}">${e(snapshot.cid ?? '—')}</a></span>
          <span style="flex:0 0 96px;color:${result === 'CHANGED' ? COLORS.red : '#93A0B0'}">${result}</span>
        </div>`;
              })
              .join('')
          : '<div class="empty">No snapshots captured yet.</div>'
      }
    </div>
  </section>
</div>`;

  return layout({
    title: `${site.title ?? hostOf(site.canonical_url)} — monitored page`,
    description: `Change history and snapshot ledger for ${site.canonical_url}. ${site.change_count} changes recorded across ${site.snapshot_count} captures.`,
    path: `/sites/${site.id}`,
    ogImage: `${props.baseUrl}/sites/${site.id}/og.png`,
    baseUrl: props.baseUrl,
    active: 'sites',
    body,
  });
}
