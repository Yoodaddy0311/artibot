/**
 * D9 — the two vocabularies that took over from the frozen decision trail, and
 * the fail-closed allowlists around them.
 *
 * WHAT THIS SUITE CANNOT SEE (stated next to the gate):
 *  1. It never runs a cron runner or the hook. That `scripts/cron/*` actually
 *     call `recordSelfControlDecision` through their `trail` default, and that
 *     the hook binds `recordSkillLevelChanged` into `recordSignal`'s port, is
 *     asserted by source scan here (vocabulary ↔ source) and by the runner
 *     suites' `trail` spies — not by running the CLI entry points.
 *  2. Every write goes to a `storeDir` under `os.tmpdir()`. The real
 *     `<projectRoot>/.artibot/runtime/decisions/` resolution is untouched.
 *  3. The vocabulary ↔ source ratchet reads `action:` and `subsystem:` LITERALS.
 *     A runner that builds an action string at run time (`` `${x}-ed` ``)
 *     would pass the scan and be refused live, which is the fail-closed
 *     direction — refused and counted, never written under an unknown name.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _recordForTest,
  CRON_RUN_ID_PREFIX,
  cronRunId,
  DECISION_EVENT_TYPES,
  getDecisionRecorderStats,
  isAllowedDecisionType,
  readDecisionEvents,
  recordSelfControlDecision,
  recordSkillLevelChanged,
  resetDecisionRecorderStats,
  SELF_CONTROL_ACTIONS,
  SELF_CONTROL_DECIDED,
  SELF_CONTROL_SUBSYSTEMS,
  SKILL_LEVEL_CHANGED,
  SKILL_LEVELS,
} from '../../lib/observability/decision-events.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_PATH = path.join(PLUGIN_ROOT, 'lib', 'observability', 'decision-events.js');
const CRON_FILES = [
  'scripts/cron/auto-cleanup-runner.js',
  'scripts/cron/auto-commit-runner.js',
  'scripts/cron/auto-macro-register-runner.js',
  'scripts/cron/auto-pr-creator.js',
];

let storeDir;
const RUN = 'cron-auto-commit-20260905-020000';

beforeEach(() => {
  storeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-d9-store-'));
  resetDecisionRecorderStats();
});

afterEach(() => {
  try { fsSync.rmSync(storeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  resetDecisionRecorderStats();
});

describe('recordSelfControlDecision()', () => {
  it('writes one self-control-decided line carrying subsystem, action and reason', () => {
    const ev = recordSelfControlDecision(RUN, {
      subsystem: 'auto-commit',
      action: 'refused',
      reason: 'level=high exceeds ceiling=low',
      inputs: { files: ['a.js', 'b.js'] },
      outputs: { level: 'high' },
    }, { storeDir });
    expect(ev).not.toBeNull();
    const [line] = readDecisionEvents(RUN, { storeDir });
    expect(line.type).toBe(SELF_CONTROL_DECIDED);
    expect(line.phase).toBe('SELF_CONTROL');
    expect(line.level).toBe('info');
    expect(line.data).toEqual({
      subsystem: 'auto-commit',
      action: 'refused',
      reason: 'level=high exceeds ceiling=low',
      inputs: { files: ['a.js', 'b.js'] },
      outputs: { level: 'high' },
    });
    expect(line.message).toContain('auto-commit refused');
  });

  it('marks a failed action as warn so a broken PR push is visible at level', () => {
    recordSelfControlDecision(RUN, { subsystem: 'auto-pr-creator', action: 'failed' }, { storeDir });
    expect(readDecisionEvents(RUN, { storeDir })[0].level).toBe('warn');
  });

  it('refuses a subsystem outside the allowlist — counted, not written (fail-closed)', () => {
    const ev = recordSelfControlDecision(RUN, { subsystem: 'auto-deploy', action: 'applied' }, { storeDir });
    expect(ev).toBeNull();
    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, failed: 1 });
    expect(getDecisionRecorderStats().lastError).toBe('subsystem-not-allowed:auto-deploy');
    expect(fsSync.readdirSync(storeDir)).toEqual([]);
  });

  it('refuses an action outside the allowlist', () => {
    const ev = recordSelfControlDecision(RUN, { subsystem: 'auto-cleanup', action: 'yolo' }, { storeDir });
    expect(ev).toBeNull();
    expect(getDecisionRecorderStats().lastError).toBe('action-not-allowed:yolo');
    expect(fsSync.readdirSync(storeDir)).toEqual([]);
  });

  it('counts a run-less call as skipped and writes nothing (no session, no file)', () => {
    expect(recordSelfControlDecision(null, { subsystem: 'auto-commit', action: 'refused' }, { storeDir })).toBeNull();
    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, failed: 0, skipped: 1 });
    expect(fsSync.readdirSync(storeDir)).toEqual([]);
  });

  it('keeps inputs/outputs one level deep, bounded, and redacted', () => {
    recordSelfControlDecision(RUN, {
      subsystem: 'auto-pr-creator',
      action: 'created',
      reason: 'notified ops@example.com about the branch',
      inputs: {
        category: 'drift',
        nested: { deep: 1 },
        fn: () => 1,
        nan: Number.NaN,
        many: Array.from({ length: 80 }, (_, i) => i),
        long: 'x'.repeat(500),
      },
      outputs: { branch: 'artibot/auto/drift-1', prUrl: null, ok: true },
    }, { storeDir });
    const { data } = readDecisionEvents(RUN, { storeDir })[0];
    expect(data.inputs.nested).toBeUndefined();
    expect(data.inputs.fn).toBeUndefined();
    expect(data.inputs.nan).toBeUndefined();
    expect(data.inputs.many).toHaveLength(50);
    expect(data.inputs.long).toHaveLength(200);
    expect(data.inputs.category).toBe('drift');
    expect(data.outputs).toEqual({ branch: 'artibot/auto/drift-1', prUrl: null, ok: true });
    // The shared redactor (lib/core/redaction.js GENERIC_PATTERNS) masks emails.
    expect(data.reason).not.toContain('ops@example.com');
  });

  it('never throws on malformed input', () => {
    expect(() => recordSelfControlDecision(RUN, null, { storeDir })).not.toThrow();
    expect(() => recordSelfControlDecision(RUN, 'nope', { storeDir })).not.toThrow();
    expect(recordSelfControlDecision(RUN, undefined, { storeDir })).toBeNull();
  });
});

describe('recordSkillLevelChanged()', () => {
  it('writes one skill-level-changed line with from/to/signals/evidence', () => {
    const ev = recordSkillLevelChanged('sess-1', {
      from: 'novice', to: 'pro', signals: 12, evidence: ['slash-ratio=0.80', 'jargon-density=0.60'],
    }, { storeDir });
    expect(ev).not.toBeNull();
    const [line] = readDecisionEvents('sess-1', { storeDir });
    expect(line.type).toBe(SKILL_LEVEL_CHANGED);
    expect(line.phase).toBe('PROFILE');
    expect(line.data).toEqual({
      from: 'novice', to: 'pro', signals: 12, evidence: ['slash-ratio=0.80', 'jargon-density=0.60'],
    });
    expect(line.message).toBe('skill level novice -> pro (12 signals)');
  });

  it('refuses a level outside SKILL_LEVELS', () => {
    expect(recordSkillLevelChanged('sess-1', { from: 'novice', to: 'wizard' }, { storeDir })).toBeNull();
    expect(getDecisionRecorderStats().lastError).toBe('skill-level-not-allowed:novice->wizard');
    expect(fsSync.readdirSync(storeDir)).toEqual([]);
  });

  it('drops long or non-string evidence entries', () => {
    recordSkillLevelChanged('sess-1', {
      from: 'pro', to: 'novice', evidence: ['ok', 'x'.repeat(65), 42, null],
    }, { storeDir });
    expect(readDecisionEvents('sess-1', { storeDir })[0].data.evidence).toEqual(['ok']);
  });

  it('counts a session-less call as skipped', () => {
    expect(recordSkillLevelChanged(null, { from: 'novice', to: 'pro' }, { storeDir })).toBeNull();
    expect(getDecisionRecorderStats()).toMatchObject({ skipped: 1, recorded: 0 });
  });
});

describe('the event-type allowlist is closed and live', () => {
  it('lists exactly the seven types this module writes', () => {
    expect(Object.isFrozen(DECISION_EVENT_TYPES)).toBe(true);
    expect([...DECISION_EVENT_TYPES].sort()).toEqual([
      'memory-injection-measured', 'recorder-stats', 'routing-classified',
      'self-control-decided', 'skill-level-changed', 'topology-recommended',
      'workflow-planned',
    ]);
  });

  it('refuses anything else through the predicate `record` consults', () => {
    for (const t of DECISION_EVENT_TYPES) expect(isAllowedDecisionType(t)).toBe(true);
    expect(isAllowedDecisionType('effort-classified')).toBe(false);
    expect(isAllowedDecisionType('')).toBe(false);
    expect(isAllowedDecisionType(undefined)).toBe(false);
    expect(isAllowedDecisionType(null)).toBe(false);
  });

  it('every `type:` literal written in the module source is a member (source ratchet)', () => {
    // A recorder added without registering its type must go red here before it
    // can write. The scan is on the source so it does not depend on calling
    // every recorder.
    const src = fsSync.readFileSync(MODULE_PATH, 'utf-8');
    const literals = [...src.matchAll(/^\s*type:\s*([A-Z_]+),/gm)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThanOrEqual(7);
    const constants = new Map(
      [...src.matchAll(/^export const ([A-Z_]+) = '([a-z-]+)';/gm)].map((m) => [m[1], m[2]]),
    );
    for (const name of literals) {
      expect(constants.has(name), `type literal ${name} is not an exported constant`).toBe(true);
      expect(DECISION_EVENT_TYPES).toContain(constants.get(name));
    }
  });

  it('an unlisted type never reaches disk — refused and counted (behavioural, via the test seam)', () => {
    // Mutation M2 (2026-09-05): with the gate disabled (`if (false && …)`) the
    // source-text checks above stayed green. This is the case that goes red.
    const ev = _recordForTest('run-1', {
      phase: 'ROUTE', type: 'effort-classified', level: 'info', message: 'x', data: {},
    }, { storeDir });
    expect(ev).toBeNull();
    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, failed: 1 });
    expect(getDecisionRecorderStats().lastError).toBe('type-not-allowed:effort-classified');
    expect(fsSync.readdirSync(storeDir)).toEqual([]);
    // Control: the same seam with a listed type does write, so the null above
    // is the gate and not a broken seam.
    expect(_recordForTest('run-1', { type: 'recorder-stats', message: 'ok' }, { storeDir })).not.toBeNull();
    expect(readDecisionEvents('run-1', { storeDir })).toHaveLength(1);
  });
});

describe('the self-control vocabulary matches the cron sources (ratchet, both directions)', () => {
  const sources = CRON_FILES.map((rel) => [rel, fsSync.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8')]);
  /**
   * The quoted literal(s) assigned to `key:` on each line. A direct
   * `key: 'x'` yields one; a ternary `key: cond ? 'x' : 'y'` yields both. Only
   * the text AFTER `key:` is read, so `{ subsystem: 'a', action: 'b' }` on one
   * line does not leak `'b'` into the subsystem set.
   */
  const literalsOn = (src, key) => {
    const out = new Set();
    for (const line of src.split('\n')) {
      const at = line.search(new RegExp(`\\b${key}:`));
      if (at < 0) continue;
      const rest = line.slice(at + key.length + 1);
      const direct = rest.match(/^\s*'([a-z][a-z-]*)'/);
      if (direct) {
        out.add(direct[1]);
        continue;
      }
      const ternary = rest.match(/\?\s*'([a-z][a-z-]*)'\s*:\s*'([a-z][a-z-]*)'/);
      if (ternary) {
        out.add(ternary[1]);
        out.add(ternary[2]);
      }
    }
    return out;
  };

  it('every subsystem a runner writes is allowlisted, and every allowlisted one is written', () => {
    const written = new Set();
    for (const [, src] of sources) for (const s of literalsOn(src, 'subsystem')) written.add(s);
    expect([...written].sort()).toEqual([...SELF_CONTROL_SUBSYSTEMS].sort());
    expect(Object.isFrozen(SELF_CONTROL_SUBSYSTEMS)).toBe(true);
  });

  it('every action a runner writes is allowlisted, and every allowlisted one is written', () => {
    const written = new Set();
    for (const [, src] of sources) for (const a of literalsOn(src, 'action')) written.add(a);
    expect([...written].sort()).toEqual([...SELF_CONTROL_ACTIONS].sort());
    expect(Object.isFrozen(SELF_CONTROL_ACTIONS)).toBe(true);
  });

  it('no runner imports the frozen trail any more', () => {
    for (const [rel, src] of sources) {
      expect(src.includes('decision-trail.js'), `${rel} still imports the trail`).toBe(false);
      expect(src.includes('recordSelfControlDecision'), `${rel} does not use the D9 recorder`).toBe(true);
      expect(src.includes('cronRunId('), `${rel} CLI entry does not mint a run id`).toBe(true);
    }
  });

  it('SKILL_LEVELS is the pair user-profile.js can return', () => {
    expect([...SKILL_LEVELS]).toEqual(['novice', 'pro']);
  });
});

describe('cronRunId()', () => {
  it('uses the GitHub run id when the scheduler is Actions', () => {
    expect(cronRunId('auto-commit', { env: { GITHUB_RUN_ID: '123456' } })).toBe('cron-auto-commit-gha123456');
  });

  it('falls back to a compact UTC stamp elsewhere', () => {
    const id = cronRunId('auto-pr-creator', { env: {}, now: new Date('2026-09-05T02:03:04.567Z') });
    expect(id).toBe('cron-auto-pr-creator-20260905-020304');
  });

  it('always carries the prefix Check 7 keys on and a file-safe feature name', () => {
    const id = cronRunId('weird name/../x', { env: {}, now: new Date('2026-09-05T00:00:00Z') });
    expect(id.startsWith(CRON_RUN_ID_PREFIX)).toBe(true);
    expect(id).toBe('cron-weird-name----x-20260905-000000');
    expect(id).not.toContain('/');
  });

  it('ignores a malformed GITHUB_RUN_ID rather than embedding it', () => {
    const id = cronRunId('auto-commit', { env: { GITHUB_RUN_ID: '../evil' }, now: new Date('2026-09-05T00:00:00Z') });
    expect(id).toBe('cron-auto-commit-20260905-000000');
  });
});
