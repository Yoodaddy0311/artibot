import { describe, expect, it } from 'vitest';
import { deterministicLayerFrom, readSnapshotIdentity, REASONS } from '../../lib/verification/deterministic-source.js';
import { verify } from '../../lib/verification/unified-verifier.js';

/**
 * lib/verification/deterministic-source.js — the GIT IDENTITY of the measured
 * tree: what the reporter's v3 keys `gitSha` and `gitDirty` do to the reading.
 *
 * WHY IT EXISTS. The freshness rule (F1) dates a run against the last main-agent
 * edit; it cannot say WHICH commit the run measured. The REPORT gate's SHA binding
 * (`.artibot/guides/v5-design/practicality-improvement-20261023/05_REVISED_DESIGN.md`
 * D-04, rule 7) needs that: a verdict that cannot name its commit is a verdict a
 * later edit can inherit. So the reporter records the identity and this module
 * exposes it two ways — `readSnapshotIdentity` for a gate that wants the raw
 * values, and a `sha=… dirty=…` clause in the evidence note for a ledger reader
 * that has nothing else.
 *
 * WHAT THESE TESTS MEASURE AND WHAT THEY CANNOT. Every case is a PURE call. They
 * pin the identity reader's allowlist, the note clause and the byte-identity of
 * v1/v2 readings. Whether a live snapshot carries the keys at all depends on git
 * being present where vitest ran — a question for a real run, not for these.
 *
 * UNMEASURED is expressed by omitting `exitCode`, because
 * `unified-verifier.js#normalizeDeterministic` treats a missing numeric exit code
 * as "nothing was run"; such a layer carries no evidence, so no clause either.
 */

const MARKER_MS = Date.parse('2026-09-15T00:00:00.000Z');
const NOW_MS = Date.parse('2026-09-15T01:00:00.000Z');
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** What the reporter writes for a run that ended cleanly. */
const CLEAN_COMPLETION = Object.freeze({ reason: 'passed', unhandledErrorCount: 0, unfinishedCount: 0 });

/**
 * A v1 payload: the eight keys of `tests/reporters/test-status-reporter.js`. v2
 * adds `schemaVersion` + `completion`; v3 adds `gitSha` + `gitDirty` — through `over`.
 *
 * @param {object} [over]
 * @returns {string}
 */
function resultJson(over = {}) {
  return JSON.stringify({
    timestamp: '2026-09-15T00:30:00.000Z',
    durationMs: 132138,
    totalTests: 17377,
    passed: 17365,
    failed: 0,
    skipped: 12,
    failedFiles: [],
    ...over,
  });
}

/** @param {object} over */
function fresh(over = {}) {
  return deterministicLayerFrom({ resultJsonText: resultJson(over), markerMtimeMs: MARKER_MS, nowMs: NOW_MS });
}

/** A v2 record as the reporter wrote it before the identity existed. */
const V2 = Object.freeze({ schemaVersion: 2, completion: CLEAN_COMPLETION });

/** A v3 record as the reporter writes it today. */
const V3 = Object.freeze({ schemaVersion: 3, completion: CLEAN_COMPLETION, gitSha: SHA, gitDirty: false });

const V2_NOTE = 'vitest total=17377 passed=17365 failed=0 skipped=12 completion=passed unhandled=0 unfinished=0';

/** @param {object} layer */
const idHash = (layer) => verify({ layers: { deterministic: layer } }).verification_id.split('-')[1];

describe('readSnapshotIdentity — the allowlist of what counts as an identity', () => {
  it('reads the sha, the dirty flag and the timestamp of a v3 record', () => {
    expect(readSnapshotIdentity(resultJson(V3))).toEqual({
      gitSha: SHA,
      gitDirty: false,
      measuredAtMs: Date.parse('2026-09-15T00:30:00.000Z'),
    });
  });

  it('reads a v1 or v2 record as "identity not recorded", with the timestamp it does have', () => {
    for (const over of [{}, V2]) {
      expect(readSnapshotIdentity(resultJson(over))).toEqual({
        gitSha: null,
        gitDirty: null,
        measuredAtMs: Date.parse('2026-09-15T00:30:00.000Z'),
      });
    }
  });

  it('accepts an abbreviated sha of 7 to 40 lowercase hex digits and nothing else', () => {
    expect(readSnapshotIdentity(resultJson({ gitSha: SHA.slice(0, 7) })).gitSha).toBe(SHA.slice(0, 7));
    expect(readSnapshotIdentity(resultJson({ gitSha: SHA.slice(0, 12) })).gitSha).toBe(SHA.slice(0, 12));
    for (const bad of ['HEAD', SHA.slice(0, 6), `${SHA}0`, SHA.toUpperCase(), 'g'.repeat(40), '', null, 42, true, {}, [SHA]]) {
      expect(readSnapshotIdentity(resultJson({ gitSha: bad })).gitSha, `gitSha=${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('reads the dirty flag only as a real boolean', () => {
    expect(readSnapshotIdentity(resultJson({ gitDirty: true })).gitDirty).toBe(true);
    expect(readSnapshotIdentity(resultJson({ gitDirty: false })).gitDirty).toBe(false);
    for (const bad of ['true', 'false', 1, 0, null, {}, []]) {
      expect(readSnapshotIdentity(resultJson({ gitDirty: bad })).gitDirty, `gitDirty=${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('reads each field on its own: a usable sha survives an unusable timestamp and vice versa', () => {
    expect(readSnapshotIdentity(resultJson({ gitSha: SHA, timestamp: 'yesterday' })))
      .toEqual({ gitSha: SHA, gitDirty: null, measuredAtMs: null });
    expect(readSnapshotIdentity(JSON.stringify({ timestamp: '2026-09-15T00:30:00.000Z' })))
      .toEqual({ gitSha: null, gitDirty: null, measuredAtMs: Date.parse('2026-09-15T00:30:00.000Z') });
  });

  it('answers all-null, and never throws, for text that is not a record', () => {
    const none = { gitSha: null, gitDirty: null, measuredAtMs: null };
    for (const text of [null, undefined, '', '{not json', '[1,2]', '"sha"', '42', 'null', 7, {}, () => {}]) {
      expect(readSnapshotIdentity(/** @type {any} */ (text)), `text=${String(text)}`).toEqual(none);
    }
  });

  it('does not require the four counts — identity and measurement are read independently', () => {
    const noCounts = JSON.stringify({ timestamp: '2026-09-15T00:30:00.000Z', gitSha: SHA, gitDirty: true });
    expect(readSnapshotIdentity(noCounts))
      .toEqual({ gitSha: SHA, gitDirty: true, measuredAtMs: Date.parse('2026-09-15T00:30:00.000Z') });
    expect(deterministicLayerFrom({ resultJsonText: noCounts, markerMtimeMs: MARKER_MS, nowMs: NOW_MS }).reason)
      .toBe(REASONS.corrupt);
  });

  it('returns a fresh object each call, never a shared one', () => {
    const a = readSnapshotIdentity(resultJson(V3));
    const b = readSnapshotIdentity(resultJson(V3));
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('deterministicLayerFrom — the identity clause in the evidence note', () => {
  it('appends sha and dirty after the completion clause for a v3 record, and leaves the reason alone', () => {
    const layer = fresh(V3);
    expect(layer.exitCode).toBe(0);
    expect(layer.evidence[0].note).toBe(`${V2_NOTE} sha=${SHA.slice(0, 12)} dirty=false`);
    expect(layer.reason).toBe(fresh(V2).reason);
  });

  it('keeps the clause order: counts, modules, completion, identity', () => {
    expect(fresh({ ...V3, modules: 1204 }).evidence[0].note).toBe(
      'vitest total=17377 passed=17365 failed=0 skipped=12 modules=1204 '
      + `completion=passed unhandled=0 unfinished=0 sha=${SHA.slice(0, 12)} dirty=false`,
    );
  });

  it('spells a dirty tree dirty=true', () => {
    expect(fresh({ ...V3, gitDirty: true }).evidence[0].note).toContain(` sha=${SHA.slice(0, 12)} dirty=true`);
  });

  it('writes the sha alone when the dirty flag was not recorded or is unusable', () => {
    const { gitDirty: _omitted, ...noDirty } = V3;
    expect(fresh(noDirty).evidence[0].note).toBe(`${V2_NOTE} sha=${SHA.slice(0, 12)}`);
    for (const bad of ['true', 1, null]) {
      expect(fresh({ ...V3, gitDirty: bad }).evidence[0].note, `gitDirty=${JSON.stringify(bad)}`)
        .toBe(`${V2_NOTE} sha=${SHA.slice(0, 12)}`);
    }
  });

  it('writes no identity clause at all without a usable sha — a dirty flag alone anchors nothing', () => {
    for (const over of [{ ...V3, gitSha: undefined }, { ...V3, gitSha: 'HEAD' }, { ...V3, gitSha: SHA.toUpperCase() }]) {
      const note = fresh(over).evidence[0].note;
      expect(note, `gitSha=${JSON.stringify(over.gitSha)}`).toBe(V2_NOTE);
      expect(note).not.toContain('dirty=');
    }
  });

  it('abbreviates to 12 hex digits whatever length the record carried', () => {
    expect(fresh({ ...V3, gitSha: SHA.slice(0, 7) }).evidence[0].note).toContain(` sha=${SHA.slice(0, 7)} `);
    expect(fresh({ ...V3, gitSha: SHA.slice(0, 20) }).evidence[0].note).toContain(` sha=${SHA.slice(0, 12)} `);
  });

  /**
   * BYTE FOR BYTE. These two literals are what the module wrote before the
   * identity existed, and `tests/verification/deterministic-source-completion.test.js`
   * pins their verification_id hashes. A record without `gitSha` must keep writing
   * exactly them, or the live histogram is silently re-keyed.
   */
  it('leaves a v2 record byte-identical: no clause, same note, same reason', () => {
    const layer = fresh(V2);
    expect(layer.evidence[0].note).toBe(V2_NOTE);
    expect(layer.reason).toBe(
      'vitest result fresh — 17377 tests, 17365 passed, 0 failed, 12 skipped '
      + '(measured 2026-09-15T00:30:00.000Z, at or after the last main-agent edit); '
      + 'the run ended cleanly (no unhandled errors, no unfinished tests)',
    );
  });

  it('leaves a v1 record byte-identical, including its pinned id', () => {
    const layer = fresh();
    expect(layer.evidence[0].note).toBe('vitest total=17377 passed=17365 failed=0 skipped=12');
    expect(idHash(layer)).toBe('5b205cc3239d');
  });

  it('still judges a v3 record by its completion: interrupted is unmeasured and carries no clause', () => {
    const layer = fresh({ ...V3, completion: { ...CLEAN_COMPLETION, reason: 'interrupted' } });
    expect(layer.exitCode).toBeUndefined();
    expect(layer.reason).toBe(REASONS.interrupted);
    expect(layer.evidence ?? []).toEqual([]);
  });

  it('still fails a v3 record on an unhandled error, with the clause beside the completion facts', () => {
    const layer = fresh({ ...V3, completion: { ...CLEAN_COMPLETION, unhandledErrorCount: 1 } });
    expect(layer.exitCode).toBe(1);
    expect(layer.evidence[0].note).toBe(
      `vitest total=17377 passed=17365 failed=0 skipped=12 completion=passed unhandled=1 unfinished=0 sha=${SHA.slice(0, 12)} dirty=false`,
    );
  });

  it('reads a v3 record with no completion key as v2-unreadable, identity or not', () => {
    const { completion: _omitted, ...noCompletion } = V3;
    const layer = fresh(noCompletion);
    expect(layer.exitCode).toBeUndefined();
    expect(layer.reason).toBe(REASONS.completionUnreadable);
  });

  it('meets the earlier guards first: a stale v3 run is stale, whatever its sha says', () => {
    expect(fresh({ ...V3, timestamp: '2026-09-14T23:59:59.999Z' }).reason).toBe(REASONS.stale);
    expect(fresh({ ...V3, totalTests: 0, passed: 0, failed: 0, skipped: 0 }).reason).toBe(REASONS.emptyRun);
  });

  it('survives the verifier evidence schema unchanged', () => {
    const verdict = verify({ layers: { deterministic: fresh(V3) } });
    expect(verdict.layers[0].evidence).toHaveLength(1);
    expect(verdict.warnings).toEqual([]);
    expect(verdict.layers[0].status).toBe('PASS');
  });
});

/**
 * THE ID NOW NAMES THE TREE. `unified-verifier.js#buildVerificationId` hashes the
 * evidence entries, note included (`serializableEntry` copies every field), so a v3
 * record's `verification_id` changes with the sha and with the dirty flag. That is
 * the point — two passes of different trees are different verdicts — but it also
 * means a ledger reader must group v3 rows by `result`, not by hash, when it tallies
 * passes. v1/v2 ids are untouched (pinned above and in the completion suite).
 */
describe('deterministicLayerFrom — what the identity does to verification_id', () => {
  it('gives a v3 pass a different id from the same v2 pass', () => {
    expect(idHash(fresh(V3))).not.toBe(idHash(fresh(V2)));
  });

  it('gives two v3 passes of different trees different ids, and the same tree the same id', () => {
    const other = `${'f'.repeat(39)}0`;
    expect(idHash(fresh(V3))).not.toBe(idHash(fresh({ ...V3, gitSha: other })));
    expect(idHash(fresh(V3))).not.toBe(idHash(fresh({ ...V3, gitDirty: true })));
    expect(idHash(fresh(V3))).toBe(idHash(fresh({ ...V3 })));
  });
});
