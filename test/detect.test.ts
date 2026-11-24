import { describe, expect, it } from 'vitest';
import { buildDiffPayload, detectChange, severityFromScore, structuralDiff } from '../src/lib/detect';
import { normalizeHtml } from '../src/lib/normalize';

const URL_PRICING = 'https://example.com/pricing';
const page = (body: string, title = 'Example Pricing') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const doc = (body: string, title?: string) => normalizeHtml(page(body, title), URL_PRICING);

function detect(beforeBody: string, afterBody: string, options: Partial<Parameters<typeof detectChange>[0]> = {}) {
  return detectChange({
    siteTitle: 'Example',
    url: URL_PRICING,
    category: 'Pricing',
    previous: doc(beforeBody, options.previous ? undefined : undefined),
    current: doc(afterBody),
    previousStatus: 200,
    currentStatus: 200,
    ...options,
  });
}

describe('severity bands', () => {
  it('matches the documented thresholds', () => {
    expect(severityFromScore(5)).toBe('TRIVIAL');
    expect(severityFromScore(11)).toBe('MINOR');
    expect(severityFromScore(31)).toBe('MODERATE');
    expect(severityFromScore(61)).toBe('SIGNIFICANT');
    expect(severityFromScore(81)).toBe('MAJOR');
  });
});

describe('price changes', () => {
  const before = '<h2>Pro</h2><p>$19 / month</p><p>Includes 5 seats</p>';
  const after = '<h2>Pro</h2><p>$24 / month</p><p>Includes 5 seats</p>';

  it('classifies the change as PRICE and scores it highly', () => {
    const result = detect(before, after);
    expect(result.changed).toBe(true);
    expect(result.changeType).toBe('PRICE');
    expect(result.interestingness).toBeGreaterThanOrEqual(61);
    expect(['SIGNIFICANT', 'MAJOR']).toContain(result.severity);
  });

  it('extracts the before/after values and the percentage delta', () => {
    const result = detect(before, after);
    expect(result.beforeValue).toBe('$19');
    expect(result.afterValue).toBe('$24');
    expect(result.delta).toBe('+26.3%');
    expect(result.label).toBe('Pro');
    expect(result.headline).toContain('raised');
    expect(result.headline).toContain('$24');
  });

  it('detects price cuts too', () => {
    const result = detect('<h2>Team</h2><p>$100 / month</p>', '<h2>Team</h2><p>$80 / month</p>');
    expect(result.priceChanges[0]).toMatchObject({ before: 100, after: 80, direction: 'down' });
    expect(result.delta).toBe('-20.0%');
    expect(result.headline).toContain('cut');
  });
});

describe('page disappearance', () => {
  it('scores a 404 as a major event', () => {
    const result = detect('<p>Content</p>', '<p>Not found</p>', { currentStatus: 404 });
    expect(result.changeType).toBe('STATUS_CODE');
    expect(result.severity).toBe('MAJOR');
    expect(result.delta).toBe('GONE');
    expect(result.headline).toContain('disappeared');
    expect(result.signals.some((signal) => signal.name === 'Page disappeared')).toBe(true);
  });

  it('recognises recovery', () => {
    const result = detect('<p>gone</p>', '<p>Content</p>', { previousStatus: 404, currentStatus: 200 });
    expect(result.delta).toBe('BACK');
    expect(result.headline).toContain('back online');
  });
});

describe('structural changes', () => {
  it('reports an added section', () => {
    const result = detect('<h2>Overview</h2><p>Text</p>', '<h2>Overview</h2><p>Text</p><h2>Authentication</h2><p>New</p>');
    expect(result.structural.headingsAdded).toContain('Authentication');
    expect(result.headline).toContain('Authentication');
    expect(result.changeType).toBe('STRUCTURE');
  });

  it('reports a removed section', () => {
    const result = detect('<h2>Overview</h2><p>a</p><h2>Legacy</h2><p>b</p>', '<h2>Overview</h2><p>a</p>');
    expect(result.structural.headingsRemoved).toContain('Legacy');
    expect(result.headline).toContain('removed');
  });

  it('reports a title change', () => {
    const result = detectChange({
      siteTitle: 'Example',
      url: URL_PRICING,
      category: 'Pricing',
      previous: doc('<p>same</p>', 'Old Title'),
      current: doc('<p>same</p>', 'New Title'),
      previousStatus: 200,
      currentStatus: 200,
    });
    expect(result.changeType).toBe('TITLE');
    expect(result.structural.titleChanged).toEqual({ before: 'Old Title', after: 'New Title' });
  });
});

describe('false positive suppression', () => {
  it('does not raise a change when only suppressed noise moved', () => {
    const result = detect(
      '<p>Stable copy</p><span>Updated 2026-09-09T06:12:00Z</span>',
      '<p>Stable copy</p><span>Updated 2026-09-09T18:42:00Z</span>',
    );
    expect(result.changed).toBe(false);
    expect(result.interestingness).toBeLessThanOrEqual(10);
  });

  it('scores a tiny cosmetic edit on a big page below the publication threshold', () => {
    const filler = Array.from({ length: 300 }, (_, i) => `<p>Paragraph number ${i} with stable wording.</p>`).join('');
    const result = detect(`${filler}<p>Read our blog</p>`, `${filler}<p>Read the blog</p>`);
    expect(result.interestingness).toBeLessThan(25);
    expect(result.severity === 'TRIVIAL' || result.severity === 'MINOR').toBe(true);
  });

  it('scores an identical page as unchanged', () => {
    const result = detect('<p>Nothing moved</p>', '<p>Nothing moved</p>');
    expect(result.changed).toBe(false);
    expect(result.interestingness).toBe(0);
  });

  it('treats the very first capture as a non-event', () => {
    const result = detectChange({
      siteTitle: 'Example',
      url: URL_PRICING,
      category: 'Pricing',
      previous: null,
      current: doc('<p>First</p>'),
      previousStatus: null,
      currentStatus: 200,
    });
    expect(result.changed).toBe(false);
    expect(result.summary).toContain('First snapshot');
  });
});

describe('high-signal keywords', () => {
  it('lifts the score when terms like "deprecated" appear', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `<p>Stable line ${i}</p>`).join('');
    const quiet = detect(`${filler}<p>The endpoint is supported.</p>`, `${filler}<p>The endpoint is available.</p>`);
    const loud = detect(`${filler}<p>The endpoint is supported.</p>`, `${filler}<p>The endpoint is deprecated and will sunset.</p>`);
    expect(loud.interestingness).toBeGreaterThan(quiet.interestingness);
    expect(loud.keywords).toContain('deprecated');
  });

  it('lifts the score on terms and privacy pages', () => {
    const result = detectChange({
      siteTitle: 'Example',
      url: 'https://example.com/legal/terms',
      category: 'Companies',
      previous: doc('<p>We keep data for 30 days.</p>'),
      current: doc('<p>We keep data for 180 days. Disputes go to arbitration.</p>'),
      previousStatus: 200,
      currentStatus: 200,
    });
    expect(result.signals.some((signal) => signal.name === 'Legal / terms page')).toBe(true);
  });
});

describe('structuralDiff', () => {
  it('separates changed headings from added and removed ones', () => {
    const result = structuralDiff(doc('<h2>Alpha</h2><p>x</p>'), doc('<h2>Alpha renamed</h2><p>x</p>'));
    expect(result.headingsChanged).toEqual([{ before: 'Alpha', after: 'Alpha renamed' }]);
    expect(result.headingsAdded).toHaveLength(0);
    expect(result.headingsRemoved).toHaveLength(0);
  });
});

describe('diff payload', () => {
  it('is compact, JSON-serializable and marked when truncated', () => {
    const before = Array.from({ length: 900 }, (_, i) => `<p>row ${i}</p>`).join('');
    const after = Array.from({ length: 900 }, (_, i) => `<p>row ${i} edited</p>`).join('');
    const payload = buildDiffPayload(detect(before, after), 100);
    expect(payload.truncated).toBe(true);
    const rows = payload.hunks.reduce((total, hunk) => total + hunk.rows.length, 0);
    expect(rows).toBeLessThanOrEqual(100);
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});
