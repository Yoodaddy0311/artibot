/**
 * Decision trail — concurrent-write survival.
 *
 * These cases exist because `recordDecision` used to suspend in the middle of
 * its read-modify-write. `readTrailSync` snapshotted the file, `await
 * ensureDir(...)` yielded the event loop, and `writeTrailSync` then persisted
 * that now-stale snapshot plus one entry. Two calls overlapping across the
 * suspension both read the same base and both wrote it back, so the later write
 * erased the earlier one's entry — a classic lost update. Measured on HEAD
 * daf7fec0, 2026-08-28: five concurrent writes, one survivor.
 *
 * The fix moved that suspension above the read, leaving the read-modify-write
 * unbroken. Nothing here is guarded by a serialization queue or a mutex — the
 * section is simply synchronous, so Node's single thread cannot interleave two
 * of them.
 *
 * WHERE THE OVERLAP ACTUALLY COMES FROM. An earlier version of this header
 * named `router.js#route()` — it fires its trail write into an unawaited
 * `.then()` chain, which looks like the obvious source. It is not: `route()`
 * has ZERO production callers (measured 2026-08-28; the live path calls
 * `classifyComplexity` directly through `lib/runtime/middleware/router.js`).
 * The real overlap today is CROSS-PROCESS — the per-prompt hook
 * (`scripts/hooks/runtime-prompt.js`) and the `scripts/cron/` runners are
 * separate Node processes — and a synchronous section cannot serialize those:
 * 21 of 60 writes were lost across three processes in the same measurement.
 *
 * So these cases drive the overlap directly with `Promise.all` rather than
 * through a caller. They pin the in-process guarantee, which is real and worth
 * keeping — a future in-process concurrent caller must not silently reopen the
 * defect. Closing the cross-process half needs a file lock or an append-only
 * format and is deliberately out of scope.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { queryDecisions, recordDecision } from '../../lib/core/decision-trail.js';
import { useTrailSandbox } from '../helpers/trail-sandbox.js';

const sandbox = useTrailSandbox('trail-concurrency');

/**
 * Read the trail straight off disk rather than through `queryDecisions`, so a
 * regression cannot hide behind the reader.
 *
 * @returns {{entries: object[], metadata: object}}
 */
function readTrailFromDisk() {
  const file = path.join(sandbox.root(), 'runtime', 'decision-trail.json');
  return JSON.parse(fsSync.readFileSync(file, 'utf-8'));
}

describe('decision-trail concurrent writes', () => {
  it('keeps every entry when writes are issued without awaiting each other', async () => {
    const count = 5;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        recordDecision({
          subsystem: 'concurrency-probe',
          action: 'recorded',
          reason: `write ${i}`,
          outputs: { index: i },
        }),
      ),
    );

    // Every call must report success — a null here means the write was rejected
    // outright before it ever touched the file, a different defect from a lost
    // update.
    expect(results.every((r) => r && typeof r.id === 'string')).toBe(true);

    const onDisk = readTrailFromDisk();
    const probeEntries = onDisk.entries.filter((e) => e.subsystem === 'concurrency-probe');
    expect(probeEntries).toHaveLength(count);

    // Each write carried a distinct index; none may be missing.
    const indexes = probeEntries.map((e) => e.outputs?.index).sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1, 2, 3, 4]);

    // The returned ids must all be present on disk.
    const idsOnDisk = new Set(onDisk.entries.map((e) => e.id));
    for (const r of results) expect(idsOnDisk.has(r.id)).toBe(true);
  });

  it('keeps the metadata counter consistent with the entries written', async () => {
    const before = readTrailFromDisk().metadata?.totalAppended ?? 0;

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        recordDecision({ subsystem: 'counter-probe', action: 'recorded', outputs: { index: i } }),
      ),
    );

    const after = readTrailFromDisk();
    // `totalAppended` increments off the value the call read. When writes clobber
    // each other the counter lags the real append count by the number lost.
    expect(after.metadata.totalAppended).toBe(before + 4);
    expect(after.entries.filter((e) => e.subsystem === 'counter-probe')).toHaveLength(4);
  });

  it('interleaves cleanly with a fire-and-forget writer that is never awaited', async () => {
    // The unawaited shape `route()` uses — the caller moves on immediately and
    // the write completes on a later turn. Kept as a shape, not as a claim about
    // a live caller: see the header on where overlap actually comes from.
    recordDecision({ subsystem: 'forget-probe', action: 'classified', outputs: { index: 0 } });
    recordDecision({ subsystem: 'forget-probe', action: 'classified', outputs: { index: 1 } });
    const last = await recordDecision({
      subsystem: 'forget-probe',
      action: 'classified',
      outputs: { index: 2 },
    });
    expect(last).not.toBeNull();

    // One more awaited write, to give the two unawaited ones above their turn
    // on the event loop before reading back.
    await recordDecision({ subsystem: 'drain', action: 'noop' });

    const entries = await queryDecisions({ subsystem: 'forget-probe' });
    expect(entries).toHaveLength(3);
  });
});
