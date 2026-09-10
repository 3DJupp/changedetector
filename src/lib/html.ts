/**
 * A small, dependency-free, forgiving HTML tokenizer + tree builder.
 *
 * Written in portable TypeScript rather than using HTMLRewriter so the exact
 * same normalization runs inside the Worker and inside the unit tests.
 * It is deliberately tolerant: malformed markup must never throw.
 */

export interface Element {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}

export interface TextNode {
  type: 'text';
  value: string;
}

export type Node = Element | TextNode;

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'noscript']);

/** Tags that implicitly close an open sibling of the same kind. */
const IMPLICIT_CLOSE: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  p: ['p'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['tbody', 'tfoot'],
  tbody: ['thead', 'tbody', 'tfoot'],
  option: ['option'],
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', times: '×', divide: '÷', deg: '°', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  laquo: '«', raquo: '»', dagger: '†', permil: '‰', prime: '′',
  larr: '←', rarr: '→', harr: '↔', darr: '↓', uarr: '↑',
  infin: '∞', ne: '≠', le: '≤', ge: '≥', minus: '−',
  shy: '', zwj: '', zwnj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (!name || name === '/') continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
    if (Object.keys(attrs).length > 64) break; // defensive cap
  }
  return attrs;
}

export interface ParseOptions {
  /** Hard cap on nodes, protecting against pathological documents. */
  maxNodes?: number;
}

/** Parse an HTML document into a tolerant tree. Never throws. */
export function parseHtml(html: string, options: ParseOptions = {}): Element {
  const maxNodes = options.maxNodes ?? 200000;
  const root: Element = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  let nodeCount = 0;
  let index = 0;
  const length = html.length;

  const top = (): Element => stack[stack.length - 1];
  const pushText = (value: string) => {
    if (!value) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') last.value += value;
    else {
      parent.children.push({ type: 'text', value });
      nodeCount++;
    }
  };

  while (index < length && nodeCount < maxNodes) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      pushText(decodeEntities(html.slice(index)));
      break;
    }
    if (lt > index) pushText(decodeEntities(html.slice(index, lt)));

    // Comments, doctype, CDATA.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      pushText(html.slice(lt + 9, end === -1 ? length : end));
      index = end === -1 ? length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      index = end === -1 ? length : end + 1;
      continue;
    }

    // Closing tag.
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      if (end === -1) {
        index = length;
        break;
      }
      const tag = html.slice(lt + 2, end).trim().toLowerCase().split(/\s/)[0];
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].tag === tag) {
          stack.length = depth;
          break;
        }
      }
      index = end + 1;
      continue;
    }

    // Opening tag.
    const tagEnd = (() => {
      let cursor = lt + 1;
      let quote: string | null = null;
      while (cursor < length) {
        const ch = html[cursor];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') return cursor;
        cursor++;
      }
      return -1;
    })();
    if (tagEnd === -1) {
      pushText(decodeEntities(html.slice(lt)));
      break;
    }

    const inner = html.slice(lt + 1, tagEnd);
    const selfClosing = inner.endsWith('/');
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(inner);
    if (!nameMatch) {
      pushText(decodeEntities(html.slice(lt, tagEnd + 1)));
      index = tagEnd + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const attrs = parseAttributes(inner.slice(nameMatch[1].length, selfClosing ? -1 : undefined));

    const closes = IMPLICIT_CLOSE[tag];
    if (closes) {
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (closes.includes(stack[depth].tag)) {
          stack.length = depth;
          break;
        }
        if (['ul', 'ol', 'table', 'tbody', 'thead', 'dl', 'select'].includes(stack[depth].tag)) break;
      }
    }

    const element: Element = { type: 'element', tag, attrs, children: [] };
    top().children.push(element);
    nodeCount++;
    index = tagEnd + 1;

    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;

    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closeIndex = html.toLowerCase().indexOf(`</${tag}`, index);
      const raw = html.slice(index, closeIndex === -1 ? length : closeIndex);
      if (tag === 'title' || tag === 'textarea' || tag === 'noscript') {
        element.children.push({ type: 'text', value: decodeEntities(raw) });
      } else {
        element.children.push({ type: 'text', value: raw });
      }
      nodeCount++;
      if (closeIndex === -1) {
        index = length;
      } else {
        const gt = html.indexOf('>', closeIndex);
        index = gt === -1 ? length : gt + 1;
      }
      continue;
    }

    if (stack.length < 256) stack.push(element);
  }

  return root;
}

export function walk(node: Node, visit: (node: Node, parents: Element[]) => boolean | void): void {
  const stack: { node: Node; parents: Element[] }[] = [{ node, parents: [] }];
  while (stack.length) {
    const item = stack.pop()!;
    const descend = visit(item.node, item.parents);
    if (descend === false) continue;
    if (item.node.type === 'element') {
      const parents = [...item.parents, item.node];
      for (let i = item.node.children.length - 1; i >= 0; i--) {
        stack.push({ node: item.node.children[i], parents });
      }
    }
  }
}

export function textOf(node: Node): string {
  if (node.type === 'text') return node.value;
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

/** Escape a string for safe interpolation into HTML text or attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
