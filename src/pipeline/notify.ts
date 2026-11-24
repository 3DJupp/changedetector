/**
 * Notifications: email (Resend) and webhooks, driven off a durable outbox so a
 * delivery failure never loses a change event.
 */
import type { Env } from '../types';
import { Repo } from '../db/repo';
import { escapeHtml } from '../lib/html';
import type { ChangeEvent } from '../types';

export async function queueForSubscribers(
  env: Env,
  repo: Repo,
  change: { id: string; interestingness_score: number },
  site: { id: string; category: string },
): Promise<number> {
  const subscribers = await repo.subscribersFor(site.id, site.category, change.interestingness_score);
  for (const subscriber of subscribers) {
    await repo.queueNotification(subscriber.user_id, change.id, subscriber.channel);
  }
  return subscribers.length;
}

interface PendingRow {
  id: string;
  user_id: string | null;
  change_id: string;
  channel: string;
  email: string | null;
  token: string | null;
  verified: number | null;
  payload: string | null;
  headline: string | null;
  summary: string | null;
  slug: string | null;
}

export async function deliverPending(env: Env, repo: Repo, limit = 25): Promise<{ sent: number; failed: number }> {
  const pending = (await repo.pendingNotifications(limit)) as unknown as PendingRow[];
  let sent = 0;
  let failed = 0;

  const digestCache = new Map<string, DigestEmail | null>();

  for (const row of pending) {
    try {
      if ((row.channel === 'EMAIL' || row.channel === 'DIGEST') && (!row.email || row.verified !== 1)) {
        await repo.markNotification(row.id, 'SKIPPED', row.email ? 'address not confirmed' : 'no email');
        continue;
      }
      if (row.channel === 'EMAIL') {
        if (!row.slug || !row.headline) {
          await repo.markNotification(row.id, 'SKIPPED', 'change no longer exists');
          continue;
        }
        await sendEmail(env, row.email!, `Change detected: ${row.headline}`, alertHtml(env, row), unsubscribeUrl(env, row.token));
      } else if (row.channel === 'DIGEST') {
        const day = row.payload ?? '';
        if (!digestCache.has(day)) digestCache.set(day, await loadDigestEmail(env, repo, day));
        const digest = digestCache.get(day);
        if (!digest || !digest.changes.length) {
          await repo.markNotification(row.id, 'SKIPPED', 'no digest content');
          continue;
        }
        await sendEmail(env, row.email!, `The Internet Changed Today · ${day}`, digestHtml(env, digest, row.token), unsubscribeUrl(env, row.token));
      } else if (row.channel === 'WEBHOOK') {
        await repo.markNotification(row.id, 'SKIPPED', 'webhook target missing');
        continue;
      } else {
        await repo.markNotification(row.id, 'SKIPPED', `unsupported channel ${row.channel}`);
        continue;
      }
      await repo.markNotification(row.id, 'SENT');
      sent++;
    } catch (error) {
      await repo.markNotification(row.id, 'PENDING', error instanceof Error ? error.message.slice(0, 200) : 'error');
      failed++;
    }
  }
  return { sent, failed };
}

function unsubscribeUrl(env: Env, token: string | null): string | undefined {
  return token ? `${env.PUBLIC_BASE_URL}/unsubscribe?token=${token}` : undefined;
}

export async function sendEmail(env: Env, to: string, subject: string, html: string, unsubscribe?: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error('email provider not configured');
  // RFC 8058 one-click unsubscribe: Gmail and Yahoo require it for bulk senders.
  const headers: Record<string, string> = unsubscribe
    ? { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : {};
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'digest@changedetector.app',
      to: [to],
      subject,
      html,
      headers,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`resend ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

function alertHtml(env: Env, row: PendingRow): string {
  const url = `${env.PUBLIC_BASE_URL}/changes/${row.slug}`;
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">
  <p style="font:600 11px/1 monospace;letter-spacing:.08em;color:#D63B42">CHANGE DETECTED</p>
  <h1 style="font-size:22px;line-height:1.2;margin:12px 0">${escapeHtml(row.headline ?? "")}</h1>
  <p style="font-size:15px;line-height:1.5;color:#444">${escapeHtml(row.summary ?? "")}</p>
  <p><a href="${url}" style="display:inline-block;padding:11px 18px;background:#16181C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px">View the evidence</a></p>
  <p style="font-size:11px;color:#888">You are receiving this because you follow this page.
  <a href="${unsubscribeUrl(env, row.token) ?? env.PUBLIC_BASE_URL}">Unsubscribe</a></p>
</div>`;
}

export function confirmationHtml(env: Env, token: string): string {
  const confirm = `${env.PUBLIC_BASE_URL}/confirm?token=${token}`;
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">
  <p style="font:600 11px/1 monospace;letter-spacing:.08em;color:#D63B42">CONFIRM YOUR ADDRESS</p>
  <h1 style="font-size:22px;line-height:1.2;margin:12px 0">One click and you are in</h1>
  <p style="font-size:15px;line-height:1.5;color:#444">Someone, hopefully you, asked The Internet Change Detector to send updates to this address. Nothing is sent until you confirm.</p>
  <p><a href="${confirm}" style="display:inline-block;padding:11px 18px;background:#16181C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px">Confirm subscription</a></p>
  <p style="font-size:11px;color:#888">If this was not you, ignore this email and you will hear nothing further.</p>
</div>`;
}

interface DigestEmail {
  day: string;
  intro: string;
  changes: Pick<ChangeEvent, 'slug' | 'headline' | 'summary' | 'delta' | 'severity'>[];
}

async function loadDigestEmail(env: Env, repo: Repo, day: string): Promise<DigestEmail | null> {
  const digest = await repo.getDigest(day);
  if (!digest) return null;
  let ids: string[] = [];
  try {
    ids = JSON.parse(digest.change_ids) as string[];
  } catch {
    return null;
  }
  const changes = (await Promise.all(ids.map((id) => repo.getChange(id)))).filter(
    (change): change is ChangeEvent => Boolean(change && change.published === 1 && change.false_positive === 0),
  );
  return { day, intro: digest.intro ?? '', changes };
}

function digestHtml(env: Env, digest: DigestEmail, token: string | null): string {
  const base = env.PUBLIC_BASE_URL;
  const rows = digest.changes
    .map(
      (change, index) => `<tr><td style="padding:14px 0;border-top:1px solid #E5E2DA;vertical-align:top;width:34px;font:500 15px monospace;color:#A8ADB4">${String(index + 1).padStart(2, '0')}</td>
  <td style="padding:14px 0;border-top:1px solid #E5E2DA">
    <a href="${base}/changes/${escapeHtml(change.slug)}" style="font-size:16px;font-weight:700;color:#16181C;text-decoration:none">${escapeHtml(change.headline)}</a>
    <div style="font-size:13.5px;line-height:1.45;color:#5B6068;margin-top:4px">${escapeHtml(change.summary)}</div>
    ${change.delta ? `<div style="font:500 13px monospace;color:#C0332F;margin-top:6px">${escapeHtml(change.delta)}</div>` : ''}
  </td></tr>`,
    )
    .join('');
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">
  <p style="font:600 11px/1 monospace;letter-spacing:.08em;color:#D63B42">DAILY DIGEST · ${escapeHtml(digest.day)}</p>
  <h1 style="font-size:24px;line-height:1.2;margin:12px 0">The Internet Changed Today</h1>
  ${digest.intro ? `<p style="font-size:15px;line-height:1.5;color:#444">${escapeHtml(digest.intro)}</p>` : ''}
  <table style="width:100%;border-collapse:collapse;margin-top:10px">${rows}</table>
  <p style="margin-top:22px"><a href="${base}/digest/${escapeHtml(digest.day)}" style="color:#16181C">Read it on the web</a></p>
  <p style="font-size:11px;color:#888">You get this because you subscribed to the daily digest.
  <a href="${unsubscribeUrl(env, token) ?? base}">Unsubscribe</a></p>
</div>`;
}
