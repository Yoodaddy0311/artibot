/**
 * P3-2 — lib/runtime/task-budget.js unit tests.
 *
 * Covers:
 * - getTaskBudgetForEffort() per-level mapping + config override
 * - buildTaskBudgetDirective() output format + beta header toggle
 * - persistTaskBudget() file write + idempotency
 * - F05 effort records: buildEffortRecord / persistEffortRecord /
 *   readEffortRecord
 *
 * O2: both records are SESSION-scoped and live under the artibot STATE dir
 * (`<state dir>/runtime/sessions/<session_id>/`, `lib/core/runtime-state.js`), not
 * under the `pluginRoot` argument. The suites below that write files point the state
 * dir at their tmp dir (`pointStateDirAt`) — the install.sh layout, where the state
 * dir and the plugin root are one directory — so `<tmpRoot>/runtime/...` assertions
 * keep their shape and each test starts empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildEffortRecord,
  buildTaskBudgetDirective,
  EFFORT_RECORD_TTL_MS,
  getTaskBudgetForEffort,
  persistEffortRecord,
  persistTaskBudget,
  readEffortRecord,
  readEffortSnapshot,
  runSnapshotCli,
} from '../../lib/runtime/task-budget.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const TASK_BUDGET_SCRIPT = fileURLToPath(new URL('../../lib/runtime/task-budget.js', import.meta.url));

describe('getTaskBudgetForEffort', () => {
  const config = {
    runtime: {
      effort: {
        budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 },
      },
    },
  };

  it('maps xhigh to 128000', () => {
    expect(getTaskBudgetForEffort('xhigh', config)).toBe(128000);
  });

  it('maps high to 64000', () => {
    expect(getTaskBudgetForEffort('high', config)).toBe(64000);
  });

  it('maps medium to 32000', () => {
    expect(getTaskBudgetForEffort('medium', config)).toBe(32000);
  });

  it('maps low to 16000', () => {
    expect(getTaskBudgetForEffort('low', config)).toBe(16000);
  });

  it('returns null for unknown level', () => {
    expect(getTaskBudgetForEffort('unknown', config)).toBeNull();
  });

  it('returns null for null/undefined level', () => {
    expect(getTaskBudgetForEffort(null, config)).toBeNull();
    expect(getTaskBudgetForEffort(undefined, config)).toBeNull();
  });

  it('falls back to defaults when config is empty', () => {
    expect(getTaskBudgetForEffort('xhigh', {})).toBe(128000);
    expect(getTaskBudgetForEffort('low', undefined)).toBe(16000);
  });

  it('honours caller-supplied budget override', () => {
    const custom = { runtime: { effort: { budgetMap: { xhigh: 200000 } } } };
    expect(getTaskBudgetForEffort('xhigh', custom)).toBe(200000);
  });
});

describe('getTaskBudgetForEffort P3 overlay multiplier', () => {
  const config = {
    runtime: {
      effort: {
        budgetMap: { max: 200000, xhigh: 128000, high: 64000, medium: 32000, low: 16000 },
      },
    },
  };

  it('returns the base value when overlay is null/absent', () => {
    expect(getTaskBudgetForEffort('high', config)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, {})).toBe(64000);
  });

  it('multiplies the base budget by a valid multiplier', () => {
    const overlay = { budgetMultipliers: { high: 1.2 } };
    expect(getTaskBudgetForEffort('high', config, overlay)).toBe(Math.round(64000 * 1.2));
  });

  it('re-clamps a boosted budget to the budgetMap ceiling (max)', () => {
    // xhigh=128000 * 1.5 = 192000 (< max 200000) — stays under ceiling.
    expect(getTaskBudgetForEffort('xhigh', config, { budgetMultipliers: { xhigh: 1.5 } }))
      .toBe(192000);
    // max=200000 * 1.5 = 300000 -> clamped down to ceiling 200000.
    expect(getTaskBudgetForEffort('max', config, { budgetMultipliers: { max: 1.5 } }))
      .toBe(200000);
  });

  it('ignores zero / NaN / negative / out-of-range multipliers', () => {
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 0 } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: NaN } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: -1 } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 2 } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 0.4 } })).toBe(64000);
  });

  it('reduces budget for a multiplier below 1', () => {
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 0.5 } }))
      .toBe(32000);
  });
});

describe('getTaskBudgetForEffort model coefficient (opts)', () => {
  const config = {
    runtime: {
      effort: {
        budgetMap: { max: 200000, xhigh: 128000, high: 64000, medium: 32000, low: 16000 },
      },
    },
  };

  it('is byte-identical when opts is absent or coeff is 1.0', () => {
    expect(getTaskBudgetForEffort('high', config)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, null)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, {})).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: 1.0 })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { modelTier: 'opus' })).toBe(64000);
  });

  it('multiplies the budget by an explicit coefficient (1.3×)', () => {
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: 1.3 }))
      .toBe(Math.round(64000 * 1.3)); // 83200
  });

  it('resolves modelTier "fable" to the catalog coefficient (1.3)', () => {
    // medium=32000 * 1.3 = 41600 (well above the 20k floor).
    expect(getTaskBudgetForEffort('medium', config, null, { modelTier: 'fable' }))
      .toBe(Math.round(32000 * 1.3));
  });

  it('clamps fable budgets up to the 20k beta floor for low effort', () => {
    // low=16000 * 1.3 = 20800 → already >= 20000.
    expect(getTaskBudgetForEffort('low', config, null, { modelTier: 'fable' }))
      .toBeGreaterThanOrEqual(20000);
    // With a tiny custom budgetMap, the floor is what saves us.
    const tinyConfig = {
      runtime: { effort: { budgetMap: { max: 200000, low: 1000 } } },
    };
    expect(getTaskBudgetForEffort('low', tinyConfig, null, { modelTier: 'fable' }))
      .toBe(20000);
  });

  it('lets explicit coefficient win over modelTier', () => {
    expect(getTaskBudgetForEffort('high', config, null, { modelTier: 'fable', tokenizerCoeff: 2.0 }))
      .toBe(Math.min(Math.round(64000 * 2.0), 200000)); // 128000
  });

  it('re-clamps a coefficient-boosted budget to the map ceiling', () => {
    // xhigh=128000 * 1.3 = 166400 (< 200000) stays under ceiling.
    expect(getTaskBudgetForEffort('xhigh', config, null, { tokenizerCoeff: 1.3 }))
      .toBe(166400);
    // max=200000 * 1.3 = 260000 → clamped down to ceiling 200000.
    expect(getTaskBudgetForEffort('max', config, null, { tokenizerCoeff: 1.3 }))
      .toBe(200000);
  });

  it('stacks the overlay multiplier and the model coefficient', () => {
    // high=64000 * 1.2 (overlay) = 76800, then * 1.3 (coeff) = 99840.
    const out = getTaskBudgetForEffort(
      'high',
      config,
      { budgetMultipliers: { high: 1.2 } },
      { tokenizerCoeff: 1.3 },
    );
    expect(out).toBe(Math.round(Math.round(64000 * 1.2) * 1.3));
  });

  it('degrades NaN / negative / string coefficients to 1.0', () => {
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: NaN })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: -1 })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: 0 })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: '1.3' })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { modelTier: 'nope' })).toBe(64000);
  });
});

describe('buildTaskBudgetDirective', () => {
  it('emits max_tokens directive without beta header by default', () => {
    const out = buildTaskBudgetDirective('xhigh', 128000, {});
    expect(out).toBe('[artibot:task-budget max_tokens=128000]');
  });

  it('appends anthropic-beta header when longContext.enabled=true', () => {
    const config = {
      runtime: {
        longContext: { enabled: true, betaHeader: 'context-1m-2025-08-01' },
      },
    };
    const out = buildTaskBudgetDirective('xhigh', 128000, config);
    expect(out).toBe(
      '[artibot:task-budget max_tokens=128000 anthropic-beta=context-1m-2025-08-01]',
    );
  });

  it('omits beta header when longContext.enabled=false', () => {
    const config = {
      runtime: {
        longContext: { enabled: false, betaHeader: 'context-1m-2025-08-01' },
      },
    };
    const out = buildTaskBudgetDirective('xhigh', 128000, config);
    expect(out).toBe('[artibot:task-budget max_tokens=128000]');
  });

  it('returns empty string for invalid budget', () => {
    expect(buildTaskBudgetDirective('xhigh', 0, {})).toBe('');
    expect(buildTaskBudgetDirective('xhigh', null, {})).toBe('');
    expect(buildTaskBudgetDirective('', 128000, {})).toBe('');
  });
});

describe('persistTaskBudget', () => {
  let tmpRoot;
  let restoreState;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-tb-'));
    restoreState = pointStateDirAt(tmpRoot);
  });

  afterEach(() => {
    restoreState();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('writes runtime/current-task-budget.json with expected shape (no session: the flat file)', () => {
    const filePath = persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 128000 },
      tmpRoot,
    );

    expect(filePath).toBe(path.join(tmpRoot, 'runtime', 'current-task-budget.json'));
    expect(existsSync(filePath)).toBe(true);

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.command).toBe('implement');
    expect(data.effort).toBe('xhigh');
    expect(data.budget).toBe(128000);
    expect(typeof data.updatedAt).toBe('string');
  });

  it('with a session id it writes that session\'s own file and leaves the flat one alone (O2)', () => {
    const a = persistTaskBudget({ command: 'implement', effort: 'max', budget: 200000 }, tmpRoot, { sessionId: 'sA' });
    const b = persistTaskBudget({ command: 'daily', effort: 'low', budget: 16000 }, tmpRoot, { sessionId: 'sB' });

    expect(a).toBe(path.join(tmpRoot, 'runtime', 'sessions', 'sA', 'current-task-budget.json'));
    expect(b).toBe(path.join(tmpRoot, 'runtime', 'sessions', 'sB', 'current-task-budget.json'));
    // B did not overwrite A — the pre-O2 single slot.
    expect(JSON.parse(readFileSync(a, 'utf8')).budget).toBe(200000);
    expect(JSON.parse(readFileSync(b, 'utf8')).budget).toBe(16000);
    expect(existsSync(path.join(tmpRoot, 'runtime', 'current-task-budget.json'))).toBe(false);
  });

  it('does not write under pluginRoot once the state dir is somewhere else (O2)', () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'artibot-tb-state-'));
    const restoreElsewhere = pointStateDirAt(elsewhere);
    try {
      const filePath = persistTaskBudget(
        { command: 'implement', effort: 'xhigh', budget: 128000 }, tmpRoot, { sessionId: 'sA' },
      );
      expect(filePath.startsWith(elsewhere)).toBe(true);
      expect(existsSync(path.join(tmpRoot, 'runtime'))).toBe(false);
    } finally {
      restoreElsewhere();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('returns null when pluginRoot is missing', () => {
    const result = persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 128000 },
      '',
    );
    expect(result).toBeNull();
  });

  it('returns null when budget is invalid', () => {
    const result = persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 0 },
      tmpRoot,
    );
    expect(result).toBeNull();
  });

  it('overwrites previous file on subsequent calls', () => {
    persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 128000 },
      tmpRoot,
    );
    const second = persistTaskBudget(
      { command: 'code-review', effort: 'high', budget: 64000 },
      tmpRoot,
    );

    const data = JSON.parse(readFileSync(second, 'utf-8'));
    expect(data.command).toBe('code-review');
    expect(data.budget).toBe(64000);
  });
});

describe('F05 effort records', () => {
  const META = { command: 'implement', effort: 'max', baseline: 'xhigh', shift: 1, reason: 'r' };
  const T0 = Date.parse('2026-09-14T00:00:00.000Z');
  let tmpRoot;
  let restoreState;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-effort-'));
    restoreState = pointStateDirAt(tmpRoot);
  });

  afterEach(() => {
    restoreState();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('exports the record TTL', () => {
    expect(EFFORT_RECORD_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('buildEffortRecord derives updatedAt/expiresAt from the injected clock', () => {
    const record = buildEffortRecord(META, { sessionId: 's1', promptId: 'p1', now: T0 });
    expect(record.updatedAt).toBe(new Date(T0).toISOString());
    expect(record.expiresAt).toBe(new Date(T0 + EFFORT_RECORD_TTL_MS).toISOString());
    expect(record.command).toBe('implement');
  });

  it('buildEffortRecord normalizes blank ids to null', () => {
    const record = buildEffortRecord(META, { sessionId: '   ', promptId: undefined, now: T0 });
    expect(record.sessionId).toBeNull();
    expect(record.promptId).toBeNull();
  });

  it('buildEffortRecord honours an explicit ttlMs', () => {
    const record = buildEffortRecord(META, { sessionId: 's1', now: T0, ttlMs: 5000 });
    expect(record.expiresAt).toBe(new Date(T0 + 5000).toISOString());
  });

  it('persistEffortRecord writes the SESSION file — and only it — and readEffortRecord round-trips', () => {
    const { legacyPath, sessionPath } = persistEffortRecord(META, tmpRoot, {
      sessionId: 's1', promptId: 'p1', now: T0,
    });
    expect(legacyPath).toBeNull();
    expect(existsSync(sessionPath)).toBe(true);
    expect(sessionPath).toBe(path.join(tmpRoot, 'runtime', 'sessions', 's1', 'current-effort.json'));
    // O2: no shared slot is written alongside it.
    expect(existsSync(path.join(tmpRoot, 'runtime', 'current-effort.json'))).toBe(false);
    expect(existsSync(path.join(tmpRoot, 'runtime', 'effort'))).toBe(false);

    const read = readEffortRecord(tmpRoot, { sessionId: 's1', promptId: 'p1', now: T0 + 1 });
    expect(read.effort).toBe('max');
    expect(read.shift).toBe(1);
  });

  it('with no session id the record goes to the flat file in the state dir and round-trips', () => {
    const { legacyPath, sessionPath } = persistEffortRecord(META, tmpRoot, { sessionId: null, now: T0 });
    expect(sessionPath).toBeNull();
    expect(legacyPath).toBe(path.join(tmpRoot, 'runtime', 'current-effort.json'));
    expect(readEffortRecord(tmpRoot, { sessionId: null, now: T0 + 1 })?.effort).toBe('max');
  });

  it('persistEffortRecord writes nothing for meta === null (the stale file is NOT deleted)', () => {
    persistEffortRecord(META, tmpRoot, { sessionId: 's1', promptId: 'p1', now: T0 });
    const sessionFile = path.join(tmpRoot, 'runtime', 'sessions', 's1', 'current-effort.json');
    const before = readFileSync(sessionFile, 'utf8');

    expect(persistEffortRecord(null, tmpRoot, { sessionId: 's1', now: T0 }))
      .toEqual({ legacyPath: null, sessionPath: null });
    expect(readFileSync(sessionFile, 'utf8')).toBe(before);
  });

  it('persistEffortRecord rejects a missing pluginRoot without throwing', () => {
    expect(persistEffortRecord(META, '', { sessionId: 's1' }))
      .toEqual({ legacyPath: null, sessionPath: null });
    expect(persistEffortRecord(META, null, { sessionId: 's1' }))
      .toEqual({ legacyPath: null, sessionPath: null });
  });

  it('persistEffortRecord never throws when runtime/ cannot be created', () => {
    writeFileSync(path.join(tmpRoot, 'runtime'), 'not a directory');
    expect(() => persistEffortRecord(META, tmpRoot, { sessionId: 's1', now: T0 })).not.toThrow();
    expect(persistEffortRecord(META, tmpRoot, { sessionId: 's1', now: T0 }))
      .toEqual({ legacyPath: null, sessionPath: null });
  });

  it('readEffortRecord rejects a missing pluginRoot and unparseable files', () => {
    expect(readEffortRecord('', { sessionId: 's1' })).toBeNull();
    // a session file that is not JSON, and a flat file that is not JSON: nothing is accepted.
    const sessionFile = path.join(tmpRoot, 'runtime', 'sessions', 's1', 'current-effort.json');
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, '{ not json');
    writeFileSync(path.join(tmpRoot, 'runtime', 'current-effort.json'), '{ not json');
    expect(readEffortRecord(tmpRoot, { sessionId: 's1', now: T0 })).toBeNull();
  });

  it('a session id that sanitizes to nothing is treated as "no session": flat file, never sessions/', () => {
    const { legacyPath, sessionPath } = persistEffortRecord(META, tmpRoot, { sessionId: '...', now: T0 });
    expect(sessionPath).toBeNull();
    expect(legacyPath).toBe(path.join(tmpRoot, 'runtime', 'current-effort.json'));
    expect(existsSync(path.join(tmpRoot, 'runtime', 'sessions'))).toBe(false);
  });

  it('reads a record a pre-O2 hook left in <pluginRoot>/runtime/ — for a reader with no session id only', () => {
    // Not the state dir: a DIFFERENT directory that is only the plugin root.
    const legacyRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-effort-legacy-'));
    try {
      mkdirSync(path.join(legacyRoot, 'runtime'), { recursive: true });
      writeFileSync(
        path.join(legacyRoot, 'runtime', 'current-effort.json'),
        JSON.stringify({ command: 'daily', effort: 'medium' }),
      );
      // no session id: the legacy fallback, through the flat gate
      expect(readEffortRecord(legacyRoot, { now: T0 })?.effort).toBe('medium');
      // a session id: its own file or nothing — never a flat record that belongs to nobody
      expect(readEffortRecord(legacyRoot, { sessionId: 's1', now: T0 })).toBeNull();
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});

// R2b — effort and budget from ONE accepted record. The shared
// `current-task-budget.json` is written below with a DIFFERENT session's budget
// in every case, so a reader that still consulted it would fail here.
describe('readEffortSnapshot', () => {
  const T0 = Date.parse('2026-09-28T00:00:00.000Z');
  const A = { command: 'implement', effort: 'max', baseline: 'xhigh', shift: 1, reason: 'score>=0.7 (+1)' };
  const B = { command: 'daily', effort: 'low', baseline: 'medium', shift: -1, reason: 'score<=0.25 (-1)' };
  let tmpRoot;
  let restoreState;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-snapshot-'));
    restoreState = pointStateDirAt(tmpRoot);
  });

  afterEach(() => {
    restoreState();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function writeAthenB(now = T0) {
    persistEffortRecord(A, tmpRoot, { sessionId: 'sA', promptId: 'pA', now });
    persistTaskBudget({ command: A.command, effort: A.effort, budget: 200000 }, tmpRoot);
    persistEffortRecord(B, tmpRoot, { sessionId: 'sB', promptId: 'pB', now });
    persistTaskBudget({ command: B.command, effort: B.effort, budget: 16000 }, tmpRoot);
  }

  it('returns null when no record is accepted', () => {
    expect(readEffortSnapshot(tmpRoot, { sessionId: 'sA', now: T0 })).toBeNull();
    expect(readEffortSnapshot('', { sessionId: 'sA', now: T0 })).toBeNull();
  });

  it('recomputes the budget from the accepted effort, ignoring the shared budget file', () => {
    writeAthenB();

    expect(readEffortSnapshot(tmpRoot, { sessionId: 'sA', promptId: 'pA', now: T0 + 1 })).toEqual({
      effort: 'max', command: 'implement', shift: 1, reason: 'score>=0.7 (+1)', taskBudget: 200000,
    });
    expect(readEffortSnapshot(tmpRoot, { sessionId: 'sB', promptId: 'pB', now: T0 + 1 }).taskBudget)
      .toBe(16000);
  });

  it('uses the budget map of the config it is given', () => {
    writeAthenB();
    const config = { runtime: { effort: { budgetMap: { max: 150000, low: 12000 } } } };

    const snap = readEffortSnapshot(tmpRoot, { sessionId: 'sA', promptId: 'pA', now: T0 + 1 }, config);

    expect(snap.taskBudget).toBe(getTaskBudgetForEffort('max', config));
    expect(snap.taskBudget).toBe(150000);
  });

  it('inherits the identity gate: another prompt of the same session is refused', () => {
    writeAthenB();
    expect(readEffortSnapshot(tmpRoot, { sessionId: 'sA', promptId: 'pOther', now: T0 + 1 })).toBeNull();
  });

  it('inherits the expiry gate', () => {
    writeAthenB();
    expect(readEffortSnapshot(tmpRoot, {
      sessionId: 'sA', promptId: 'pA', now: T0 + EFFORT_RECORD_TTL_MS,
    })).toBeNull();
  });

  it('yields a null budget for an effort the map does not know', () => {
    persistEffortRecord({ command: 'x', effort: 'turbo' }, tmpRoot, { sessionId: 'sA', now: T0 });
    expect(readEffortSnapshot(tmpRoot, { sessionId: 'sA', now: T0 + 1 })).toEqual({
      effort: 'turbo', command: 'x', shift: null, reason: null, taskBudget: null,
    });
  });
});

describe('task-budget CLI (snapshot)', () => {
  let tmpRoot;
  let homeDir;
  let restoreState;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-snapshot-cli-'));
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-snapshot-home-'));
    restoreState = pointStateDirAt(tmpRoot);
  });

  afterEach(() => {
    restoreState();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /**
   * Spawn the real file as a CLI. Throws on a non-zero exit, which is the assertion.
   *
   * The child has its OWN home, so the in-process state dir (`tmpRoot`) has to be handed
   * over explicitly — paired with the CHILD's home, the only pairing `resolveArtibotDir`
   * honours. Without it the child would look in `<homeDir>/.claude/artibot`, which is
   * exactly what the real command does: it finds the records under `~/.claude/artibot`.
   */
  function runCli(args) {
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ARTIBOT_STATE_DIR: tmpRoot,
      ARTIBOT_STATE_DIR_HOME: homeDir,
    };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    return execFileSync(process.execPath, [TASK_BUDGET_SCRIPT, ...args], { env, encoding: 'utf8' });
  }

  it('finds the records under <home>/.claude/artibot with no override at all (the real command)', () => {
    const real = path.join(homeDir, '.claude', 'artibot');
    mkdirSync(path.join(real, 'runtime', 'sessions', 'sA'), { recursive: true });
    const now = Date.now();
    writeFileSync(
      path.join(real, 'runtime', 'sessions', 'sA', 'current-effort.json'),
      JSON.stringify(buildEffortRecord({ command: 'implement', effort: 'max' }, { sessionId: 'sA', now })),
    );
    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    delete env.ARTIBOT_STATE_DIR;
    delete env.ARTIBOT_STATE_DIR_HOME;
    delete env.CLAUDE_CODE_SESSION_ID;

    const out = execFileSync(process.execPath, [TASK_BUDGET_SCRIPT, 'snapshot', '--session', 'sA', '--plugin-root', tmpRoot], {
      env, encoding: 'utf8',
    });

    expect(JSON.parse(out)).toMatchObject({ effort: 'max', command: 'implement' });
  });

  it('prints this session\'s snapshot as one JSON line and exits 0', () => {
    // Real clock: the CLI reads records against Date.now(), so the fixture must
    // be fresh on it too (TTL 10 min).
    persistEffortRecord(
      { command: 'implement', effort: 'max', shift: 1, reason: 'r' }, tmpRoot, { sessionId: 'sA', promptId: 'pA' },
    );
    persistTaskBudget({ command: 'implement', effort: 'max', budget: 200000 }, tmpRoot);
    persistEffortRecord({ command: 'daily', effort: 'low' }, tmpRoot, { sessionId: 'sB', promptId: 'pB' });
    persistTaskBudget({ command: 'daily', effort: 'low', budget: 16000 }, tmpRoot);

    const out = runCli(['snapshot', '--session', 'sA', '--prompt', 'pA', '--plugin-root', tmpRoot]);

    expect(out.endsWith('\n')).toBe(true);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({
      effort: 'max', command: 'implement', shift: 1, reason: 'r', taskBudget: 200000,
    });
  });

  it('prints null for a session with no accepted record, still exiting 0', () => {
    persistEffortRecord({ command: 'daily', effort: 'low' }, tmpRoot, { sessionId: 'sB', promptId: 'pB' });

    expect(runCli(['snapshot', '--session', 'sA', '--plugin-root', tmpRoot])).toBe('null\n');
  });

  it('reads the budget map from <plugin-root>/artibot.config.json', () => {
    const config = { runtime: { effort: { budgetMap: { max: 150000 } } } };
    writeFileSync(path.join(tmpRoot, 'artibot.config.json'), JSON.stringify(config));
    persistEffortRecord({ command: 'implement', effort: 'max' }, tmpRoot, { sessionId: 'sA' });

    expect(JSON.parse(runCli(['snapshot', '--session', 'sA', '--plugin-root', tmpRoot])).taskBudget)
      .toBe(150000);
  });

  // Fail-closed: a reader with no session id skips the per-session file and is
  // honoured by ANY legacy record (readEffortRecord's legacy contract), so an
  // unset `$CLAUDE_CODE_SESSION_ID` would hand this caller another session's
  // effort. The CLI is a new surface with no legacy contract to keep.
  it.each([
    ['missing', []],
    ['valueless', ['--session']],
    ['empty', ['--session', '']],
    ['blank', ['--session', '   ']],
  ])('answers null when --session is %s, even over a legacy record', (_label, sessionArgs) => {
    persistEffortRecord({ command: 'daily', effort: 'low' }, tmpRoot, { sessionId: 'sB', promptId: 'pB' });
    expect(runSnapshotCli(['snapshot', '--plugin-root', tmpRoot, ...sessionArgs])).toBe('null');

    persistEffortRecord({ command: 'daily', effort: 'low' }, tmpRoot, {});
    expect(runSnapshotCli(['snapshot', '--plugin-root', tmpRoot, ...sessionArgs])).toBe('null');
  });

  it('answers null from the real process when the session is empty', () => {
    persistEffortRecord({ command: 'daily', effort: 'low' }, tmpRoot, {});
    expect(runCli(['snapshot', '--session', '', '--plugin-root', tmpRoot])).toBe('null\n');
  });

  it('answers null for an unknown subcommand', () => {
    expect(runSnapshotCli(['bogus'])).toBe('null');
    expect(runSnapshotCli([])).toBe('null');
  });
});
