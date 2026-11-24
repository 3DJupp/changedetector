import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { Repo } from '../src/db/repo';
import { deliverPending } from '../src/pipeline/notify';
import { webhookBody, webhookKind, type ChangeEventPayload } from '../src/pipeline/webhooks';
import { pingIndexNow } from '../src/lib/indexnow';
import { badgeSvg } from '../src/ui/embed';
import { executionCtx, testEnv } from './helpers/env';
import { addChange, addSite } from './helpers/fixtures';

type Call = { url: string; body: string; headers: Headers };

let env: ReturnType<typeof testEnv>;
let repo: Repo;
let calls: Call[];

/** Public names resolve to a public address; anything under .internal to a private one. */
function stubNetwork() {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    if (parsed.hostname === 'cloudflare-dns.com') {
      const name = parsed.searchParams.get('name') ?? '';
      const type = parsed.searchParams.get('type');
      if (type !== 'A') return Response.json({ Answer: [] });
      return Response.json({ Answer: [{ type: 1, data: name.endsWith('.internal') ? '10.0.0.7' : '93.184.216.34' }] });
    }
    calls.push({ url, body: String(init?.body ?? ''), headers: new Headers(init?.headers) });
    if (parsed.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (parsed.hostname === 'api.resend.com') return Response.json({ id: 'x' });
    return new Response('ok', { status: 200 });
  });
}

beforeEach(() => {
  env = testEnv({ RESEND_API_KEY: 're_test' });
  repo = new Repo(env.DB as unknown as D1Database);
  stubNetwork();
});

afterEach(() => vi.unstubAllGlobals());

function request(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://changes.example${path}`, { redirect: 'manual', ...init }), env, executionCtx);
}

function form(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const admin = { authorization: 'Bearer test-admin' };

describe('suggestions', () => {
  it('records a suggestion and counts repeat suggestions as votes', async () => {
    const first = await form('/suggest', { url: 'https://example.net/terms?utm_source=x', category: 'Companies', reason: 'ToS changes a lot' });
    expect(first.status).toBe(202);
    expect(await first.text()).toContain('Suggestion received');
    const second = await form('/suggest', { url: 'https://example.net/terms' });
    expect(await second.text()).toContain('Already suggested');
    const [row] = await repo.pendingSuggestions();
    expect(row.canonical_url).toBe('https://example.net/terms');
    expect(row.votes).toBe(2);
  });

  it('refuses private targets and points to pages that are already monitored', async () => {
    const internal = await form('/suggest', { url: 'https://wiki.corp.internal/secret' });
    expect(internal.status).toBe(400);
    expect(await internal.text()).toContain('cannot be monitored');
    const site = await addSite(repo, { url: 'https://example.com/pricing', title: 'Example Pricing' });
    const known = await form('/suggest', { url: 'https://example.com/pricing/' });
    expect(await known.text()).toContain(`/sites/${site.slug}`);
    expect(await repo.pendingSuggestions()).toHaveLength(0);
  });

  it('silently drops bot submissions that fill the honeypot', async () => {
    await form('/suggest', { url: 'https://example.org/a', website: 'spam' });
    expect(await repo.pendingSuggestions()).toHaveLength(0);
  });

  it('rate-limits suggestions per client', async () => {
    for (let i = 0; i < 10; i++) await form('/suggest', { url: `https://example.org/p${i}` }, { 'cf-connecting-ip': '198.51.100.1' });
    const blocked = await form('/suggest', { url: 'https://example.org/p11' }, { 'cf-connecting-ip': '198.51.100.1' });
    expect(blocked.status).toBe(429);
    const other = await form('/suggest', { url: 'https://example.org/p12' }, { 'cf-connecting-ip': '198.51.100.2' });
    expect(other.status).toBe(202);
  });

  it('lets an admin approve or reject, and only an admin', async () => {
    await form('/suggest', { url: 'https://example.org/pricing', category: 'Pricing' });
    await form('/suggest', { url: 'https://example.org/blog' });
    const [first, second] = await repo.pendingSuggestions();

    expect((await form(`/admin/suggestions/${first.id}/approve`, { category: 'Pricing' })).headers.get('location')).toContain('error=');
    expect(await repo.getSiteByCanonical('https://example.org/pricing')).toBeNull();

    await form(`/admin/suggestions/${first.id}/approve`, { category: 'Pricing', interval: '6h' }, admin);
    const site = await repo.getSiteByCanonical('https://example.org/pricing');
    expect(site?.category).toBe('Pricing');
    expect((await repo.getSuggestion(first.id))?.status).toBe('APPROVED');

    await form(`/admin/suggestions/${second.id}/reject`, {}, admin);
    expect((await repo.getSuggestion(second.id))?.status).toBe('REJECTED');
    expect(await (await form('/suggest', { url: 'https://example.org/blog' })).text()).toContain('Reviewed before');
  });

  it('shows pending suggestions in the console only to admins', async () => {
    await form('/suggest', { url: 'https://example.org/pricing', reason: 'watch <this>' });
    expect(await (await request('/admin')).text()).not.toContain('SUGGESTED BY VISITORS');
    const page = await (await request('/admin', { headers: admin })).text();
    expect(page).toContain('SUGGESTED BY VISITORS');
    expect(page).toContain('watch &lt;this&gt;');
  });
});

describe('webhooks', () => {
  async function subscribe(webhook: string, accept = 'application/json') {
    const site = await addSite(repo, { title: 'Northbeam' });
    const response = await form('/api/subscriptions', { email: 'ops@example.com', siteId: site.id, webhook }, { accept });
    return { site, response };
  }

  async function confirmAndDeliver(site: Awaited<ReturnType<typeof addSite>>) {
    const mail = calls.find((call) => call.url === 'https://api.resend.com/emails')!;
    const token = /confirm\?token=([0-9a-f]+)/.exec(JSON.parse(mail.body).html)![1];
    await form('/confirm', { token });
    const change = await addChange(env.DB, repo, site, { interestingness_score: 70 });
    for (const subscriber of await repo.subscribersFor(site.id, site.category, 70)) {
      await repo.queueNotification(subscriber.user_id, change.id, subscriber.channel, subscriber.channel === 'WEBHOOK' ? subscriber.target : null);
    }
    calls = [];
    return { change, result: await deliverPending(env, repo) };
  }

  it('delivers a formatted Slack message after the owner confirms', async () => {
    const { site, response } = await subscribe('https://hooks.slack.com/services/T000/B000/XXXX');
    expect(response.status).toBe(202);
    const { result } = await confirmAndDeliver(site);
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(calls[0].url).toBe('https://hooks.slack.com/services/T000/B000/XXXX');
    const body = JSON.parse(calls[0].body);
    expect(body.text).toContain('Pro plan went from $19 to $24');
    expect(body.text).toContain('$19 → $24 (+26.3%)');
  });

  it('sends nothing before confirmation', async () => {
    const { site } = await subscribe('https://hooks.slack.com/services/T000/B000/XXXX');
    expect(await repo.subscribersFor(site.id, site.category, 99)).toHaveLength(0);
  });

  it('rejects plain http and private targets', async () => {
    const plain = await subscribe('http://example.com/hook');
    expect(plain.response.status).toBe(400);
    const internal = await form('/api/subscriptions', { email: 'a@example.com', siteId: plain.site.id, webhook: 'https://hooks.corp.internal/x' }, { accept: 'application/json' });
    expect(internal.status).toBe(400);
    expect(env.DB.rows(`SELECT * FROM subscriptions`)).toHaveLength(0);
  });

  it('formats Discord and generic payloads', () => {
    const event: ChangeEventPayload = {
      id: 'chg_1', url: 'https://changes.example/changes/1-x', headline: '@everyone price up', summary: 'More.',
      severity: 'MAJOR', score: 90, before: '$1', after: '$2', delta: '+100%', detectedAt: '2026-11-24T00:00:00.000Z',
      site: { title: 'X', url: 'https://x.example', category: 'Pricing' },
    };
    expect(webhookKind('https://discord.com/api/webhooks/1/abc')).toBe('discord');
    expect(webhookKind('https://hooks.slack.com/services/a')).toBe('slack');
    expect(webhookKind('https://api.example.com/hook')).toBe('generic');
    const discord = webhookBody('discord', event) as { allowed_mentions: { parse: string[] }; embeds: { color: number }[] };
    expect(discord.allowed_mentions.parse).toEqual([]);
    expect(discord.embeds[0].color).toBe(0xc6332f);
    expect(webhookBody('generic', event)).toEqual({ type: 'change.detected', version: 1, change: event });
  });

  it('lists webhooks on the unsubscribe page by host only', async () => {
    const { site } = await subscribe('https://hooks.slack.com/services/T000/B000/SECRET');
    const mail = calls.find((call) => call.url === 'https://api.resend.com/emails')!;
    const token = /confirm\?token=([0-9a-f]+)/.exec(JSON.parse(mail.body).html)![1];
    const page = await (await request(`/unsubscribe?token=${token}`)).text();
    expect(page).toContain('webhook at hooks.slack.com');
    expect(page).not.toContain('SECRET');
    expect(site).toBeTruthy();
  });
});

describe('embeds and badges', () => {
  it('serves a frameable card while normal pages refuse framing', async () => {
    const site = await addSite(repo);
    const change = await addChange(env.DB, repo, site);
    const embed = await request(`/changes/${change.slug}/embed`);
    expect(embed.status).toBe(200);
    expect(embed.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(embed.headers.get('x-frame-options')).toBeNull();
    expect(await embed.text()).toContain('Pro plan went from $19 to $24');

    const pageResponse = await request('/');
    expect(pageResponse.headers.get('x-frame-options')).toBe('DENY');

    const hidden = await addChange(env.DB, repo, site, { published: 0 });
    expect((await request(`/changes/${hidden.slug}/embed`)).status).toBe(404);
  });

  it('renders a badge for a site', async () => {
    const site = await addSite(repo, { title: 'Northbeam' });
    const response = await request(`/sites/${site.slug}/badge.svg`);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(await response.text()).toContain('none yet');
    const changed = badgeSvg({ ...site, last_changed_at: 1000 }, 1000 + 3600);
    expect(changed).toContain('#C6332F');
  });
});

describe('IndexNow', () => {
  it('serves the key file and pings only for public hosts', async () => {
    env = testEnv({ INDEXNOW_KEY: 'abc123def456' });
    expect(await (await request('/abc123def456.txt')).text()).toBe('abc123def456');
    expect((await request('/wrong.txt')).status).toBe(404);

    expect(await pingIndexNow(env, ['https://changes.example/changes/1-x'])).toBe(200);
    const ping = calls.find((call) => call.url === 'https://api.indexnow.org/indexnow')!;
    expect(JSON.parse(ping.body)).toEqual({
      host: 'changes.example',
      key: 'abc123def456',
      keyLocation: 'https://changes.example/abc123def456.txt',
      urlList: ['https://changes.example/changes/1-x'],
    });

    calls = [];
    const local = testEnv({ INDEXNOW_KEY: 'abc123def456', PUBLIC_BASE_URL: 'http://localhost:8787' });
    expect(await pingIndexNow(local, ['http://localhost:8787/x'])).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
