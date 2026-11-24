import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { Repo } from '../src/db/repo';
import { categoryFromSlug, changeKey, changePath, kebab } from '../src/lib/paths';
import { metaDescription } from '../src/ui/seo';
import { executionCtx, testEnv } from './helpers/env';
import { addChange, addSite } from './helpers/fixtures';

let env: ReturnType<typeof testEnv>;
let repo: Repo;

class FakeR2 {
  store = new Map<string, Uint8Array>();
  async get(key: string) {
    const value = this.store.get(key);
    return value ? { body: value } : null;
  }
  async put(key: string, value: Uint8Array) {
    this.store.set(key, value);
  }
}

beforeEach(() => {
  env = testEnv({ ARTIFACTS: new FakeR2() as unknown as R2Bucket });
  repo = new Repo(env.DB as unknown as D1Database);
});

function get(path: string) {
  return worker.fetch(new Request(`https://changes.example${path}`, { redirect: 'manual' }), env, executionCtx);
}

describe('readable URLs', () => {
  it('builds slugs from headlines', () => {
    expect(kebab('Northbeam raised Pro pricing from $19 to $24')).toBe('northbeam-raised-pro-pricing-from-19-to-24');
    expect(kebab('Größenänderung & Ümläute')).toBe('grossenanderung-and-umlaute');
    expect(changePath({ slug: '8f21ac3d', headline: 'orbital-sync disappeared' })).toBe('/changes/8f21ac3d-orbital-sync-disappeared');
    expect(changeKey('8f21ac3d-orbital-sync-disappeared')).toBe('8f21ac3d');
    expect(categoryFromSlug('open-source')).toBe('Open Source');
    expect(categoryFromSlug('nope')).toBeNull();
  });

  it('redirects bare and outdated change URLs to the readable one', async () => {
    const site = await addSite(repo);
    const change = await addChange(env.DB, repo, site);
    const readable = changePath(change);

    const bare = await get(`/changes/${change.slug}`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe(readable);

    const stale = await get(`/changes/${change.slug}-old-headline/diff?mode=words`);
    expect(stale.status).toBe(301);
    expect(stale.headers.get('location')).toBe(`${readable}/diff?mode=words`);

    const page = await get(readable);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(`<link rel="canonical" href="https://changes.example${readable}">`);
    expect(body).toContain('"@type":"NewsArticle"');
    expect(body).toContain('"@type":"BreadcrumbList"');
  });

  it('gives sites unique readable slugs and redirects ids to them', async () => {
    const a = await addSite(repo, { title: 'OpenAI API Pricing', url: 'https://openai.com/api/pricing' });
    const b = await addSite(repo, { title: 'OpenAI API Pricing', url: 'https://openai.com/api/pricing-2' });
    const c = await addSite(repo, { title: null, url: 'https://www.example.org/legal/terms' });
    expect(a.slug).toBe('openai-api-pricing');
    expect(b.slug).toBe('openai-api-pricing-2');
    expect(c.slug).toBe('example-org-legal-terms');

    const byId = await get(`/sites/${a.id}`);
    expect(byId.status).toBe(301);
    expect(byId.headers.get('location')).toBe('/sites/openai-api-pricing');
    expect((await get('/sites/openai-api-pricing')).status).toBe(200);
  });

  it('backfills slugs for sites created before slugs existed', async () => {
    const site = await addSite(repo, { title: 'Legacy Page' });
    env.DB.rows('UPDATE monitored_sites SET slug = NULL WHERE id = ?', site.id);
    expect(await repo.backfillSiteSlugs()).toBe(1);
    expect((await repo.getSite(site.id))!.slug).toBe('legacy-page');
  });
});

describe('category pages and pagination', () => {
  it('moves the old query-string filter to a category page', async () => {
    const response = await get('/?category=Open%20Source&order=recent');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/category/open-source?order=recent');
  });

  it('renders a category landing page with its own title and canonical', async () => {
    const site = await addSite(repo);
    await addChange(env.DB, repo, site);
    const body = await (await get('/category/pricing')).text();
    expect(body).toContain('<title>Pricing changes — The Internet Change Detector</title>');
    expect(body).toContain('<link rel="canonical" href="https://changes.example/category/pricing">');
    expect(body).not.toContain('name="robots"');
  });

  it('keeps sorted views out of the index', async () => {
    const body = await (await get('/category/pricing?order=recent')).text();
    expect(body).toContain('<meta name="robots" content="noindex,follow">');
  });

  it('paginates the feed with prev/next links', async () => {
    const site = await addSite(repo);
    for (let i = 0; i < 30; i++) await addChange(env.DB, repo, site, { headline: `Change number ${i}` });
    const first = await (await get('/')).text();
    expect(first).toContain('<link rel="next" href="https://changes.example/?page=2">');
    const second = await get('/?page=2');
    expect(second.status).toBe(200);
    const body = await second.text();
    expect(body).toContain('<link rel="canonical" href="https://changes.example/?page=2">');
    expect(body).toContain('<link rel="prev" href="https://changes.example/">');
    expect((await get('/?page=9')).status).toBe(404);
  });
});

describe('sitemaps', () => {
  it('serves an index whose files list every published change with lastmod', async () => {
    const site = await addSite(repo, { title: 'Northbeam' });
    const published = await addChange(env.DB, repo, site);
    const hidden = await addChange(env.DB, repo, site, { published: 0, headline: 'Hidden change' });

    const index = await (await get('/sitemap.xml')).text();
    expect(index).toContain('<sitemapindex');
    expect(index).toContain('https://changes.example/sitemaps/changes-1.xml');

    const changes = await (await get('/sitemaps/changes-1.xml')).text();
    expect(changes).toContain(`https://changes.example${changePath(published)}</loc><lastmod>`);
    expect(changes).not.toContain(hidden.slug);

    const sites = await (await get('/sitemaps/sites.xml')).text();
    expect(sites).toContain('https://changes.example/sites/northbeam</loc>');

    const pages = await (await get('/sitemaps/pages.xml')).text();
    expect(pages).toContain('https://changes.example/category/pricing</loc><lastmod>');
    expect((await get('/sitemaps/nonsense.xml')).status).toBe(404);
  });
});

describe('site furniture', () => {
  it('serves an HTML 404 with noindex for unknown paths', async () => {
    const response = await get('/this/does/not/exist');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('noindex');
  });

  it('serves icons and a manifest', async () => {
    const ico = await get('/favicon.ico');
    expect(ico.headers.get('content-type')).toBe('image/x-icon');
    const bytes = new Uint8Array(await ico.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 1, 0]);
    expect(Array.from(bytes.slice(22, 26))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const manifest = await (await get('/manifest.webmanifest')).json<{ icons: unknown[] }>();
    expect(manifest.icons).toHaveLength(3);
    expect((await get('/apple-touch-icon.png')).headers.get('content-type')).toBe('image/png');
  });

  it('serves the default, site and digest share cards', async () => {
    const site = await addSite(repo, { title: 'Northbeam' });
    const change = await addChange(env.DB, repo, site);
    await repo.saveDigest('2026-11-24', [change.id], 'Intro', { detected: 3, published: 1, sites: 1 });
    for (const path of ['/og/default.png', `/sites/${site.id}/og.png`, '/og/digest-2026-11-24.png', `/changes/${change.slug}/og.png`]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
    }
    expect((await get('/og/digest-2001-01-01.png')).status).toBe(404);
  });

  it('cuts meta descriptions at a word boundary', () => {
    const text = 'word '.repeat(60);
    const out = metaDescription(text);
    expect(out.length).toBeLessThanOrEqual(158);
    expect(out.endsWith('…')).toBe(true);
    expect(metaDescription('Short.')).toBe('Short.');
  });
});
