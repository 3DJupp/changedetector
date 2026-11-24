/**
 * Sanitizer for archived HTML.
 *
 * Captured pages are hostile by definition. Archived HTML is never served on
 * the app origin as-is: it is re-parsed, stripped of every executable and
 * network-fetching construct, re-serialized, and then delivered under a
 * `sandbox` CSP with no permitted sources at all. Defence in depth — either
 * layer alone would do, and stored XSS needs both to fail.
 */
import { Element, escapeHtml, Node, parseHtml } from './html';

const DROP_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'base', 'form', 'input', 'button', 'select', 'textarea', 'option',
  'noscript', 'template', 'portal', 'audio', 'video', 'source', 'track', 'canvas',
  'math', 'svg',
]);

const VOID_ELEMENTS = new Set([
  'area', 'br', 'col', 'hr', 'img', 'wbr',
]);

const ALLOWED_ATTRS = new Set([
  'alt', 'title', 'colspan', 'rowspan', 'datetime', 'lang', 'dir', 'width', 'height',
]);

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (/^(https?:)?\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // javascript:, data:, vbscript:, …
  return trimmed;
}

function serialize(node: Node, depth: number, out: string[]): void {
  if (depth > 100) return;
  if (node.type === 'text') {
    out.push(escapeHtml(node.value));
    return;
  }
  const element = node as Element;
  if (DROP_ELEMENTS.has(element.tag) || element.tag.includes(':')) return;
  if (element.tag === '#root') {
    for (const child of element.children) serialize(child, depth + 1, out);
    return;
  }

  const attributes: string[] = [];
  for (const [name, value] of Object.entries(element.attrs)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('on') || lower === 'srcset' || lower === 'style' || lower === 'formaction') continue;
    if (lower === 'href' || lower === 'src' || lower === 'cite') {
      const url = safeUrl(value);
      if (!url) continue;
      // Archived links are inert: they point out, but never carry referrer.
      attributes.push(`${lower}="${escapeHtml(url)}"`);
      if (lower === 'href') attributes.push('rel="nofollow noopener noreferrer"');
      continue;
    }
    if (ALLOWED_ATTRS.has(lower)) attributes.push(`${lower}="${escapeHtml(value)}"`);
  }

  const open = `<${element.tag}${attributes.length ? ' ' + attributes.join(' ') : ''}>`;
  out.push(open);
  if (VOID_ELEMENTS.has(element.tag)) return;
  for (const child of element.children) serialize(child, depth + 1, out);
  out.push(`</${element.tag}>`);
}

export function sanitizeArchivedHtml(html: string): string {
  const root = parseHtml(html, { maxNodes: 120000 });
  const out: string[] = [];
  serialize(root, 0, out);
  return out.join('');
}

/** Headers that make an archived page inert even if sanitization missed something. */
export const ARCHIVE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};
