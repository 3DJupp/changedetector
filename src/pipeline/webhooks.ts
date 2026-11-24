/**
 * Webhook delivery: Slack and Discord incoming webhooks get a message in
 * their own format, any other HTTPS endpoint gets a JSON event.
 *
 * Targets are user-supplied URLs, so they go through the same SSRF guard as
 * crawled pages, once when subscribing and again before every delivery (the
 * DNS answer may have changed since). Redirects are not followed.
 */
import type { Env } from '../types';
import { assertFetchable, UrlNotAllowed } from '../lib/urlguard';

export type WebhookKind = 'slack' | 'discord' | 'generic';

export interface ChangeEventPayload {
  id: string;
  url: string;
  headline: string;
  summary: string;
  severity: string;
  score: number;
  before: string | null;
  after: string | null;
  delta: string | null;
  detectedAt: string;
  site: { title: string | null; url: string | null; category: string | null };
}

export function webhookKind(target: string): WebhookKind {
  const url = new URL(target);
  if (url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/')) return 'slack';
  if (['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname) && url.pathname.startsWith('/api/webhooks/')) {
    return 'discord';
  }
  return 'generic';
}

/** Throws UrlNotAllowed with a user-facing message if the target is not acceptable. */
export async function validateWebhookTarget(env: Env, target: string): Promise<{ url: string; kind: WebhookKind }> {
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    throw new UrlNotAllowed('That is not a valid URL', 'invalid');
  }
  if (url.protocol !== 'https:') throw new UrlNotAllowed('Webhook URLs must use https', 'protocol');
  if (url.username || url.password) throw new UrlNotAllowed('Webhook URLs must not contain credentials', 'credentials');
  if (url.toString().length > 500) throw new UrlNotAllowed('That webhook URL is too long', 'invalid');
  await assertFetchable(url.toString(), { cache: env.CACHE });
  return { url: url.toString(), kind: webhookKind(url.toString()) };
}

const SEVERITY_COLOR: Record<string, number> = {
  MAJOR: 0xc6332f,
  SIGNIFICANT: 0xa6721b,
  MODERATE: 0xa6721b,
  MINOR: 0x2a78d6,
  TRIVIAL: 0x7a8089,
};

function valueLine(event: ChangeEventPayload): string {
  if (event.before && event.after) return `${event.before} → ${event.after}${event.delta ? ` (${event.delta})` : ''}`;
  return event.delta ?? '';
}

/** Slack mrkdwn needs &, < and > escaped; everything else is literal. */
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function webhookBody(kind: WebhookKind, event: ChangeEventPayload): unknown {
  const values = valueLine(event);
  if (kind === 'slack') {
    const lines = [
      `*<${event.url}|${slackEscape(event.headline)}>*`,
      slackEscape(event.summary),
      values ? `\`${slackEscape(values)}\`` : '',
      `_${slackEscape(event.severity)} · ${slackEscape(event.site.title ?? event.site.url ?? '')}_`,
    ].filter(Boolean);
    return { text: lines.join('\n'), unfurl_links: false };
  }
  if (kind === 'discord') {
    return {
      username: 'Change Detector',
      // Never let page-derived text ping anyone.
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: event.headline.slice(0, 256),
          url: event.url,
          description: [event.summary, values ? `**${values}**` : ''].filter(Boolean).join('\n\n').slice(0, 4000),
          color: SEVERITY_COLOR[event.severity] ?? SEVERITY_COLOR.TRIVIAL,
          timestamp: event.detectedAt,
          footer: { text: `${event.severity} · ${event.site.title ?? event.site.url ?? ''}`.slice(0, 2048) },
        },
      ],
    };
  }
  return { type: 'change.detected', version: 1, change: event };
}

export async function deliverWebhook(env: Env, target: string, event: ChangeEventPayload): Promise<void> {
  await assertFetchable(target, { cache: env.CACHE });
  const kind = webhookKind(target);
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': env.USER_AGENT,
      'x-changedetector-event': 'change.detected',
      'x-changedetector-delivery': event.id,
    },
    body: JSON.stringify(webhookBody(kind, event)),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`webhook ${response.status}`);
  }
}
