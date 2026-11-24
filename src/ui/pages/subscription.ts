/** Subscribe result, confirmation and unsubscribe pages. All noindex. */
import { layout } from '../layout';
import { e } from '../components';

interface SubscriptionRow {
  site_id: string | null;
  category: string | null;
  pending: number;
  site_title: string | null;
  canonical_url: string | null;
}

function shell(baseUrl: string, path: string, title: string, body: string): string {
  return layout({
    title: `${title} — The Internet Change Detector`,
    description: title,
    path,
    baseUrl,
    narrow: true,
    noindex: true,
    body: `<div class="wrap-narrow" style="padding:64px 0 80px">${body}</div>`,
  });
}

function heading(label: string, title: string, text: string): string {
  return `<div class="label">${e(label)}</div>
  <h1 style="font-size:32px;letter-spacing:-.04em;font-weight:800;margin:14px 0 0">${e(title)}</h1>
  <p class="muted" style="margin-top:12px;font-size:15px;line-height:1.55;max-width:56ch">${e(text)}</p>`;
}

export function subscribeResultPage(props: {
  baseUrl: string;
  ok: boolean;
  message: string;
  deliveryUnavailable?: boolean;
  back?: string;
}): string {
  const back = props.back ?? '/';
  return shell(
    props.baseUrl,
    '/api/subscriptions',
    props.ok ? 'Check your inbox' : 'That did not work',
    `${heading(props.ok ? 'ALMOST THERE' : 'SUBSCRIPTION', props.ok ? 'Check your inbox' : 'That did not work', props.message)}
    ${props.deliveryUnavailable ? `<div class="notice" style="margin-top:20px">Email delivery is not configured on this instance, so no confirmation email was sent. The confirmation link was written to the server log.</div>` : ''}
    <p style="margin-top:26px"><a class="btn btn-ghost" href="${e(back)}">Back</a></p>`,
  );
}

export function confirmPage(props: { baseUrl: string; token: string; state: 'ask' | 'done' | 'invalid'; activated?: number }): string {
  if (props.state === 'invalid') {
    return shell(props.baseUrl, '/confirm', 'Link not valid', heading('CONFIRMATION', 'Link not valid', 'This confirmation link is unknown or has been mistyped. Subscribe again to get a fresh one.'));
  }
  if (props.state === 'done') {
    return shell(
      props.baseUrl,
      '/confirm',
      'Subscription confirmed',
      `${heading('CONFIRMED', 'You are subscribed', 'Your address is confirmed. You will only hear from us when something meaningful changes, plus the daily digest if you asked for it.')}
      <p style="margin-top:26px;display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-primary" href="/">Go to the feed</a><a class="btn btn-ghost" href="/unsubscribe?token=${e(props.token)}">Manage subscriptions</a></p>`,
    );
  }
  // A GET only shows the button. Mail scanners follow links, they do not submit forms.
  return shell(
    props.baseUrl,
    '/confirm',
    'Confirm your subscription',
    `${heading('CONFIRMATION', 'Confirm your subscription', 'One click and you are in. Nothing is sent to this address until you confirm.')}
    <form method="post" action="/confirm" style="margin-top:26px">
      <input type="hidden" name="token" value="${e(props.token)}">
      <button class="btn btn-primary" type="submit">Confirm subscription</button>
    </form>`,
  );
}

export function unsubscribePage(props: {
  baseUrl: string;
  token: string;
  state: 'ask' | 'done' | 'invalid';
  email?: string;
  digest?: boolean;
  subscriptions?: SubscriptionRow[];
}): string {
  if (props.state === 'invalid') {
    return shell(props.baseUrl, '/unsubscribe', 'Link not valid', heading('UNSUBSCRIBE', 'Link not valid', 'This unsubscribe link is unknown. If you keep getting email from us, reply to it and we will remove you by hand.'));
  }
  if (props.state === 'done') {
    return shell(
      props.baseUrl,
      '/unsubscribe',
      'Unsubscribed',
      heading('UNSUBSCRIBED', 'You will not hear from us again', 'Every subscription and the daily digest for this address are switched off. You can always subscribe again from any page.'),
    );
  }
  const rows = props.subscriptions ?? [];
  const items = [
    ...(props.digest ? ['Daily digest'] : []),
    ...rows.map((row) =>
      `${row.site_id ? `Page: ${row.site_title ?? row.canonical_url ?? row.site_id}` : `Category: ${row.category ?? 'all'}`}${row.pending ? ' (not confirmed yet)' : ''}`,
    ),
  ];
  return shell(
    props.baseUrl,
    '/unsubscribe',
    'Unsubscribe',
    `${heading('UNSUBSCRIBE', 'Stop the emails', `This switches off everything we send to ${props.email ?? 'this address'}.`)}
    ${items.length ? `<ul style="margin:22px 0 0;padding-left:18px;line-height:1.8;font-size:14px">${items.map((item) => `<li>${e(item)}</li>`).join('')}</ul>` : '<p class="muted" style="margin-top:18px">There are no active subscriptions for this address.</p>'}
    <form method="post" action="/unsubscribe" style="margin-top:26px">
      <input type="hidden" name="token" value="${e(props.token)}">
      <button class="btn btn-primary" type="submit">Unsubscribe from everything</button>
    </form>`,
  );
}
