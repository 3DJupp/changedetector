/**
 * Notifications: email (Resend) and webhooks, driven off a durable outbox so a
 * delivery failure never loses a change event.
 */
import type { Env } from '../types';
import { Repo } from '../db/repo';
import { escapeHtml } from '../lib/html';

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
  headline: string;
  summary: string;
  slug: string;
}

export async function deliverPending(env: Env, repo: Repo, limit = 25): Promise<{ sent: number; failed: number }> {
  const pending = (await repo.pendingNotifications(limit)) as unknown as PendingRow[];
  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      if (row.channel === 'EMAIL') {
        if (!row.email) {
          await repo.markNotification(row.id, 'SKIPPED', 'no email');
          continue;
        }
        await sendEmail(env, row.email, `Change detected: ${row.headline}`, alertHtml(env, row));
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

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error('email provider not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'digest@changedetector.app',
      to: [to],
      subject,
      html,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`resend ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

function alertHtml(env: Env, row: PendingRow): string {
  const url = `${env.PUBLIC_BASE_URL}/changes/${row.slug}`;
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px">
  <p style="font:600 11px/1 monospace;letter-spacing:.08em;color:#D63B42">CHANGE DETECTED</p>
  <h1 style="font-size:22px;line-height:1.2;margin:12px 0">${escapeHtml(row.headline)}</h1>
  <p style="font-size:15px;line-height:1.5;color:#444">${escapeHtml(row.summary)}</p>
  <p><a href="${url}" style="display:inline-block;padding:11px 18px;background:#16181C;color:#fff;border-radius:8px;text-decoration:none;font-size:14px">View the evidence</a></p>
  <p style="font-size:11px;color:#888">You are receiving this because you follow this page.
  <a href="${env.PUBLIC_BASE_URL}/unsubscribe?token=${row.token ?? ''}">Unsubscribe</a></p>
</div>`;
}
