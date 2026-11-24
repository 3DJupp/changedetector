/**
 * Diff engine.
 *
 * Patience-style anchoring on lines that are unique in both documents, with
 * Myers' O(ND) algorithm inside each gap. Anchoring keeps the cost bounded on
 * large pages and produces diffs that line up the way a human would align them.
 */

export type OpType = 'equal' | 'delete' | 'insert';

export interface DiffOp<T = string> {
  type: OpType;
  value: T;
  aIndex: number;
  bIndex: number;
}

const MYERS_BUDGET = 1600;

function myers<T>(a: T[], b: T[], offsetA: number, offsetB: number, key: (x: T) => string): DiffOp<T>[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((value, i) => ({ type: 'insert' as const, value, aIndex: offsetA, bIndex: offsetB + i }));
  if (m === 0) return a.map((value, i) => ({ type: 'delete' as const, value, aIndex: offsetA + i, bIndex: offsetB }));

  const max = n + m;
  if (max > MYERS_BUDGET) return greedy(a, b, offsetA, offsetB, key);

  const size = 2 * max + 1;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];
  const keyA = a.map(key);
  const keyB = b.map(key);

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) x = v[max + k + 1];
      else x = v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && keyA[x] === keyB[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d, max, offsetA, offsetB);
    }
  }
  return greedy(a, b, offsetA, offsetB, key);
}

function backtrack<T>(
  a: T[],
  b: T[],
  trace: Int32Array[],
  d: number,
  max: number,
  offsetA: number,
  offsetB: number,
): DiffOp<T>[] {
  const ops: DiffOp<T>[] = [];
  let x = a.length;
  let y = b.length;

  for (let depth = d; depth > 0; depth--) {
    const v = trace[depth];
    const k = x - y;
    const previousK = k === -depth || (k !== depth && v[max + k - 1] < v[max + k + 1]) ? k + 1 : k - 1;
    const previousX = v[max + previousK];
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x--;
      y--;
      ops.push({ type: 'equal', value: a[x], aIndex: offsetA + x, bIndex: offsetB + y });
    }
    if (x > previousX) {
      x--;
      ops.push({ type: 'delete', value: a[x], aIndex: offsetA + x, bIndex: offsetB + y });
    } else if (y > previousY) {
      y--;
      ops.push({ type: 'insert', value: b[y], aIndex: offsetA + x, bIndex: offsetB + y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ type: 'equal', value: a[x], aIndex: offsetA + x, bIndex: offsetB + y });
  }
  while (x > 0) {
    x--;
    ops.push({ type: 'delete', value: a[x], aIndex: offsetA + x, bIndex: offsetB });
  }
  while (y > 0) {
    y--;
    ops.push({ type: 'insert', value: b[y], aIndex: offsetA, bIndex: offsetB + y });
  }
  return ops.reverse();
}

/** Linear fallback for very large inputs: sync on matching lines, greedily. */
function greedy<T>(a: T[], b: T[], offsetA: number, offsetB: number, key: (x: T) => string): DiffOp<T>[] {
  const ops: DiffOp<T>[] = [];
  const positions = new Map<string, number[]>();
  b.forEach((item, index) => {
    const k = key(item);
    const bucket = positions.get(k);
    if (bucket) bucket.push(index);
    else positions.set(k, [index]);
  });

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]) === key(b[j])) {
      ops.push({ type: 'equal', value: a[i], aIndex: offsetA + i, bIndex: offsetB + j });
      i++;
      j++;
      continue;
    }
    const candidates = positions.get(key(a[i])) ?? [];
    const next = candidates.find((position) => position >= j && position - j < 64);
    if (next !== undefined) {
      for (; j < next; j++) ops.push({ type: 'insert', value: b[j], aIndex: offsetA + i, bIndex: offsetB + j });
    } else {
      ops.push({ type: 'delete', value: a[i], aIndex: offsetA + i, bIndex: offsetB + j });
      i++;
    }
  }
  for (; i < a.length; i++) ops.push({ type: 'delete', value: a[i], aIndex: offsetA + i, bIndex: offsetB + j });
  for (; j < b.length; j++) ops.push({ type: 'insert', value: b[j], aIndex: offsetA + i, bIndex: offsetB + j });
  return ops;
}

/** Longest increasing subsequence over anchor pairs (patience diff). */
function longestIncreasing(pairs: [number, number][]): [number, number][] {
  if (pairs.length === 0) return [];
  const tails: number[] = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  const indexes: number[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const value = pairs[i][1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid] < value) low = mid + 1;
      else high = mid;
    }
    tails[low] = value;
    indexes[low] = i;
    previous[i] = low > 0 ? indexes[low - 1] : -1;
  }

  const out: [number, number][] = [];
  let cursor = indexes[tails.length - 1];
  while (cursor !== -1) {
    out.push(pairs[cursor]);
    cursor = previous[cursor];
  }
  return out.reverse();
}

export function diffSequences<T>(a: T[], b: T[], key: (x: T) => string = String): DiffOp<T>[] {
  // Trim the common prefix and suffix first: most page changes are local.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && key(a[prefix]) === key(b[prefix])) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    key(a[a.length - 1 - suffix]) === key(b[b.length - 1 - suffix])
  ) {
    suffix++;
  }

  const ops: DiffOp<T>[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ type: 'equal', value: a[i], aIndex: i, bIndex: i });

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  if (midA.length + midB.length > MYERS_BUDGET) {
    // Anchor on lines that appear exactly once on both sides.
    const countA = new Map<string, number>();
    const countB = new Map<string, number>();
    midA.forEach((x) => countA.set(key(x), (countA.get(key(x)) ?? 0) + 1));
    midB.forEach((x) => countB.set(key(x), (countB.get(key(x)) ?? 0) + 1));
    const indexB = new Map<string, number>();
    midB.forEach((x, i) => {
      const k = key(x);
      if (countB.get(k) === 1) indexB.set(k, i);
    });
    const pairs: [number, number][] = [];
    midA.forEach((x, i) => {
      const k = key(x);
      if (countA.get(k) === 1 && countB.get(k) === 1 && indexB.has(k)) pairs.push([i, indexB.get(k)!]);
    });
    const anchors = longestIncreasing(pairs);

    let cursorA = 0;
    let cursorB = 0;
    for (const [anchorA, anchorB] of anchors) {
      ops.push(
        ...myers(midA.slice(cursorA, anchorA), midB.slice(cursorB, anchorB), prefix + cursorA, prefix + cursorB, key),
      );
      ops.push({ type: 'equal', value: midA[anchorA], aIndex: prefix + anchorA, bIndex: prefix + anchorB });
      cursorA = anchorA + 1;
      cursorB = anchorB + 1;
    }
    ops.push(...myers(midA.slice(cursorA), midB.slice(cursorB), prefix + cursorA, prefix + cursorB, key));
  } else {
    ops.push(...myers(midA, midB, prefix, prefix, key));
  }

  for (let i = 0; i < suffix; i++) {
    ops.push({
      type: 'equal',
      value: a[a.length - suffix + i],
      aIndex: a.length - suffix + i,
      bIndex: b.length - suffix + i,
    });
  }
  return ops;
}

export function diffLines(before: string[], after: string[]): DiffOp<string>[] {
  return diffSequences(before, after, (line) => line);
}

const WORD_PATTERN = /(\s+|[\p{L}\p{N}$€£¥%.,+-]+|[^\s\p{L}\p{N}])/gu;

export function tokenizeWords(input: string): string[] {
  return input.match(WORD_PATTERN) ?? [];
}

export function diffWords(before: string, after: string): DiffOp<string>[] {
  return diffSequences(tokenizeWords(before), tokenizeWords(after), (token) => token);
}

export interface DiffRow {
  left: string | null;
  right: string | null;
  leftNumber: number | null;
  rightNumber: number | null;
  kind: 'same' | 'changed' | 'added' | 'removed';
  /** Word-level segments, present on `changed` rows. */
  words?: { left: DiffOp<string>[]; right: DiffOp<string>[] };
}

/** Pair deletes with the inserts that replaced them, for side-by-side rendering. */
export function buildRows(ops: DiffOp<string>[], withWords = true): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;

  while (index < ops.length) {
    const op = ops[index];
    if (op.type === 'equal') {
      rows.push({
        left: op.value,
        right: op.value,
        leftNumber: op.aIndex + 1,
        rightNumber: op.bIndex + 1,
        kind: 'same',
      });
      index++;
      continue;
    }

    const deletes: DiffOp<string>[] = [];
    const inserts: DiffOp<string>[] = [];
    while (index < ops.length && ops[index].type !== 'equal') {
      if (ops[index].type === 'delete') deletes.push(ops[index]);
      else inserts.push(ops[index]);
      index++;
    }

    const pairs = Math.max(deletes.length, inserts.length);
    for (let i = 0; i < pairs; i++) {
      const left = deletes[i];
      const right = inserts[i];
      if (left && right) {
        rows.push({
          left: left.value,
          right: right.value,
          leftNumber: left.aIndex + 1,
          rightNumber: right.bIndex + 1,
          kind: 'changed',
          words: withWords && left.value.length + right.value.length < 4000
            ? { left: diffWords(left.value, right.value), right: diffWords(left.value, right.value) }
            : undefined,
        });
      } else if (left) {
        rows.push({ left: left.value, right: null, leftNumber: left.aIndex + 1, rightNumber: null, kind: 'removed' });
      } else if (right) {
        rows.push({ left: null, right: right.value, leftNumber: null, rightNumber: right.bIndex + 1, kind: 'added' });
      }
    }
  }
  return rows;
}

export interface DiffHunk {
  header: string;
  rows: DiffRow[];
}

/** Collapse unchanged regions, keeping `context` lines around each change. */
export function buildHunks(rows: DiffRow[], context = 3): DiffHunk[] {
  const interesting = rows.map((row) => row.kind !== 'same');
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (!interesting[i]) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  }

  const hunks: DiffHunk[] = [];
  let current: DiffRow[] = [];
  let start = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (current.length === 0) start = i;
      current.push(rows[i]);
    } else if (current.length) {
      hunks.push({ header: `@@ lines ${start + 1}–${i} @@`, rows: current });
      current = [];
    }
  }
  if (current.length) hunks.push({ header: `@@ lines ${start + 1}–${rows.length} @@`, rows: current });
  return hunks;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Fraction of lines touched, 0..1. */
  ratio: number;
  addedChars: number;
  removedChars: number;
}

export function computeStats(rows: DiffRow[]): DiffStats {
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  let addedChars = 0;
  let removedChars = 0;

  for (const row of rows) {
    switch (row.kind) {
      case 'added':
        added++;
        addedChars += row.right?.length ?? 0;
        break;
      case 'removed':
        removed++;
        removedChars += row.left?.length ?? 0;
        break;
      case 'changed':
        changed++;
        addedChars += row.right?.length ?? 0;
        removedChars += row.left?.length ?? 0;
        break;
      default:
        unchanged++;
    }
  }
  const total = added + removed + changed + unchanged;
  return {
    added,
    removed,
    changed,
    unchanged,
    ratio: total === 0 ? 0 : (added + removed + changed) / total,
    addedChars,
    removedChars,
  };
}

export function setDifference<T>(before: T[], after: T[], key: (x: T) => string): { added: T[]; removed: T[] } {
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((item) => !beforeKeys.has(key(item))),
    removed: before.filter((item) => !afterKeys.has(key(item))),
  };
}
