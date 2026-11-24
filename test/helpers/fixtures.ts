import { Repo } from '../../src/db/repo';
import type { ChangeEvent, MonitoredSite } from '../../src/types';
import type { FakeD1 } from './env';

let counter = 0;

export async function addSite(repo: Repo, overrides: Partial<{ url: string; title: string | null; category: string }> = {}): Promise<MonitoredSite> {
  const url = overrides.url ?? `https://example.com/pricing-${++counter}`;
  return repo.createSite({
    url,
    canonicalUrl: url,
    host: new URL(url).host,
    title: overrides.title === undefined ? 'Example Pricing' : overrides.title,
    category: overrides.category ?? 'Pricing',
    crawlIntervalS: 21600,
    priority: 'NORMAL',
  });
}

export async function addChange(
  db: FakeD1,
  repo: Repo,
  site: MonitoredSite,
  overrides: Partial<ChangeEvent> = {},
): Promise<ChangeEvent> {
  const snapshotId = `snap_${++counter}`;
  db.rows(`INSERT INTO snapshots (id, site_id, captured_at, content_hash, created_at) VALUES (?, ?, 1, 'h', 1)`, snapshotId, site.id);
  return repo.createChange({
    site_id: site.id, previous_snapshot_id: null, current_snapshot_id: snapshotId,
    detected_at: Math.floor(Date.now() / 1000), change_type: 'PRICE', severity: 'SIGNIFICANT',
    change_score: 60, interestingness_score: 60, headline: 'Pro plan went from $19 to $24',
    summary: 'The Pro plan costs more.', label: 'Pro', before_value: '$19', after_value: '$24', delta: '+26.3%',
    delta_note: null, diff: '{}', signals: '[]', suppressed: '{}', ai_model: null, ai_analysis: null,
    published: 1, false_positive: 0, ...overrides,
  } as never);
}
