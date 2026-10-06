import { describe, expect, it } from 'vitest';
import { deterministicLayerFrom, REASONS } from '../../lib/verification/deterministic-source.js';
import { verify } from '../../lib/verification/unified-verifier.js';

/**
 * lib/verification/deterministic-source.js — the COMPLETION record: what the
 * reporter's `schemaVersion: 2` and `completion` fields do to the verdict.
 * Moved out of `deterministic-source.test.js` unchanged (a pure move, 2026-10-06)
 * so both files stay under the repo's 800-line standard. That file keeps the
 * freshness and unmeasured-branch decision table, the reason-to-id hash pins and
 * the port boundary.
 *
 * WHAT THESE TESTS MEASURE AND WHAT THEY CANNOT. Every case below is a PURE
 * call: the module never touches the filesystem, so these assertions pin the
 * decision order and the evidence shape, nothing about a real repo. Whether a
 * live Stop finds a v2 snapshot and records it is a LIVE question (rules §9)
 * answered only by `scripts/ledger/verify-rate.mjs` after landing — a green run
 * here is not evidence for it.
 *
 * UNMEASURED is expressed by omitting `exitCode`, because
 * `unified-verifier.js#normalizeDeterministic` (:323-325) treats a missing
 * numeric exit code as "nothing was run".
 */

const MARKER_MS = Date.parse('2026-09-15T00:00:00.000Z');
const NOW_MS = Date.parse('2026-09-15T01:00:00.000Z');

/**
 * A reporter payload without `completion` (v1): the eight keys of
 * `tests/reporters/test-status-reporter.js:126-133`. A v2 case adds `schemaVersion`
 * and `completion` (:134-139) through `over`.
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
  return deterministicLayerFrom({
    resultJsonText: resultJson(over),
    markerMtimeMs: MARKER_MS,
    nowMs: NOW_MS,
  });
}

/** What the reporter writes for a run that ended cleanly. */
const CLEAN_COMPLETION = Object.freeze({ reason: 'passed', unhandledErrorCount: 0, unfinishedCount: 0 });

/**
 * A v2 record, as the reporter writes it today. `completion` is MERGED over the
 * clean one so a case names only the field it is about; a case that needs the
 * completion missing or malformed as a whole goes through `fresh()` instead.
 *
 * @param {object} [completion]
 * @param {object} [over]
 */
function freshV2(completion = {}, over = {}) {
  return fresh({ schemaVersion: 2, completion: { ...CLEAN_COMPLETION, ...completion }, ...over });
}

/**
 * The shape this module uses to say UNMEASURED, and what the verifier makes of it.
 *
 * @param {{ exitCode?: number, reason: string, evidence?: object[] }} layer
 * @param {string} reason
 */
function expectUnmeasured(layer, reason) {
  expect(layer.exitCode, 'no exitCode is how this module says UNMEASURED').toBeUndefined();
  expect(layer.reason).toBe(reason);
  expect(layer.evidence ?? [], 'the unmeasured shape carries no evidence').toEqual([]);
  const verdict = verify({ layers: { deterministic: layer } });
  expect(verdict.layers[0].status).toBe('UNMEASURED');
  expect(verdict.layers[0].evidence).toEqual([]);
}

describe('deterministic-source — a record without completion (v1) is read exactly as before', () => {
  /**
   * BYTE FOR BYTE, not merely "still passes". These literals are what this module
   * wrote before `completion` existed, captured from the unmodified module on
   * 2026-10-06. The reason and the note are hashed into `verification_id`, so a
   * changed word is a re-keyed histogram, not a cosmetic edit.
   */
  it('writes the exact pre-completion passing layer', () => {
    expect(fresh()).toEqual({
      exitCode: 0,
      reason: 'vitest result fresh — 17377 tests, 17365 passed, 0 failed, 12 skipped '
        + '(measured 2026-09-15T00:30:00.000Z, at or after the last main-agent edit)',
      evidence: [{
        kind: 'file',
        file: 'plugins/artibot/runtime/last-test-result.json',
        line: 1,
        measured_at: '2026-09-15T00:30:00.000Z',
        note: 'vitest total=17377 passed=17365 failed=0 skipped=12',
      }],
    });
  });

  it('writes the exact pre-completion failing layer', () => {
    expect(fresh({ failed: 3, passed: 17362 })).toEqual({
      exitCode: 1,
      reason: 'vitest result fresh — 17377 tests, 17362 passed, 3 failed, 12 skipped '
        + '(measured 2026-09-15T00:30:00.000Z, at or after the last main-agent edit)',
      evidence: [{
        kind: 'file',
        file: 'plugins/artibot/runtime/last-test-result.json',
        line: 1,
        measured_at: '2026-09-15T00:30:00.000Z',
        note: 'vitest total=17377 passed=17362 failed=3 skipped=12',
      }],
    });
  });

  it('keeps the verification_id of those layers (captured from the unmodified module)', () => {
    /** @param {object} layer */
    const idHash = (layer) => verify({ layers: { deterministic: layer } }).verification_id.split('-')[1];

    expect({
      pass: idHash(fresh()),
      passWithModules: idHash(fresh({ modules: 1204 })),
      fail: idHash(fresh({ failed: 3, passed: 17362 })),
    }).toEqual({ pass: '5b205cc3239d', passWithModules: '0b3dfdb07f7a', fail: '0e6febebe237' });
  });

  it('keeps reading a record whose schema version is below 2 as v1', () => {
    for (const schemaVersion of [0, 1, 1.5, -1]) {
      expect(fresh({ schemaVersion }), `schemaVersion=${schemaVersion}`).toEqual(fresh());
    }
  });
});

describe('deterministic-source — a v2 record passes only when the run ended cleanly', () => {
  /** @param {object} layer */
  const statusOf = (layer) => verify({ layers: { deterministic: layer } }).layers[0].status;

  it('passes when vitest says passed, nothing was unhandled and nothing is unfinished', () => {
    const layer = freshV2();
    expect(layer).toEqual({
      exitCode: 0,
      reason: 'vitest result fresh — 17377 tests, 17365 passed, 0 failed, 12 skipped '
        + '(measured 2026-09-15T00:30:00.000Z, at or after the last main-agent edit); '
        + 'the run ended cleanly (no unhandled errors, no unfinished tests)',
      evidence: [{
        kind: 'file',
        file: 'plugins/artibot/runtime/last-test-result.json',
        line: 1,
        measured_at: '2026-09-15T00:30:00.000Z',
        note: 'vitest total=17377 passed=17365 failed=0 skipped=12 completion=passed unhandled=0 unfinished=0',
      }],
    });
    expect(statusOf(layer)).toBe('PASS');
  });

  it('puts the completion clause after the module count, so the older clauses keep their place', () => {
    expect(freshV2({}, { modules: 1204 }).evidence[0].note).toBe(
      'vitest total=17377 passed=17365 failed=0 skipped=12 modules=1204 '
      + 'completion=passed unhandled=0 unfinished=0',
    );
  });

  it('fails when tests failed, and still says how the run ended', () => {
    // A clean completion on purpose, though no real run writes one beside a failed
    // test: with reason 'failed' the third rule would also say exitCode 1 and a
    // broken first rule could not be seen. Only the failed count can fail this one.
    const layer = freshV2({}, { failed: 3, passed: 17362 });
    expect(layer.exitCode).toBe(1);
    expect(layer.reason).toBe(
      'vitest result fresh — 17377 tests, 17362 passed, 3 failed, 12 skipped '
      + '(measured 2026-09-15T00:30:00.000Z, at or after the last main-agent edit)',
    );
    expect(layer.evidence[0].note)
      .toBe('vitest total=17377 passed=17362 failed=3 skipped=12 completion=passed unhandled=0 unfinished=0');
    expect(statusOf(layer)).toBe('FAIL');
  });

  it('spells a completion field it cannot read "unknown" and never copies the raw value into the note', () => {
    const unreadable = fresh({
      schemaVersion: 2,
      failed: 1,
      passed: 17364,
      completion: { reason: 'cancelled', unhandledErrorCount: -1, unfinishedCount: '0' },
    });
    const absent = fresh({ schemaVersion: 2, failed: 1, passed: 17364 });
    const unknownClause = 'completion=unknown unhandled=unknown unfinished=unknown';

    expect(unreadable.exitCode, 'a counted failure is still a failure').toBe(1);
    expect(unreadable.evidence[0].note).toBe(`vitest total=17377 passed=17364 failed=1 skipped=12 ${unknownClause}`);
    expect(absent.evidence[0].note).toBe(`vitest total=17377 passed=17364 failed=1 skipped=12 ${unknownClause}`);
  });

  /**
   * Measured on vitest 4.0.18, 2026-10-06 (real runs, vitest exit 1 in both): an
   * unobserved promise rejection and an exception thrown from a timer each leave
   * `failed: 0` AND vitest's reason 'passed', with ONE unhandled error. The count
   * is the only field that carries them.
   */
  it('fails when unhandled errors were raised although every test passed and vitest said passed', () => {
    const layer = freshV2({ unhandledErrorCount: 1 });
    expect(layer.exitCode).toBe(1);
    expect(layer.reason).toContain('1 unhandled error(s) outside the tests');
    expect(layer.evidence[0].note).toContain('completion=passed unhandled=1 unfinished=0');
    expect(statusOf(layer)).toBe('FAIL');
  });

  /**
   * Measured the same way: a `beforeAll` that throws inside a `describe` ends with
   * reason 'failed', no failed test (all three skipped) and no unhandled error; an
   * `afterAll` that throws leaves every test 'passed'. Vitest exits 1 for both.
   */
  it("fails when vitest itself ended the run as 'failed' although no test failed", () => {
    const layer = freshV2({ reason: 'failed' }, { totalTests: 3, passed: 0, skipped: 3 });
    expect(layer.exitCode).toBe(1);
    expect(layer.reason).toContain('vitest itself ended the run as failed');
    expect(layer.evidence[0].note).toContain('completion=failed unhandled=0 unfinished=0');
    expect(statusOf(layer)).toBe('FAIL');
  });

  it('reports an interrupted run as unmeasured — what finished does not cover the tree', () => {
    expectUnmeasured(freshV2({ reason: 'interrupted' }), REASONS.interrupted);
  });

  it('reports tests that never reached a final state as unmeasured', () => {
    expectUnmeasured(freshV2({ unfinishedCount: 3 }), REASONS.unfinished);
  });

  it('keeps the evidence a single file entry the verifier accepts', () => {
    const verdict = verify({ layers: { deterministic: freshV2() } });
    expect(verdict.layers[0].evidence).toHaveLength(1);
    expect(verdict.warnings, 'a dropped entry would surface as a warning').toEqual([]);
  });
});

describe('deterministic-source — a v2 record with an unusable completion is unmeasured', () => {
  /** @type {Array<[string, object]>} */
  const cases = [
    ['no completion key (the schema version alone)', { schemaVersion: 2 }],
    ['completion null', { schemaVersion: 2, completion: null }],
    ['completion a list', { schemaVersion: 2, completion: [] }],
    ['completion a string', { schemaVersion: 2, completion: 'passed' }],
    ['completion a number', { schemaVersion: 2, completion: 42 }],
    ['completion an empty object', { schemaVersion: 2, completion: {} }],
    ['reason unknown (the reporter wrote null)', { completion: { ...CLEAN_COMPLETION, reason: null } }],
    ['reason missing', { completion: { unhandledErrorCount: 0, unfinishedCount: 0 } }],
    ['reason outside the vitest vocabulary', { completion: { ...CLEAN_COMPLETION, reason: 'cancelled' } }],
    ['reason in the wrong case', { completion: { ...CLEAN_COMPLETION, reason: 'PASSED' } }],
    ['reason not a string', { completion: { ...CLEAN_COMPLETION, reason: 42 } }],
    ['unhandled count unknown (the reporter wrote null)', { completion: { ...CLEAN_COMPLETION, unhandledErrorCount: null } }],
    ['unhandled count missing', { completion: { reason: 'passed', unfinishedCount: 0 } }],
    ['unhandled count negative', { completion: { ...CLEAN_COMPLETION, unhandledErrorCount: -1 } }],
    ['unhandled count fractional', { completion: { ...CLEAN_COMPLETION, unhandledErrorCount: 1.5 } }],
    ['unhandled count a string', { completion: { ...CLEAN_COMPLETION, unhandledErrorCount: '0' } }],
    ['unfinished count unknown', { completion: { ...CLEAN_COMPLETION, unfinishedCount: null } }],
    ['unfinished count missing', { completion: { reason: 'passed', unhandledErrorCount: 0 } }],
    ['unfinished count negative', { completion: { ...CLEAN_COMPLETION, unfinishedCount: -1 } }],
    ['unfinished count fractional', { completion: { ...CLEAN_COMPLETION, unfinishedCount: 0.5 } }],
    ['unfinished count a string', { completion: { ...CLEAN_COMPLETION, unfinishedCount: '0' } }],
  ];

  for (const [name, over] of cases) {
    it(`reports "${name}" as unmeasured instead of passing it`, () => {
      expectUnmeasured(fresh(over), REASONS.completionUnreadable);
    });
  }
});

describe('deterministic-source — v2 precedence', () => {
  it('lets a counted failure outrank an interrupted run', () => {
    // Measured: --bail=1 after a failing test ends with reason 'interrupted',
    // failed 1 and the next test 'pending'. Vitest exits 1 — the failure is the fact.
    const layer = freshV2(
      { reason: 'interrupted', unfinishedCount: 1 },
      { totalTests: 2, passed: 0, failed: 1, skipped: 0 },
    );
    expect(layer.exitCode).toBe(1);
  });

  it('lets a counted failure outrank an unusable completion record', () => {
    expect(fresh({ schemaVersion: 2, completion: 'garbage', failed: 1, passed: 17364 }).exitCode).toBe(1);
    expect(fresh({ schemaVersion: 2, failed: 1, passed: 17364 }).exitCode).toBe(1);
  });

  it('lets unhandled errors outrank unfinished tests (a killed worker)', () => {
    // Measured: a worker killed mid-file leaves EVERY test of that file 'pending' —
    // one that had already passed included — with reason 'passed' and one unhandled
    // error. Vitest exits 1.
    const layer = freshV2(
      { unhandledErrorCount: 1, unfinishedCount: 3 },
      { totalTests: 3, passed: 0, failed: 0, skipped: 0 },
    );
    expect(layer.exitCode).toBe(1);
  });

  it('lets unhandled errors outrank an interrupted run', () => {
    expect(freshV2({ reason: 'interrupted', unhandledErrorCount: 2 }).exitCode).toBe(1);
  });

  it("lets vitest's own 'failed' outrank unusable counts", () => {
    const layer = fresh({
      schemaVersion: 2,
      completion: { reason: 'failed', unhandledErrorCount: null, unfinishedCount: 'x' },
    });
    expect(layer.exitCode).toBe(1);
  });

  it('lets interrupted outrank unfinished', () => {
    expectUnmeasured(freshV2({ reason: 'interrupted', unfinishedCount: 2 }), REASONS.interrupted);
  });

  it('lets unfinished outrank an unusable record', () => {
    expectUnmeasured(
      fresh({ schemaVersion: 2, completion: { reason: null, unhandledErrorCount: 0, unfinishedCount: 2 } }),
      REASONS.unfinished,
    );
  });
});

describe('deterministic-source — which records are v2', () => {
  it('reads a completion key without a schema version as v2', () => {
    expectUnmeasured(
      fresh({ completion: { ...CLEAN_COMPLETION, reason: 'interrupted' } }),
      REASONS.interrupted,
    );
  });

  it('reads a schema version of 2 without a completion key as v2 — and unreadable', () => {
    expectUnmeasured(fresh({ schemaVersion: 2 }), REASONS.completionUnreadable);
  });

  it('reads a schema version above 2 as v2', () => {
    expect(fresh({ schemaVersion: 3, completion: CLEAN_COMPLETION }).evidence[0].note)
      .toContain('completion=passed');
    expectUnmeasured(fresh({ schemaVersion: 3 }), REASONS.completionUnreadable);
  });

  it('lets a completion key outrank a schema version below 2', () => {
    expectUnmeasured(
      fresh({ schemaVersion: 1, completion: { ...CLEAN_COMPLETION, reason: 'interrupted' } }),
      REASONS.interrupted,
    );
  });

  /**
   * FAIL CLOSED. Only an absent version, or a number below 2, is v1 — the one
   * shape the reporter ever wrote without a completion. A version that is present
   * but is not a number is not a record this module can vouch for.
   */
  it('reads a schema version that is not a number as v2 rather than as v1', () => {
    for (const schemaVersion of ['2', '1', 'v1', null, true, {}, []]) {
      expectUnmeasured(fresh({ schemaVersion }), REASONS.completionUnreadable);
    }
  });
});

describe('deterministic-source — a v2 record meets the same guards, in the same order', () => {
  // Would FAIL (exitCode 1) if completion were read first.
  const bad = { schemaVersion: 2, completion: { reason: 'failed', unhandledErrorCount: 3, unfinishedCount: 2 } };

  it('reports a run of zero tests as empty, whatever its completion says', () => {
    expect(fresh({ ...bad, totalTests: 0, passed: 0, failed: 0, skipped: 0 }).reason).toBe(REASONS.emptyRun);
  });

  it('reports corrupt counters before reading completion', () => {
    expect(fresh({ ...bad, failed: 'none' }).reason).toBe(REASONS.corrupt);
  });

  it('reports an unusable timestamp before reading completion', () => {
    expect(fresh({ ...bad, timestamp: 'yesterday' }).reason).toBe(REASONS.badTimestamp);
  });

  it('reports a missing marker before reading completion', () => {
    const layer = deterministicLayerFrom({ resultJsonText: resultJson(bad), markerMtimeMs: null, nowMs: NOW_MS });
    expect(layer.reason).toBe(REASONS.noMarker);
  });

  it('reports a stale run before reading completion', () => {
    expect(fresh({ ...bad, timestamp: '2026-09-14T23:59:59.999Z' }).reason).toBe(REASONS.stale);
  });
});

/**
 * THE SNAPSHOTS A REAL VITEST 4.0.18 WROTE, AGAINST THE EXIT CODE IT GAVE.
 *
 * Each row is what the reporter wrote for one run of a scratch micro-suite on
 * 2026-10-06, with vitest's own process exit code beside it. The invariant is the
 * whole point of the completion slice: wherever vitest exited non-zero the verdict
 * is never `exitCode 0`, and wherever it exited 0 the verdict is 0 — which the
 * hand-built fixtures above cannot show, because their author chose the shapes.
 *
 * WHAT THIS CANNOT SEE: it replays frozen measurements. A vitest upgrade that
 * changes one of these shapes is invisible here; only a fresh real run sees it.
 */
describe('deterministic-source — the verdict agrees with the exit code of the real run behind the snapshot', () => {
  /** @type {Array<[string, number, number[], [string, number, number], number|string]>} */
  const rows = [
    // scenario, vitest exit, [total, passed, failed, skipped], [reason, unhandled, unfinished], verdict
    ['all tests pass', 0, [2, 2, 0, 0], ['passed', 0, 0], 0],
    ['a test fails', 1, [2, 1, 1, 0], ['failed', 0, 0], 1],
    ['unobserved promise rejection', 1, [1, 1, 0, 0], ['passed', 1, 0], 1],
    ['exception thrown from a timer', 1, [1, 1, 0, 0], ['passed', 1, 0], 1],
    ['beforeAll throws inside a describe', 1, [3, 0, 0, 3], ['failed', 0, 0], 1],
    ['afterAll throws inside a describe', 1, [2, 2, 0, 0], ['failed', 0, 0], 1],
    ['worker killed mid-file', 1, [3, 0, 0, 0], ['passed', 1, 3], 1],
    ['--bail=1 after a failing test', 1, [2, 0, 1, 0], ['interrupted', 0, 1], 1],
    ['only skip, todo and ctx.skip()', 0, [3, 0, 0, 3], ['passed', 0, 0], 0],
    ['beforeAll throws at file top level', 1, [2, 0, 1, 2], ['failed', 0, 0], 1],
    ['a broken file beside a passing one', 1, [1, 1, 1, 0], ['failed', 0, 0], 1],
    // Not a pass, which is the invariant; the zero-test guard answers before completion is read.
    ['a file that throws while collecting', 1, [0, 0, 1, 0], ['failed', 0, 0], 'UNMEASURED'],
  ];

  for (const [scenario, vitestExit, [totalTests, passed, failed, skipped], [reason, unhandled, unfinished], verdict] of rows) {
    it(`${scenario}: vitest exit ${vitestExit}, verdict ${verdict}`, () => {
      const layer = fresh({
        totalTests,
        passed,
        failed,
        skipped,
        schemaVersion: 2,
        completion: { reason, unhandledErrorCount: unhandled, unfinishedCount: unfinished },
      });

      expect(layer.exitCode ?? 'UNMEASURED').toBe(verdict);
      if (vitestExit === 0) expect(layer.exitCode, 'a clean run stays a pass').toBe(0);
      else expect(layer.exitCode, 'a run vitest exited non-zero on is never a pass').not.toBe(0);
    });
  }
});
