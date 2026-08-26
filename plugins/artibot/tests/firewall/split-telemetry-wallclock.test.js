/**
 * Firewall — `/split` measurement contract (PRD split-cross-session-multi-
 * worktree G4 / Phase 5, 2026-08-26).
 *
 * ── What is being protected ─────────────────────────────────────────────────
 * The `/split` vs `-fast` speed comparison has NO real-operator data on either
 * side (2026-08-26: autopilot wall-clock telemetry 0 rows, `/split` runs 0).
 * Until it does, the only thing that can be made true is the *shape* of what
 * will be recorded, so that the first live run is comparable at all:
 *
 *   1. `wall-clock-start` / `wall-clock-end` pairs. An unpaired window is
 *      `null`, never `0`. `0` means "measured, zero length"; `null` means "not
 *      measured". Conflating them is how a stalled phase once read as instant.
 *   2. `fast-profile-planned` carries the same nine `data` keys, spelled the
 *      same, in the same order, as `lib/autopilot/engine.js` writes for `-fast`.
 *      The list is compared against the engine SOURCE, not a copy of it.
 *   3. `phase-start` / `phase-end` pairs that `replay.js#findUnterminatedPhases`
 *      reads unchanged — one pairing walk for both streams.
 *   4. `replay.js` reports unmeasured durations as `null`; this is the 0→null
 *      change, and this file is where it is pinned.
 *   5. `lib/observability/run-events.js` has two real consumers (autopilot
 *      telemetry + split telemetry). A promotion with one consumer is the
 *      `lib/orchestration/` mistake the PRD forbids repeating.
 *   6. Split telemetry is record-only: it imports no config and holds no
 *      threshold. The human-wait re-evaluation rule is the reader's.
 *
 * ── ACCEPTANCE ──────────────────────────────────────────────────────────────
 * 라이브 1회 실측 없이는 수락 불가 (PRD 수락기준 Phase 5): `/split` 라이브 1회
 * 후 ndjson 에서 phase 쌍 · 9필드 · 미쌍 null 을 실측해야 한다. 이 파일이
 * 그린이어도 그 실측을 대체하지 않는다.
 *
 * ── WHAT THIS GATE DOES NOT SEE ─────────────────────────────────────────────
 *   - Whether `/split` (a markdown-driven command) ever calls these helpers.
 *     A recorder nobody invokes writes nothing; existence is not operation.
 *   - Fixture scale: one run, a handful of segments. A real run has N windows
 *     and a human between them.
 *   - Whether the wall-clock a human experiences matches the timestamps the
 *     recorder gets handed. The `ts` seam exists precisely so tests can lie.
 *   - The `-fast` side of the comparison — only its field names are checked.
 *   - `runtime/split/` on a real machine: every write here goes to
 *     `os.tmpdir()` (shared-tree rule), so path resolution against the real
 *     plugin root is asserted by string only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAST_PROFILE_PLANNED_FIELDS,
  fastProfileFromPlan,
  getSplitEventsPath,
  getSplitStoreDir,
  readSplitEvents,
  recordFastProfilePlanned,
  recordPhaseEnd,
  recordPhaseStart,
  recordWallClockEnd,
  recordWallClockStart,
  RUN_SEGMENT,
  summarizeWallClock,
} from '../../lib/observability/split-telemetry.js';
import { normalizeRunEvent, RUN_EVENTS_SUFFIX } from '../../lib/observability/run-events.js';
import { findUnterminatedPhases, summarizeEvents } from '../../lib/autopilot/replay.js';
import { buildFastFanoutPlan } from '../../lib/autopilot/fast-profile.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_PATH = path.join(PLUGIN_ROOT, 'lib', 'autopilot', 'engine.js');
const TELEMETRY_PATH = path.join(PLUGIN_ROOT, 'lib', 'autopilot', 'telemetry.js');
const SPLIT_TELEMETRY_PATH = path.join(PLUGIN_ROOT, 'lib', 'observability', 'split-telemetry.js');

// Key order of every line autopilot has ever written (checked against
// runtime/autopilot/ap-20260514-042942-21a3.events.ndjson, read-only,
// 2026-08-26). `data` is optional and always last.
const LINE_KEY_ORDER = ['ts', 'sessionId', 'phase', 'type', 'level', 'message'];

const T0 = Date.parse('2026-08-26T12:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

let storeDir;
let runCounter = 0;

function nextRunId() {
  runCounter += 1;
  return `split-fw-${runCounter}`;
}

beforeEach(() => {
  storeDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-split-telemetry-'));
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

/**
 * Pull the `data: { ... }` key list out of the engine's `fast-profile-planned`
 * tick. Regex over source on purpose: importing `engine.js` would drag the
 * whole autopilot boot in, and what we want to pin is the *spelling* in the
 * file, which is what a human editing the engine changes.
 * @returns {string[]}
 */
function engineFastProfileFields() {
  const src = readFileSync(ENGINE_PATH, 'utf-8');
  const anchor = src.indexOf("'fast-profile-planned'");
  expect(anchor, "engine.js no longer contains 'fast-profile-planned'").toBeGreaterThan(-1);
  const dataStart = src.indexOf('data: {', anchor);
  const dataEnd = src.indexOf('}', dataStart);
  const block = src.slice(dataStart + 'data: {'.length, dataEnd);
  return block
    .split(',')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry) => entry.split(':')[0].trim());
}

describe('wall-clock pairs — unpaired is null, never 0', () => {
  it('measures a paired window and leaves an unpaired start as null', () => {
    const runId = nextRunId();
    recordWallClockStart(runId, { segment: RUN_SEGMENT, storeDir, ts: at(0) });
    recordWallClockStart(runId, { segment: 'dispatch', storeDir, ts: at(1_000) });
    recordWallClockEnd(runId, { segment: 'dispatch', storeDir, ts: at(4_000) });
    // `run` never closes — the process died, or the operator walked away.

    const summary = summarizeWallClock(readSplitEvents(runId, { storeDir }));
    const dispatch = summary.segments.find((s) => s.segment === 'dispatch');
    const run = summary.segments.find((s) => s.segment === RUN_SEGMENT);

    expect(dispatch.durationMs).toBe(3_000);
    expect(run.durationMs).toBeNull();
    expect(run.endedAt).toBeNull();
    expect(summary.totalMs).toBeNull();
    expect(summary.unpaired).toEqual([{ segment: RUN_SEGMENT, side: 'start', ts: at(0) }]);
  });

  it('records an end with no start as unpaired and measures nothing for it', () => {
    const runId = nextRunId();
    recordWallClockEnd(runId, { segment: 'open-windows', storeDir, ts: at(500) });

    const summary = summarizeWallClock(readSplitEvents(runId, { storeDir }));
    expect(summary.segments).toEqual([]);
    expect(summary.unpaired).toEqual([{ segment: 'open-windows', side: 'end', ts: at(500) }]);
    expect(summary.totalMs).toBeNull();
    expect(summary.humanWaitMs).toBeNull();
    expect(summary.humanWaitPct).toBeNull();
  });

  it('keeps 0 for a real zero-length window and null for a non-monotonic one', () => {
    const runId = nextRunId();
    recordWallClockStart(runId, { segment: 'instant', storeDir, ts: at(0) });
    recordWallClockEnd(runId, { segment: 'instant', storeDir, ts: at(0) });
    recordWallClockStart(runId, { segment: 'skewed', storeDir, ts: at(5_000) });
    recordWallClockEnd(runId, { segment: 'skewed', storeDir, ts: at(1_000) });

    const summary = summarizeWallClock(readSplitEvents(runId, { storeDir }));
    expect(summary.segments.find((s) => s.segment === 'instant').durationMs).toBe(0);
    expect(summary.segments.find((s) => s.segment === 'skewed').durationMs).toBeNull();
  });

  it('never emits 0 for any window that lacks an end', () => {
    const runId = nextRunId();
    for (const segment of ['a', 'b', 'c']) {
      recordWallClockStart(runId, { segment, storeDir, ts: at(0) });
    }
    const summary = summarizeWallClock(readSplitEvents(runId, { storeDir }));
    expect(summary.segments).toHaveLength(3);
    for (const s of summary.segments) expect(s.durationMs).toBeNull();
    expect(summary.segments.some((s) => s.durationMs === 0)).toBe(false);
  });

  it('tolerates garbage input without throwing', () => {
    expect(summarizeWallClock(null)).toEqual({
      segments: [], unpaired: [], totalMs: null, humanWaitMs: null, humanWaitPct: null,
    });
    expect(summarizeWallClock([null, 1, {}, { type: 'wall-clock-start' }]).segments).toEqual([]);
  });
});

describe('human-wait share — a percentage over a partial sum is not a number', () => {
  it('computes humanWaitPct only when run and every human-wait window are paired', () => {
    const runId = nextRunId();
    recordWallClockStart(runId, { segment: RUN_SEGMENT, storeDir, ts: at(0) });
    recordWallClockStart(runId, { segment: 'open-windows', humanWait: true, storeDir, ts: at(0) });
    recordWallClockEnd(runId, { segment: 'open-windows', storeDir, ts: at(30_000) });
    recordWallClockStart(runId, { segment: 'dispatch', storeDir, ts: at(30_000) });
    recordWallClockEnd(runId, { segment: 'dispatch', storeDir, ts: at(40_000) });
    recordWallClockStart(runId, { segment: 'confirm-integrate', humanWait: true, storeDir, ts: at(40_000) });
    recordWallClockEnd(runId, { segment: 'confirm-integrate', storeDir, ts: at(50_000) });
    recordWallClockEnd(runId, { segment: RUN_SEGMENT, storeDir, ts: at(100_000) });

    const summary = summarizeWallClock(readSplitEvents(runId, { storeDir }));
    expect(summary.totalMs).toBe(100_000);
    expect(summary.humanWaitMs).toBe(40_000);
    expect(summary.humanWaitPct).toBe(40);
    expect(summary.unpaired).toEqual([]);
  });

  it('returns null humanWaitPct when one human-wait window never closed', () => {
    const runId = nextRunId();
    recordWallClockStart(runId, { segment: RUN_SEGMENT, storeDir, ts: at(0) });
    recordWallClockStart(runId, { segment: 'open-windows', humanWait: true, storeDir, ts: at(0) });
    recordWallClockEnd(runId, { segment: 'open-windows', storeDir, ts: at(30_000) });
    recordWallClockStart(runId, { segment: 'confirm-integrate', humanWait: true, storeDir, ts: at(40_000) });
    recordWallClockEnd(runId, { segment: RUN_SEGMENT, storeDir, ts: at(100_000) });

    const summary = summarizeWallClock(readSplitEvents(runId, { storeDir }));
    expect(summary.totalMs).toBe(100_000);
    expect(summary.humanWaitMs).toBeNull();
    expect(summary.humanWaitPct).toBeNull();
    expect(summary.unpaired).toEqual([{ segment: 'confirm-integrate', side: 'start', ts: at(40_000) }]);
  });

  it('returns null humanWaitPct when the run window itself is unpaired', () => {
    const runId = nextRunId();
    recordWallClockStart(runId, { segment: RUN_SEGMENT, storeDir, ts: at(0) });
    recordWallClockStart(runId, { segment: 'open-windows', humanWait: true, storeDir, ts: at(0) });
    recordWallClockEnd(runId, { segment: 'open-windows', storeDir, ts: at(30_000) });

    const summary = summarizeWallClock(readSplitEvents(runId, { storeDir }));
    expect(summary.humanWaitMs).toBe(30_000);
    expect(summary.totalMs).toBeNull();
    expect(summary.humanWaitPct).toBeNull();
  });
});

describe('fast-profile-planned — nine fields, copied by name from engine.js', () => {
  it('matches the engine source field list exactly, in order', () => {
    const fromEngine = engineFastProfileFields();
    expect(fromEngine).toHaveLength(9);
    expect([...FAST_PROFILE_PLANNED_FIELDS]).toEqual(fromEngine);
  });

  it('writes exactly the nine keys in engine order and nulls what the caller omitted', () => {
    const runId = nextRunId();
    const persisted = recordFastProfilePlanned(runId, {
      requested: true,
      enabled: true,
      cpuCount: 8,
      plannedParallelism: 3,
      worktrees: { required: true, count: 3 },
      unrelatedKey: 'must not leak',
    }, { storeDir, ts: at(0) });

    expect(Object.keys(persisted.data)).toEqual([...FAST_PROFILE_PLANNED_FIELDS]);
    expect(persisted.data.unrelatedKey).toBeUndefined();
    expect(persisted.data.cpuCount).toBe(8);
    expect(persisted.data.reused).toBeNull();
    expect(persisted.data.requestedParallelism).toBeNull();
    expect(persisted.data.eligibleParallelism).toBeNull();
    expect(persisted.data.serialReasons).toBeNull();
    expect(persisted.data.fallbackReason).toBeNull();
    expect(persisted.type).toBe('fast-profile-planned');
    expect(persisted.level).toBe('info');
    expect(persisted.phase).toBe('PLAN');

    const [line] = readSplitEvents(runId, { storeDir });
    expect(Object.keys(line.data)).toEqual([...FAST_PROFILE_PLANNED_FIELDS]);
  });

  it('mirrors engine type/level selection: reused → fast-profile-reused, disabled → warn', () => {
    const runId = nextRunId();
    recordFastProfilePlanned(runId, { reused: true, enabled: true }, { storeDir, ts: at(0) });
    recordFastProfilePlanned(runId, { reused: false, enabled: false }, { storeDir, ts: at(1) });
    const [reused, fallback] = readSplitEvents(runId, { storeDir });
    expect(reused.type).toBe('fast-profile-reused');
    expect(reused.level).toBe('info');
    expect(fallback.type).toBe('fast-profile-planned');
    expect(fallback.level).toBe('warn');
  });

  it('fastProfileFromPlan fills all nine from a real buildFastFanoutPlan result', () => {
    const plan = buildFastFanoutPlan({ fast: false, tasks: [], cpuCount: 4 });
    const profile = fastProfileFromPlan(plan, { cpuCount: 4 });
    for (const key of FAST_PROFILE_PLANNED_FIELDS) {
      expect(profile[key], key).not.toBeUndefined();
    }
    expect(profile.requested).toBe(true);
    expect(profile.reused).toBe(false);
    expect(profile.cpuCount).toBe(4);
    expect(profile.requestedParallelism).toBe(plan.requestedTaskCount);
    expect(profile.fallbackReason).toBe('fast-not-requested');
    expect(profile.serialReasons).toEqual(['fast-not-requested']);
    // Not measured → null, not a guessed core count.
    expect(fastProfileFromPlan(plan).cpuCount).toBeNull();
  });
});

describe('phase pairs — replay.js#findUnterminatedPhases reads the split stream unchanged', () => {
  it('reports an open phase after start-only and nothing after start+end', () => {
    const runId = nextRunId();
    recordPhaseStart(runId, 'PLAN', { storeDir, ts: at(0) });
    expect(findUnterminatedPhases(readSplitEvents(runId, { storeDir })))
      .toEqual([{ phase: 'PLAN', startedAt: at(0) }]);

    recordPhaseEnd(runId, 'PLAN', { storeDir, ts: at(2_000) });
    expect(findUnterminatedPhases(readSplitEvents(runId, { storeDir }))).toEqual([]);
  });

  it('writes the same line shape autopilot writes (key order, sessionId carries the run id)', () => {
    const runId = nextRunId();
    recordPhaseStart(runId, 'OPEN', { storeDir, ts: at(0) });
    const raw = readFileSync(getSplitEventsPath(runId, { storeDir }), 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(Object.keys(line)).toEqual(LINE_KEY_ORDER);
    expect(line.sessionId).toBe(runId);
    expect(line).toEqual(normalizeRunEvent(runId, { ts: at(0), phase: 'OPEN', type: 'phase-start', level: 'info', message: 'OPEN start' }));
  });
});

describe('replay.js — unmeasured duration is null, not 0', () => {
  it('yields durationMs null for an unterminated phase and a number for a closed one', () => {
    const runId = nextRunId();
    recordPhaseStart(runId, 'PLAN', { storeDir, ts: at(0) });
    recordPhaseEnd(runId, 'PLAN', { storeDir, ts: at(9_000) });
    recordPhaseStart(runId, 'EXECUTE', { storeDir, ts: at(9_000) });

    const summary = summarizeEvents(runId, readSplitEvents(runId, { storeDir }));
    const plan = summary.phases.find((p) => p.phase === 'PLAN');
    const execute = summary.phases.find((p) => p.phase === 'EXECUTE');
    expect(plan.durationMs).toBe(9_000);
    expect(execute.unterminated).toBe(true);
    expect(execute.durationMs).toBeNull();
    expect(summary.phases.some((p) => p.unterminated && p.durationMs === 0)).toBe(false);
  });

  it('yields totalDurationMs null when there is nothing to measure', () => {
    expect(summarizeEvents('none', []).totalDurationMs).toBeNull();
    expect(summarizeEvents('none', null).totalDurationMs).toBeNull();
    const unparseable = [{ ts: 'not-a-date', sessionId: 'x', phase: 'A', type: 'phase-start', level: 'info', message: '' }];
    const summary = summarizeEvents('x', unparseable);
    expect(summary.totalDurationMs).toBeNull();
    expect(summary.phases[0].durationMs).toBeNull();
  });
});

describe('run-events promotion — two consumers, one line shape', () => {
  it('autopilot telemetry and split telemetry both import lib/observability/run-events.js', () => {
    const telemetry = readFileSync(TELEMETRY_PATH, 'utf-8');
    const split = readFileSync(SPLIT_TELEMETRY_PATH, 'utf-8');
    expect(telemetry).toMatch(/from '\.\.\/observability\/run-events\.js'/);
    expect(split).toMatch(/from '\.\/run-events\.js'/);
  });

  it('resolves the split store under runtime/split by default and honours storeDir', () => {
    const real = getSplitStoreDir();
    expect(real.split(path.sep).slice(-2)).toEqual(['runtime', 'split']);
    expect(getSplitStoreDir({ storeDir })).toBe(storeDir);
    expect(getSplitEventsPath('r1', { storeDir })).toBe(path.join(storeDir, `r1${RUN_EVENTS_SUFFIX}`));
  });
});

describe('record-only — no config, no threshold', () => {
  it('split-telemetry.js imports no config module and compares against no threshold in code', () => {
    const src = readFileSync(SPLIT_TELEMETRY_PATH, 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/core\/config/);
    expect(code).not.toMatch(/humanWaitReevalPct/);
    expect(code).not.toMatch(/loadConfig|readConfig|artibot\.config/);
  });
});
