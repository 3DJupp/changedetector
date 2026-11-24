/** Public forms: following a page or category, and suggesting a page to watch. */
import { CATEGORIES } from '../../types';
import { layout } from '../layout';
import { e } from '../components';

function page(baseUrl: string, path: string, title: string, description: string, body: string, noindex: boolean | string = false): string {
  return layout({
    title: `${title} — The Internet Change Detector`,
    description,
    path,
    baseUrl,
    narrow: true,
    noindex: noindex || undefined,
    body: `<div class="wrap-narrow" style="padding-top:48px;padding-bottom:80px">${body}</div>`,
  });
}

function field(label: string, control: string, hint = ''): string {
  return `<label style="display:block;margin-top:18px">
    <span class="label" style="display:block;margin-bottom:8px">${e(label)}</span>
    ${control}
    ${hint ? `<span class="dim" style="display:block;font-size:12px;margin-top:6px;line-height:1.45">${hint}</span>` : ''}
  </label>`;
}

export function followPage(props: {
  baseUrl: string;
  site?: { id: string; title: string | null; canonical_url: string } | null;
  category?: string | null;
}): string {
  const target = props.site
    ? `<input type="hidden" name="siteId" value="${e(props.site.id)}">`
    : field(
        'Category',
        `<select class="field" name="category" style="width:100%">${CATEGORIES.map(
          (category) => `<option value="${e(category)}"${category === props.category ? ' selected' : ''}>${e(category)}</option>`,
        ).join('')}</select>`,
      );
  const subject = props.site ? props.site.title ?? props.site.canonical_url : props.category ? `${props.category} changes` : 'a category';

  const body = `<div class="label">FOLLOW</div>
  <h1 style="font-size:32px;letter-spacing:-.04em;font-weight:800;margin:14px 0 0">Follow ${e(subject)}</h1>
  <p class="muted" style="margin-top:12px;font-size:15px;line-height:1.55;max-width:56ch">Get every meaningful change by email, or straight into Slack, Discord or your own endpoint. Your email address owns the subscription: we send one confirmation link and nothing is delivered before it is clicked.</p>
  <form method="post" action="/api/subscriptions" style="margin-top:10px;max-width:520px">
    ${target}
    ${field('Your email', '<input class="field" type="email" name="email" required placeholder="you@company.com" style="width:100%">', 'Used to confirm and to unsubscribe. Never shared, never used for anything else.')}
    ${field(
      'Deliver to (optional)',
      '<input class="field mono" type="url" name="webhook" placeholder="https://hooks.slack.com/services/…" style="width:100%;font-size:12px">',
      'Leave empty for email. Slack and Discord incoming webhook URLs get a formatted message; any other HTTPS URL receives a JSON <code class="mono">change.detected</code> event.',
    )}
    ${field(
      'Only changes scoring at least',
      `<select class="field" name="minScore" style="width:100%">
        <option value="25">25 · everything published</option>
        <option value="40" selected>40 · moderate and up</option>
        <option value="60">60 · significant and up</option>
        <option value="80">80 · major only</option>
      </select>`,
    )}
    <p style="margin-top:22px"><button class="btn btn-primary" type="submit">Follow</button></p>
  </form>`;
  // Every variant of this page is a form, not content.
  return page(props.baseUrl, '/follow', `Follow ${subject}`, `Get changes to ${subject} by email, Slack, Discord or webhook.`, body, 'noindex,follow');
}

export function suggestPage(props: { baseUrl: string; url?: string; error?: string }): string {
  const body = `<div class="label">SUGGEST A PAGE</div>
  <h1 style="font-size:32px;letter-spacing:-.04em;font-weight:800;margin:14px 0 0">Which page should we watch?</h1>
  <p class="muted" style="margin-top:12px;font-size:15px;line-height:1.55;max-width:58ch">Pricing pages, terms of service, API limits, policies: pages where a quiet edit matters. Every suggestion is reviewed by a person before it is monitored, and pages whose robots.txt disallows us are never crawled.</p>
  ${props.error ? `<div class="notice" style="margin-top:20px">${e(props.error)}</div>` : ''}
  <form method="post" action="/suggest" style="margin-top:10px;max-width:560px">
    ${field('Page URL', `<input class="field mono" type="url" name="url" required value="${e(props.url ?? '')}" placeholder="https://example.com/pricing" style="width:100%;font-size:12px">`)}
    ${field(
      'Category',
      `<select class="field" name="category" style="width:100%"><option value="">Not sure</option>${CATEGORIES.map((category) => `<option value="${e(category)}">${e(category)}</option>`).join('')}</select>`,
    )}
    ${field('Why does it matter? (optional)', '<textarea class="field" name="reason" rows="3" maxlength="500" style="width:100%;resize:vertical"></textarea>')}
    <div aria-hidden="true" style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden">
      <label>Leave this empty <input type="text" name="website" tabindex="-1" autocomplete="off"></label>
    </div>
    <p style="margin-top:22px"><button class="btn btn-primary" type="submit">Suggest this page</button></p>
  </form>`;
  return page(
    props.baseUrl,
    '/suggest',
    'Suggest a page to watch',
    'Suggest a public web page for The Internet Change Detector to monitor. Every suggestion is reviewed before it is crawled.',
    body,
  );
}

export function suggestResultPage(props: {
  baseUrl: string;
  outcome: 'received' | 'voted' | 'monitored' | 'declined';
  sitePath?: string;
}): string {
  const copy = {
    received: ['THANK YOU', 'Suggestion received', 'A person will review it. If it is a good fit, it shows up under Sites, usually within a few days.'],
    voted: ['THANK YOU', 'Already suggested', 'Someone suggested this page before you. We counted your vote, which moves it up the review queue.'],
    monitored: ['GOOD NEWS', 'Already watched', 'We already monitor this page. You can follow it and get every meaningful change.'],
    declined: ['NOTED', 'Reviewed before', 'This page was reviewed earlier and is not on the list. Thanks for thinking of it.'],
  }[props.outcome];
  const action =
    props.outcome === 'monitored' && props.sitePath
      ? `<a class="btn btn-primary" href="${e(props.sitePath)}">Open the page history</a>`
      : '<a class="btn btn-primary" href="/suggest">Suggest another</a>';
  const body = `<div class="label">${copy[0]}</div>
  <h1 style="font-size:32px;letter-spacing:-.04em;font-weight:800;margin:14px 0 0">${copy[1]}</h1>
  <p class="muted" style="margin-top:12px;font-size:15px;line-height:1.55;max-width:56ch">${copy[2]}</p>
  <p style="margin-top:26px;display:flex;gap:8px;flex-wrap:wrap">${action}<a class="btn btn-ghost" href="/">Back to the feed</a></p>`;
  return page(props.baseUrl, '/suggest', copy[1], copy[2], body, true);
}
