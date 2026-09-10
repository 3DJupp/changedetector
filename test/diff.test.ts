import { describe, expect, it } from 'vitest';
import { buildHunks, buildRows, computeStats, diffLines, diffWords, setDifference, tokenizeWords } from '../src/lib/diff';

describe('line diff', () => {
  it('reports an unchanged document as all equal', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(ops.every((op) => op.type === 'equal')).toBe(true);
  });

  it('detects a single replaced line', () => {
    const ops = diffLines(['Pro — $19', 'billed monthly'], ['Pro — $24', 'billed monthly']);
    expect(ops.filter((op) => op.type === 'delete').map((op) => op.value)).toEqual(['Pro — $19']);
    expect(ops.filter((op) => op.type === 'insert').map((op) => op.value)).toEqual(['Pro — $24']);
  });

  it('detects insertions and deletions', () => {
    const ops = diffLines(['a', 'b'], ['a', 'x', 'b', 'c']);
    expect(ops.filter((op) => op.type === 'insert').map((op) => op.value)).toEqual(['x', 'c']);
    expect(ops.filter((op) => op.type === 'delete')).toHaveLength(0);
  });

  it('reconstructs both documents from the op stream', () => {
    const before = ['one', 'two', 'three', 'four'];
    const after = ['one', '2', 'three', 'four', 'five'];
    const ops = diffLines(before, after);
    const rebuiltBefore = ops.filter((op) => op.type !== 'insert').map((op) => op.value);
    const rebuiltAfter = ops.filter((op) => op.type !== 'delete').map((op) => op.value);
    expect(rebuiltBefore).toEqual(before);
    expect(rebuiltAfter).toEqual(after);
  });

  it('stays correct on large documents via anchoring', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[2000] = 'line 2000 CHANGED';
    after.splice(3000, 0, 'brand new line');
    const ops = diffLines(before, after);
    const rebuiltBefore = ops.filter((op) => op.type !== 'insert').map((op) => op.value);
    const rebuiltAfter = ops.filter((op) => op.type !== 'delete').map((op) => op.value);
    expect(rebuiltBefore).toEqual(before);
    expect(rebuiltAfter).toEqual(after);
    const changed = ops.filter((op) => op.type !== 'equal');
    expect(changed.length).toBeLessThan(10);
  });
});

describe('word diff', () => {
  it('tokenizes prices and punctuation as units', () => {
    expect(tokenizeWords('Pro — $19/month').filter((t) => t.trim())).toEqual(['Pro', '—', '$19', '/', 'month']);
  });

  it('isolates the changed word', () => {
    const ops = diffWords('Pro plan costs $19 per month', 'Pro plan costs $24 per month');
    expect(ops.filter((op) => op.type === 'delete').map((op) => op.value)).toEqual(['$19']);
    expect(ops.filter((op) => op.type === 'insert').map((op) => op.value)).toEqual(['$24']);
  });
});

describe('side-by-side rows', () => {
  it('pairs a delete with the insert that replaced it', () => {
    const rows = buildRows(diffLines(['old'], ['new']), false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'changed', left: 'old', right: 'new' });
  });

  it('marks pure additions and removals', () => {
    const rows = buildRows(diffLines(['a'], ['a', 'b']), false);
    expect(rows.map((row) => row.kind)).toEqual(['same', 'added']);
    const removed = buildRows(diffLines(['a', 'b'], ['a']), false);
    expect(removed.map((row) => row.kind)).toEqual(['same', 'removed']);
  });

  it('computes statistics', () => {
    const rows = buildRows(diffLines(['a', 'b', 'c'], ['a', 'B', 'c', 'd']), false);
    const stats = computeStats(rows);
    expect(stats).toMatchObject({ changed: 1, added: 1, removed: 0, unchanged: 2 });
    expect(stats.ratio).toBeCloseTo(2 / 4);
  });
});

describe('hunks', () => {
  it('collapses long unchanged regions but keeps context', () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[30] = 'line 30 changed';
    const hunks = buildHunks(buildRows(diffLines(before, after), false), 3);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].rows).toHaveLength(7);
    expect(hunks[0].rows.some((row) => row.kind === 'changed')).toBe(true);
  });
});

describe('set difference', () => {
  it('reports added and removed members', () => {
    const result = setDifference([{ href: 'a' }, { href: 'b' }], [{ href: 'b' }, { href: 'c' }], (x) => x.href);
    expect(result.added.map((x) => x.href)).toEqual(['c']);
    expect(result.removed.map((x) => x.href)).toEqual(['a']);
  });
});
