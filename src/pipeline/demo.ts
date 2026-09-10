/**
 * Local demo data.
 *
 * Runs the real pipeline — normalize, hash, artifact, diff, score, publish —
 * over bundled fixtures instead of a network fetch, so a fresh local install
 * has something to look at, and so the whole detection path can be exercised
 * without touching anyone else's website.
 */
import type { Env } from '../types';
import { Repo, now } from '../db/repo';
import { Capture, processCapture } from './crawl';
import { canonicalizeUrl } from '../lib/urlguard';

const encoder = new TextEncoder();

function capture(body: string, status = 200): Capture {
  const bytes = encoder.encode(body);
  return {
    status,
    contentType: 'text/html; charset=utf-8',
    body: bytes,
    finalUrl: 'https://demo.invalid/',
    headers: { 'content-type': 'text/html; charset=utf-8' },
    durationMs: 240,
    method: 'HTTP',
    bytes: bytes.length,
  };
}

const shell = (title: string, main: string) => `<!doctype html>
<html lang="en"><head><title>${title}</title>
<meta name="description" content="${title}">
<script>window.analytics=1</script>
</head><body>
<nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
<div class="cookie-consent">We use cookies. <button>Accept</button></div>
${main}
<footer>© 2026 Demo Inc · Page generated 2026-09-09T06:12:04Z · build 9f2c41ab7e08d5136ca0be99f4d2718c</footer>
</body></html>`;

interface Fixture {
  url: string;
  title: string;
  category: string;
  before: string;
  after: string;
  afterStatus?: number;
}

const FIXTURES: Fixture[] = [
  {
    url: 'https://demo.invalid/northbeam/pricing',
    title: 'Northbeam',
    category: 'Pricing',
    before: shell('Northbeam — Pricing', `<main><h1>Pricing</h1>
      <h2>Starter</h2><p>$0 / month</p><p>1 seat · 5 GB storage</p>
      <h2>Pro</h2><p>$19 / month</p><p>Includes 5 seats</p><p>50 GB storage</p><p class="promo">Save 20% with annual billing</p><p>Priority support</p>
      <h2>Team</h2><p>$49 / month</p><p>Unlimited seats</p></main>`),
    after: shell('Northbeam — Pricing', `<main><h1>Pricing</h1>
      <h2>Starter</h2><p>$0 / month</p><p>1 seat · 5 GB storage</p>
      <h2>Pro</h2><p>$24 / month</p><p>Includes 5 seats</p><p>50 GB storage</p><p class="promo">Annual billing available</p><p>Priority support</p>
      <h2>Team</h2><p>$59 / month</p><p>Unlimited seats</p>
      <h2>SSO add-on</h2><p>$99 / month</p></main>`),
  },
  {
    url: 'https://demo.invalid/postmark-labs/pricing',
    title: 'Postmark Labs',
    category: 'APIs',
    before: shell('Postmark Labs — API pricing', `<main><h1>API pricing</h1>
      <h2>Free tier</h2><p>10,000 requests per month included.</p><p>Overage billed at USD 0.50 per 1,000 requests.</p>
      <h2>Scale</h2><p>$99 / month</p></main>`),
    after: shell('Postmark Labs — API pricing', `<main><h1>API pricing</h1>
      <h2>Free tier</h2><p>2,000 requests per month included.</p><p>Overage billed at USD 0.50 per 1,000 requests.</p>
      <h2>Scale</h2><p>$99 / month</p></main>`),
  },
  {
    url: 'https://demo.invalid/fieldstone/legal/terms',
    title: 'Fieldstone Cloud',
    category: 'Companies',
    before: shell('Fieldstone Cloud — Terms of Service', `<main><h1>Terms of Service</h1>
      <h2>Data retention</h2><p>We retain customer log data for 30 days.</p>
      <h2>Governing law</h2><p>Disputes are resolved in the courts of Delaware.</p></main>`),
    after: shell('Fieldstone Cloud — Terms of Service', `<main><h1>Terms of Service</h1>
      <h2>Data retention</h2><p>We retain customer log data for 180 days.</p>
      <h2>Governing law</h2><p>Disputes are resolved in the courts of Delaware.</p>
      <h2>Arbitration</h2><p>You agree to binding arbitration and waive class action rights.</p></main>`),
  },
  {
    url: 'https://demo.invalid/orbital-sync/readme',
    title: 'orbital-sync',
    category: 'Open Source',
    before: shell('orbital-sync — README', `<main><h1>orbital-sync</h1>
      <p>Bidirectional sync for embedded devices.</p>
      <h2>Install</h2><p>npm install orbital-sync</p>
      <h2>Status</h2><p>Actively maintained.</p></main>`),
    after: shell('404 Not Found', '<main><h1>404</h1><p>This is not the web page you are looking for.</p></main>'),
    afterStatus: 404,
  },
  {
    url: 'https://demo.invalid/loomcraft/',
    title: 'Loomcraft',
    category: 'Products',
    before: shell('Loomcraft — Weave your workflows', `<main><h1>Weave your workflows</h1>
      <p>Loomcraft connects the tools your team already uses.</p><p><a href="/signup">Start free</a></p>
      <h2>Why teams switch</h2><p>Set up in minutes, not weeks.</p></main>`),
    after: shell('Loomcraft — Automation for serious teams', `<main><h1>Automation for serious teams</h1>
      <p>Loomcraft connects the tools your team already uses.</p><p><a href="/demo">Book a demo</a></p>
      <h2>Why teams switch</h2><p>Set up in minutes, not weeks.</p></main>`),
  },
];

export interface DemoResult {
  sites: number;
  changes: number;
  details: string[];
}

/**
 * Seed demo sites and run two captures over each, producing real change events
 * with real content addresses. Idempotent-ish: existing demo sites are reused.
 */
export async function seedDemo(env: Env, repo: Repo): Promise<DemoResult> {
  const details: string[] = [];
  let changes = 0;

  for (const fixture of FIXTURES) {
    const canonical = canonicalizeUrl(fixture.url);
    let site = await repo.getSiteByCanonical(canonical);
    if (!site) {
      const parsed = new URL(canonical);
      site = await repo.createSite({
        url: fixture.url,
        canonicalUrl: canonical,
        host: parsed.host,
        title: fixture.title,
        category: fixture.category,
        crawlIntervalS: 1800,
        priority: 'NORMAL',
      });
    }
    const first = await processCapture(env, repo, site, capture(fixture.before), now() - 43200);
    const refreshed = (await repo.getSite(site.id))!;
    const second = await processCapture(
      env,
      repo,
      refreshed,
      capture(fixture.after, fixture.afterStatus ?? 200),
      now() - Math.floor(Math.random() * 36000),
    );
    // Demo sites are fixtures, never fetched for real: park them afterwards so
    // the scheduler never tries to reach demo.invalid.
    await repo.updateSite(site.id, { status: 'PAUSED', next_check_at: now() + 315360000 });
    if (second.changeId) changes++;
    details.push(`${fixture.title}: ${first.outcome} → ${second.outcome}${second.changeId ? ` (${second.changeId})` : ''}`);
  }

  return { sites: FIXTURES.length, changes, details };
}
