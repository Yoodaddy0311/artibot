/**
 * Firewall — the decisions-store resolver accepts an ALLOWLIST of option keys.
 *
 * `lib/observability/decision-events.js#getDecisionStoreDir` used to ignore any
 * key it did not recognize, so a caller passing e.g. `{ sandboxDir }` fell
 * through to `resolveProjectRoot(undefined)` = `process.cwd()` and wrote into
 * the REAL repo store. A typo in an isolation option therefore produced a
 * silent, fully successful write to the developer's own store — the same class
 * of pollution `tests/firewall/decisions-store-sandbox-required.test.js` exists
 * to prevent, but one that gate cannot see because the polluting file DOES
 * carry a `storeDir`/`mkdtemp` marker.
 *
 * This gate asserts the refusal by CALLING the resolver, not by grepping its
 * source: a source scan would stay green if the allowlist check were reordered
 * below the first `return`.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - **Scripts outside `tests/`.** Only this file's own calls are exercised.
 *     A benchmark, a `scripts/` entry point or an eval runner that passes a
 *     misspelled key is refused at runtime by the same code path, but nothing
 *     here measures that it does.
 *   - **Subprocess writers.** A test that spawns the hook writes the store from
 *     a child process. The refusal lives in the child; this file never sees it.
 *   - **A valid key carrying a live value.** `{ cwd: process.cwd() }` is an
 *     allowlisted key and resolves to the real repo store, by design — that is
 *     the production path. The allowlist closes the "unknown key" hole only;
 *     the "known key, real value" hole is out of scope here.
 *   - **The known out-of-scope leak.** `tests/hooks/runtime-prompt-command-wiring.test.js`
 *     drives the hook with `cwd: null`, which resolves to the real store, and
 *     left `sess-cmd-e` / `sess-cmd-g` behind (measured 2026-09-17). That is a
 *     valid-key case and was ruled out of this limb by leader decision
 *     `decision-store-1`; the allowlist would not have stopped it.
 *   - **Whether callers HANDLE the null.** `getDecisionStoreDir` and
 *     `getDecisionEventsPath` now return `null` on refusal. This file pins that
 *     the two readers and `record` cope; a future third caller that forwards
 *     the null into `path.join` is not covered.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _recordForTest,
  DECISION_STORE_OPTS,
  getDecisionEventsPath,
  getDecisionRecorderStats,
  getDecisionStoreDir,
  readDecisionEvents,
  recordWorkflowPlanDecision,
  resetDecisionRecorderStats,
  ROUTING_CLASSIFIED,
} from '../../lib/observability/decision-events.js';

/** The store path fragment every resolved answer ends with. */
const DECISIONS_REL = path.join('.artibot', 'runtime', 'decisions');

let storeDir;

beforeEach(() => {
  storeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-store-opts-'));
  resetDecisionRecorderStats();
});

/** Files currently in `dir`; an absent directory counts as zero. */
function fileCount(dir) {
  try {
    return fsSync.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/** A minimal `buildWorkflowPlan` result — enough for the recorder's `pick`. */
const PLAN = Object.freeze({
  runner: 'team',
  effort: 'high',
  perAgentBudget: 4000,
  teammates: [],
  trigger: { fired: true, reasons: ['subObjectives>=2'], bypassed: false },
  recommendation: null,
  autoFire: true,
});

/** A valid event for the vocabulary gate, so only the opts axis is under test. */
function validEvent() {
  return {
    phase: 'ROUTE',
    type: ROUTING_CLASSIFIED,
    level: 'info',
    message: 'probe',
    data: { system: 1 },
  };
}

describe('getDecisionStoreDir — the three allowlisted keys still resolve', () => {
  it('returns an explicit storeDir unchanged', () => {
    expect(getDecisionStoreDir({ storeDir })).toBe(storeDir);
  });

  it('joins the store path onto an injected projectRoot', () => {
    expect(getDecisionStoreDir({ projectRoot: storeDir }))
      .toBe(path.join(storeDir, '.artibot', 'runtime', 'decisions'));
  });

  it('resolves a cwd through resolveProjectRoot', () => {
    // A mkdtemp directory has no `.git` ancestor, so `resolveProjectRoot` falls
    // to its step 4 and returns the start directory. The exact string is NOT
    // asserted: that helper canonicalizes the path, and on Windows os.tmpdir()
    // may arrive as an 8.3 short name that canonicalization expands. What
    // matters here is that a cwd resolves to a real store path at all, rather
    // than being refused like an unknown key.
    const resolved = getDecisionStoreDir({ cwd: storeDir });
    expect(typeof resolved).toBe('string');
    expect(resolved.endsWith(DECISIONS_REL)).toBe(true);
  });
});

describe('getDecisionStoreDir — an unknown key is refused, not ignored', () => {
  it('returns null for a key outside the allowlist', () => {
    expect(getDecisionStoreDir({ sandboxDir: storeDir })).toBeNull();
  });

  it('refuses even when a valid key sits beside the unknown one', () => {
    // One unknown key poisons the call. The alternative — honour the valid key
    // and ignore the rest — is exactly the silent behaviour this gate replaces:
    // the caller who typed the unknown key believed it was doing something.
    expect(getDecisionStoreDir({ storeDir, sandboxDir: storeDir })).toBeNull();
  });

  it('refuses without throwing, from every public entry point', () => {
    // `resolveRunEventsPath` throws a TypeError on a non-string storeDir, so
    // without a guard in each of these the observe-only recorder would acquire
    // a failure mode. Refusal is a value, never an exception.
    expect(getDecisionEventsPath('run-x', { sandboxDir: storeDir })).toBeNull();
    expect(readDecisionEvents('run-x', { sandboxDir: storeDir })).toEqual([]);
  });
});

describe('record — a refused resolve is counted and writes nothing', () => {
  it('counts the refusal and names the offending key', () => {
    const before = fileCount(getDecisionStoreDir({ cwd: process.cwd() }));

    expect(_recordForTest('run-opts-probe', validEvent(), { sandboxDir: storeDir })).toBeNull();

    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, failed: 1 });
    expect(getDecisionRecorderStats().lastError).toBe('store-opts-not-allowed:sandboxDir');

    // Nothing may reach disk — not the temp directory the caller meant...
    expect(fileCount(path.join(storeDir, '.artibot', 'runtime', 'decisions'))).toBe(0);
    // ...and above all not the store the old fall-through would have used.
    expect(fileCount(getDecisionStoreDir({ cwd: process.cwd() }))).toBe(before);
  });

  it('names the first unknown key in sorted order, so the message is stable', () => {
    expect(_recordForTest('run-opts-probe', validEvent(), { zeta: 1, alpha: 2 })).toBeNull();
    expect(getDecisionRecorderStats().lastError).toBe('store-opts-not-allowed:alpha');
  });
});

describe('event vocabulary is stripped before the resolver sees it', () => {
  it('records normally when ts/phase/mode ride along with storeDir', () => {
    // `ts`, `phase` and `mode` are event vocabulary, not store options. They
    // are stripped in `record`, so the resolver never has to learn them — which
    // is what keeps the allowlist from rotting every time a recorder grows a
    // field. `mode` is the live proof: it was added later by
    // `lib/runtime/middleware/workflow-mode.js#recordWorkflow`.
    const ev = recordWorkflowPlanDecision('run-x', PLAN, {
      storeDir, ts: '2026-09-21T00:00:00.000Z', phase: 'PLAN', mode: 'agentTeam',
    });

    expect(ev).not.toBeNull();
    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 1, failed: 0 });

    const onDisk = readDecisionEvents('run-x', { storeDir });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].data.mode).toBe('agentTeam');
  });

  it('strips tail/level in the reader the same way', () => {
    recordWorkflowPlanDecision('run-x', PLAN, { storeDir, ts: '2026-09-21T00:00:00.000Z', phase: 'PLAN' });

    const onDisk = readDecisionEvents('run-x', { storeDir, tail: 1, level: 'info' });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].type).toBe('workflow-planned');
  });
});

describe('the allowlist itself (self-check)', () => {
  it('is exported, frozen, and holds exactly the three store keys', () => {
    // Without this the gate above could pass because the allowlist quietly grew
    // to admit everything a caller happened to send.
    expect(Object.isFrozen(DECISION_STORE_OPTS)).toBe(true);
    expect([...DECISION_STORE_OPTS]).toEqual(['storeDir', 'projectRoot', 'cwd']);
  });

  it('accounts for every other option key the recorders document', () => {
    // The recorders' JSDoc names six keys in total. Three are store options;
    // the other three are event vocabulary and must be stripped, never
    // allowlisted. If a seventh appears, this assertion is where the decision
    // gets made rather than silently deferred.
    const EVENT_OPTS = ['ts', 'phase', 'mode'];
    const READ_OPTS = ['tail', 'level'];
    for (const key of [...EVENT_OPTS, ...READ_OPTS]) {
      expect(DECISION_STORE_OPTS).not.toContain(key);
    }
  });
});
