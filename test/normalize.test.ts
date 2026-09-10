import { describe, expect, it } from 'vitest';
import { canonicalPayload, needsBrowserRendering, normalizeHtml, normalizePlainText, suppressNoise } from '../src/lib/normalize';
import { parseHtml, textOf } from '../src/lib/html';
import { sha256Hex } from '../src/lib/hash';

const BASE = 'https://example.com/pricing';

const page = (body: string, head = '') => `<!doctype html><html lang="en"><head><title>Example Pricing</title>${head}</head><body>${body}</body></html>`;

describe('html parser', () => {
  it('survives malformed markup', () => {
    const root = parseHtml('<div><p>unclosed<div>nested</div><span>x</p></div><br>');
    expect(textOf(root)).toContain('unclosed');
    expect(textOf(root)).toContain('nested');
  });

  it('decodes entities and ignores comments', () => {
    const root = parseHtml('<p>A&nbsp;&amp;&nbsp;B<!-- hidden --> &#36;19</p>');
    // &nbsp; decodes to U+00A0; collapsing happens later in the normalizer.
    const text = textOf(root).replace(/\u00a0/g, ' ');
    expect(text).toContain('A & B');
    expect(text).toContain('$19');
    expect(text).not.toContain('hidden');
  });

  it('does not leak script bodies into text', () => {
    const doc = normalizeHtml(page('<script>var secret = "leak";</script><p>Visible</p>'), BASE);
    expect(doc.text).toContain('Visible');
    expect(doc.text).not.toContain('leak');
  });
});

describe('noise suppression', () => {
  it('replaces timestamps, dates and hashes with stable tokens', () => {
    const counters: Record<string, number> = {};
    const out = suppressNoise('Updated 2026-09-09T18:42:00Z on September 9, 2026 build 9f2c41ab7e08d5136ca0be99f4d2718c', counters);
    expect(out).not.toMatch(/2026-09-09T18:42/);
    expect(out).toContain('⟨ts⟩');
    expect(out).toContain('⟨date⟩');
    expect(out).toContain('⟨hash⟩');
    expect(Object.keys(counters).length).toBeGreaterThan(1);
  });

  it('normalizes relative times', () => {
    const counters: Record<string, number> = {};
    expect(suppressNoise('posted 3 hours ago', counters)).toBe('posted ⟨ago⟩');
  });
});

describe('normalizeHtml', () => {
  it('extracts headings, links, images and metadata', () => {
    const doc = normalizeHtml(
      page(
        `<h1>Pricing</h1><h2>Pro</h2><p>$19 / month</p>
         <a href="/signup?utm_source=nav">Sign up</a><img src="/logo.png" alt="Logo">`,
        '<meta name="description" content="Plans and pricing">',
      ),
      BASE,
    );
    expect(doc.title).toBe('Example Pricing');
    expect(doc.headings.map((h) => h.text)).toEqual(['Pricing', 'Pro']);
    expect(doc.meta.description).toBe('Plans and pricing');
    expect(doc.links[0].href).toBe('https://example.com/signup');
    expect(doc.images[0]).toEqual({ src: 'https://example.com/logo.png', alt: 'Logo' });
    expect(doc.prices[0]).toMatchObject({ currency: 'USD', amount: 19, period: 'monthly' });
  });

  it('drops cookie banners, chat widgets and hidden decoration', () => {
    const doc = normalizeHtml(
      page(`<div class="cookie-consent">We use cookies</div>
            <div id="intercom-container">Chat with us</div>
            <div aria-hidden="true">decorative</div>
            <div class="promo-carousel">Rotating offer 4 of 9</div>
            <p>Real content</p>`),
      BASE,
    );
    expect(doc.text).toBe('Real content');
    expect(doc.suppressed['Cookie notices']).toBe(1);
    expect(doc.suppressed['Chat widgets']).toBe(1);
    expect(doc.suppressed['Rotating content']).toBe(1);
  });

  it('excludes navigation and footer chrome from the main signal', () => {
    const doc = normalizeHtml(page('<nav><a href="/x">Home</a></nav><p>Body</p><footer>© 2026 Example</footer>'), BASE);
    expect(doc.text).toBe('Body');
  });

  it('gives the same hash when only noise changed', async () => {
    const first = normalizeHtml(
      page(`<p>Pro — $19 / month</p><span class="timestamp">Updated 2026-09-09T06:12:00Z</span>
            <div class="cookie-banner">Accept cookies</div><div class="css-1a2b3c4">styled</div>`),
      BASE,
    );
    const second = normalizeHtml(
      page(`<p>Pro — $19 / month</p><span class="timestamp">Updated 2026-09-09T18:42:00Z</span>
            <div class="cookie-banner">Accept all cookies now</div><div class="css-9z8y7x6">styled</div>`),
      BASE,
    );
    expect(await sha256Hex(canonicalPayload(first))).toBe(await sha256Hex(canonicalPayload(second)));
  });

  it('gives a different hash when a price changed', async () => {
    const before = normalizeHtml(page('<h2>Pro</h2><p>$19 / month</p>'), BASE);
    const after = normalizeHtml(page('<h2>Pro</h2><p>$24 / month</p>'), BASE);
    expect(await sha256Hex(canonicalPayload(before))).not.toBe(await sha256Hex(canonicalPayload(after)));
  });

  it('is deterministic for identical input', async () => {
    const html = page('<h1>Same</h1><p>Body text</p>');
    expect(canonicalPayload(normalizeHtml(html, BASE))).toBe(canonicalPayload(normalizeHtml(html, BASE)));
  });
});

describe('plain text and JSON', () => {
  it('normalizes text bodies line by line', () => {
    const doc = normalizePlainText('alpha\n\n  beta  \ngamma', 'text/plain');
    expect(doc.blocks).toEqual(['alpha', '  beta', 'gamma']);
  });
});

describe('browser fallback heuristic', () => {
  it('flags an empty SPA shell', () => {
    const html = '<html><body><div id="root"></div><script>window.__NEXT_DATA__={}</script></body></html>';
    const doc = normalizeHtml(html, BASE);
    expect(needsBrowserRendering(html, doc)).toBe(true);
  });

  it('does not flag a server-rendered page', () => {
    const html = page(`<div id="root"><p>${'Real server-rendered content. '.repeat(60)}</p></div>`);
    const doc = normalizeHtml(html, BASE);
    expect(needsBrowserRendering(html, doc)).toBe(false);
  });
});
