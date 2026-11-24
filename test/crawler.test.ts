import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from '../src/lib/robots';
import { computeBackoffSeconds, parseRetryAfter } from '../src/lib/fetcher';
import { decodeBody } from '../src/pipeline/crawl';
import { extractPrices, diffPrices, formatMoney } from '../src/lib/price';
import { sanitizeArchivedHtml } from '../src/lib/sanitize';

const UA = 'ChangeDetectorBot/1.0';

describe('robots.txt', () => {
  const robots = parseRobots(`
# comment
User-agent: *
Disallow: /admin
Disallow: /private/
Allow: /private/public-page
Crawl-delay: 5

User-agent: ChangeDetectorBot
Disallow: /nope

Sitemap: https://example.com/sitemap.xml
`);

  it('parses groups, rules, crawl delay and sitemaps', () => {
    expect(robots.groups).toHaveLength(2);
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(robots.groups[0].crawlDelay).toBe(5);
  });

  it('prefers the most specific matching user-agent group', () => {
    expect(isAllowed(robots, UA, '/nope').allowed).toBe(false);
    // Our own group has no /admin rule, so /admin is allowed for us.
    expect(isAllowed(robots, UA, '/admin').allowed).toBe(true);
    expect(isAllowed(robots, 'SomeOtherBot', '/admin').allowed).toBe(false);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    expect(isAllowed(robots, 'SomeOtherBot', '/private/secret').allowed).toBe(false);
    expect(isAllowed(robots, 'SomeOtherBot', '/private/public-page').allowed).toBe(true);
  });

  it('supports wildcard and end-anchor patterns', () => {
    const wild = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?*');
    expect(isAllowed(wild, UA, '/docs/file.pdf').allowed).toBe(false);
    expect(isAllowed(wild, UA, '/docs/file.pdf.html').allowed).toBe(true);
    expect(isAllowed(wild, UA, '/search?q=x').allowed).toBe(false);
  });

  it('treats an empty Disallow as allow-all', () => {
    const permissive = parseRobots('User-agent: *\nDisallow:');
    expect(isAllowed(permissive, UA, '/anything').allowed).toBe(true);
  });

  it('fails open on an empty robots.txt', () => {
    expect(isAllowed(parseRobots(''), UA, '/x').allowed).toBe(true);
  });
});

describe('backoff', () => {
  it('grows exponentially and stays within the cap', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const delay = computeBackoffSeconds(attempt, 60, 21600);
      expect(delay).toBeGreaterThanOrEqual(60);
      expect(delay).toBeLessThanOrEqual(21600);
    }
    const early = Array.from({ length: 40 }, () => computeBackoffSeconds(1, 60));
    const later = Array.from({ length: 40 }, () => computeBackoffSeconds(6, 60));
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean(later)).toBeGreaterThan(mean(early));
  });

  it('honours Retry-After in both seconds and HTTP-date form', () => {
    expect(parseRetryAfter('120')).toBe(120);
    const now = Date.parse('2026-09-09T18:00:00Z');
    expect(parseRetryAfter('Wed, 09 Sep 2026 18:05:00 GMT', now)).toBe(300);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('nonsense')).toBeNull();
    expect(parseRetryAfter('999999')).toBe(86400);
  });
});

describe('charset decoding', () => {
  it('honours the Content-Type charset', () => {
    const latin1 = new Uint8Array([0x50, 0x72, 0xe9, 0x6d, 0x69, 0x75, 0x6d]); // "Prémium"
    expect(decodeBody(latin1, 'text/html; charset=iso-8859-1')).toBe('Prémium');
  });

  it('falls back to the meta charset, then to UTF-8', () => {
    const html = new TextEncoder().encode('<meta charset="utf-8"><p>café</p>');
    expect(decodeBody(html, 'text/html')).toContain('café');
  });
});

describe('price extraction', () => {
  it('reads symbols, codes and periods', () => {
    const prices = extractPrices('Pro $19/month · Team USD 49 per user · Enterprise 1.200,50 EUR');
    expect(prices[0]).toMatchObject({ currency: 'USD', amount: 19, period: 'monthly' });
    expect(prices[1]).toMatchObject({ currency: 'USD', amount: 49, period: 'per-seat' });
    expect(prices[2]).toMatchObject({ currency: 'EUR', amount: 1200.5 });
  });

  it('pairs before/after prices and computes the percentage', () => {
    const before = extractPrices('Pro $19 / month', [{ index: 0, text: 'Pro' }]);
    const after = extractPrices('Pro $24 / month', [{ index: 0, text: 'Pro' }]);
    const changes = diffPrices(before, after);
    expect(changes[0]).toMatchObject({ before: 19, after: 24, percent: 26.3, direction: 'up' });
  });

  it('reports no change when prices are stable', () => {
    const same = extractPrices('Pro $19 / month');
    expect(diffPrices(same, same)).toHaveLength(0);
  });

  it('formats money back with the right symbol', () => {
    expect(formatMoney('USD', 19)).toBe('$19');
    expect(formatMoney('EUR', 24.5)).toBe('€24.50');
    expect(formatMoney('SEK', 99)).toBe('99 SEK');
  });
});

describe('archived HTML sanitizer', () => {
  it('removes scripts, handlers and javascript: URLs', () => {
    const dirty = `<div onclick="steal()"><script>alert(1)</script>
      <a href="javascript:alert(2)">click</a>
      <a href="https://example.com/ok">ok</a>
      <img src="x" onerror="alert(3)">
      <iframe src="https://evil.example"></iframe>
      <p>kept</p></div>`;
    const clean = sanitizeArchivedHtml(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onclick|onerror/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).not.toMatch(/<iframe/i);
    expect(clean).toContain('kept');
    expect(clean).toContain('https://example.com/ok');
    expect(clean).toContain('rel="nofollow noopener noreferrer"');
  });

  it('escapes text so injected markup cannot re-enter', () => {
    const clean = sanitizeArchivedHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(clean).toContain('&lt;script&gt;');
    expect(clean).not.toMatch(/<script/i);
  });

  it('drops forms and inputs so archived pages cannot phish', () => {
    const clean = sanitizeArchivedHtml('<form action="https://evil"><input name="password"></form><p>x</p>');
    expect(clean).not.toMatch(/<form|<input/i);
  });
});
