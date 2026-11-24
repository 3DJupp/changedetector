import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { Repo } from '../src/db/repo';
import { deliverPending } from '../src/pipeline/notify';
import { executionCtx, testEnv } from './helpers/env';

type Sent = { to: string[]; subject: string; html: string; headers: Record<string, string> };

let env: ReturnType<typeof testEnv>;
let repo: Repo;
let sent: Sent[];
let siteId: string;

function call(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://changes.example${path}`, init), env, executionCtx);
}

function post(path: string, form: Record<string, string>, accept = 'text/html') {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept },
    body: new URLSearchParams(form).toString(),
  });
}

function tokenFrom(mail: Sent): string {
  return /confirm\?token=([0-9a-f]+)/.exec(mail.html)![1];
}

beforeEach(async () => {
  env = testEnv({ RESEND_API_KEY: 're_test' });
  repo = new Repo(env.DB as unknown as D1Database);
  sent = [];
  vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.resend.com/emails') {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{"id":"x"}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const site = await repo.createSite({
    url: 'https://example.com/pricing',
    canonicalUrl: 'https://example.com/pricing',
    host: 'example.com',
    title: 'Example Pricing',
    category: 'Pricing',
    crawlIntervalS: 21600,
    priority: 'NORMAL',
  });
  siteId = site.id;
});

afterEach(() => vi.unstubAllGlobals());

async function addChange(score = 60) {
  const snapshot = env.DB.rows<{ id: string }>(
    `INSERT INTO snapshots (id, site_id, captured_at, content_hash, created_at) VALUES ('snap_1', ?, 1, 'h', 1) RETURNING id`,
    siteId,
  )[0];
  const change = await repo.createChange({
    site_id: siteId, previous_snapshot_id: null, current_snapshot_id: snapshot.id, detected_at: Math.floor(Date.now() / 1000),
    change_type: 'PRICE', severity: 'SIGNIFICANT', change_score: score, interestingness_score: score,
    headline: 'Pro plan went from $19 to $24', summary: 'The Pro plan costs more.', label: 'Pro', before_value: '$19',
    after_value: '$24', delta: '+26.3%', delta_note: null, diff: '{}', signals: '[]', suppressed: '{}', ai_model: null,
    ai_analysis: null, published: 1, false_positive: 0,
  } as never);
  return change;
}

describe('double opt-in', () => {
  it('sends a confirmation email and nothing else until the link is used', async () => {
    const response = await post('/api/subscriptions', { email: 'Reader@Example.com', siteId });
    expect(response.status).toBe(202);
    expect(await response.text()).toContain('Check your inbox');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['reader@example.com']);

    const change = await addChange();
    expect(await repo.subscribersFor(siteId, 'Pricing', change.interestingness_score)).toHaveLength(0);

    const token = tokenFrom(sent[0]);
    // A GET (mail scanners) must not confirm.
    const page = await call(`/confirm?token=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('noindex');
    expect(await repo.subscribersFor(siteId, 'Pricing', 60)).toHaveLength(0);

    const confirmed = await post('/confirm', { token });
    expect(await confirmed.text()).toContain('You are subscribed');
    expect(await repo.subscribersFor(siteId, 'Pricing', 60)).toHaveLength(1);
  });

  it('does not activate new subscriptions on an already confirmed address without a click', async () => {
    await post('/api/subscriptions', { email: 'a@example.com', siteId });
    await post('/confirm', { token: tokenFrom(sent[0]) });

    await post('/api/subscriptions', { email: 'a@example.com', category: 'Security' });
    expect(await repo.subscribersFor('other', 'Security', 90)).toHaveLength(0);
  });

  it('throttles confirmation emails per address', async () => {
    await post('/api/subscriptions', { email: 'b@example.com', siteId });
    await post('/api/subscriptions', { email: 'b@example.com', category: 'AI' });
    await post('/api/subscriptions', { email: 'b@example.com', digest: '1' });
    expect(sent).toHaveLength(1);
    // The one link confirms all three requests.
    await post('/confirm', { token: tokenFrom(sent[0]) });
    const user = env.DB.rows<{ digest_optin: number }>(`SELECT digest_optin FROM users`)[0];
    expect(user.digest_optin).toBe(1);
    expect(env.DB.rows(`SELECT * FROM subscriptions WHERE pending = 1`)).toHaveLength(0);
  });

  it('answers the same way for known and unknown addresses', async () => {
    const first = await post('/api/subscriptions', { email: 'c@example.com', siteId }, 'application/json');
    const second = await post('/api/subscriptions', { email: 'c@example.com', siteId }, 'application/json');
    expect(await first.json()).toEqual(await second.json());
  });

  it('rejects requests that subscribe to nothing', async () => {
    const response = await post('/api/subscriptions', { email: 'd@example.com' }, 'application/json');
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe('unsubscribe', () => {
  async function confirmedUser() {
    await post('/api/subscriptions', { email: 'e@example.com', siteId, digest: '1' });
    const token = tokenFrom(sent[0]);
    await post('/confirm', { token });
    return token;
  }

  it('shows what will be switched off and removes it on submit', async () => {
    const token = await confirmedUser();
    const page = await (await call(`/unsubscribe?token=${token}`)).text();
    expect(page).toContain('Daily digest');
    expect(page).toContain('Example Pricing');

    const done = await post('/unsubscribe', { token });
    expect(await done.text()).toContain('You will not hear from us again');
    expect(await repo.subscribersFor(siteId, 'Pricing', 100)).toHaveLength(0);
    expect(env.DB.rows<{ digest_optin: number }>(`SELECT digest_optin FROM users`)[0].digest_optin).toBe(0);
  });

  it('supports RFC 8058 one-click requests', async () => {
    const token = await confirmedUser();
    const response = await call(`/unsubscribe?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(response.status).toBe(200);
    expect(await repo.subscribersFor(siteId, 'Pricing', 100)).toHaveLength(0);
  });

  it('returns 404 for unknown tokens', async () => {
    expect((await call('/unsubscribe?token=0123456789abcdef0123')).status).toBe(404);
    expect((await call('/confirm?token=not-a-token')).status).toBe(404);
  });
});

describe('delivery', () => {
  it('sends alerts with one-click unsubscribe headers only to confirmed addresses', async () => {
    await post('/api/subscriptions', { email: 'f@example.com', siteId });
    await post('/confirm', { token: tokenFrom(sent[0]) });
    const change = await addChange(70);
    for (const subscriber of await repo.subscribersFor(siteId, 'Pricing', 70)) {
      await repo.queueNotification(subscriber.user_id, change.id, subscriber.channel);
    }
    sent = [];
    expect(await deliverPending(env, repo)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0].subject).toContain('Pro plan went from $19 to $24');
    expect(sent[0].headers['List-Unsubscribe']).toMatch(/^<https:\/\/changes\.example\/unsubscribe\?token=[0-9a-f]+>$/);
    expect(sent[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('queues the digest once per day and sends it', async () => {
    await post('/api/subscriptions', { email: 'g@example.com', digest: '1' });
    await post('/confirm', { token: tokenFrom(sent[0]) });
    const change = await addChange(80);
    await repo.saveDigest('2026-11-24', [change.id], 'One thing changed.', {});
    expect(await repo.queueDigestNotifications('2026-11-24')).toBe(1);
    expect(await repo.queueDigestNotifications('2026-11-24')).toBe(0);
    sent = [];
    expect(await deliverPending(env, repo)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0].subject).toContain('2026-11-24');
    expect(sent[0].html).toContain('Pro plan went from $19 to $24');
  });
});
