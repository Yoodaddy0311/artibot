import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readReviewKeysTail, REVIEW_KEYS_MAX_ROWS } from '../../lib/review/review-keys.js';
import { TAIL_SCAN_BYTES } from '../../lib/review/tail-scan.js';
import { claimAuditIdempotencyKey, reviewCompletedIdempotencyKey } from '../../lib/review/verdict-writer.js';

/**
 * `lib/review/review-keys.js` — the `existingKeys` dedupe port, bounded.
 *
 * It replaced `readAllEvents`, a whole-ledger read that took 204-273 ms over a
 * 24.6 MB ledger and 5.3-6.0 s over a 20x copy (the SubagentStop handler's budget is
 * 5,000 ms). What must survive the change: the keys the verdict writer builds are
 * found (they come from the WRITER here, not from a fixture's idea of them), other
 * sessions and other events are not, and a read that could not reach the window's
 * edge says so, because the writer prefers an unwritten verdict to a written twice.
 *
 * WHAT GREEN HERE DOES NOT PROVE: the cost on a real disk (no timing is asserted;
 * `bytesRead` is the bounded-work witness and the lane report carries the
 * measured milliseconds), or which redeliveries a real host produces.
 */

const SID = 'sess-review-keys';
const OTHER = 'sess-somebody-else';

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-review-keys-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

const reviewRow = (event, key, session = SID) => ({
  v: 1, ts: '2026-09-30T08:00:00.000Z', event, session_id: session, source: 'reviewer', pid: 1, seq: 0,
  idempotency_key: key, data: { verdict: 'PASS' },
});
const filler = (i, note = '') => ({
  v: 1, ts: '2026-09-30T08:30:00.000Z', event: 'hook.fired', session_id: SID, source: 'hook', pid: 2, seq: 0,
  data: { slot: 'PostToolUse', hooks: ['quality-gate', 'post-edit-format'], failed: [], count: 2, tool: 'Edit', i, note },
});
const lines = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`);
const fillerLines = (count, note = '') => lines(Array.from({ length: count }, (_, i) => filler(i, note)));
const bytes = (ls) => ls.reduce((n, l) => n + Buffer.byteLength(l), 0);
function write(parts, name = 'ledger.jsonl') {
  const file = path.join(tmp, name);
  writeFileSync(file, parts.join(''), 'utf-8');
  return file;
}

describe('readReviewKeysTail - what it collects', () => {
  it('finds the keys the verdict WRITER builds, for both review events', () => {
    const completed = reviewCompletedIdempotencyKey(SID, 'v1-abc-20260930T000000Z');
    const audit = claimAuditIdempotencyKey(SID, {
      claims_total: 9, claims_refuted: 2, nature: 'process', subject_agent_type: 'tdd-guide', evidence_refs: ['a:1'],
    });
    const file = write([
      ...fillerLines(5),
      ...lines([reviewRow('review.completed', completed), reviewRow('review.claim_audit', audit)]),
      ...fillerLines(5),
    ]);
    const got = readReviewKeysTail(file, SID);
    expect(got.complete).toBe(true);
    expect([...got.keys].sort()).toEqual([audit, completed].sort());
    expect(got.rows).toBe(2);
  });

  it('ignores other sessions, other events, and rows without a key', () => {
    const file = write(lines([
      reviewRow('review.completed', `review.completed:${OTHER}:v1`, OTHER),
      reviewRow('verify.completed', 'review.completed:sess-review-keys:v9'),
      { ...reviewRow('review.completed', ''), idempotency_key: '' },
      { ...reviewRow('review.completed', 'x'), idempotency_key: 42 },
      reviewRow('review.completed', `review.completed:${SID}:v1`),
    ]));
    expect(readReviewKeysTail(file, SID).keys).toEqual([`review.completed:${SID}:v1`]);
  });

  it('skips a ledger.rejected row that merely QUOTES a review event', () => {
    const file = write(lines([{
      v: 1, ts: '2026-09-30T08:00:00.000Z', event: 'ledger.rejected', session_id: SID, source: 'hook',
      data: { event: 'review.completed', idempotency_key: `review.completed:${SID}:refused`, reason: 'oversize' },
    }]));
    const got = readReviewKeysTail(file, SID);
    expect(got.keys).toEqual([]);
    expect(got.complete).toBe(true);
  });

  it('skips a quoting row even when it carries a top-level key of its own in this session', () => {
    // The case above nests the key inside `data`, so a reader that dropped the event check would still add nothing.
    // Here the row quotes the marker AND has a top-level `idempotency_key`: only the event check keeps it out.
    const quoting = { ...reviewRow('ledger.rejected', `ledger.rejected:${SID}:refused`), data: { event: 'review.completed', reason: 'oversize' } };
    const real = `review.completed:${SID}:v1`;
    const got = readReviewKeysTail(write(lines([quoting, reviewRow('review.completed', real)])), SID);
    expect(got.keys).toEqual([real]);
    expect(got.complete).toBe(true);
  });

  it('returns each key once', () => {
    const key = `review.completed:${SID}:v1`;
    const file = write(lines([reviewRow('review.completed', key), reviewRow('review.completed', key)]));
    expect(readReviewKeysTail(file, SID).keys).toEqual([key]);
  });

  it.each([1, 64, 97, 1000, 4096])('finds keys across chunk boundaries at chunk size %i, multibyte filler included', (chunkBytes) => {
    const key = `review.completed:${SID}:v-한글-1`;
    const file = write([...fillerLines(20, '검수 🚀'), ...lines([reviewRow('review.completed', key)]), ...fillerLines(20, '검수 🚀')]);
    expect(readReviewKeysTail(file, SID, { chunkBytes }).keys).toEqual([key]);
  });
});

describe('readReviewKeysTail - bounded, and honest about what it did not read', () => {
  it('never reads more than the cap (plus one byte of look-behind), and a key older than the window is not returned', () => {
    const old = `review.completed:${SID}:old`;
    const recent = `review.completed:${SID}:recent`;
    const tail = fillerLines(500);
    const file = write([...lines([reviewRow('review.completed', old)]), ...tail, ...lines([reviewRow('review.completed', recent)])]);
    const got = readReviewKeysTail(file, SID, { maxBytes: bytes(tail) + 200, chunkBytes: 256 });
    expect(got.keys).toEqual([recent]);
    expect(got.bytesRead).toBeLessThanOrEqual(bytes(tail) + 200 + 1);
    // Window edge, not failure: the walk reached it, so the answer is complete FOR THE WINDOW.
    expect(got.complete).toBe(true);
  });

  it('is flat in the size of the ledger: a file far past the cap costs the cap, not the file', () => {
    const big = fillerLines(9000);
    const file = write([...big, ...lines([reviewRow('review.completed', `review.completed:${SID}:v1`)])]);
    expect(bytes(big)).toBeGreaterThan(2_000_000);
    const got = readReviewKeysTail(file, SID, { maxBytes: 600_000 });
    expect(got.bytesRead).toBeLessThanOrEqual(600_001);
    expect(got.keys).toEqual([`review.completed:${SID}:v1`]);
  });

  it('a ledger that does not exist is complete and empty: there is nothing to duplicate', () => {
    expect(readReviewKeysTail(path.join(tmp, 'nope.jsonl'), SID)).toMatchObject({ keys: [], complete: true });
  });

  it.each([
    ['a directory where the ledger should be', () => tmp],
    ['an empty path', () => ''],
    ['a path that is not a string', () => undefined],
    ['a line with no newline longer than a ledger line can be', () => write([`${'x'.repeat(300_000)}\n`], 'giant.jsonl')],
  ])('is INCOMPLETE for %s, so the caller can refuse to write', (_label, make) => {
    const got = readReviewKeysTail(make(), SID);
    expect(got.complete).toBe(false);
    expect(got.keys).toEqual([]);
  });

  it('is INCOMPLETE when the row budget runs out, and keeps what it had', () => {
    const rows = Array.from({ length: 20 }, (_, i) => reviewRow('review.completed', `review.completed:${SID}:v${i}`));
    const file = write(lines(rows));
    const cut = readReviewKeysTail(file, SID, { maxRows: 5 });
    expect(cut.complete).toBe(false);
    expect(cut.keys.length).toBeLessThan(20);
    expect(readReviewKeysTail(file, SID, { maxRows: 50 })).toMatchObject({ complete: true, rows: 20 });
    expect(REVIEW_KEYS_MAX_ROWS).toBe(4096);
  });

  it('is INCOMPLETE without a session: it cannot say which keys are this one\'s', () => {
    const file = write(lines([reviewRow('review.completed', `review.completed:${SID}:v1`)]));
    for (const session of [undefined, null, '', 7]) {
      expect(readReviewKeysTail(file, session)).toMatchObject({ keys: [], complete: false });
    }
  });

  it('skips torn and corrupt lines without losing the rest', () => {
    const good = `review.completed:${SID}:good`;
    const file = write([
      'not json\n',
      '{"event":"review.completed","session_id":"sess-review-keys","idempotency_key":\n',
      ...lines([reviewRow('review.completed', good)]),
      '{"v":1,"event":"review.claim_audit","session_id":"sess-review-keys","idempotency_key":"review.claim',
    ]);
    const got = readReviewKeysTail(file, SID);
    expect(got.keys).toEqual([good]);
    expect(got.complete).toBe(true);
  });

  it('defaults to the 8 MiB window of the identity scan: a key 5 MiB back is found, one 9 MiB back is the recorded gap', () => {
    const fillerBytes = (target) => {
      const out = [];
      let n = 0;
      for (let i = 0; n < target; i += 1) {
        const line = `${JSON.stringify(filler(i))}\n`;
        out.push(line);
        n += Buffer.byteLength(line);
      }
      return out;
    };
    const far = `review.completed:${SID}:far`;
    const near = `review.completed:${SID}:near`;
    const MIB = 1024 * 1024;
    const file = write([
      ...lines([reviewRow('review.completed', far)]),
      ...fillerBytes(4 * MIB),
      ...lines([reviewRow('review.completed', near)]),
      ...fillerBytes(5 * MIB),
    ]);
    const got = readReviewKeysTail(file, SID);
    expect(got.keys).toEqual([near]);
    expect(got.complete).toBe(true);
    expect(got.bytesRead).toBeLessThanOrEqual(TAIL_SCAN_BYTES + 1);
  });
});
