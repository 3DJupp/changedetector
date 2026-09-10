# The Internet Change Detector

The internet changes. We keep receipts.

A production-shaped MVP that continuously monitors a curated list of public web
pages, detects **meaningful** changes, preserves the previous versions as
content-addressed artifacts, and publishes each change as a beautiful, shareable
event page.

```
CHANGE DETECTED

Northbeam · /pricing

Before  $19 / month
After   $24 / month        +26.3%

Detected  September 9, 2026 · 14:35 UTC
Snapshot  bafybeihdasoqehwmuugcmzrkuka5zam4dqc2sj737aado77ecj3fc4zffm
```

Everything runs as **one Cloudflare Worker**: the public site, the JSON API, the
crawl scheduler and the job consumers.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Detection pipeline](#detection-pipeline)
- [Content addressing](#content-addressing-and-ipfs)
- [Quick start](#quick-start)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [API](#api)
- [Security](#security)
- [Testing](#testing)
- [Project layout](#project-layout)

---

## What it does

| | |
|---|---|
| **Monitors** | ~136 curated public pages (pricing, docs, changelogs, terms, releases, status pages) on per-site schedules |
| **Detects** | price movements, disappearing pages, status changes, added/removed sections, heading and title changes, high-signal wording |
| **Suppresses** | timestamps, dates, cookie banners, rotating promos, chat widgets, analytics attributes, randomized class names, build hashes, tracking parameters |
| **Preserves** | every meaningful capture as an IPFS-addressable artifact (`metadata.json`, `page.html`, `content.txt`, `normalized.json`) |
| **Publishes** | a public change page, a side-by-side diff, an auto-generated OG share card, RSS feeds and a daily digest |
| **Explains** | headline and summary written by a language model, bounded by the heuristic score — and fully functional without it |

## Architecture

```
                        ┌───────────────────────────┐
      Cron triggers ───▶│  Cloudflare Worker        │◀─── Public HTTP
      */5 * * * *       │                           │
      0 7 * * *         │  fetch()     site + API   │
                        │  scheduled() sweep+digest │
                        │  queue()     job consumer │
                        └───┬───────────────┬───────┘
                            │               │
                  ┌─────────▼───────┐   ┌───▼──────────────┐
                  │ Queues          │   │ D1 (SQLite)      │
                  │ crawl / notify  │   │ sites, snapshots │
                  │ digest jobs     │   │ changes, users,  │
                  └─────────┬───────┘   │ subs, FTS5 index │
                            │           └──────────────────┘
                  ┌─────────▼─────────┐
                  │ Crawler           │  HTTP first, browser rendering
                  │ + URL guard       │  only when a page renders empty
                  │ + robots.txt      │
                  └─────────┬─────────┘
                            │
                  ┌─────────▼─────────┐
                  │ Normalizer        │  HTML → canonical representation
                  └─────────┬─────────┘
                            │
          ┌─────────────────┼──────────────────┐
          ▼                 ▼                  ▼
  ┌───────────────┐ ┌──────────────┐  ┌─────────────────┐
  │ Change engine │ │ ContentStore │  │ Workers AI      │
  │ diff + scores │ │ R2 ⇄ IPFS    │  │ headline/summary│
  └───────┬───────┘ └──────────────┘  └─────────────────┘
          ▼
  ┌────────────────────────────────────────────┐
  │ ChangeEvent = URL + time + prevCID + CID   │
  │              + derived diff + scores       │
  └────────────────────────────────────────────┘
```

**The database is not the source of truth for content.** D1 records *"we observed
this URL at this time"*. The artifact records *"these exact bytes were captured"*.

## Detection pipeline

Each layer is cheaper than the one after it, and most crawls stop at layer 1.

1. **Fetch** — plain HTTP with a timeout, a byte cap, redirect re-validation,
   ETag/Last-Modified revalidation and per-domain rate limiting. `robots.txt` is
   honoured. Browser rendering is attempted *only* when the HTTP response
   demonstrably renders no content (`needsBrowserRendering`).
2. **Normalize** — scripts, styles, cookie banners, chat widgets, ad slots,
   carousels and hidden decoration are dropped; timestamps, dates, relative
   times, copyright years, build hashes, UUIDs and cache-busted asset names are
   replaced with stable tokens; tracking parameters are stripped from links.
   Every suppression is counted and shown in the UI. Rules are per-site
   configurable.
3. **Hash** — SHA-256 over the canonical representation. Identical hash ⇒ the
   capture is recorded as a duplicate, no artifact is written, no event is
   created, processing stops.
4. **Diff** — patience-anchored line diff (Myers inside each gap), word-level
   diff for changed lines, and a structural diff over headings, links, images,
   metadata and section counts.
5. **Score** — a *magnitude* score (how much moved) and an *interestingness*
   score (whether anyone should care):

   | Signal | Points |
   |---|---|
   | Page disappeared (404/410/451) | +65, floor of 82 |
   | Pricing changed | +40 … +55 |
   | Page came back | +30 |
   | High-signal keywords (deprecated, sunset, arbitration, rate limit …) | up to +24 |
   | Headings changed | up to +22 |
   | Title changed | +20 |
   | HTTP status changed | +20 |
   | Text difference | up to +20 |
   | Legal / terms page | +15 |
   | Large section added/removed | up to +15 |
   | Pricing page | +10 |
   | Cosmetic-only change | +1 |
   | Sub-0.5% diff with no price/title/status change | **−12** |

   Bands: `0-10 TRIVIAL · 11-30 MINOR · 31-60 MODERATE · 61-80 SIGNIFICANT · 81-100 MAJOR`.
   Only events at or above `PUBLISH_THRESHOLD` (default 25) become public.
6. **Explain** — for events already above 20, Workers AI reviews the diff and
   writes the headline and summary. Its significance score is blended with the
   heuristic and clamped to ±25 points of it, and an `is_noise` verdict caps the
   score rather than deleting the event. Page content is passed as explicitly
   delimited untrusted data.

## Content addressing and IPFS

Snapshot artifacts are packed as a UnixFS directory and addressed with a real
CIDv1 computed locally from the bytes:

```
snapshot/
  metadata.json     url, capturedAt, httpStatus, contentHash, previousCid, toolVersion, suppression counters
  page.html         the exact response body
  content.txt       extracted visible text
  normalized.json   the canonical representation that was hashed
```

The CID implementation (`src/lib/cid.ts`) is dependency-free and verified in the
test suite against published IPFS vectors — including
`bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku` (empty raw block)
and `QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o` (the classic dag-pb node),
so the same bytes get the same CID here as under `ipfs add`.

Every artifact is also written as a **CARv1 archive**, downloadable at
`/api/snapshots/:id/artifact.car` and importable into any IPFS implementation.

Storage is layered behind one interface (`ContentStore`):

- **R2** is the durable primary replica.
- **IPFS** (any Kubo-compatible RPC endpoint) is a best-effort mirror, written
  via `dag/import`.

> Content addressing guarantees **integrity**, not permanence. The UI reports how
> many replicas actually accepted an artifact instead of implying that IPFS keeps
> things forever.

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars          # set ADMIN_TOKEN
npm run db:migrate:local
npm run dev                             # http://localhost:8787
```

Then, in another terminal:

```bash
# Generate demo change events through the real pipeline (no network needed)
curl -X POST localhost:8787/admin/demo -H "authorization: Bearer dev-admin-token"

# Or load the curated seed list and crawl for real (run it a few times; it works
# in batches so no single request runs long)
curl -X POST localhost:8787/admin/seed  -H "authorization: Bearer dev-admin-token"
curl -X POST localhost:8787/admin/sweep -H "authorization: Bearer dev-admin-token"
```

Open http://localhost:8787 — the feed, a change page, its diff, the snapshot
ledger, the digest and the console at `/admin` all work locally.

With Docker:

```bash
docker compose up                    # Worker only
docker compose --profile ipfs up     # Worker + a local Kubo node
```

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full walkthrough. The short version:

```bash
npx wrangler d1 create changedetector          # copy the id into wrangler.toml
npx wrangler kv namespace create CACHE         # copy the id into wrangler.toml
npx wrangler r2 bucket create changedetector-artifacts
npx wrangler queues create changedetector-jobs
npx wrangler queues create changedetector-jobs-dlq

npx wrangler secret put ADMIN_TOKEN
npm run db:migrate:remote
npm run deploy
```

Queues require a paid Workers plan. Without the binding the scheduler falls back
to bounded inline processing, so the system still works — just slower.

## Configuration

Vars live in `wrangler.toml`; secrets are set with `wrangler secret put`.

| Name | Default | Purpose |
|---|---|---|
| `PUBLIC_BASE_URL` | `http://localhost:8787` | canonical URLs, OG tags, feeds |
| `USER_AGENT` | `ChangeDetectorBot/1.0 (+…)` | identifies the crawler to sites and to `robots.txt` |
| `CONTENT_STORE` | `r2` | `r2` or `ipfs-http` — which replica is primary |
| `IPFS_GATEWAY` | `https://ipfs.io/ipfs` | gateway used for "open raw artifact" links |
| `IPFS_API_URL` | — | Kubo-compatible RPC endpoint; enables IPFS mirroring |
| `AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | empty disables the AI layer |
| `MAX_RESPONSE_BYTES` | `2097152` | hard cap on a fetched body |
| `FETCH_TIMEOUT_MS` | `15000` | per-request timeout |
| `DOMAIN_MIN_INTERVAL_S` | `20` | politeness floor between fetches of one domain |
| `PUBLISH_THRESHOLD` | `25` | interestingness needed to publish |
| `ADMIN_TOKEN` | *secret* | admin API and console |
| `IPFS_API_TOKEN` | *secret* | bearer token for the IPFS endpoint |
| `RESEND_API_KEY` / `EMAIL_FROM` | *secret* | digest and alert email |
| `ANTHROPIC_API_KEY` | *secret* | optional hosted-model fallback |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` | *secret* | enables Browser Rendering for JS-only pages |

Crawl cadence is chosen from presets (`15m`, `30m`, `1h`, `2h`, `6h`, `12h`,
`24h`) with a hard floor of 15 minutes — clients cannot request an aggressive
rate.

## API

Read endpoints are public and edge-cached; writes need
`Authorization: Bearer $ADMIN_TOKEN`. Full reference at `/api`.

```http
GET    /api/changes?category=Pricing&order=interesting&limit=24
GET    /api/changes/:idOrSlug
GET    /api/changes/:idOrSlug/diff
GET    /api/sites
GET    /api/sites/:id
GET    /api/sites/:id/changes?format=csv
GET    /api/sites/:id/snapshots
GET    /api/snapshots/:id
GET    /api/snapshots/:id/verify
GET    /api/snapshots/:id/artifact.car
GET    /api/search?q=pricing
GET    /api/stats
GET    /api/digest/:day
POST   /api/subscriptions        {email, siteId? | category?, minScore?}
POST   /api/sites                {url, category, interval, priority}      🔒
POST   /api/sites/:id/crawl                                               🔒
PATCH  /api/sites/:id                                                     🔒
DELETE /api/sites/:id                                                     🔒
```

Feeds: `/rss.xml`, `/rss.xml?category=Pricing`, `/sites/:id/rss.xml`, `/digest.xml`.

## Security

The crawler accepts arbitrary URLs, so it is treated as the security boundary of
the system.

- **SSRF** — protocol allowlist (`http`/`https` only), port allowlist, no
  credentials in URLs, and rejection of loopback, private, link-local, CGNAT,
  benchmark, multicast and cloud-metadata ranges in **every** IPv4 spelling
  (dotted, decimal, octal, hex, short forms) and IPv6 form (including
  IPv4-mapped and NAT64). Hostnames are resolved over DNS-over-HTTPS and the
  answers are re-checked, and **every redirect hop is re-validated**.
- **Resource limits** — response size cap, streaming reader that cancels on
  overflow, request timeout, redirect cap, node cap in the HTML parser.
- **Stored XSS** — archived HTML is never served as-is. It is re-parsed,
  stripped of scripts, styles, iframes, forms, event handlers and
  `javascript:`/`data:` URLs, re-serialized with all text escaped, and delivered
  under `Content-Security-Policy: sandbox; default-src 'none'`.
- **Prompt injection** — page content reaches the model only inside a
  nonce-delimited block labelled untrusted, the system prompt forbids following
  instructions found there, and the output is parsed into a fixed JSON shape and
  clamped before use.
- **Abuse** — `robots.txt` is respected on the first request and on every crawl;
  401/403 is treated as "we are being turned away" with a six-hour backoff, never
  as a disappearance; 429 honours `Retry-After`; errors back off exponentially
  with jitter and a six-hour cap; per-domain spacing and queue concurrency bound
  the load a single site can ever see.

## Testing

```bash
npm test         # 103 unit and integration tests
npm run typecheck
```

Coverage focuses on the parts where a bug would be invisible in production:
content addressing (against published IPFS vectors), SSRF classification, HTML
parsing and normalization, hash stability under pure noise, diff correctness and
reconstruction, scoring bands, `robots.txt` semantics, backoff, the sanitizer,
the PNG encoder, and a full two-capture pipeline run including the
store-and-rehydrate round trip.

## Project layout

```
src/
  index.ts              fetch / scheduled / queue entry points
  router.ts             tiny pattern router
  types.ts              bindings and domain types
  lib/
    urlguard.ts         SSRF defence, URL canonicalization
    robots.ts           robots.txt parsing and caching
    fetcher.ts          bounded HTTP fetching, backoff, throttling
    html.ts             forgiving HTML tokenizer
    normalize.ts        canonical representation + noise suppression
    diff.ts             patience/Myers diff, rows, hunks, stats
    detect.ts           change classification and scoring
    price.ts            price extraction and pairing
    cid.ts              CIDv1, UnixFS, dag-pb, CARv1
    sanitize.ts         archived-HTML sanitizer
    png.ts              indexed PNG encoder
    hash.ts             SHA-256, ids, constant-time compare
  store/                ContentStore interface, R2, IPFS, tiered
  db/repo.ts            all SQL
  pipeline/             crawl, processCapture, scheduler, notify, digest, demo
  ai/                   prompts and the analysis layer
  api/                  JSON API, admin routes, auth, site service
  ui/                   layout, components, pages, share card, RSS
migrations/             D1 schema
seed/sites.json         the curated watchlist
test/                   unit and integration tests
```

## License

MIT
