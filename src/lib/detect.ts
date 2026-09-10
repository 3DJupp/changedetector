/**
 * Change detection and scoring.
 *
 * Layered, in this order — each layer is cheaper than the next:
 *   1. content hash        → identical? stop, no event, nothing stored twice
 *   2. semantic text diff  → what text actually changed
 *   3. structural diff     → sections, headings, links, images, metadata
 *   4. significance score  → 0-100 magnitude of the change
 *   5. interestingness     → 0-100 editorial value, decides publication
 */
import { buildHunks, buildRows, computeStats, diffLines, DiffRow, setDifference } from './diff';
import { NormalizedDocument } from './normalize';
import { diffPrices, formatMoney, PriceChange } from './price';
import type { ChangeType, Severity } from '../types';

export interface Signal {
  name: string;
  points: number;
  detail?: string;
}

export interface StructuralDiff {
  headingsAdded: string[];
  headingsRemoved: string[];
  headingsChanged: { before: string; after: string }[];
  linksAdded: string[];
  linksRemoved: string[];
  imagesAdded: string[];
  imagesRemoved: string[];
  metaChanged: { key: string; before: string; after: string }[];
  titleChanged: { before: string; after: string } | null;
  sectionsAdded: number;
  sectionsRemoved: number;
}

export interface DetectionInput {
  siteTitle: string;
  url: string;
  category: string;
  previous: NormalizedDocument | null;
  current: NormalizedDocument;
  previousStatus: number | null;
  currentStatus: number;
}

export interface DetectionResult {
  changed: boolean;
  changeType: ChangeType;
  severity: Severity;
  changeScore: number;
  interestingness: number;
  headline: string;
  summary: string;
  label: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  delta: string | null;
  deltaNote: string | null;
  signals: Signal[];
  priceChanges: PriceChange[];
  structural: StructuralDiff;
  stats: ReturnType<typeof computeStats>;
  rows: DiffRow[];
  keywords: string[];
}

/** Words whose appearance or disappearance is newsworthy on its own. */
const HIGH_SIGNAL_KEYWORDS = [
  'deprecated', 'deprecation', 'sunset', 'discontinued', 'end of life', 'end-of-life',
  'breaking change', 'no longer available', 'no longer supported', 'shutting down',
  'acquired', 'acquisition', 'merger', 'layoff', 'rebrand',
  'vulnerability', 'security advisory', 'data breach', 'incident',
  'rate limit', 'quota', 'free tier', 'usage limit', 'fair use',
  'waitlist', 'general availability', 'now available', 'coming soon',
  'sold out', 'out of stock', 'back in stock', 'discontinued',
  'arbitration', 'class action', 'data retention', 'terms of service',
  'price increase', 'new pricing', 'per seat', 'per user',
];

const LEGAL_PATH = /(terms|tos|legal|privacy|policy|policies|dpa|agreement|aup|eula|conditions)/i;
const PRICING_PATH = /(pricing|price|plans|billing|subscribe|upgrade|cost)/i;

export function severityFromScore(score: number): Severity {
  if (score >= 81) return 'MAJOR';
  if (score >= 61) return 'SIGNIFICANT';
  if (score >= 31) return 'MODERATE';
  if (score >= 11) return 'MINOR';
  return 'TRIVIAL';
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function structuralDiff(before: NormalizedDocument, after: NormalizedDocument): StructuralDiff {
  const headingKey = (h: { level: number; text: string }) => `${h.level}:${h.text.toLowerCase()}`;
  const headings = setDifference(before.headings, after.headings, headingKey);

  // A heading whose text changed but whose neighbours did not is a "changed"
  // heading rather than an add + a remove.
  const headingsChanged: { before: string; after: string }[] = [];
  const removedPool = [...headings.removed];
  const addedPool = [...headings.added];
  for (let i = removedPool.length - 1; i >= 0; i--) {
    const removed = removedPool[i];
    const matchIndex = addedPool.findIndex(
      (added) => added.level === removed.level && Math.abs(added.index - removed.index) <= 1,
    );
    if (matchIndex !== -1) {
      headingsChanged.push({ before: removed.text, after: addedPool[matchIndex].text });
      addedPool.splice(matchIndex, 1);
      removedPool.splice(i, 1);
    }
  }

  const links = setDifference(before.links, after.links, (l) => l.href);
  const images = setDifference(before.images, after.images, (i) => i.src);

  const metaChanged: { key: string; before: string; after: string }[] = [];
  const metaKeys = new Set([...Object.keys(before.meta), ...Object.keys(after.meta)]);
  for (const key of metaKeys) {
    const b = before.meta[key] ?? '';
    const a = after.meta[key] ?? '';
    if (b !== a) metaChanged.push({ key, before: b, after: a });
  }

  const blockDelta = after.stats.blockCount - before.stats.blockCount;

  return {
    headingsAdded: addedPool.map((h) => h.text),
    headingsRemoved: removedPool.map((h) => h.text),
    headingsChanged,
    linksAdded: links.added.map((l) => l.href).slice(0, 200),
    linksRemoved: links.removed.map((l) => l.href).slice(0, 200),
    imagesAdded: images.added.map((i) => i.src).slice(0, 100),
    imagesRemoved: images.removed.map((i) => i.src).slice(0, 100),
    metaChanged,
    titleChanged: before.title !== after.title ? { before: before.title, after: after.title } : null,
    sectionsAdded: Math.max(0, blockDelta),
    sectionsRemoved: Math.max(0, -blockDelta),
  };
}

function keywordHits(before: string, after: string): string[] {
  const beforeLower = before.toLowerCase();
  const afterLower = after.toLowerCase();
  const hits: string[] = [];
  for (const keyword of HIGH_SIGNAL_KEYWORDS) {
    const inBefore = beforeLower.includes(keyword);
    const inAfter = afterLower.includes(keyword);
    if (inBefore !== inAfter) hits.push(keyword);
  }
  return [...new Set(hits)].slice(0, 12);
}

function pickChangeType(
  price: PriceChange[],
  structural: StructuralDiff,
  statusChanged: boolean,
  stats: ReturnType<typeof computeStats>,
): ChangeType {
  if (statusChanged) return 'STATUS_CODE';
  if (price.length > 0) return 'PRICE';
  if (structural.titleChanged) return 'TITLE';
  if (structural.headingsAdded.length || structural.headingsRemoved.length || structural.headingsChanged.length) {
    return 'STRUCTURE';
  }
  if (stats.added + stats.removed + stats.changed > 0) return 'TEXT';
  if (structural.linksAdded.length || structural.linksRemoved.length) return 'LINK';
  if (structural.imagesAdded.length || structural.imagesRemoved.length) return 'IMAGE';
  if (structural.metaChanged.length) return 'METADATA';
  return 'CONTENT';
}

function describePriceChange(change: PriceChange): { headlineFragment: string; delta: string; note: string } {
  const before = formatMoney(change.currency, change.before);
  const after = formatMoney(change.currency, change.after);
  const verb = change.direction === 'up' ? 'raised' : 'cut';
  const label = change.label ? `${change.label} ` : '';
  const periodNote =
    change.period === 'monthly'
      ? 'monthly price movement'
      : change.period === 'yearly'
        ? 'annual price movement'
        : change.period === 'per-seat'
          ? 'per-seat price movement'
          : change.period === 'usage'
            ? 'usage price movement'
            : 'price movement';
  const sign = change.percent > 0 ? '+' : '';
  return {
    headlineFragment: `${verb} ${label}pricing from ${before} to ${after}`,
    delta: `${sign}${change.percent.toFixed(1)}%`,
    note: periodNote,
  };
}

/** The whole detection pipeline for one pair of snapshots. */
export function detectChange(input: DetectionInput): DetectionResult {
  const { previous, current, siteTitle, url, category } = input;
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  const empty: StructuralDiff = {
    headingsAdded: [], headingsRemoved: [], headingsChanged: [],
    linksAdded: [], linksRemoved: [], imagesAdded: [], imagesRemoved: [],
    metaChanged: [], titleChanged: null, sectionsAdded: 0, sectionsRemoved: 0,
  };

  if (!previous) {
    return {
      changed: false,
      changeType: 'CONTENT',
      severity: 'TRIVIAL',
      changeScore: 0,
      interestingness: 0,
      headline: `${siteTitle} added to monitoring`,
      summary: 'First snapshot captured. Future captures will be compared against it.',
      label: null, beforeValue: null, afterValue: null, delta: null, deltaNote: null,
      signals: [], priceChanges: [], structural: empty,
      stats: computeStats([]), rows: [], keywords: [],
    };
  }

  const rows = buildRows(diffLines(previous.blocks, current.blocks));
  const stats = computeStats(rows);
  const structural = structuralDiff(previous, current);
  const priceChanges = diffPrices(previous.prices, current.prices);
  const keywords = keywordHits(previous.text, current.text);

  const statusChanged = input.previousStatus !== null && input.previousStatus !== input.currentStatus;
  // 401/403 usually mean "the crawler was blocked", not "the page is gone", and
  // are handled upstream as an error rather than a disappearance.
  const GONE_STATUSES = [404, 410, 451];
  const wentMissing = GONE_STATUSES.includes(input.currentStatus) && (input.previousStatus ?? 200) < 400;
  const cameBack = input.currentStatus < 400 && (input.previousStatus ?? 200) >= 400;

  const signals: Signal[] = [];
  const add = (name: string, points: number, detail?: string) => {
    if (points !== 0) signals.push({ name, points, detail });
  };

  // --- magnitude ------------------------------------------------------------
  const textPercent = stats.ratio * 100;
  let changeScore = 0;
  changeScore += Math.min(35, textPercent * 1.4);
  changeScore += Math.min(20, (structural.headingsAdded.length + structural.headingsRemoved.length) * 6);
  changeScore += Math.min(10, structural.headingsChanged.length * 5);
  changeScore += structural.titleChanged ? 12 : 0;
  changeScore += Math.min(8, (structural.linksAdded.length + structural.linksRemoved.length) * 0.4);
  changeScore += Math.min(5, (structural.imagesAdded.length + structural.imagesRemoved.length) * 1.5);
  changeScore += priceChanges.length ? 25 : 0;
  changeScore += statusChanged ? 30 : 0;
  changeScore = clamp(changeScore);

  // --- interestingness ------------------------------------------------------
  let interestingness = 0;

  if (wentMissing) {
    add('Page disappeared', 65, `HTTP ${input.currentStatus}`);
    interestingness += 65;
  } else if (cameBack) {
    add('Page came back', 30, `HTTP ${input.currentStatus}`);
    interestingness += 30;
  } else if (statusChanged) {
    add('HTTP status changed', 20, `${input.previousStatus} → ${input.currentStatus}`);
    interestingness += 20;
  }

  if (priceChanges.length > 0) {
    const top = priceChanges[0];
    const magnitude = Math.min(15, Math.abs(top.percent) / 4);
    add('Pricing changed', 40 + magnitude, `${priceChanges.length} price(s) moved`);
    interestingness += 40 + magnitude;
  }

  if (structural.titleChanged) {
    add('Title changed', 20, `${structural.titleChanged.before} → ${structural.titleChanged.after}`);
    interestingness += 20;
  }

  const headingChangeCount =
    structural.headingsAdded.length + structural.headingsRemoved.length + structural.headingsChanged.length;
  if (headingChangeCount > 0) {
    const points = Math.min(22, 8 + headingChangeCount * 3);
    add('Headings changed', points, `${headingChangeCount} heading(s)`);
    interestingness += points;
  }

  if (textPercent > 0) {
    const points = Math.min(20, textPercent * 0.8);
    add('Text difference', points, `${textPercent.toFixed(1)}% of lines`);
    interestingness += points;
  }

  const bigSection = Math.max(structural.sectionsAdded, structural.sectionsRemoved);
  if (bigSection >= 5) {
    const points = Math.min(15, bigSection * 0.8);
    add(structural.sectionsAdded > structural.sectionsRemoved ? 'Large section added' : 'Large section removed', points);
    interestingness += points;
  }

  if (keywords.length > 0) {
    const points = Math.min(24, keywords.length * 8);
    add('High-signal keywords', points, keywords.slice(0, 4).join(', '));
    interestingness += points;
  }

  if (LEGAL_PATH.test(path) && stats.ratio > 0.005) {
    add('Legal / terms page', 15, path);
    interestingness += 15;
  }
  if (PRICING_PATH.test(path) && (stats.ratio > 0.01 || priceChanges.length > 0)) {
    add('Pricing page', 10, path);
    interestingness += 10;
  }
  if (category === 'Security' && stats.ratio > 0.005) {
    add('Security category', 12);
    interestingness += 12;
  }

  const cosmeticOnly =
    stats.added + stats.removed + stats.changed === 0 &&
    !structural.titleChanged &&
    headingChangeCount === 0 &&
    priceChanges.length === 0 &&
    !statusChanged;
  if (cosmeticOnly) {
    const linkOnly = structural.linksAdded.length + structural.linksRemoved.length;
    const metaOnly = structural.metaChanged.length;
    if (linkOnly > 0) {
      add('Links only', Math.min(8, 1 + linkOnly * 0.3));
      interestingness += Math.min(8, 1 + linkOnly * 0.3);
    }
    if (metaOnly > 0) {
      add('Metadata only', 3);
      interestingness += 3;
    }
    if (linkOnly === 0 && metaOnly === 0) {
      add('Cosmetic change', 1);
      interestingness += 1;
    }
  }

  // Tiny diffs on big pages are almost always noise that slipped the filters.
  if (textPercent < 0.5 && priceChanges.length === 0 && !statusChanged && !structural.titleChanged) {
    add('Sub-threshold diff', -12, `${textPercent.toFixed(2)}% of lines`);
    interestingness -= 12;
  }

  // A page that vanished is a major event by definition, whatever else moved.
  if (wentMissing) interestingness = Math.max(interestingness, 82);
  interestingness = clamp(interestingness);
  const changed =
    stats.added + stats.removed + stats.changed > 0 ||
    statusChanged ||
    priceChanges.length > 0 ||
    structural.titleChanged !== null ||
    structural.metaChanged.length > 0 ||
    structural.linksAdded.length + structural.linksRemoved.length > 0 ||
    structural.imagesAdded.length + structural.imagesRemoved.length > 0;

  const changeType = pickChangeType(priceChanges, structural, statusChanged, stats);
  const severity = severityFromScore(interestingness);

  // --- human-readable summary ----------------------------------------------
  let headline = `${siteTitle} updated ${path === '/' ? 'its homepage' : path}`;
  let summary = `${stats.changed} line(s) changed, ${stats.added} added, ${stats.removed} removed.`;
  let label: string | null = null;
  let beforeValue: string | null = null;
  let afterValue: string | null = null;
  let delta: string | null = null;
  let deltaNote: string | null = null;

  if (wentMissing) {
    headline = `${siteTitle} disappeared`;
    summary = `The page now returns HTTP ${input.currentStatus}. The last successful snapshot is preserved and addressable by CID.`;
    label = 'HTTP status';
    beforeValue = String(input.previousStatus ?? 200);
    afterValue = String(input.currentStatus);
    delta = 'GONE';
    deltaNote = 'page no longer resolves';
  } else if (cameBack) {
    headline = `${siteTitle} is back online`;
    summary = `The page resolves again (HTTP ${input.currentStatus}) after previously returning ${input.previousStatus}.`;
    label = 'HTTP status';
    beforeValue = String(input.previousStatus);
    afterValue = String(input.currentStatus);
    delta = 'BACK';
    deltaNote = 'page resolves again';
  } else if (priceChanges.length > 0) {
    const top = priceChanges[0];
    const described = describePriceChange(top);
    headline = `${siteTitle} ${described.headlineFragment}`;
    const others = priceChanges.length > 1 ? ` ${priceChanges.length - 1} other price(s) moved on the same page.` : '';
    summary = `${top.label ? `${top.label} ` : ''}${top.period === 'unknown' ? 'price' : top.period + ' price'} went from ${formatMoney(top.currency, top.before)} to ${formatMoney(top.currency, top.after)}.${others}`;
    label = top.label ?? 'Price';
    beforeValue = formatMoney(top.currency, top.before);
    afterValue = formatMoney(top.currency, top.after);
    delta = described.delta;
    deltaNote = described.note;
  } else if (structural.titleChanged) {
    headline = `${siteTitle} changed its page title`;
    summary = `"${structural.titleChanged.before}" became "${structural.titleChanged.after}".`;
    label = 'Page title';
    beforeValue = structural.titleChanged.before.slice(0, 60);
    afterValue = structural.titleChanged.after.slice(0, 60);
    delta = 'TITLE';
    deltaNote = 'document title replaced';
  } else if (structural.headingsAdded.length > 0) {
    const first = structural.headingsAdded[0];
    headline = `${siteTitle} added the "${first}" section`;
    summary = `${structural.headingsAdded.length} new section heading(s) appeared${structural.headingsRemoved.length ? ` and ${structural.headingsRemoved.length} were removed` : ''}.`;
    label = 'Sections';
    beforeValue = String(previous.stats.headingCount);
    afterValue = String(current.stats.headingCount);
    delta = `+${structural.headingsAdded.length}`;
    deltaNote = 'sections added';
  } else if (structural.headingsRemoved.length > 0) {
    headline = `${siteTitle} removed the "${structural.headingsRemoved[0]}" section`;
    summary = `${structural.headingsRemoved.length} section heading(s) disappeared from the page.`;
    label = 'Sections';
    beforeValue = String(previous.stats.headingCount);
    afterValue = String(current.stats.headingCount);
    delta = `−${structural.headingsRemoved.length}`;
    deltaNote = 'sections removed';
  } else if (keywords.length > 0) {
    headline = `${siteTitle} changed wording around "${keywords[0]}"`;
    summary = `Text mentioning ${keywords.slice(0, 3).join(', ')} was added or removed.`;
    label = 'Keywords';
    beforeValue = null;
    afterValue = null;
    delta = keywords.length > 1 ? `${keywords.length} terms` : keywords[0];
    deltaNote = 'high-signal wording';
  } else if (stats.changed + stats.added + stats.removed > 0) {
    const firstChanged = rows.find((row) => row.kind === 'changed');
    if (firstChanged?.left && firstChanged.right) {
      label = 'Text';
      beforeValue = firstChanged.left.slice(0, 60);
      afterValue = firstChanged.right.slice(0, 60);
      delta = `${textPercent.toFixed(1)}%`;
      deltaNote = 'of lines differ';
      summary = `"${firstChanged.left.slice(0, 90)}" became "${firstChanged.right.slice(0, 90)}".`;
    } else {
      delta = `${textPercent.toFixed(1)}%`;
      deltaNote = 'of lines differ';
    }
  } else if (cosmeticOnly) {
    headline = `${siteTitle} made a cosmetic change`;
    summary = 'Only links, images or metadata changed; the visible text is identical.';
    delta = 'MINOR';
    deltaNote = 'no visible text change';
  }

  return {
    changed,
    changeType,
    severity,
    changeScore,
    interestingness,
    headline: headline.slice(0, 220),
    summary: summary.slice(0, 600),
    label,
    beforeValue,
    afterValue,
    delta,
    deltaNote,
    signals: signals.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    priceChanges,
    structural,
    stats,
    rows,
    keywords,
  };
}

/** Compact, storable diff payload. Rows are capped so D1 rows stay small. */
export function buildDiffPayload(result: DetectionResult, maxRows = 400) {
  const hunks = buildHunks(result.rows, 3).slice(0, 40);
  let budget = maxRows;
  const trimmed = hunks.map((hunk) => {
    const rows = hunk.rows.slice(0, Math.max(0, budget));
    budget -= rows.length;
    return { header: hunk.header, rows: rows.map((row) => ({ ...row, words: undefined })) };
  });
  return {
    hunks: trimmed.filter((hunk) => hunk.rows.length > 0),
    stats: result.stats,
    structural: {
      ...result.structural,
      linksAdded: result.structural.linksAdded.slice(0, 30),
      linksRemoved: result.structural.linksRemoved.slice(0, 30),
    },
    priceChanges: result.priceChanges,
    keywords: result.keywords,
    truncated: result.rows.length > maxRows,
  };
}
