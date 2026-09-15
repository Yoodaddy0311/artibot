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
 * A reporter payload shaped like `tests/reporters/test-status-reporter.js:90-98`.
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

  it('gives every branch a distinct reason, so the id hash can tell them apart', () => {
    const reasons = Object.values(REASONS);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons).toHaveLength(5);
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
      // The shape this gate wrote before a source existed. Live ledger lines
      // carrying it are pre-numerator fires, not a new unmeasured branch.
      legacyNoLayerSupplied: hashFor(undefined),
    }).toMatchInlineSnapshot(`
      {
        "absent": "cd83b9f6c3a6",
        "badTimestamp": "8193e683f558",
        "corrupt": "ecfca95e038e",
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
