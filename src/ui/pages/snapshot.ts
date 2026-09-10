/** Snapshot detail and verification. Archived HTML is never rendered live. */
import type { MonitoredSite, Snapshot } from '../../types';
import { layout } from '../layout';
import { e, hostOf, stampShort } from '../components';
import { COLORS } from '../theme';

export interface SnapshotProps {
  baseUrl: string;
  snapshot: Snapshot;
  site: MonitoredSite;
  gatewayUrl: string | null;
  artifact: { name: string; cid: string; size: number }[];
  verification?: { ok: boolean; expected: string; actual: string; checkedAt: string } | null;
  textPreview: string;
}

export function snapshotPage(props: SnapshotProps): string {
  const { snapshot } = props;
  const facts = [
    { label: 'SNAPSHOT ID', value: snapshot.id },
    { label: 'DIRECTORY CID', value: snapshot.cid ?? 'pending' },
    { label: 'SHA-256 (NORMALIZED)', value: snapshot.content_hash },
    { label: 'SHA-256 (RAW BODY)', value: snapshot.raw_hash ?? '—' },
    { label: 'CAPTURED', value: stampShort(snapshot.captured_at) },
    { label: 'HTTP STATUS', value: String(snapshot.http_status ?? '—') },
    { label: 'FETCH METHOD', value: snapshot.fetch_method },
    { label: 'BYTES', value: String(snapshot.raw_bytes ?? 0) },
  ];

  const body = `<div class="wrap-narrow">
  <div style="padding:24px 0 0"><a class="label" href="/sites/${e(props.site.id)}">← ${e(props.site.title ?? hostOf(props.site.canonical_url))}</a></div>
  <section style="padding:22px 0 26px;border-bottom:1px solid rgba(255,255,255,.09)">
    <div class="label">ARCHIVED SNAPSHOT</div>
    <h1 style="margin:14px 0 0;font-size:30px;letter-spacing:-.04em;font-weight:800">${e(props.site.title ?? hostOf(props.site.canonical_url))}</h1>
    <div class="mono" style="font-size:11px;color:#93A0B0;margin-top:9px;word-break:break-all">${e(snapshot.final_url ?? props.site.canonical_url)}</div>
  </section>

  ${
    props.verification
      ? `<div class="notice" style="margin-top:20px;${props.verification.ok ? `border-color:rgba(63,191,127,.35);background:rgba(63,191,127,.08);color:#8FE3B6` : `border-color:rgba(242,84,91,.35);background:rgba(242,84,91,.08);color:#FF9BA0`}">
      ${props.verification.ok ? '✓ Verified' : '✗ Verification failed'} — the stored bytes ${props.verification.ok ? 'hash to' : 'do not hash to'} the recorded content address.
      <div class="mono" style="font-size:10px;margin-top:8px;word-break:break-all">expected ${e(props.verification.expected)}<br>actual&nbsp;&nbsp; ${e(props.verification.actual)}</div>
    </div>`
      : ''
  }

  <section class="panel" style="margin:24px 0 0;overflow:hidden">
    <div class="proof">
      ${facts.map((fact) => `<div><div class="label">${e(fact.label)}</div><div class="v">${e(fact.value)}</div></div>`).join('')}
    </div>
    <div style="padding:16px 20px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="/snapshots/${e(snapshot.id)}/raw">View sanitized HTML</a>
      <a class="btn btn-ghost btn-sm" href="/snapshots/${e(snapshot.id)}/text">Plain text</a>
      <a class="btn btn-ghost btn-sm" href="/snapshots/${e(snapshot.id)}/verify">Re-verify hash</a>
      <a class="btn btn-ghost btn-sm" href="/api/snapshots/${e(snapshot.id)}/artifact.car">Download CAR</a>
      ${props.gatewayUrl ? `<a class="btn btn-ghost btn-sm" href="${e(props.gatewayUrl)}" target="_blank" rel="nofollow noopener">IPFS gateway</a>` : ''}
    </div>
  </section>

  <section style="margin-top:24px">
    <div class="label" style="margin-bottom:12px">ARTIFACT CONTENTS</div>
    <div class="rowlist">
      ${
        props.artifact.length
          ? props.artifact
              .map(
                (file) => `<div class="ledger">
        <span style="flex:0 0 150px"><a href="/snapshots/${e(snapshot.id)}/file/${e(file.name)}">${e(file.name)}</a></span>
        <span style="flex:1 1 200px;min-width:0;color:#93A0B0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e(file.cid)}</span>
        <span style="flex:0 0 80px;color:#93A0B0">${file.size.toLocaleString()} B</span>
      </div>`,
              )
              .join('')
          : '<div class="empty">Artifact manifest unavailable for this snapshot.</div>'
      }
    </div>
    <div style="font-size:11.5px;color:#93A0B0;margin-top:12px;line-height:1.55">
      The database records that this URL was observed at this time. The artifact records the exact bytes. Availability is provided by the replicas listed above — content addressing guarantees integrity, not permanence.
    </div>
  </section>

  <section style="margin-top:28px">
    <div class="label" style="margin-bottom:12px">EXTRACTED TEXT · FIRST 4,000 CHARACTERS</div>
    <pre class="panel panel-pad mono" style="font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:${COLORS.muted};margin:0">${e(props.textPreview)}</pre>
  </section>
</div>`;

  return layout({
    title: `Snapshot ${snapshot.cid ? snapshot.cid.slice(0, 14) : snapshot.id}`,
    description: `Archived capture of ${props.site.canonical_url} from ${stampShort(snapshot.captured_at)}.`,
    path: `/snapshots/${snapshot.id}`,
    baseUrl: props.baseUrl,
    narrow: true,
    body,
  });
}
