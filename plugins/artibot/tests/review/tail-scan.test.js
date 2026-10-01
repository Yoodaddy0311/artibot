import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  positiveInt,
  scanLedgerTail,
  TAIL_SCAN_BYTES,
  TAIL_SCAN_CHUNK_BYTES,
} from '../../lib/review/tail-scan.js';

/**
 * `lib/review/tail-scan.js` — the bounded reverse walk that the reviewer-identity
 * join and the review-dedupe read share. A bug here is silent (a line missed or
 * half-read), so the walk is driven at chunk sizes smaller than one line, with
 * multibyte text on the boundaries, at the window edge to the byte, and through
 * every way it can end. `stop-identity.test.js` and `review-keys.test.js` drive it
 * through their own questions.
 *
 * WHAT GREEN HERE DOES NOT PROVE: how fast a walk is on a real disk (no timing is
 * asserted; `bytesRead` is the bounded-work witness), or that a real ledger holds
 * only newline-terminated compact JSON (the writer's contract, pinned elsewhere).
 */

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-tail-scan-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

/** A file of `count` distinct lines, some with multibyte text, each newline-terminated. */
function linesFile(count, name = 'f.jsonl') {
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ i, note: i % 3 === 0 ? `검수 ${i} 🚀 결과` : `row ${i}` }));
  const file = path.join(tmp, name);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
  return { file, lines };
}

/** Collect the whole lines the walk delivers, oldest first, plus its return value. */
function collect(file, opts = {}) {
  const runs = [];
  const res = scanLedgerTail(file, opts, (run) => { runs.push(run); return false; });
  const lines = [];
  for (const run of [...runs].reverse()) for (const line of run.split('\n')) if (line !== '') lines.push(line);
  return { ...res, lines, runs };
}

describe('constants', () => {
  it('reads an 8 MiB window in 256 KiB chunks', () => {
    expect(TAIL_SCAN_BYTES).toBe(8 * 1024 * 1024);
    expect(TAIL_SCAN_CHUNK_BYTES).toBe(256 * 1024);
  });

  it.each([
    [undefined, 7, 7], [0, 7, 7], [-3, 7, 7], [Number.NaN, 7, 7], ['9', 7, 7], [2.9, 7, 2], [5, 7, 5],
  ])('positiveInt(%s, %s) -> %s', (value, fallback, expected) => {
    expect(positiveInt(value, fallback)).toBe(expected);
  });
});

describe('scanLedgerTail - every line exactly once, at any chunk size', () => {
  it.each([1, 7, 64, 97, 333, 4096, TAIL_SCAN_CHUNK_BYTES])('reproduces the file at chunk size %i (multibyte on the boundaries)', (chunkBytes) => {
    const { file, lines } = linesFile(40);
    const got = collect(file, { chunkBytes });
    expect(got.status).toBe('exhausted');
    expect(got.lines).toEqual(lines);
  });

  it('delivers the NEWEST run first', () => {
    const { file, lines } = linesFile(200);
    const got = collect(file, { chunkBytes: 256 });
    expect(got.runs.length).toBeGreaterThan(3);
    expect(got.runs[0]).toContain(lines.at(-1));
    expect(got.runs.at(-1)).toContain(lines[0]);
  });

  it('an empty file is exhausted with nothing to deliver', () => {
    const file = path.join(tmp, 'empty.jsonl');
    writeFileSync(file, '', 'utf-8');
    expect(collect(file)).toMatchObject({ status: 'exhausted', lines: [], bytesRead: 0 });
  });

  it('a file whose last line has no newline still delivers it', () => {
    const file = path.join(tmp, 'nonl.jsonl');
    writeFileSync(file, '{"a":1}\n{"a":2}', 'utf-8');
    expect(collect(file, { chunkBytes: 4 }).lines).toEqual(['{"a":1}', '{"a":2}']);
  });
});

describe('scanLedgerTail - the window', () => {
  it('never reads more than the cap plus one byte of look-behind', () => {
    const { file } = linesFile(400);
    const got = collect(file, { maxBytes: 1000, chunkBytes: 128 });
    expect(got.bytesRead).toBeLessThanOrEqual(1001);
    expect(got.status).toBe('exhausted');
  });

  it('keeps a line that starts exactly at the window edge and drops one the edge cuts', () => {
    const { file, lines } = linesFile(30);
    const len = (l) => Buffer.byteLength(l) + 1;
    const fromSecond = lines.slice(1).reduce((n, l) => n + len(l), 0);
    // floor lands on the first byte of line 2, and the byte before it is line 1's newline: line 2 is whole.
    expect(collect(file, { maxBytes: fromSecond, chunkBytes: 64 }).lines).toEqual(lines.slice(1));
    // One byte fewer: the edge is INSIDE line 2, which is cut and dropped.
    expect(collect(file, { maxBytes: fromSecond - 1, chunkBytes: 64 }).lines).toEqual(lines.slice(2));
  });

  it('reads as if the file ended at endOffset', () => {
    const { file, lines } = linesFile(20);
    const len = (l) => Buffer.byteLength(l) + 1;
    const firstTen = lines.slice(0, 10).reduce((n, l) => n + len(l), 0);
    expect(collect(file, { endOffset: firstTen, chunkBytes: 50 }).lines).toEqual(lines.slice(0, 10));
  });

  it('ignores nonsense caps instead of reading without one', () => {
    const { file, lines } = linesFile(10);
    for (const maxBytes of [0, -5, Number.NaN, undefined, 'all']) {
      const got = collect(file, { maxBytes });
      expect(got.lines).toEqual(lines);
      expect(got.bytesRead).toBeLessThanOrEqual(TAIL_SCAN_BYTES + 1);
    }
  });
});

describe('scanLedgerTail - why the walk ended', () => {
  it('stopped: the callback asked to', () => {
    const { file } = linesFile(400);
    let calls = 0;
    const res = scanLedgerTail(file, { chunkBytes: 128 }, () => { calls += 1; return true; });
    expect(res.status).toBe('stopped');
    expect(calls).toBe(1);
    expect(res.bytesRead).toBeLessThanOrEqual(128);
  });

  it('missing: the file does not exist (complete: there is nothing to find)', () => {
    expect(scanLedgerTail(path.join(tmp, 'nope.jsonl'), {}, () => false)).toEqual({ bytesRead: 0, status: 'missing' });
  });

  it('error: not a string, empty, a directory, or a callback that throws', () => {
    for (const target of [undefined, null, 7, '', tmp]) {
      expect(scanLedgerTail(target, {}, () => false).status).toBe('error');
    }
    const { file } = linesFile(5);
    expect(scanLedgerTail(file, {}, () => { throw new Error('boom'); }).status).toBe('error');
  });

  it('aborted: a line with no newline longer than a ledger line can be', () => {
    const file = path.join(tmp, 'giant.jsonl');
    writeFileSync(file, `${'x'.repeat(300_000)}\n`, 'utf-8');
    expect(scanLedgerTail(file, {}, () => false).status).toBe('aborted');
  });
});
