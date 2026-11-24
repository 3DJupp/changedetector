/** Side-by-side diff viewer: text, word-level and raw HTML modes. */
import { changePath } from '../../lib/paths';
import type { ChangeEvent, MonitoredSite, Snapshot } from '../../types';
import { layout } from '../layout';
import { DiffRow, diffWords } from '../../lib/diff';
import { e, hostOf, pathOf, shortCid, stampShort } from '../components';
import { COLORS } from '../theme';
import { escapeHtml } from '../../lib/html';

export interface DiffProps {
  baseUrl: string;
  change: ChangeEvent;
  site: MonitoredSite;
  previous: Snapshot | null;
  current: Snapshot;
  hunks: { header: string; rows: DiffRow[] }[];
  stats: { added: number; removed: number; changed: number; ratio: number };
  suppressed: Record<string, number>;
  mode: 'text' | 'words' | 'raw';
  truncated: boolean;
  rawUnavailable?: string;
}

function renderInline(ops: ReturnType<typeof diffWords>, side: 'left' | 'right'): string {
  return ops
    .filter((op) => op.type === 'equal' || (side === 'left' ? op.type === 'delete' : op.type === 'insert'))
    .map((op) => {
      const text = escapeHtml(op.value);
      if (op.type === 'equal') return text;
      return side === 'left' ? `<del>${text}</del>` : `<ins>${text}</ins>`;
    })
    .join('');
}

function renderRow(row: DiffRow, wordLevel: boolean): string {
  const number = (value: number | null) => `<span class="ln">${value === null ? '' : String(value).padStart(2, '0')}</span>`;

  if (row.kind === 'same') {
    return `<div class="diffrow">
      <div class="cell">${number(row.leftNumber)}${e(row.left ?? '')}</div>
      <div class="cell">${number(row.rightNumber)}${e(row.right ?? '')}</div>
    </div>`;
  }
  if (row.kind === 'changed' && wordLevel && row.left && row.right && row.left.length + row.right.length < 4000) {
    const ops = diffWords(row.left, row.right);
    return `<div class="diffrow">
      <div class="cell del">${number(row.leftNumber)}${renderInline(ops, 'left')}</div>
      <div class="cell add">${number(row.rightNumber)}${renderInline(ops, 'right')}</div>
    </div>`;
  }
  const left = row.left === null
    ? `<div class="cell blank">${number(null)}</div>`
    : `<div class="cell del">${number(row.leftNumber)}${e(row.left)}</div>`;
  const right = row.right === null
    ? `<div class="cell blank">${number(null)}</div>`
    : `<div class="cell add">${number(row.rightNumber)}${e(row.right)}</div>`;
  return `<div class="diffrow">${left}${right}</div>`;
}

export function diffPage(props: DiffProps): string {
  const { change, site } = props;
  const modes: [DiffProps['mode'], string][] = [
    ['text', 'Text'],
    ['words', 'Word-level'],
    ['raw', 'Raw HTML'],
  ];

  const suppressedRows = Object.entries(props.suppressed).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const body = `<div class="wrap">
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:26px 0 18px;border-bottom:1px solid rgba(255,255,255,.09)">
    <div>
      <a class="label" href="${e(changePath(change))}">← BACK TO CHANGE EVENT</a>
      <h1 style="margin:12px 0 0;font-size:26px;letter-spacing:-.035em;font-weight:800">${e(site.title ?? hostOf(site.canonical_url))}
        <span class="mono" style="font-size:13px;font-weight:400;color:#93A0B0">${e(pathOf(site.canonical_url))}</span>
      </h1>
      <div class="mono" style="font-size:9.5px;color:#8892A0;margin-top:8px">${props.previous ? e(stampShort(props.previous.captured_at)) : 'first capture'} → ${e(stampShort(props.current.captured_at))}</div>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${modes
        .map(
          ([mode, label]) =>
            `<a class="chip${props.mode === mode ? ' on' : ''}" href="${e(changePath(change))}/diff?mode=${mode}">${label}</a>`,
        )
        .join('')}
    </div>
  </div>

  <div class="diffstats">
    <div class="s"><b style="color:${COLORS.amber}">${props.stats.changed}</b><span class="muted">lines changed</span></div>
    <div class="s"><b style="color:${COLORS.green}">${props.stats.added}</b><span class="muted">lines added</span></div>
    <div class="s"><b style="color:${COLORS.red}">${props.stats.removed}</b><span class="muted">lines removed</span></div>
    <div class="s"><b style="color:${COLORS.red}">${change.interestingness_score}</b><span class="muted">interestingness score</span></div>
  </div>

  <div class="cols">
    <div class="col-main difftable">
      <div class="diffhead">
        <div>PREVIOUS · ${e(shortCid(props.previous?.cid ?? null, 18))}</div>
        <div>CURRENT · ${e(shortCid(props.current.cid, 18))}</div>
      </div>
      ${
        props.rawUnavailable
          ? `<div class="empty">${e(props.rawUnavailable)}</div>`
          : props.hunks.length === 0
            ? '<div class="empty">No line-level differences were recorded for this event.</div>'
            : props.hunks
                .map(
                  (hunk) =>
                    `<div class="hunk">${e(hunk.header)}</div>${hunk.rows.map((row) => renderRow(row, props.mode === 'words')).join('')}`,
                )
                .join('')
      }
      ${props.truncated ? '<div class="hunk">diff truncated — download the artifact for the complete capture</div>' : ''}
    </div>

    <aside class="col-side">
      <div class="panel panel-pad">
        <div class="label">SUPPRESSED AS NOISE</div>
        ${
          suppressedRows.length
            ? suppressedRows
                .map(([name, count]) => `<div class="signal-row"><span>${e(name)}</span><span class="mono">${count}</span></div>`)
                .join('')
            : '<div class="signal-row"><span>Nothing suppressed</span><span class="mono">0</span></div>'
        }
        <div style="font-size:11px;color:#93A0B0;margin-top:12px;line-height:1.5">Suppression rules are configured per site in the normalization pipeline.</div>
      </div>
      <div class="panel panel-pad">
        <div class="label">CLASSIFICATION</div>
        <div class="signal-row"><span>Change type</span><span class="mono">${e(change.change_type)}</span></div>
        <div class="signal-row"><span>Severity</span><span class="mono">${e(change.severity)}</span></div>
        <div class="signal-row"><span>Interestingness</span><span class="mono">${change.interestingness_score} / 100</span></div>
        <div class="signal-row"><span>Magnitude</span><span class="mono">${change.change_score} / 100</span></div>
        <div class="signal-row"><span>Lines touched</span><span class="mono">${(props.stats.ratio * 100).toFixed(1)}%</span></div>
        <form method="post" action="/admin/changes/${e(change.id)}/false-positive" style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" type="submit">Mark false positive</button>
          <a class="btn btn-ghost btn-sm" href="/api/changes/${e(change.id)}">JSON</a>
        </form>
      </div>
      <div class="panel panel-pad">
        <div class="label">ARTIFACTS</div>
        <div class="signal-row"><span>Previous snapshot</span><span>${props.previous ? `<a href="/snapshots/${e(props.previous.id)}">open</a>` : '—'}</span></div>
        <div class="signal-row"><span>Current snapshot</span><span><a href="/snapshots/${e(props.current.id)}">open</a></span></div>
        <div class="signal-row"><span>CAR archive</span><span><a href="/api/snapshots/${e(props.current.id)}/artifact.car">download</a></span></div>
      </div>
    </aside>
  </div>
</div>`;

  return layout({
    title: `Diff — ${change.headline}`,
    // The change page is the one to rank; the diff is its evidence.
    noindex: 'noindex,follow',
    description: change.summary,
    path: `${changePath(change)}/diff`,
    baseUrl: props.baseUrl,
    active: 'feed',
    body,
    ogImage: `${props.baseUrl}/changes/${change.slug}/og.png`,
  });
}
