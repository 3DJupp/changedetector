import { describe, expect, it } from 'vitest';
import { canonicalPayload, normalizeHtml } from '../src/lib/normalize';
import { parseNormalized } from '../src/pipeline/crawl';
import { detectChange } from '../src/lib/detect';
import { sha256Hex } from '../src/lib/hash';
import { encodeDirectory, writeCar } from '../src/lib/cid';
import { cardText, renderCardPng, renderCardSvg } from '../src/ui/og';
import { encodeIndexedPng, Canvas } from '../src/lib/png';

const URL = 'https://example.com/pricing';
const page = (body: string) => `<!doctype html><html><head><title>Example Pricing</title></head><body>${body}</body></html>`;

const BEFORE = page(`
  <h1>Pricing</h1>
  <div class="cookie-consent">We use cookies</div>
  <h2>Pro</h2><p>$19 / month</p><p>Includes 5 seats</p><p>50 GB storage</p>
  <h2>Team</h2><p>$49 / month</p>
  <footer>© 2025 Example · Updated 2026-09-09T06:12:00Z</footer>`);

const AFTER = page(`
  <h1>Pricing</h1>
  <div class="cookie-consent">We use cookies. Accept?</div>
  <h2>Pro</h2><p>$24 / month</p><p>Includes 5 seats</p><p>50 GB storage</p>
  <h2>Team</h2><p>$59 / month</p><h2>SSO add-on</h2><p>$99 / month</p>
  <footer>© 2026 Example · Updated 2026-09-09T18:42:00Z</footer>`);

describe('end-to-end detection over two captures', () => {
  it('stores a canonical payload that rehydrates into an equivalent document', () => {
    const original = normalizeHtml(BEFORE, URL);
    const rehydrated = parseNormalized(canonicalPayload(original));
    expect(rehydrated).not.toBeNull();
    expect(rehydrated!.blocks).toEqual(original.blocks);
    expect(rehydrated!.title).toBe(original.title);
    expect(rehydrated!.headings.map((h) => h.text)).toEqual(original.headings.map((h) => h.text));
    // Prices must survive the round trip, or price diffing silently stops working.
    expect(rehydrated!.prices.map((p) => p.amount)).toEqual(original.prices.map((p) => p.amount));
    expect(rehydrated!.prices.map((p) => p.label)).toEqual(original.prices.map((p) => p.label));
  });

  it('detects the same change from a rehydrated previous snapshot as from a live one', () => {
    const before = normalizeHtml(BEFORE, URL);
    const after = normalizeHtml(AFTER, URL);
    const rehydrated = parseNormalized(canonicalPayload(before))!;

    const live = detectChange({
      siteTitle: 'Example', url: URL, category: 'Pricing',
      previous: before, current: after, previousStatus: 200, currentStatus: 200,
    });
    const stored = detectChange({
      siteTitle: 'Example', url: URL, category: 'Pricing',
      previous: rehydrated, current: after, previousStatus: 200, currentStatus: 200,
    });

    expect(stored.changeType).toBe(live.changeType);
    expect(stored.delta).toBe(live.delta);
    expect(stored.beforeValue).toBe(live.beforeValue);
    expect(stored.afterValue).toBe(live.afterValue);
    expect(Math.abs(stored.interestingness - live.interestingness)).toBeLessThanOrEqual(2);
  });

  it('produces the expected public event for a pricing page edit', () => {
    const result = detectChange({
      siteTitle: 'Example', url: URL, category: 'Pricing',
      previous: normalizeHtml(BEFORE, URL), current: normalizeHtml(AFTER, URL),
      previousStatus: 200, currentStatus: 200,
    });
    expect(result.changed).toBe(true);
    expect(result.changeType).toBe('PRICE');
    expect(result.beforeValue).toBe('$19');
    expect(result.afterValue).toBe('$24');
    expect(result.severity).toBe('MAJOR');
    // The cookie banner and the copyright year must not appear in the diff.
    const touched = result.rows.filter((row) => row.kind !== 'same').map((row) => `${row.left ?? ''}${row.right ?? ''}`).join(' ');
    expect(touched.toLowerCase()).not.toContain('cookie');
    expect(touched).not.toContain('2025');
  });

  it('yields identical content hashes for two captures that differ only in noise', async () => {
    const first = normalizeHtml(BEFORE, URL);
    const noisy = normalizeHtml(BEFORE.replace('06:12:00Z', '23:59:00Z').replace('© 2025', '© 2027'), URL);
    expect(await sha256Hex(canonicalPayload(first))).toBe(await sha256Hex(canonicalPayload(noisy)));
  });
});

describe('snapshot artifact', () => {
  it('packs the four artifact files and exposes a CAR archive', async () => {
    const encoder = new TextEncoder();
    const doc = normalizeHtml(AFTER, URL);
    const dag = await encodeDirectory([
      { name: 'metadata.json', content: encoder.encode(JSON.stringify({ url: URL, httpStatus: 200 })) },
      { name: 'page.html', content: encoder.encode(AFTER) },
      { name: 'content.txt', content: encoder.encode(doc.text) },
      { name: 'normalized.json', content: encoder.encode(canonicalPayload(doc)) },
    ]);
    expect(dag.entries.map((entry) => entry.name)).toEqual(['content.txt', 'metadata.json', 'normalized.json', 'page.html']);
    expect(dag.cid).toMatch(/^bafybei/);
    const car = writeCar(dag.root, dag.blocks);
    expect(car.length).toBeGreaterThan(AFTER.length);
  });
});

describe('share card rendering', () => {
  const model = {
    headline: 'Example raised Pro pricing from $19 to $24',
    before: '$19',
    after: '$24',
    delta: '+26.3%',
    severity: 'MAJOR',
    detectedAt: 'Sep 9, 2026 18:42 UTC',
    url: 'change.detector/changes/8f21ac3d',
  };

  it('emits a valid 1200x630 PNG', async () => {
    const png = await renderCardPng(model);
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(new TextDecoder().decode(png.slice(12, 16))).toBe('IHDR');
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
    expect(png[24]).toBe(4); // bit depth
    expect(png[25]).toBe(3); // indexed colour
    expect(new TextDecoder().decode(png.slice(-8, -4))).toBe('IEND');
  });

  it('compresses the card to a size unfurlers accept', async () => {
    const png = await renderCardPng(model);
    expect(png.length).toBeLessThan(60_000);
  });

  it('draws umlauts as their base letters instead of "?"', () => {
    expect(cardText('Preisänderung für Größe')).toBe('Preisanderung fur Grosse');
    expect(cardText('“Pro” plan – now €24')).toBe('"Pro" plan – now €24');
  });

  it('renders cards without a severity or detection time', async () => {
    const png = await renderCardPng({ headline: 'Fieldstone Cloud', before: null, after: null, delta: '12 CHANGES', severity: null, footer: 'Monitored since 2026', url: 'x.example/sites/a' });
    expect(new TextDecoder().decode(png.slice(12, 16))).toBe('IHDR');
  });

  it('renders different bytes for different content', async () => {
    const a = await renderCardPng(model);
    const b = await renderCardPng({ ...model, headline: 'Something else entirely happened' });
    expect(a.length === b.length && a.every((byte, index) => byte === b[index])).toBe(false);
  });

  it('emits an SVG card with the headline and values', () => {
    const svg = renderCardSvg(model);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('$24');
    expect(svg).toContain('THE INTERNET CHANGE DETECTOR');
  });
});

describe('png encoder', () => {
  it('round-trips pixel data into a well-formed chunk stream', () => {
    const canvas = new Canvas(4, 2, 0);
    canvas.fillRect(0, 0, 2, 1, 1);
    const png = encodeIndexedPng({
      width: 4,
      height: 2,
      pixels: canvas.pixels,
      palette: [[0, 0, 0], [255, 255, 255]],
    });
    const text = new TextDecoder('latin1').decode(png);
    expect(text).toContain('IHDR');
    expect(text).toContain('PLTE');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');
  });

  it('rejects palettes larger than the 4-bit format allows', () => {
    expect(() =>
      encodeIndexedPng({
        width: 1,
        height: 1,
        pixels: new Uint8Array(1),
        palette: Array.from({ length: 17 }, () => [0, 0, 0] as [number, number, number]),
      }),
    ).toThrow();
  });
});
