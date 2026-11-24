/**
 * Price extraction.
 *
 * Prices are the highest-signal thing on a monitored page, so they get a
 * dedicated extractor rather than being left to the generic text diff.
 */

export interface PriceMention {
  /** Raw matched text, e.g. "$19/month". */
  raw: string;
  currency: string;
  amount: number;
  /** monthly | yearly | one-time | usage | unknown */
  period: string;
  /** Nearest plan/section label, e.g. "Pro". */
  label: string | null;
  /** Position in the extracted text, used to pair up before/after mentions. */
  index: number;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR', '₽': 'RUB',
  '₩': 'KRW', '₺': 'TRY', '₪': 'ILS', 'R$': 'BRL', 'C$': 'CAD', 'A$': 'AUD',
};

const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'DKK',
  'PLN', 'INR', 'BRL', 'MXN', 'SGD', 'NZD', 'ZAR', 'KRW', 'CNY', 'TRY',
]);

const PERIOD_PATTERNS: [RegExp, string][] = [
  [/\/\s*(mo|month|monthly|mth)\b/i, 'monthly'],
  [/\bper\s+month\b/i, 'monthly'],
  [/\ba\s+month\b/i, 'monthly'],
  [/\/\s*(yr|year|yearly|annually|annum)\b/i, 'yearly'],
  [/\bper\s+year\b/i, 'yearly'],
  [/\ba\s+year\b/i, 'yearly'],
  [/\/\s*(seat|user|member)\b/i, 'per-seat'],
  [/\bper\s+(seat|user|member)\b/i, 'per-seat'],
  [/\/\s*(1M|million|1K|thousand|request|call|token)s?\b/i, 'usage'],
  [/\bper\s+(1M|million|1K|thousand|request|call|token)s?\b/i, 'usage'],
  [/\bone[- ]time\b/i, 'one-time'],
];

function parseAmount(text: string): number | null {
  const cleaned = text.replace(/\s/g, '');
  // 1,234.56 (en) vs 1.234,56 (de) — decide by the last separator.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  else normalized = cleaned.replace(/,/g, '');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

const PRICE_PATTERN = new RegExp(
  [
    // Symbol first: $19, €1.234,56, R$ 99
    '(?<sym>R\\$|C\\$|A\\$|[$£€¥₹₽₩₺₪])\\s?(?<amt1>\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)',
    // Code first or after: USD 19 / 19 USD / 19 EUR
    '(?<code>\\b[A-Z]{3})\\s?(?<amt2>\\d+(?:[.,]\\d{1,3})*(?:[.,]\\d{1,2})?)',
    '(?<amt3>\\d+(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?)\\s?(?<code2>[A-Z]{3}\\b)',
  ].join('|'),
  'g',
);

/** Extract price mentions with their surrounding period and label. */
export function extractPrices(text: string, labels: { index: number; text: string }[] = []): PriceMention[] {
  const out: PriceMention[] = [];
  PRICE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PRICE_PATTERN.exec(text)) !== null && out.length < 400) {
    const groups = match.groups ?? {};
    let currency: string | null = null;
    let amountText: string | null = null;

    if (groups.sym && groups.amt1) {
      currency = CURRENCY_SYMBOLS[groups.sym] ?? groups.sym;
      amountText = groups.amt1;
    } else if (groups.code && groups.amt2 && CURRENCY_CODES.has(groups.code)) {
      currency = groups.code;
      amountText = groups.amt2;
    } else if (groups.code2 && groups.amt3 && CURRENCY_CODES.has(groups.code2)) {
      currency = groups.code2;
      amountText = groups.amt3;
    }
    if (!currency || !amountText) continue;

    const amount = parseAmount(amountText);
    if (amount === null || amount > 100_000_000) continue;

    const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 28);
    let period = 'unknown';
    for (const [pattern, name] of PERIOD_PATTERNS) {
      if (pattern.test(tail)) {
        period = name;
        break;
      }
    }

    let label: string | null = null;
    for (const candidate of labels) {
      if (candidate.index <= match.index) label = candidate.text;
      else break;
    }

    out.push({
      raw: (match[0] + (tail.match(/^\s*\/?\s*[a-zA-Z0-9 ]{0,12}/)?.[0] ?? '')).trim().slice(0, 40),
      currency,
      amount,
      period,
      label,
      index: match.index,
    });
  }
  return out;
}

export function formatMoney(currency: string, amount: number): string {
  const symbol = Object.entries(CURRENCY_SYMBOLS).find(([, code]) => code === currency)?.[0];
  const rendered = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return symbol ? `${symbol}${rendered}` : `${rendered} ${currency}`;
}

export interface PriceChange {
  label: string | null;
  period: string;
  currency: string;
  before: number;
  after: number;
  /** Percentage change, e.g. 26.3 for $19 → $24. */
  percent: number;
  direction: 'up' | 'down';
}

/**
 * Pair up before/after price mentions.
 *
 * Matching is by (label, period, currency) first, then by ordinal position
 * within the same currency+period bucket — which is what a pricing table
 * edit actually looks like.
 */
export function diffPrices(before: PriceMention[], after: PriceMention[]): PriceChange[] {
  const key = (p: PriceMention) => `${p.label ?? ''}|${p.period}|${p.currency}`;
  const changes: PriceChange[] = [];
  const usedAfter = new Set<number>();

  const groupBy = (list: PriceMention[]) => {
    const map = new Map<string, PriceMention[]>();
    list.forEach((p) => {
      const k = key(p);
      const bucket = map.get(k);
      if (bucket) bucket.push(p);
      else map.set(k, [p]);
    });
    return map;
  };

  const beforeGroups = groupBy(before);
  const afterGroups = groupBy(after);

  for (const [k, beforeList] of beforeGroups) {
    const afterList = afterGroups.get(k);
    if (!afterList) continue;
    const count = Math.min(beforeList.length, afterList.length);
    for (let i = 0; i < count; i++) {
      const b = beforeList[i];
      const a = afterList[i];
      const afterIndex = after.indexOf(a);
      if (usedAfter.has(afterIndex)) continue;
      usedAfter.add(afterIndex);
      if (b.amount === a.amount) continue;
      if (b.amount === 0) continue;
      const percent = ((a.amount - b.amount) / b.amount) * 100;
      changes.push({
        label: b.label,
        period: b.period,
        currency: b.currency,
        before: b.amount,
        after: a.amount,
        percent: Math.round(percent * 10) / 10,
        direction: a.amount > b.amount ? 'up' : 'down',
      });
    }
  }

  // Rank by absolute impact so the headline picks the most meaningful move.
  return changes.sort((x, y) => Math.abs(y.percent) - Math.abs(x.percent)).slice(0, 20);
}
