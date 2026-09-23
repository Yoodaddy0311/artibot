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
 *   - **The formerly out-of-scope leak.** `tests/hooks/runtime-prompt-command-wiring.test.js`
 *     drives the hook with `cwd: null`, which resolved to the real store, and
 *     left `sess-cmd-e` / `sess-cmd-g` behind (measured 2026-09-17, and again
 *     2026-09-23: 2 files of 2,643 B each). That is a valid-key case and was
 *     ruled out of the allowlist by leader decision `decision-store-1`; the
 *     allowlist would not have stopped it. The ENV SEAM below is what covers
 *     it now, and only because `cwd: null` carries no usable value.
 *   - **Whether callers HANDLE the null.** `getDecisionStoreDir` and
 *     `getDecisionEventsPath` now return `null` on refusal. This file pins that
 *     the two readers and `record` cope; a future third caller that forwards
 *     the null into `path.join` is not covered.
 *
 * THE ENV SEAM (2026-09-23) is a second, separate guard, pinned in the last
 * three `describe` blocks below by CALLING the resolver. `tests/setup/state-dir.js`
 * mints `ARTIBOT_DECISIONS_STORE_DIR` plus its pair `ARTIBOT_DECISIONS_STORE_DIR_ROOT`
 * for every test worker, on the precedent of the autopilot store
 * (`lib/autopilot/session-store.js#getStoreDir`). The resolver honors it ONLY
 * when `storeDir`, `projectRoot` and `cwd` are all absent — the fallback that
 * used to be `process.cwd()`. Three things it deliberately does NOT do, each
 * asserted here:
 *   - it is not an option key: `DECISION_STORE_OPTS` stays three keys, and
 *     `{ ARTIBOT_DECISIONS_STORE_DIR: x }` passed as opts is refused like any
 *     other unknown key;
 *   - it does not move a call that carries a usable key: `{ cwd: process.cwd() }`
 *     still reaches the live store, so
 *     `tests/firewall/decisions-store-sandbox-required.test.js` is still needed;
 *   - it is not honored unpaired or mismatched: the pair is what keeps an
 *     inherited override from following a spawned child somewhere it was not
 *     minted for.
 * Each verdict helper takes the resolver as a parameter, and the last block
 * hands them stubs that violate the contract, so a helper that can no longer
 * go red is itself red.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sameDirPath } from '../../lib/core/platform.js';
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
    // A run id no other case or session uses, so "its file does not exist" is
    // attributable to THIS refusal. A before/after count of the live store is
    // not asserted: a live Claude session's hooks may add their own run file
    // there mid-test, which would read as a false RED.
    const runId = `run-opts-probe-${process.pid}-${Date.now()}`;

    expect(_recordForTest(runId, validEvent(), { sandboxDir: storeDir })).toBeNull();

    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, failed: 1 });
    expect(getDecisionRecorderStats().lastError).toBe('store-opts-not-allowed:sandboxDir');

    // Nothing may reach disk — not the temp directory the caller meant...
    expect(fileCount(path.join(storeDir, '.artibot', 'runtime', 'decisions'))).toBe(0);
    // ...not the store the old fall-through used, the live repo store...
    expect(fsSync.existsSync(getDecisionEventsPath(runId, { cwd: process.cwd() }))).toBe(false);
    // ...and not where that fall-through lands today, the env seam's sandbox.
    // Without this, a refusal that regressed into the fallback would write
    // into temp and every assertion above would still pass.
    const fallbackFile = getDecisionEventsPath(runId);
    expect(typeof fallbackFile).toBe('string');
    expect(fsSync.existsSync(fallbackFile)).toBe(false);
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

// ---------------------------------------------------------------------------
// The env seam. See "THE ENV SEAM" in the header.

/** The pair the global setup mints; the second records where the first belongs. */
const SEAM_ENV = Object.freeze(['ARTIBOT_DECISIONS_STORE_DIR', 'ARTIBOT_DECISIONS_STORE_DIR_ROOT']);

/**
 * Call shapes that carry no usable store key, so the seam must catch them.
 * `{ cwd: null }` is the one that leaked: `scripts/hooks/runtime-prompt.js`
 * builds `{ cwd: hookData?.cwd }` for its recorders, and a payload without a
 * cwd hands the resolver exactly this. An empty string is no usable value
 * either — the resolver's `typeof … === 'string' && …` guards skip it.
 */
const ALL_ABSENT = Object.freeze([
  ['no argument', undefined],
  ['{}', {}],
  ['{ cwd: null }', { cwd: null }],
  ['{ cwd: undefined }', { cwd: undefined }],
  ["{ cwd: '' }", { cwd: '' }],
  ['all three null', { storeDir: null, projectRoot: null, cwd: null }],
]);

/**
 * Run `fn` with the seam variables overridden, `undefined` meaning "delete",
 * and put back whatever was in force afterwards — absence included, so a case
 * that deletes the pair cannot leak into the next one.
 *
 * @param {Record<string, string|undefined>} overrides
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
function withSeamEnv(overrides, fn) {
  const saved = Object.fromEntries(SEAM_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of SEAM_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Both seam variables deleted: what a run without the global setup sees. */
const NO_SEAM = Object.freeze({ ARTIBOT_DECISIONS_STORE_DIR: undefined, ARTIBOT_DECISIONS_STORE_DIR_ROOT: undefined });

/**
 * The live repo store. A cwd is a usable key, so the seam leaves it alone and
 * this is where an unisolated production-shaped call still lands.
 */
function liveStoreDir() {
  return getDecisionStoreDir({ cwd: process.cwd() });
}

/**
 * `p` with its longest existing ancestor realpath'd. On Windows `os.tmpdir()`
 * can arrive as an 8.3 short name while the same directory reached another way
 * is spelled long, and the store directory itself usually does not exist yet.
 */
function canonical(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fsSync.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `child` lies strictly under `parent` (not `startsWith`: `/tmp/ab` vs `/tmp/a`). */
function isInside(parent, child) {
  const rel = path.relative(canonical(parent), canonical(child));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Labels of the all-absent call shapes that did NOT land in a temp directory
 * clear of the live store. Empty means the seam holds for every shape.
 *
 * @param {(opts?: object) => string|null} resolve
 * @param {string} liveStore
 * @returns {string[]}
 */
function seamMisses(resolve, liveStore) {
  return ALL_ABSENT.filter(([, opts]) => {
    const dir = resolve(opts);
    return typeof dir !== 'string'
      || !isInside(os.tmpdir(), dir)
      || sameDirPath(dir, liveStore)
      || isInside(liveStore, dir);
  }).map(([label]) => label);
}

/**
 * Labels of calls carrying a usable key whose answer CHANGES when the seam
 * variables are cleared. Empty means the seam only ever touches the fallback.
 *
 * @param {(opts?: object) => string|null} resolve
 * @param {Array<[string, object]>} cases
 * @returns {string[]}
 */
function explicitKeyDrift(resolve, cases) {
  return cases.filter(([, opts]) => resolve(opts) !== withSeamEnv(NO_SEAM, () => resolve(opts)))
    .map(([label]) => label);
}

/**
 * Pair violations: an all-absent call that still leaves the live store when
 * the pair is missing or names another root. Empty means both are discarded.
 *
 * The override is set to `seamDir` explicitly rather than inherited, so a
 * worker that lost the setup block cannot make this vacuously green: with no
 * override at all, every resolver "discards" it.
 *
 * @param {(opts?: object) => string|null} resolve
 * @param {string} liveStore
 * @param {string} seamDir - A temp directory to stand in as the override.
 * @returns {string[]}
 */
function pairIgnored(resolve, liveStore, seamDir) {
  const out = [];
  const otherRoot = path.join(os.tmpdir(), 'artibot-decisions-some-other-root');
  withSeamEnv({ ARTIBOT_DECISIONS_STORE_DIR: seamDir, ARTIBOT_DECISIONS_STORE_DIR_ROOT: undefined }, () => {
    if (!sameDirPath(resolve({}), liveStore)) out.push('unpaired override honored');
  });
  withSeamEnv({ ARTIBOT_DECISIONS_STORE_DIR: seamDir, ARTIBOT_DECISIONS_STORE_DIR_ROOT: otherRoot }, () => {
    if (!sameDirPath(resolve({}), liveStore)) out.push('mismatched pair honored');
  });
  return out;
}

/**
 * Seam variables the resolver ACCEPTED when passed as option keys. Empty means
 * the env stayed an env and never became a fourth opts key.
 *
 * @param {(opts?: object) => string|null} resolve
 * @param {string} value
 * @returns {string[]}
 */
function seamKeysAccepted(resolve, value) {
  return SEAM_ENV.filter((key) => resolve({ [key]: value }) !== null);
}

describe('env seam — global setup redirects the all-absent fallback', () => {
  it('this worker carries both seam variables (minted by tests/setup/state-dir.js)', () => {
    // Nothing in THIS file sets them. If they are missing, the setup block was
    // removed or stopped running, and every case below is judging a no-op.
    for (const key of SEAM_ENV) {
      expect(typeof process.env[key], key).toBe('string');
      expect(process.env[key].length, key).toBeGreaterThan(0);
    }
    expect(isInside(os.tmpdir(), process.env.ARTIBOT_DECISIONS_STORE_DIR)).toBe(true);
  });

  it('resolves every all-absent call shape into temp, clear of the live store', () => {
    expect(seamMisses(getDecisionStoreDir, liveStoreDir())).toEqual([]);
  });

  it('without the seam the same shapes land in the live store (the leak it closes)', () => {
    // The before-picture. Were this green only because the fallback no longer
    // points at the repo for some unrelated reason, the case above would prove
    // nothing about the seam.
    withSeamEnv(NO_SEAM, () => {
      expect(seamMisses(getDecisionStoreDir, liveStoreDir()))
        .toEqual(ALL_ABSENT.map(([label]) => label));
    });
  });

  it('a real writer with no store opts writes to temp and leaves the live store untouched', () => {
    // A resolver answer is a necessary condition; this drives the recorder the
    // hook uses and then looks at both places on disk.
    const runId = `fw-decisions-seam-${process.pid}-${Date.now()}`;
    const liveFile = getDecisionEventsPath(runId, { cwd: process.cwd() });
    const written = getDecisionEventsPath(runId);
    // Checked BEFORE writing: with the seam broken this case must go red
    // without itself becoming the polluter it exists to catch. On 2026-09-23,
    // while the resolver was still being edited, the post-write form of this
    // check failed only after the recorder had already appended wherever the
    // fallback pointed.
    expect(isInside(os.tmpdir(), written)).toBe(true);

    try {
      for (const [, opts] of ALL_ABSENT) {
        expect(recordWorkflowPlanDecision(runId, PLAN, opts)).not.toBeNull();
      }
      expect(readDecisionEvents(runId)).toHaveLength(ALL_ABSENT.length);
      // Absence of THIS run's file only. A before/after count of the live
      // store is not asserted: a live Claude session's hooks may add their
      // own run file there mid-test, which would read as a false RED.
      expect(fsSync.existsSync(liveFile)).toBe(false);
    } finally {
      try { fsSync.unlinkSync(written); } catch { /* best effort */ }
    }
  });

  it('discards the override when the pair is missing or names another root', () => {
    expect(pairIgnored(getDecisionStoreDir, liveStoreDir(), storeDir)).toEqual([]);
  });
});

describe('env seam — does not widen or bend the option keys', () => {
  it('is not an option key: DECISION_STORE_OPTS is unchanged and the names are refused', () => {
    expect([...DECISION_STORE_OPTS]).toEqual(['storeDir', 'projectRoot', 'cwd']);
    for (const key of SEAM_ENV) expect(DECISION_STORE_OPTS).not.toContain(key);
    expect(seamKeysAccepted(getDecisionStoreDir, storeDir)).toEqual([]);
  });

  it('counts a seam name passed as opts as an unknown key, like any other', () => {
    expect(_recordForTest('run-opts-probe', validEvent(), { ARTIBOT_DECISIONS_STORE_DIR: storeDir })).toBeNull();
    expect(getDecisionRecorderStats().lastError).toBe('store-opts-not-allowed:ARTIBOT_DECISIONS_STORE_DIR');
  });

  it('leaves every call carrying a usable key exactly as it resolves without the seam', () => {
    expect(explicitKeyDrift(getDecisionStoreDir, [
      ['{ storeDir }', { storeDir }],
      ['{ projectRoot }', { projectRoot: storeDir }],
      ['{ cwd: temp }', { cwd: storeDir }],
      ['{ cwd: process.cwd() }', { cwd: process.cwd() }],
    ])).toEqual([]);
  });

  it('still sends a usable key with a live value to the live store', () => {
    // Why the sandbox scan in decisions-store-sandbox-required stays necessary:
    // the seam covers the fallback only, and the production path is a cwd.
    const dir = getDecisionStoreDir({ cwd: process.cwd() });
    expect(isInside(os.tmpdir(), dir)).toBe(false);
    expect(dir).toBe(withSeamEnv(NO_SEAM, () => getDecisionStoreDir({})));
  });
});

describe('env seam verdicts (negative controls)', () => {
  // Each helper above is handed a resolver that breaks the contract in exactly
  // one way. A helper that returns [] here has lost the ability to go red.
  // The seam variables are pinned per case, so these controls do not depend on
  // what the global setup left in this worker.
  const LIVE = path.join(os.tmpdir(), '..', 'artibot-fake-repo', '.artibot', 'runtime', 'decisions');
  const minted = () => ({ ARTIBOT_DECISIONS_STORE_DIR: storeDir, ARTIBOT_DECISIONS_STORE_DIR_ROOT: 'minted-root' });

  it('seamMisses flags a resolver that ignores the seam', () => {
    const ignoresSeam = () => LIVE;
    withSeamEnv(minted(), () => {
      expect(seamMisses(ignoresSeam, LIVE)).toEqual(ALL_ABSENT.map(([label]) => label));
    });
  });

  it('seamMisses flags a resolver that only catches the no-argument shape', () => {
    // The shape that leaked was `{ cwd: null }`, not a bare call.
    const bareOnly = (opts) => (opts === undefined ? process.env.ARTIBOT_DECISIONS_STORE_DIR : LIVE);
    withSeamEnv(minted(), () => {
      expect(seamMisses(bareOnly, LIVE)).toEqual(ALL_ABSENT.slice(1).map(([label]) => label));
    });
  });

  it('explicitKeyDrift flags a resolver that lets the env outrank a usable key', () => {
    const envWins = (opts) => process.env.ARTIBOT_DECISIONS_STORE_DIR || opts.storeDir || LIVE;
    const other = path.join(storeDir, 'explicit');
    withSeamEnv(minted(), () => {
      expect(explicitKeyDrift(envWins, [['{ storeDir }', { storeDir: other }]])).toEqual(['{ storeDir }']);
    });
  });

  it('pairIgnored flags a resolver that honors the override without its pair', () => {
    const noPairCheck = () => process.env.ARTIBOT_DECISIONS_STORE_DIR || LIVE;
    expect(pairIgnored(noPairCheck, LIVE, storeDir))
      .toEqual(['unpaired override honored', 'mismatched pair honored']);
  });

  it('seamKeysAccepted flags a resolver that reads the seam from opts', () => {
    const readsOpts = (o) => o.ARTIBOT_DECISIONS_STORE_DIR ?? o.ARTIBOT_DECISIONS_STORE_DIR_ROOT ?? null;
    expect(seamKeysAccepted(readsOpts, storeDir)).toEqual([...SEAM_ENV]);
  });
});
