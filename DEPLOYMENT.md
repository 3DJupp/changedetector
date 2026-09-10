# Deployment

The whole product is one Cloudflare Worker plus four storage bindings. There are
no servers to run and no containers in production — the Docker setup exists only
for local development.

## 0. Prerequisites

- Node 20+ and npm
- A Cloudflare account with Workers enabled
- `npx wrangler login` (or a `CLOUDFLARE_API_TOKEN` in the environment)

Queues need a paid Workers plan. Everything else works on the free plan; without
a queue binding the scheduler processes a bounded number of sites inline on each
cron tick instead.

## 1. Create the resources

```bash
npx wrangler d1 create changedetector
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create changedetector-artifacts
npx wrangler queues create changedetector-jobs
npx wrangler queues create changedetector-jobs-dlq
```

Copy the ids each command prints into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "changedetector"
database_id = "<the id from d1 create>"

[[kv_namespaces]]
binding = "CACHE"
id = "<the id from kv namespace create>"
```

## 2. Set the secrets

```bash
npx wrangler secret put ADMIN_TOKEN          # required for the console and write API
npx wrangler secret put RESEND_API_KEY       # optional: digest + alert email
npx wrangler secret put IPFS_API_TOKEN       # optional: pinning endpoint auth
npx wrangler secret put ANTHROPIC_API_KEY    # optional: hosted-model fallback
npx wrangler secret put CF_ACCOUNT_ID        # optional: enables Browser Rendering
npx wrangler secret put CF_API_TOKEN         # optional: enables Browser Rendering
```

Generate a strong admin token, e.g. `openssl rand -base64 32`.

## 3. Set the public vars

In `wrangler.toml`, at minimum:

```toml
[vars]
PUBLIC_BASE_URL = "https://changes.example.com"
USER_AGENT = "ChangeDetectorBot/1.0 (+https://changes.example.com/about; respects robots.txt)"
```

The user agent should point at a page that explains what the crawler is and how
to contact you — site operators will look it up in their logs, and `/about`
already says what the crawler does and does not do.

## 4. Migrate and deploy

```bash
npm run db:migrate:remote
npm run deploy
```

## 5. Seed the watchlist

```bash
BASE=https://changes.example.com
TOKEN=<your admin token>

# The seed endpoint works in batches of 60 so no single request runs long.
# Run it a few times until it reports 0 added.
curl -X POST $BASE/admin/seed -H "authorization: Bearer $TOKEN"
curl -X POST $BASE/admin/seed -H "authorization: Bearer $TOKEN"
curl -X POST $BASE/admin/seed -H "authorization: Bearer $TOKEN"
```

The first crawl of each page only produces a baseline snapshot. Change events
start appearing on the second crawl of a page, so expect a quiet first hour.

To force the scheduler immediately instead of waiting for the cron tick:

```bash
curl -X POST $BASE/admin/sweep -H "authorization: Bearer $TOKEN"
```

## 6. Custom domain and caching

Add a custom domain in the Workers dashboard (Workers & Pages → your worker →
Settings → Domains & Routes), or via a route in `wrangler.toml`:

```toml
routes = [{ pattern = "changes.example.com", custom_domain = true }]
```

Cloudflare then provides DNS, TLS, the CDN and edge caching automatically. Page
responses already carry appropriate `Cache-Control` (`s-maxage` of 120s for the
feed, 600s for change pages, one year immutable for artifacts and share cards),
so no Page Rules are required.

Recommended, optional hardening in the dashboard:

- **Rate limiting** on `/admin*` and `POST /api/*`
- **Bot Fight Mode** on the zone (it does not affect the outbound crawler)
- **Cache Rules**: bypass cache for `/admin*`

## 7. Scheduled work

`wrangler.toml` already registers two cron triggers:

| Cron | What it does |
|---|---|
| `*/5 * * * *` | sweeps sites whose `next_check_at` has passed, enqueues crawl jobs, flushes the notification outbox |
| `0 7 * * *` | builds "The Internet Changed Today" for the day, then sweeps as usual |

Each sweep claims at most 60 due sites and pushes them onto the queue; queue
concurrency (4 by default) and per-domain spacing bound the real fetch rate.

## 8. IPFS mirroring (optional)

Set an endpoint that speaks the Kubo RPC surface:

```toml
[vars]
IPFS_API_URL = "https://ipfs.example.com"
IPFS_GATEWAY = "https://ipfs.example.com/ipfs"
CONTENT_STORE = "r2"          # keep R2 primary; IPFS becomes the mirror
```

```bash
npx wrangler secret put IPFS_API_TOKEN
```

Artifacts are pushed as CARv1 archives via `dag/import`, so any implementation
that accepts a CAR works. Setting `CONTENT_STORE = "ipfs-http"` makes IPFS the
primary and R2 the durable mirror instead.

If the remote node reports a different CID than the one computed locally, the
write fails loudly rather than publishing a reference we cannot verify.

## 9. Verifying the deployment

```bash
curl $BASE/health
```

```json
{ "ok": true, "version": "1.0.0", "queue": "queue", "ai": true, "contentStore": "r2" }
```

Then check that:

- `/` renders and lists changes once the second crawl of a page completes
- `/admin` shows crawl success near 100% and a small error count
- a change page shows a `bafy…` CID and `/snapshots/:id/verify` reports a match
- `/changes/:slug/og.png` returns a 1200×630 PNG
- `/rss.xml` validates in a feed reader

## 10. Operating notes

**Detection quality is the product.** Before turning on any automated posting,
watch the `/admin` console for a few days and use **Mark false positive** on any
event that should not have been published. Each one is a signal that a
suppression rule or a score weight needs adjusting.

**Tuning noise per site.** A site with a stubborn dynamic element can get custom
rules without a code change:

```bash
curl -X PATCH $BASE/api/sites/$SITE_ID \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"normalization":"{\"noisePatterns\":[\"hero-rotator\",\"live-metrics\"],\"suppressCounters\":true}"}'
```

Supported keys: `dropTags`, `noisePatterns`, `includeChrome`, `suppressCounters`,
`keepLinkQuery`, `scope`.

**Raising or lowering the publication bar.** `PUBLISH_THRESHOLD` (default 25)
decides what becomes public. Raise it if the feed feels noisy; lower it if
genuinely interesting changes are being held back. Events below the threshold
are still stored and visible in the console — nothing is lost.

**Cost.** The dominant costs are D1 row reads and, if enabled, Browser
Rendering. Content hashing before any expensive work means unchanged pages cost
one fetch and one D1 insert; artifacts and AI calls only happen when something
actually changed.

**Backups.** D1 supports time travel (`wrangler d1 time-travel`). The artifacts
in R2 are immutable and content-addressed, so they only ever need to be copied,
never reconciled.
