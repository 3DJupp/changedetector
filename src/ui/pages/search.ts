/** Search across sites, URLs, headlines, summaries and categories. */
import { changePath } from '../../lib/paths';
import type { ChangeEvent, MonitoredSite } from '../../types';
import { layout } from '../layout';
import { badge, e, hostOf, pathOf, severityStyle, timeAgo } from '../components';

export interface SearchProps {
  baseUrl: string;
  query: string;
  category: string;
  results: (ChangeEvent & { site: Partial<MonitoredSite> })[];
  facets: { label: string; count: number }[];
  suggestions: string[];
}

export function searchPage(props: SearchProps): string {
  const body = `<div class="wrap-mid">
  <section style="padding:34px 0 20px;border-bottom:1px solid rgba(255,255,255,.09)">
    <div class="label">SEARCH</div>
    <h1 style="margin:12px 0 0;font-size:30px;letter-spacing:-.04em;font-weight:800">${props.query ? `“${e(props.query)}”` : 'Everything indexed'}</h1>
    <div style="font-size:13.5px;color:#8892A0;margin-top:9px">${props.results.length} matching change event${props.results.length === 1 ? '' : 's'} across sites, URLs, summaries and categories.</div>
    <form action="/search" method="get" class="formrow" style="margin-top:16px;max-width:520px">
      <input class="field mono" name="q" value="${e(props.query)}" placeholder="pricing changes" style="flex:3 1 240px;font-size:12px">
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:18px">
      ${props.suggestions
        .map((suggestion) => `<a class="chip" href="/search?q=${encodeURIComponent(suggestion)}">${e(suggestion)}</a>`)
        .join('')}
    </div>
  </section>

  <section class="cols" style="padding:22px 0 0">
    <aside class="col-side panel panel-pad" style="flex:1 1 200px">
      <div class="label">BY CATEGORY</div>
      ${props.facets
        .map(
          (facet) =>
            `<a class="signal-row" style="text-decoration:none;color:${props.category === facet.label ? '#E6EAF0' : '#8892A0'}" href="/search?${new URLSearchParams({ q: props.query, category: facet.label === 'All' ? '' : facet.label })}"><span>${e(facet.label)}</span><span class="mono dim">${facet.count}</span></a>`,
        )
        .join('')}
    </aside>
    <div class="col-main rowlist">
      ${
        props.results.length
          ? props.results
              .map((change) => {
                const s = severityStyle(change.severity);
                return `<a class="row" href="${e(changePath(change))}">
        <div style="flex:0 0 86px;display:flex;flex-direction:column;gap:6px">
          ${badge(change.severity)}
          <span class="mono" style="font-size:9px;color:#93A0B0">${e(timeAgo(change.detected_at))}</span>
        </div>
        <div style="flex:1 1 250px;min-width:0">
          <div style="font-size:15px;font-weight:600;letter-spacing:-.02em">${e(change.headline)}</div>
          <div class="mono" style="font-size:9.5px;color:#93A0B0;margin-top:5px;word-break:break-all">${e(hostOf(change.site.canonical_url ?? ''))}${e(pathOf(change.site.canonical_url ?? ''))} · ${e(change.site.category ?? '')}</div>
        </div>
        <div class="mono" style="flex:0 0 auto;font-size:14px;letter-spacing:-.05em;color:${s.color}">${e(change.delta ?? '')}</div>
      </a>`;
              })
              .join('')
          : '<div class="empty">Nothing matches that yet. Changes are indexed the moment they are detected.</div>'
      }
    </div>
  </section>
</div>`;

  return layout({
    title: props.query ? `Search: ${props.query}` : 'Search change events',
    description: 'Search every detected change by site, URL, headline, summary or category.',
    path: '/search',
    baseUrl: props.baseUrl,
    active: 'search',
    query: props.query,
    body,
    noindex: props.query ? true : 'noindex,follow',
  });
}
