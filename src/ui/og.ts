/**
 * The share card.
 *
 * Rendered twice from one model: a PNG for og:image (what X, LinkedIn, Slack
 * and Discord actually unfurl) and an SVG for humans who want a crisp download.
 * PNGs are cached in R2 by change id, so each card is rendered once.
 */
import { Canvas, encodeIndexedPngAsync } from '../lib/png';
import { FONT_HEIGHT, FONT_WIDTH, glyphFor, textWidth, wrapText } from './font';
import { escapeHtml } from '../lib/html';

export interface CardModel {
  headline: string;
  before: string | null;
  after: string | null;
  delta: string | null;
  /** Severity chip top right. Null for cards that are not about one change. */
  severity: string | null;
  /** Rendered as "DETECTED <detectedAt>" unless footer is given. */
  detectedAt?: string;
  /** Left footer text, replacing the "DETECTED …" line. */
  footer?: string;
  url: string;
  /** Small label above the headline, e.g. the category or "DAILY DIGEST". */
  kicker?: string;
  category?: string;
}

const WIDTH = 1200;
const HEIGHT = 630;

/** Bump when the card layout changes, so cached PNGs are regenerated. */
export const CARD_VERSION = 3;

// Palette index map for the card.
const PAPER = 0;
const INK = 1;
const RED = 2;
const GRAY = 3;
const RULE = 4;
const AMBER = 5;
const BLUE = 6;
const GREEN = 7;

const PALETTE: [number, number, number][] = [
  [244, 242, 237], // 0 paper
  [22, 24, 28], //   1 ink
  [198, 51, 47], //  2 red
  [122, 128, 137], //3 gray
  [214, 211, 204], //4 rule
  [166, 114, 27], // 5 amber
  [42, 120, 214], // 6 blue
  [46, 138, 94], //  7 green
  [14, 17, 22], //   8 near-black (unused spare)
  [255, 255, 255], //9 white
  [154, 160, 168], //10 mid gray
  [232, 229, 222], //11 light rule
  [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
];

function accentFor(severity: string | null): number {
  if (!severity) return RED;
  if (severity === 'MAJOR') return RED;
  if (severity === 'SIGNIFICANT' || severity === 'MODERATE') return AMBER;
  if (severity === 'MINOR') return BLUE;
  return GRAY;
}

function drawText(
  canvas: Canvas,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: number,
  tracking = 1,
): number {
  let cursorX = x;
  for (const char of text) {
    const glyph = glyphFor(char);
    for (let row = 0; row < FONT_HEIGHT; row++) {
      const bits = glyph[row];
      for (let column = 0; column < FONT_WIDTH; column++) {
        if (bits & (1 << (FONT_WIDTH - 1 - column))) {
          canvas.fillRect(cursorX + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursorX += (FONT_WIDTH + tracking) * scale;
  }
  return cursorX;
}

function strikeThrough(canvas: Canvas, x: number, y: number, width: number, scale: number, color: number): void {
  canvas.fillRect(x, y + Math.floor((FONT_HEIGHT * scale) / 2), width, Math.max(2, scale / 2), color);
}

/**
 * The bitmap font is ASCII plus a few symbols. Map what it cannot draw to the
 * closest thing it can, instead of rendering "?" for every umlaut.
 */
export function cardText(text: string): string {
  return text
    .replace(/ß/g, 'ss')
    .replace(/[Ææ]/g, 'AE')
    .replace(/[Øø]/g, 'O')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[\u00a0\u2000-\u200b]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FOOTER_RULE_Y = HEIGHT - 96;
const CONTENT_TOP = 136;

function drawCard(model: CardModel): Canvas {
  const canvas = new Canvas(WIDTH, HEIGHT, PAPER);
  const accent = accentFor(model.severity);
  const margin = 72;

  // Accent rail and brand line.
  canvas.fillRect(0, 0, WIDTH, 10, accent);
  canvas.fillRect(margin, 72, 18, 18, RED);
  drawText(canvas, 'THE INTERNET CHANGE DETECTOR', margin + 34, 74, 2, GRAY, 2);

  // Severity chip.
  if (model.severity) {
    const chip = model.severity.toUpperCase();
    const chipWidth = textWidth(chip, 3, 2) + 28;
    canvas.fillRect(WIDTH - margin - chipWidth, 66, chipWidth, 34, accent);
    drawText(canvas, chip, WIDTH - margin - chipWidth + 14, 76, 3, PAPER, 2);
  }

  // Headline, wrapped and shrunk until it fits in four lines at most.
  const headline = cardText(model.headline).toUpperCase();
  const maxWidth = WIDTH - margin * 2;
  let scale = 7;
  let lines = wrapText(headline, scale, maxWidth);
  while (lines.length > 3 && scale > 4) {
    scale -= 1;
    lines = wrapText(headline, scale, maxWidth);
  }
  if (lines.length > 4) {
    lines = lines.slice(0, 4);
    lines[3] = lines[3].replace(/\s*\S*$/, '') + '…';
  }
  const lineHeight = FONT_HEIGHT * scale + Math.round(scale * 3.2);
  const headlineHeight = lines.length * lineHeight - Math.round(scale * 3.2);

  const before = model.before ? cardText(model.before) : null;
  const after = model.after ? cardText(model.after) : null;
  const delta = model.delta ? cardText(model.delta) : null;
  const kicker = model.kicker ? cardText(model.kicker).toUpperCase() : null;

  // Lay the block out as a whole and centre it between brand line and footer,
  // instead of pinning the values to a fixed row and leaving a hole.
  const kickerHeight = kicker ? FONT_HEIGHT * 3 + 22 : 0;
  const valueScale = before && after ? 8 : 7;
  const valueHeight = before && after ? FONT_HEIGHT * valueScale : delta ? FONT_HEIGHT * valueScale : 0;
  const valueGap = valueHeight ? 46 : 0;
  const blockHeight = kickerHeight + headlineHeight + valueGap + valueHeight;
  const available = FOOTER_RULE_Y - 40 - CONTENT_TOP;
  let y = CONTENT_TOP + Math.max(0, Math.floor((available - blockHeight) / 2));

  if (kicker) {
    drawText(canvas, kicker, margin, y, 3, accent, 2);
    y += kickerHeight;
  }
  for (const line of lines) {
    drawText(canvas, line, margin, y, scale, INK);
    y += lineHeight;
  }
  y += valueGap - Math.round(scale * 3.2);

  if (before && after) {
    let bigScale = valueScale;
    const arrowGap = 34;
    const rowWidth = (s: number) =>
      textWidth(before, s) + textWidth(after, s) + textWidth('→', s) + arrowGap * 2 + (delta ? 40 + textWidth(delta, 5) : 0);
    while (rowWidth(bigScale) > maxWidth && bigScale > 4) bigScale -= 1;
    const top = y + Math.round(((valueScale - bigScale) * FONT_HEIGHT) / 2);
    const beforeWidth = textWidth(before, bigScale);
    drawText(canvas, before, margin, top, bigScale, GRAY);
    strikeThrough(canvas, margin, top, beforeWidth, bigScale, GRAY);
    let cursor = margin + beforeWidth + arrowGap;
    drawText(canvas, '→', cursor, top, bigScale, GRAY);
    cursor += textWidth('→', bigScale) + arrowGap;
    drawText(canvas, after, cursor, top, bigScale, INK);
    cursor += textWidth(after, bigScale) + 40;
    if (delta) drawText(canvas, delta, cursor, top + Math.round((FONT_HEIGHT * (bigScale - 5)) / 2), 5, accent);
  } else if (delta) {
    let deltaScale = valueScale;
    while (textWidth(delta, deltaScale) > maxWidth && deltaScale > 3) deltaScale -= 1;
    drawText(canvas, delta, margin, y, deltaScale, accent);
  }

  // Footer: two texts that must never collide, so they are measured and, if
  // necessary, shrunk and elided before being drawn.
  canvas.fillRect(margin, FOOTER_RULE_Y, WIDTH - margin * 2, 3, RULE);
  const footerWidth = WIDTH - margin * 2;
  let left = cardText(model.footer ?? (model.detectedAt ? `DETECTED ${model.detectedAt}` : '')).toUpperCase();
  const fullRight = cardText(model.url.replace(/^https?:\/\//, '')).toUpperCase();
  let right = fullRight;
  let footerScale = 3;
  const gap = 40;
  const fits = () => textWidth(left, footerScale, 2) + textWidth(right, footerScale, 2) + gap <= footerWidth;

  if (!fits()) left = left.replace(/ \d{2}:\d{2} UTC$/, ''); // drop the clock time first
  if (!fits()) footerScale = 2;
  while (!fits() && right.length > 12) right = right.slice(0, -2);
  if (right !== fullRight) right += '…';

  if (left) drawText(canvas, left, margin, HEIGHT - 68, footerScale, GRAY, 2);
  drawText(canvas, right, WIDTH - margin - textWidth(right, footerScale, 2), HEIGHT - 68, footerScale, GRAY, 2);

  return canvas;
}

/** Render the 1200x630 share card as a compressed PNG. */
export async function renderCardPng(model: CardModel): Promise<Uint8Array> {
  const canvas = drawCard(model);
  return encodeIndexedPngAsync({ width: WIDTH, height: HEIGHT, pixels: canvas.pixels, palette: PALETTE });
}

/** The same card as SVG, for downloads and high-DPI embedding. */
export function renderCardSvg(model: CardModel): string {
  const e = escapeHtml;
  const accentHex =
    model.severity === 'MAJOR' ? '#C6332F' :
    model.severity === 'SIGNIFICANT' || model.severity === 'MODERATE' ? '#A6721B' :
    model.severity === 'MINOR' ? '#2A78D6' : '#7A8089';

  const words = model.headline.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  const maxChars = model.headline.length > 90 ? 34 : 28;
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars && current) {
      lines.push(current);
      current = word;
    } else current = (current ? current + ' ' : '') + word;
  }
  if (current) lines.push(current);
  const shown = lines.slice(0, 4);

  const values =
    model.before && model.after
      ? `<text x="72" y="470" font-family="ui-monospace,Menlo,monospace" font-size="62" fill="#9AA0A8" text-decoration="line-through">${e(model.before)}</text>
         <text x="${72 + Math.max(140, model.before.length * 38)}" y="470" font-family="ui-monospace,Menlo,monospace" font-size="62" fill="#16181C">${e(model.after)}</text>`
      : model.delta
        ? `<text x="72" y="470" font-family="ui-monospace,Menlo,monospace" font-size="62" fill="${accentHex}">${e(model.delta)}</text>`
        : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#F4F2ED"/>
  <rect width="1200" height="10" fill="${accentHex}"/>
  <rect x="72" y="72" width="18" height="18" fill="#D63B42"/>
  <text x="106" y="88" font-family="ui-monospace,Menlo,monospace" font-size="15" letter-spacing="3" fill="#5B6068">THE INTERNET CHANGE DETECTOR</text>
  ${model.severity ? `<rect x="${1128 - model.severity.length * 15}" y="66" width="${model.severity.length * 15}" height="34" fill="${accentHex}"/>
  <text x="${1128 - model.severity.length * 15 + 12}" y="90" font-family="ui-monospace,Menlo,monospace" font-size="15" fill="#F4F2ED">${e(model.severity)}</text>` : ''}
  ${shown
    .map(
      (line, index) =>
        `<text x="72" y="${210 + index * 62}" font-family="Helvetica,Arial,sans-serif" font-size="54" font-weight="800" letter-spacing="-2" fill="#16181C">${e(line)}</text>`,
    )
    .join('\n  ')}
  ${values}
  ${model.delta && model.before ? `<text x="72" y="530" font-family="ui-monospace,Menlo,monospace" font-size="34" fill="${accentHex}">${e(model.delta)}</text>` : ''}
  <line x1="72" y1="546" x2="1128" y2="546" stroke="#D6D3CC" stroke-width="2"/>
  <text x="72" y="580" font-family="ui-monospace,Menlo,monospace" font-size="16" fill="#7A8089">${e((model.footer ?? (model.detectedAt ? `DETECTED ${model.detectedAt}` : '')).toUpperCase())}</text>
  <text x="1128" y="580" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="16" fill="#7A8089">${e(model.url.replace(/^https?:\/\//, ''))}</text>
</svg>`;
}
