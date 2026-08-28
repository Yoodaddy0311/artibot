/**
 * Decision events — the explainability record for live routing decisions.
 *
 * Every case pins a store dir under `os.tmpdir()`. Nothing here may touch the
 * real `runtime/decisions/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDecisionEventsPath,
  getDecisionRecorderStats,
  readDecisionEvents,
  recordRoutingDecision,
  recordWorkflowPlanDecision,
  resetDecisionRecorderStats,
  resolveDecisionRunId,
} from '../../lib/observability/decision-events.js';

let storeDir;

beforeEach(() => {
  storeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-decisions-'));
  resetDecisionRecorderStats();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fsSync.rmSync(storeDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A realistic `classifyComplexity` result (lib/cognitive/router.js:330-341). */
const CLASSIFICATION = {
  score: 0.72,
  system: 2,
  confidence: 0.81,
  factors: { length: 0.3, keywords: 0.5 },
  threshold: 0.6,
  nativeEffort: 'high',
};

/** A realistic `buildWorkflowPlan` result (lib/cognitive/workflow-plan.js:319-325). */
const PLAN = {
  runner: 'team',
  effort: 'high',
  perAgentBudget: 4000,
  teammates: [
    { agent: 'backend-developer', command: '/implement', intent: 'api', effort: 'high', budget: 4000 },
    { agent: 'tdd-guide', command: '/tdd', intent: 'test', effort: 'high', budget: 4000 },
  ],
  trigger: { fired: true, runner: 'team', reasons: ['subObjectives>=2'], bypassed: false },
  recommendation: null,
  autoFire: true,
};

describe('decision-events — routing (D5)', () => {
  it('appends one line carrying the classification result', () => {
    const ev = recordRoutingDecision('run-1', CLASSIFICATION, { storeDir });

    expect(ev).not.toBeNull();
    expect(ev.type).toBe('routing-classified');
    expect(ev.data).toMatchObject({
      system: 2, score: 0.72, threshold: 0.6, confidence: 0.81, nativeEffort: 'high',
    });

    const onDisk = readDecisionEvents('run-1', { storeDir });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].sessionId).toBe('run-1');
  });

  it('states why the system was chosen, in words a reader can act on', () => {
    const ev = recordRoutingDecision('run-1', CLASSIFICATION, { storeDir });
    // The whole point of the record is answering "why system 2?".
    expect(ev.message).toContain('system 2');
    expect(ev.message).toContain('0.72');
    expect(ev.message).toContain('0.6');
  });

  it('never stores prompt text (privacy default)', () => {
    const secret = 'my password is hunter2 and my email is a@b.co';
    recordRoutingDecision('run-1', { ...CLASSIFICATION, input: secret, prompt: secret }, { storeDir });

    const raw = fsSync.readFileSync(getDecisionEventsPath('run-1', { storeDir }), 'utf-8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('a@b.co');
  });

  it('drops non-numeric factors — the map is open, so it is typed not enumerated', () => {
    // `factors` grows as the classifier gains signals, so a name allowlist would
    // silently lose real scores. The guard is the value type instead: a string
    // factor (a matched keyword, a prompt fragment) must not reach disk.
    const ev = recordRoutingDecision('run-1', {
      ...CLASSIFICATION,
      factors: {
        length: 0.3,
        newSignal: 0.9,                 // an added numeric factor must survive
        matchedKeyword: 'hunter2 leak',  // a string factor must not
        nested: { prompt: 'a@b.co' },    // nor a nested object
      },
    }, { storeDir });

    expect(ev.data.factors).toEqual({ length: 0.3, newSignal: 0.9 });
    const raw = fsSync.readFileSync(getDecisionEventsPath('run-1', { storeDir }), 'utf-8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('a@b.co');
  });
});

describe('decision-events — workflow plan (D7)', () => {
  it('records whether a team fired and why', () => {
    const ev = recordWorkflowPlanDecision('run-1', PLAN, { storeDir });

    expect(ev.type).toBe('workflow-planned');
    expect(ev.data).toMatchObject({
      runner: 'team', teammateCount: 2, autoFire: true, effort: 'high',
    });
    expect(ev.data.trigger.reasons).toEqual(['subObjectives>=2']);
    expect(ev.message).toContain('team');
  });

  it('records the inline case too — "no team" is a decision worth explaining', () => {
    const inline = {
      runner: 'inline', effort: 'medium', perAgentBudget: 0, teammates: [],
      trigger: { fired: false, runner: 'inline', reasons: ['subObjectives<2'], bypassed: false },
      recommendation: null, autoFire: false,
    };
    const ev = recordWorkflowPlanDecision('run-1', inline, { storeDir });
    expect(ev.data).toMatchObject({ runner: 'inline', teammateCount: 0, autoFire: false });
    expect(ev.data.trigger.fired).toBe(false);
  });

  it('keeps only short string trigger reasons', () => {
    // Reasons are generated tokens. A long or non-string entry is off-contract
    // and is the shape prompt-derived text would arrive in.
    const long = `matched: ${'x'.repeat(80)} hunter2`;
    const ev = recordWorkflowPlanDecision('run-1', {
      ...PLAN,
      trigger: {
        fired: true,
        reasons: ['subObjectives>=2', long, { prompt: 'a@b.co' }, null, ''],
        bypassed: false,
      },
    }, { storeDir });

    expect(ev.data.trigger.reasons).toEqual(['subObjectives>=2']);
    const raw = fsSync.readFileSync(getDecisionEventsPath('run-1', { storeDir }), 'utf-8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('a@b.co');
  });

  it('stores teammate agent names but no free-form text from the prompt', () => {
    const ev = recordWorkflowPlanDecision('run-1', PLAN, { storeDir });
    expect(ev.data.teammates).toEqual(['backend-developer', 'tdd-guide']);
  });
});

describe('decision-events — append-only survival', () => {
  it('keeps every record when many are written back to back', () => {
    for (let i = 0; i < 25; i++) {
      recordRoutingDecision('run-1', { ...CLASSIFICATION, score: i / 100 }, { storeDir });
    }
    const onDisk = readDecisionEvents('run-1', { storeDir });
    expect(onDisk).toHaveLength(25);
    expect(onDisk.map((e) => e.data.score)).toEqual(
      Array.from({ length: 25 }, (_, i) => i / 100),
    );
  });

  it('separates runs into their own files', () => {
    recordRoutingDecision('run-a', CLASSIFICATION, { storeDir });
    recordRoutingDecision('run-b', CLASSIFICATION, { storeDir });
    expect(readDecisionEvents('run-a', { storeDir })).toHaveLength(1);
    expect(readDecisionEvents('run-b', { storeDir })).toHaveLength(1);
  });
});

describe('decision-events — observe-only contract and failure signal (S1)', () => {
  /**
   * Make writes genuinely fail by pointing the store at an existing FILE:
   * `ensureDirSync` cannot create a directory there, so the append hits ENOTDIR.
   *
   * Spying on `fsSync.appendFileSync` does NOT work here — `run-events.js`
   * imports the binding by name (`import { appendFileSync } from 'node:fs'`),
   * so it never reads the namespace object a spy replaces. An earlier draft of
   * this file did exactly that and the "failure" cases silently succeeded.
   *
   * @returns {string} a path that exists as a file, not a directory
   */
  function unwritableStore() {
    const file = path.join(storeDir, 'not-a-directory');
    fsSync.writeFileSync(file, 'x', 'utf-8');
    return file;
  }

  it('returns null instead of throwing when the write fails', () => {
    const ev = recordRoutingDecision('run-1', CLASSIFICATION, { storeDir: path.join(storeDir, 'x') });
    expect(ev).not.toBeNull(); // sanity: a missing dir is created, not a failure

    const bad = unwritableStore();
    expect(() => recordRoutingDecision('run-1', CLASSIFICATION, { storeDir: bad })).not.toThrow();
    expect(recordWorkflowPlanDecision('run-1', PLAN, { storeDir: bad })).toBeNull();
  });

  it('counts failures so a silent outage is still visible', () => {
    recordRoutingDecision('run-1', CLASSIFICATION, { storeDir });
    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 1, failed: 0 });

    const bad = unwritableStore();
    recordRoutingDecision('run-1', CLASSIFICATION, { storeDir: bad });
    recordWorkflowPlanDecision('run-1', PLAN, { storeDir: bad });

    const stats = getDecisionRecorderStats();
    expect(stats).toMatchObject({ recorded: 1, failed: 2 });
    expect(stats.lastError).toBeTruthy();
  });

  it('never throws on malformed input', () => {
    expect(() => recordRoutingDecision('run-1', null, { storeDir })).not.toThrow();
    expect(() => recordRoutingDecision('', CLASSIFICATION, { storeDir })).not.toThrow();
    expect(() => recordWorkflowPlanDecision('run-1', undefined, { storeDir })).not.toThrow();
    expect(recordRoutingDecision('', CLASSIFICATION, { storeDir })).toBeNull();
  });
});

describe('decision-events — run id resolution', () => {
  it('prefers the hook payload session id', () => {
    expect(resolveDecisionRunId({ hookData: { session_id: 'sess-abc' }, sessionId: 'other' }))
      .toBe('sess-abc');
  });

  it('falls back to the context session id', () => {
    expect(resolveDecisionRunId({ sessionId: 'ctx-1' })).toBe('ctx-1');
  });

  it('returns null when there is no session, rather than inventing a bucket', () => {
    // A date-bucket fallback put test fixtures into the real store, which is
    // exactly the noise /doctor must not mistake for a healthy signal.
    expect(resolveDecisionRunId({})).toBeNull();
    expect(resolveDecisionRunId(null)).toBeNull();
    expect(resolveDecisionRunId({ sessionId: '   ' })).toBeNull();
  });

  it('counts a sessionless call as skipped, not as a silent success', () => {
    resetDecisionRecorderStats();
    expect(recordRoutingDecision(resolveDecisionRunId({}), CLASSIFICATION, { storeDir })).toBeNull();
    expect(recordWorkflowPlanDecision(resolveDecisionRunId({}), PLAN, { storeDir })).toBeNull();

    const stats = getDecisionRecorderStats();
    expect(stats).toMatchObject({ recorded: 0, failed: 0, skipped: 2 });
    // Nothing may reach disk on the skip path.
    expect(fsSync.existsSync(storeDir) && fsSync.readdirSync(storeDir)).toEqual([]);
  });

  it('rejects ids that would escape the store directory', () => {
    // A session id arrives from outside; it must not become a path traversal.
    const id = resolveDecisionRunId({ sessionId: '../../etc/passwd' });
    expect(id).not.toContain('..');
    expect(id).not.toContain('/');
  });
});
