/**
 * The run-to-mission binder against REAL concurrent processes (SH-11 pre-flip
 * condition 3).
 *
 * `bindRunToMission` records the binding with `updatePlanJson`, which used to
 * read the plan, run its updater and rename with nothing to stop a second window
 * doing the same in between; the binder's own comment called the race M1 and
 * "unmeasured under real contention". `updatePlanJson` now runs under the
 * plan.json lock, and this file is the measurement: genuine child processes,
 * released together from a start barrier, against a real plan.json in a fresh
 * tmpdir, observing what ends up on disk and what each process was told.
 *
 *  - N binders, each naming ITS OWN mission: one record lands, every process is
 *    told that same record, and exactly one of them says it created it.
 *  - binders racing the `forkPoint` recorder (`dispatch.mjs#recordForkPoint`
 *    goes through the same `updatePlanJson`): neither write is lost — the case
 *    the binder's read-back used to be the only defence against.
 *
 * MEASURED AGAINST THE UNLOCKED BASE (2026-09-30, this Windows host, this file
 * copied unchanged into a `git archive` of the base tree): both cases FAILED in
 * 7 of 7 runs — the first with a process told a binding for mission 101 while
 * plan.json held mission 100 (it acted on a binding that was not the one on
 * disk), the second with `missionBinding` gone from plan.json altogether (a
 * fork-point write renamed over it) — and both pass with the lock. So these
 * cases do detect the missing lock here. The deterministic failing-without-the-
 * lock cases, which do not depend on the host's timing at all, are in
 * tests/git/split-run-file.test.js (an update from inside `fn` is refused, and a
 * second process is held off while this one holds the lock).
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *  - Another host. The race window is the child's module-import and process-start
 *    jitter between the barrier and its read; it was measured on this Windows
 *    machine only, and a faster or POSIX host may fail the unlocked base less
 *    often (the locked code is correct either way).
 *  - Load. The lock waits up to 2 s for a contended holder; with a handful of
 *    processes and a few-millisecond section that is ample, but a machine so
 *    overloaded that a child takes seconds inside the section would show up as
 *    an ELOCKTIMEOUT in a child's output, not as a lost update.
 *  - `run.json`. Its read-modify-write is still unlocked; nothing here touches it.
 *
 * Bounding: children wait at the barrier with their own deadline, the parent
 * kills any child still alive when a case ends, and each case has an explicit
 * vitest timeout. Temp dirs are removed in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SPLIT_STATE_URL = new URL('../../lib/topology/split-state.js', import.meta.url).href;
const RUN_FILE_URL = new URL('../../lib/git/split-run-file.js', import.meta.url).href;

const BARRIER_DEADLINE_MS = 20_000;
const SCENARIO_DEADLINE_MS = 30_000;
const RUN_ID = 'split-race-1';

/**
 * One contender: waits at the barrier, then either binds the run to its mission
 * or records a fork point for its limb, and prints one JSON line.
 */
const CHILD_SOURCE = `
import { existsSync, writeFileSync } from 'node:fs';
import { bindRunToMission } from ${JSON.stringify(SPLIT_STATE_URL)};
import { updatePlanJson } from ${JSON.stringify(RUN_FILE_URL)};

const cfg = JSON.parse(process.argv[2]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
writeFileSync(cfg.readyPath, String(process.pid));
const deadline = Date.now() + cfg.barrierDeadlineMs;
while (!existsSync(cfg.goPath)) {
  if (Date.now() > deadline) process.exit(98);
  sleep(1);
}
try {
  if (cfg.role === 'bind') {
    const res = bindRunToMission({
      runDir: cfg.runDir, missionId: cfg.missionId, sessionId: cfg.sessionId, now: () => new Date('2026-09-29T04:00:00.000Z'),
    });
    process.stdout.write(JSON.stringify({ role: 'bind', res }));
  } else {
    updatePlanJson(cfg.root, (cur) => ({
      ...cur,
      limbs: cur.limbs.map((l) => (l.limb === cfg.limb ? { ...l, forkPoint: cfg.forkPoint } : l)),
    }));
    process.stdout.write(JSON.stringify({ role: 'fork', limb: cfg.limb }));
  }
} catch (err) {
  process.stdout.write(JSON.stringify({ role: cfg.role, error: String(err && err.code ? err.code : err) }));
  process.exit(3);
}
`;

let tmpDir;
let liveChildren;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-bindrace-'));
  liveChildren = new Set();
});

afterEach(() => {
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  liveChildren.clear();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A canonical run directory (`split` under the tmp project's `.artibot`, holding `plan.json` and `run.json`), the plan carrying no binding yet. */
function seedRun(limbs) {
  const runDir = path.join(tmpDir, '.artibot', 'split');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({
    runId: RUN_ID, base: 'b'.repeat(40), limbs: limbs.map((limb) => ({ limb, affectedPaths: [`lib/${limb}/**`] })),
  }, null, 2));
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId: RUN_ID }, null, 2));
  return runDir;
}
const planOf = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf-8'));

/**
 * Start the contenders, release them together, and collect what each printed.
 *
 * @param {object[]} configs - one per child, merged over the shared barrier paths
 * @returns {Promise<Array<{ code: number|null, out: object|null, stderr: string }>>}
 */
async function race(configs) {
  const script = path.join(tmpDir, 'contender.mjs');
  fs.writeFileSync(script, CHILD_SOURCE);
  const goPath = path.join(tmpDir, 'go');
  const runs = configs.map((cfg, i) => {
    const readyPath = path.join(tmpDir, `ready-${i}`);
    const child = spawn(process.execPath, [script, JSON.stringify({ ...cfg, readyPath, goPath, barrierDeadlineMs: BARRIER_DEADLINE_MS })], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const done = new Promise((resolve, reject) => {
      const killer = setTimeout(() => child.kill('SIGKILL'), SCENARIO_DEADLINE_MS);
      child.on('error', (err) => { clearTimeout(killer); reject(err); });
      child.on('exit', (code) => {
        clearTimeout(killer);
        liveChildren.delete(child);
        let out = null;
        try { out = JSON.parse(stdout); } catch { /* reported through stderr and code */ }
        resolve({ code, out, stderr });
      });
    });
    return { readyPath, done };
  });
  const until = Date.now() + BARRIER_DEADLINE_MS;
  while (!runs.every((r) => fs.existsSync(r.readyPath))) {
    if (Date.now() > until) throw new Error('contenders never all reached the barrier');
    await new Promise((r) => setTimeout(r, 10));
  }
  fs.writeFileSync(goPath, '');
  return Promise.all(runs.map((r) => r.done));
}

describe('SH-11 bind race — real processes (pre-flip condition 3)', () => {
  it('N binders naming N different missions: one record lands, every process is told that record, exactly one created it', async () => {
    const runDir = seedRun(['alpha', 'beta']);
    const N = 5;
    const results = await race(Array.from({ length: N }, (_, i) => ({
      role: 'bind', runDir, missionId: `M-20260929-${100 + i}`, sessionId: `session-${i}-aaaa-bbbb-cccc`,
    })));

    expect(results.map((r) => ({ code: r.code, err: r.out?.error ?? null }))).toEqual(Array.from({ length: N }, () => ({ code: 0, err: null })));
    const onDisk = planOf(runDir).missionBinding;
    expect(onDisk).toMatchObject({ run_id: RUN_ID, generation: 1 });
    expect(onDisk.mission_id).toMatch(/^M-20260929-10[0-4]$/);

    for (const r of results) {
      expect(r.out.res.ok).toBe(true);
      expect(r.out.res.binding).toEqual(onDisk); // nobody acts on a binding that is not the one on disk
    }
    expect(results.filter((r) => r.out.res.bound === true)).toHaveLength(1);
    const creator = results.find((r) => r.out.res.bound === true);
    expect(creator.out.res.binding.bound_by_session).toBe(onDisk.bound_by_session);
    expect(fs.existsSync(path.join(runDir, 'plan.json.lock'))).toBe(false);
  }, 40_000);

  it('binders racing the fork-point recorder: the binding and every fork point survive — no write is lost', async () => {
    const limbs = ['alpha', 'beta', 'gamma', 'delta'];
    const runDir = seedRun(limbs);
    const results = await race([
      { role: 'bind', runDir, missionId: 'M-20260929-100', sessionId: 'session-a-aaaa-bbbb-cccc' },
      { role: 'bind', runDir, missionId: 'M-20260929-101', sessionId: 'session-b-aaaa-bbbb-cccc' },
      ...limbs.map((limb, i) => ({ role: 'fork', root: tmpDir, limb, forkPoint: String(i + 1).repeat(40) })),
    ]);

    expect(results.map((r) => r.code)).toEqual(results.map(() => 0));
    const plan = planOf(runDir);
    expect(plan.missionBinding).toMatchObject({ run_id: RUN_ID, generation: 1 });
    expect(plan.limbs.map((l) => [l.limb, l.forkPoint])).toEqual(limbs.map((limb, i) => [limb, String(i + 1).repeat(40)]));
    for (const r of results.filter((x) => x.out.role === 'bind')) expect(r.out.res.binding).toEqual(plan.missionBinding);
    expect(plan.limbs).toHaveLength(limbs.length); // and the plan's own shape is intact
    expect(plan.runId).toBe(RUN_ID);
  }, 40_000);
});
