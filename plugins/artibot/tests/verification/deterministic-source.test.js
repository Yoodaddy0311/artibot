import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  deterministicLayerFrom,
  readDeterministicLayer,
  REASONS,
  RESULT_FILE_RELPATH,
} from '../../lib/verification/deterministic-source.js';
import { verify } from '../../lib/verification/unified-verifier.js';

/**
 * lib/verification/deterministic-source.js — the ONLY deterministic layer
 * source the Stop gate can honestly fill today (OB-07 numerator).
 *
 * WHAT THESE TESTS MEASURE AND WHAT THEY CANNOT. Every case below is a PURE
 * call: the module never touches the filesystem, so these assertions pin the
 * decision table and the evidence shape, nothing about a real repo. Whether a
 * live Stop actually finds a fresh `last-test-result.json` is a LIVE question
 * (rules §9) answered only by `scripts/ledger/verify-rate.mjs` after landing —
 * a green run here is not evidence for it.
 *
 * THE DECISION, STATED ONCE: PASS/FAIL is written only when the reporter's
 * output is at least as new as the last main-agent edit (owner decision F1).
 * Every other outcome is UNMEASURED — which this module expresses by omitting
 * `exitCode`, because `unified-verifier.js#normalizeDeterministic` (:323-325)
 * treats a missing numeric exit code as "nothing was run".
 */

const MARKER_MS = Date.parse('2026-09-15T00:00:00.000Z');
const NOW_MS = Date.parse('2026-09-15T01:00:00.000Z');

/**
 * A reporter payload shaped like `tests/reporters/test-status-reporter.js:99-108`.
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

describe('deterministic-source — the fresh path writes a verdict', () => {
  it('returns exitCode 0 when the fresh result reports zero failures', () => {
    const layer = fresh();
    expect(layer.exitCode).toBe(0);
    expect(verify({ layers: { deterministic: layer } }).layers[0].status).toBe('PASS');
  });

  it('returns exitCode 1 when the fresh result reports failures', () => {
    const layer = fresh({ failed: 3, passed: 17362 });
    expect(layer.exitCode).toBe(1);
    expect(verify({ layers: { deterministic: layer } }).layers[0].status).toBe('FAIL');
  });

  it('treats a result written in the same millisecond as the marker as fresh', () => {
    const layer = deterministicLayerFrom({
      resultJsonText: resultJson({ timestamp: new Date(MARKER_MS).toISOString() }),
      markerMtimeMs: MARKER_MS,
      nowMs: NOW_MS,
    });
    expect(layer.exitCode, 'F1 is >=, not > — a run at the edit instant covers it').toBe(0);
  });

  /**
   * THE TWO SIDES OF F1 DO NOT CARRY THE SAME RESOLUTION.
   *
   * `statSync().mtimeMs` is fractional — measured 2026-09-15 on this machine:
   * `…522131.7466`. The reporter's `new Date().toISOString()` truncates to whole
   * milliseconds. So a run that finished in the SAME millisecond as the edit
   * comes back up to 1ms "older" than it was, and a naive comparison calls a
   * covering run stale. Compare at the resolution both sides actually have.
   *
   * Reproduced before the fix: 2 of 3 consecutive runs of a marker-then-result
   * fixture reported `stale`, with deltas of -0.747ms and -0.703ms.
   *
   * This cannot bite in production — `npm test` and the next edit are seconds
   * to hours apart — but a rule that is wrong at its own boundary is a rule
   * nobody can reason about, and the fixture above would have been flaky.
   */
  it('ignores the sub-millisecond tail of the marker mtime, which the timestamp cannot carry', () => {
    const layer = deterministicLayerFrom({
      resultJsonText: resultJson({ timestamp: new Date(MARKER_MS).toISOString() }),
      markerMtimeMs: MARKER_MS + 0.7466,
      nowMs: NOW_MS,
    });
    expect(layer.exitCode, 'a fraction of a millisecond is not staleness').toBe(0);
  });

  it('still calls a result from the previous whole millisecond stale', () => {
    const layer = deterministicLayerFrom({
      resultJsonText: resultJson({ timestamp: new Date(MARKER_MS - 1).toISOString() }),
      markerMtimeMs: MARKER_MS + 0.7466,
      nowMs: NOW_MS,
    });
    expect(layer.exitCode, 'rounding down must not become rounding away').toBeUndefined();
    expect(layer.reason).toBe(REASONS.stale);
  });

  it('carries exactly one file evidence entry, repo-relative, with the run counts', () => {
    expect(fresh().evidence).toEqual([{
      kind: 'file',
      file: 'plugins/artibot/runtime/last-test-result.json',
      line: 1,
      measured_at: '2026-09-15T00:30:00.000Z',
      note: 'vitest total=17377 passed=17365 failed=0 skipped=12',
    }]);
  });

  /**
   * `modules` is the reporter's count of test FILES
   * (`tests/reporters/test-status-reporter.js` — `onTestRunEnd`, added
   * 2026-09-17). It rides in the note for the same reason the four counts do:
   * the ledger drops `reason`, so a later reader has the note and nothing else
   * when asking how much of the tree a verdict covered.
   *
   * WHAT IT STILL DOES NOT SETTLE: a filter matching every file counts the
   * same as no filter, so this narrows "whole suite or targeted" without
   * deciding it. No boolean is written, because the reporter API exposes no
   * filter to read one from.
   */
  it('names the module count beside the test counts when the reporter wrote one', () => {
    expect(fresh({ modules: 1204 }).evidence[0].note)
      .toBe('vitest total=17377 passed=17365 failed=0 skipped=12 modules=1204');
  });

  /**
   * BACKWARD COMPATIBILITY. Snapshots written before the reporter gained the
   * field have no `modules`, and they are still valid measurements — the four
   * counts are what `parseResult` requires. Omitting the clause is how this
   * says "not recorded" without inventing a zero, which would read as an empty
   * run the `emptyRun` guard exists to reject.
   */
  it('omits the module count for a pre-field snapshot rather than guessing zero', () => {
    const note = fresh().evidence[0].note;
    expect(note).toBe('vitest total=17377 passed=17365 failed=0 skipped=12');
    expect(note).not.toContain('modules');
  });

  it('omits the module count when the field is present but not a count', () => {
    for (const modules of ['1204', -1, 1.5, null, {}]) {
      expect(fresh({ modules }).evidence[0].note, `modules=${JSON.stringify(modules)}`)
        .not.toContain('modules');
    }
  });

  it('records a zero module count when the reporter really wrote zero', () => {
    // Reachable only alongside `totalTests > 0`, which no real run produces —
    // pinned so the guard is known to test the VALUE, not truthiness.
    expect(fresh({ modules: 0 }).evidence[0].note).toContain('modules=0');
  });

  it('survives the verifier evidence schema unchanged (kind:file needs file + line >= 1)', () => {
    const verdict = verify({ layers: { deterministic: fresh() } });
    expect(verdict.layers[0].evidence).toHaveLength(1);
    expect(verdict.warnings, 'a dropped entry would surface as a warning').toEqual([]);
  });

  it('names the result file by a repo-relative POSIX path and never an absolute one', () => {
    expect(RESULT_FILE_RELPATH).toBe('plugins/artibot/runtime/last-test-result.json');
    expect(path.isAbsolute(RESULT_FILE_RELPATH)).toBe(false);
    expect(RESULT_FILE_RELPATH).not.toMatch(/\\|^[A-Za-z]:/);
  });
});

describe('deterministic-source — every unmeasured branch', () => {
  /** @type {Array<[string, object, string]>} */
  const cases = [
    ['absent result file', { resultJsonText: null, markerMtimeMs: MARKER_MS }, REASONS.absent],
    ['corrupt JSON', { resultJsonText: '{not json', markerMtimeMs: MARKER_MS }, REASONS.corrupt],
    ['JSON that is not an object', { resultJsonText: '[1,2]', markerMtimeMs: MARKER_MS }, REASONS.corrupt],
    ['non-integer counters', { resultJsonText: resultJson({ failed: 'none' }), markerMtimeMs: MARKER_MS }, REASONS.corrupt],
    ['non-ISO timestamp', { resultJsonText: resultJson({ timestamp: 'yesterday' }), markerMtimeMs: MARKER_MS }, REASONS.badTimestamp],
    ['missing timestamp', { resultJsonText: '{"totalTests":1,"passed":1,"failed":0,"skipped":0}', markerMtimeMs: MARKER_MS }, REASONS.badTimestamp],
    ['timestamp in the future', { resultJsonText: resultJson({ timestamp: '2026-09-16T00:00:00.000Z' }), markerMtimeMs: MARKER_MS }, REASONS.badTimestamp],
    ['no main-agent-edit marker', { resultJsonText: resultJson(), markerMtimeMs: null }, REASONS.noMarker],
    ['result older than the marker', { resultJsonText: resultJson({ timestamp: '2026-09-14T23:59:59.999Z' }), markerMtimeMs: MARKER_MS }, REASONS.stale],
    ['a run of zero tests', { resultJsonText: resultJson({ totalTests: 0, passed: 0, failed: 0, skipped: 0 }), markerMtimeMs: MARKER_MS }, REASONS.emptyRun],
  ];

  for (const [name, input, reason] of cases) {
    it(`reports "${name}" as unmeasured with its own reason and no evidence`, () => {
      const layer = deterministicLayerFrom({ ...input, nowMs: NOW_MS });
      expect(layer.exitCode, 'no exitCode is how this module says UNMEASURED').toBeUndefined();
      expect(layer.reason).toBe(reason);
      expect(
        layer.evidence ?? [],
        'the unmeasured fallback must stay byte-identical to the pre-numerator denominator',
      ).toEqual([]);
      const verdict = verify({ layers: { deterministic: layer } });
      expect(verdict.layers[0].status).toBe('UNMEASURED');
      expect(verdict.layers[0].evidence).toEqual([]);
      expect(verdict.status).toBe('UNMEASURED');
    });
  }

  /**
   * ZERO TESTS IS NOT A GREEN TREE — fail-open found by cross-review C.
   *
   * `failed === 0` is true of a suite that passed AND of a suite that never
   * ran. Measured by C with a real spawn: a reporter file reading
   * `totalTests: 0, failed: 0` was recorded as deterministic `pass`
   * (`v1-a69aa375bbc0-…`). A vitest run filtered down to nothing, or one that
   * died before collecting, would have written exactly that — so the gate
   * would report a verdict about a tree nobody looked at.
   *
   * The guard is a count check, not a status check, because the count is the
   * only field that can tell the two apart.
   */
  it('refuses to call a run of zero tests a pass, however fresh the file is', () => {
    const layer = deterministicLayerFrom({
      resultJsonText: resultJson({ totalTests: 0, passed: 0, failed: 0, skipped: 0 }),
      markerMtimeMs: MARKER_MS,
      nowMs: NOW_MS,
    });
    expect(layer.exitCode, 'failed===0 is also true of a suite that never ran').toBeUndefined();
    expect(layer.reason).toBe(REASONS.emptyRun);
    expect(layer.evidence ?? []).toEqual([]);
    expect(verify({ layers: { deterministic: layer } }).status).toBe('UNMEASURED');
  });

  it('still counts a run whose tests were all skipped — something was collected', () => {
    const layer = deterministicLayerFrom({
      resultJsonText: resultJson({ totalTests: 12, passed: 0, failed: 0, skipped: 12 }),
      markerMtimeMs: MARKER_MS,
      nowMs: NOW_MS,
    });
    expect(layer.exitCode, 'the guard is about an EMPTY run, not an idle one').toBe(0);
  });

  it('gives every branch a distinct reason, so the id hash can tell them apart', () => {
    const reasons = Object.values(REASONS);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons).toHaveLength(6);
  });

  it('keeps the clock out of the decision when nowMs is unusable (no TTL, owner decision F1)', () => {
    const layer = deterministicLayerFrom({
      resultJsonText: resultJson(),
      markerMtimeMs: MARKER_MS,
      nowMs: Number.NaN,
    });
    expect(layer.exitCode, 'an unusable clock disables the future guard, it does not expire a run').toBe(0);
  });
});

/**
 * REASON -> ID HASH TABLE.
 *
 * `reason` never reaches the ledger (`verify-writer.js` writes only `layer`,
 * `result`, `evidence`, `verification_id`), so the ONLY way a later reader can
 * tell "stale" apart from "absent" in production data is the hash half of
 * `verification_id`. Pinning the table here is what makes that after-the-fact
 * tally possible — and what makes an accidental reason edit visible as a test
 * failure instead of a silent break in the live histogram.
 *
 * The hash covers the verdict shape only, never `measured_at`
 * (`unified-verifier.js#buildVerificationId` builds `shape` without it), so
 * these twelve hex digits are stable across runs and machines.
 */
describe('deterministic-source — reason to verification_id hash', () => {
  /** @param {string|undefined} reason */
  function hashFor(reason) {
    const layers = { deterministic: reason === undefined ? undefined : { reason } };
    return verify({ layers }).verification_id.split('-')[1];
  }

  it('pins one hash prefix per unmeasured reason', () => {
    expect({
      absent: hashFor(REASONS.absent),
      corrupt: hashFor(REASONS.corrupt),
      badTimestamp: hashFor(REASONS.badTimestamp),
      noMarker: hashFor(REASONS.noMarker),
      stale: hashFor(REASONS.stale),
      emptyRun: hashFor(REASONS.emptyRun),
      // The shape this gate wrote before a source existed. Live ledger lines
      // carrying it are pre-numerator fires, not a new unmeasured branch.
      legacyNoLayerSupplied: hashFor(undefined),
    }).toMatchInlineSnapshot(`
      {
        "absent": "cd83b9f6c3a6",
        "badTimestamp": "8193e683f558",
        "corrupt": "ecfca95e038e",
        "emptyRun": "a6a1361a1360",
        "legacyNoLayerSupplied": "83866286c2d8",
        "noMarker": "aff638bdfb2b",
        "stale": "f51a647bdd7d",
      }
    `);
  });
});

describe('readDeterministicLayer — the port boundary', () => {
  /**
   * @param {object} p
   * @returns {{ ports: object, seen: string[] }}
   */
  function spyPorts({ result = resultJson(), marker = MARKER_MS, throwOn = '' } = {}) {
    const seen = [];
    return {
      seen,
      ports: {
        readFile(p) {
          seen.push(p);
          if (throwOn === 'read') throw new Error('EACCES (injected)');
          return result;
        },
        statMtimeMs(p) {
          seen.push(p);
          if (throwOn === 'stat') throw new Error('EPERM (injected)');
          return marker;
        },
      },
    };
  }

  it('wraps the layer under the key verify() expects', () => {
    const { ports } = spyPorts();
    const layers = readDeterministicLayer(ports, { repoRoot: '/repo', pluginRoot: '/plugin', nowMs: NOW_MS });
    expect(Object.keys(layers)).toEqual(['deterministic']);
    expect(layers.deterministic.exitCode).toBe(0);
  });

  it('reads the result under repoRoot and the marker under pluginRoot (owner decision R1)', () => {
    const { ports, seen } = spyPorts();
    readDeterministicLayer(ports, { repoRoot: '/repo', pluginRoot: '/plugin', nowMs: NOW_MS });
    expect(seen).toEqual([
      path.join('/repo', 'plugins', 'artibot', 'runtime', 'last-test-result.json'),
      path.join('/plugin', 'runtime', 'last-main-agent-edit.timestamp'),
    ]);
  });

  it('degrades to absent when the result port throws', () => {
    const { ports } = spyPorts({ throwOn: 'read' });
    const layers = readDeterministicLayer(ports, { repoRoot: '/repo', pluginRoot: '/plugin', nowMs: NOW_MS });
    expect(layers.deterministic).toEqual({ reason: REASONS.absent });
  });

  it('degrades to noMarker when the marker port throws', () => {
    const { ports } = spyPorts({ throwOn: 'stat' });
    const layers = readDeterministicLayer(ports, { repoRoot: '/repo', pluginRoot: '/plugin', nowMs: NOW_MS });
    expect(layers.deterministic).toEqual({ reason: REASONS.noMarker });
  });

  it('degrades to absent when repoRoot is missing, without calling any port', () => {
    const { ports, seen } = spyPorts();
    const layers = readDeterministicLayer(ports, { repoRoot: null, pluginRoot: '/plugin', nowMs: NOW_MS });
    expect(layers.deterministic).toEqual({ reason: REASONS.absent });
    expect(seen).toEqual([]);
  });

  it('degrades to noMarker when pluginRoot is missing', () => {
    const { ports } = spyPorts();
    const layers = readDeterministicLayer(ports, { repoRoot: '/repo', pluginRoot: '', nowMs: NOW_MS });
    expect(layers.deterministic).toEqual({ reason: REASONS.noMarker });
  });

  it('never throws when the ports object itself is missing', () => {
    expect(readDeterministicLayer(undefined, { repoRoot: '/repo', pluginRoot: '/plugin', nowMs: NOW_MS }))
      .toEqual({ deterministic: { reason: REASONS.absent } });
  });
});
