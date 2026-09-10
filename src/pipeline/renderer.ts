/**
 * Browser rendering, used only when an HTTP fetch demonstrably came back empty.
 *
 * Kept behind an interface so the renderer (Cloudflare Browser Rendering today,
 * a Playwright service tomorrow) can be swapped without touching the crawler.
 */
import type { Env } from '../types';

export interface RenderResult {
  html: string;
  finalUrl: string;
  durationMs: number;
}

export interface BrowserRenderer {
  readonly name: string;
  render(url: string, timeoutMs: number): Promise<RenderResult | null>;
}

/** Cloudflare Browser Rendering REST API. */
class CloudflareRenderer implements BrowserRenderer {
  readonly name = 'cloudflare-browser-rendering';

  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly userAgent: string,
  ) {}

  async render(url: string, timeoutMs: number): Promise<RenderResult | null> {
    const started = Date.now();
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/browser-rendering/content`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: JSON.stringify({
            url,
            userAgent: this.userAgent,
            gotoOptions: { waitUntil: 'networkidle0', timeout: Math.min(timeoutMs, 30000) },
            rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
          }),
          signal: AbortSignal.timeout(Math.min(timeoutMs + 5000, 40000)),
        },
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { success?: boolean; result?: string };
      if (!body.success || typeof body.result !== 'string') return null;
      return { html: body.result, finalUrl: url, durationMs: Date.now() - started };
    } catch {
      return null;
    }
  }
}

export function createRenderer(env: Env): BrowserRenderer | null {
  const accountId = (env as unknown as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID;
  const token = (env as unknown as { CF_API_TOKEN?: string }).CF_API_TOKEN;
  if (accountId && token) return new CloudflareRenderer(accountId, token, env.USER_AGENT);
  return null;
}
