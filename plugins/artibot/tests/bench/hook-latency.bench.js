/**
 * Hook latency SMOKE bench — a vitest-shaped wrapper over the real runner.
 *
 * Run: npx vitest bench tests/bench/hook-latency.bench.js --run
 *
 * WHY THIS IS A SMOKE WRAPPER AND NOT THE MEASUREMENT
 *
 * The instrument is `scripts/bench/hook-latency.mjs`. It covers all 19 declared
 * slots, counts child Node processes with an `--import` probe, reads each
 * slot's declared budget out of `hooks/hooks.json`, and prints headroom. This
 * file covers 8 slots at 3 samples each and counts nothing. Quote a number from
 * here and you are quoting a sample of three from a machine that was also
 * running vitest.
 *
 *     Real run: node scripts/bench/hook-latency.mjs --n 20 --json
 *
 * What this file IS for: keeping the runner's public surface — `SLOTS`,
 * `createSandbox`, `runOnce`, the guard trio — exercised by the normal
 * developer bench command, so a refactor that breaks the contract fails
 * somewhere other than the next person's measurement session.
 *
 * WHAT THIS FILE CANNOT SEE
 *
 * Everything in the runner's own header, items 1-8 ("WHAT THIS TOOL CANNOT
 * SEE" in `scripts/bench/hook-latency.mjs`): host IPC latency, real payload
 * size, concurrent-session contention, the two network hooks (disabled), the
 * sandbox repo not being the artibot repo, the 1-byte `bench.txt`, non-Node
 * children, first-run effects. Read those before quoting anything. Plus four
 * that are specific to running under vitest:
 *
 *   a. ONE SHARED SANDBOX, NOT ONE PER SLOT. The runner gives each slot a cold
 *      home; this file creates a single sandbox and reuses it for all 8 slots
 *      in declaration order. Later slots therefore run against a home that
 *      earlier slots have already warmed and written to. Direction of the bias
 *      is not known and is not modelled: a warmed cache makes a later slot
 *      look faster, a store the earlier slots filled makes it look slower.
 *   b. SAMPLE COUNT IS 3. `rme` in the output table is computed from three
 *      samples and is noise. The runner's p50/p95 over n=20 is the number.
 *   c. THIS FILE RUNS TWICE PER INVOCATION. `vitest.config.js` declares two
 *      projects (`autopilot`, `main`) and neither narrows `benchmark.include`,
 *      so both match `*.bench.js` and both execute the whole file. Measured
 *      2026-09-11: the probe's counters reported an identical warmup+run
 *      sequence under each project name. Every hook spawn below therefore
 *      happens twice, in two separate workers with two separate sandboxes.
 *   d. IT IS NOT IN `npm test`. The test projects include
 *      `tests/**\/*.test.{js,mjs}` only, so a `.bench.js` file is never
 *      collected as a test. `npx vitest run tests/bench/hook-latency.bench.js`
 *      exits with "No test files found". Only `vitest bench` reaches this file.
 *
 * SUITE HOOKS DO NOT RUN IN BENCH MODE — MEASURED, NOT ASSUMED
 *
 * `beforeAll`/`afterAll` are silently skipped by vitest 4.0.18's benchmark
 * runner: `runBenchmarkSuite` (vitest `dist/chunks/test.*.js`) walks
 * `suite.tasks`, keeps the ones carrying `meta.benchmark`, and calls
 * `task.warmup()` then `task.run()` on each. It never touches the suite's hook
 * arrays. A throwaway probe under `tests/bench/` on 2026-09-11 logged
 * `module-toplevel`, `setup:warmup`, `teardown:warmup`, `setup:run`,
 * `teardown:run` and never `beforeAll` or `afterAll`.
 *
 * So the lifecycle is rebuilt from the two hooks that DO run:
 *   - Setup rides on tinybench's per-task `setup(task, mode)`, which `Task.run`
 *     and `Task.warmup` both `await`. `start()` is memoised, so the first bench
 *     to reach it pays for the guard snapshot and the sandbox `git init`, and
 *     it happens before that task's first timed sample rather than inside it.
 *   - Teardown CANNOT ride on tinybench's `teardown(task, mode)`: `Task.run`
 *     calls it without `await` (tinybench 2.9.0), so an async verdict there
 *     would be fire-and-forget and a throw would surface as an unhandled
 *     rejection, not a failed run. The verdict is therefore a final `bench()`
 *     of its own, whose body IS awaited and whose throw IS reported. It is
 *     last in declaration order and the runner's loop is sequential.
 *
 * ISOLATION IS ASSERTED, NOT ASSUMED
 *
 * `expect` is not available in bench mode, so the final bench throws. Guards
 * come from the runner's `defaultGuardSpecs()` — real `~/.artibot` (tree),
 * `~/.claude/artibot` (leak-scan), this worktree's `.artibot/runtime`, and the
 * PARENT checkout's `.artibot/runtime`, which the runner already derives from
 * `git rev-parse --git-common-dir`. This file adds one `leak-scan` per
 * `runtime` directory aimed straight at `ledger.jsonl`. That is not redundant:
 * a `tree` verdict of CHANGED on a ledger other live sessions append to is
 * ambiguous on its own, while the paired leak-scan answers the narrower
 * question — did a value THIS RUN generated end up in there. Its clean verdict
 * reads `clean (0 of N generated values found)`.
 *
 * The two rows are paired for reporting by PATH CONTAINMENT, not by
 * `path.dirname`. A tree guard on `…/.artibot/runtime` and a leak-scan on
 * `…/.artibot/runtime/ledger.jsonl` have different dirnames, so the dirname
 * match an earlier revision of this file used never paired them: the thrown
 * message carried the `[tree]` verdict alone and dropped the very row that
 * disambiguates it. Found in review, measured 2026-09-11 01:15 KST.
 *
 * WRITERS MODES — A CLEAN STRICT RUN IS RARE AND WORTH MORE THAN A TOLERATED ONE
 *
 * `compareGuards(before, after, { writers })` takes `strict` (the default) or
 * `tolerate`, and `ARTIBOT_BENCH_WRITERS=tolerate` selects the latter here.
 * Strict fails on ANY change to a `tree` guard. Tolerate fails only on a change
 * carrying one of this run's generated values and reports the rest as
 * `CHANGED (unattributed …)` at exit 0.
 *
 * A clean STRICT run is the strongest evidence this file can produce, because
 * it is the only result that rules out a write nobody can attribute. It is also
 * structurally unobtainable while a team is working. Measured here 2026-09-11
 * 01:2x KST: the parent checkout's ledger stood at 185,004 bytes holding 179
 * `mission.candidate_deferred` rows, every one of them under a UUID session id
 * belonging to a concurrent session rather than the `bench-`-prefixed ids this
 * file mints. One more such row landing between the two snapshots fails a
 * strict run on activity this bench did not cause.
 *
 * TOLERATE IS THE WEAKER RESULT AND MUST NOT BE QUOTED AS THE OTHER ONE. It
 * clears a change on the ABSENCE of a fingerprint, and a leak need not carry
 * one: a hook that bumps a counter or rewrites a summary derived from bench
 * activity leaves no random suffix behind, and tolerate reads that as someone
 * else's traffic. That is why every guard row carries `strictWouldFail` and why
 * the verdict bench prints it next to the writers mode — a tolerated pass whose
 * rows say `strictWouldFail: true` is a pass with a caveat, not a clean run.
 *
 * @module tests/bench/hook-latency
 */

import path from 'node:path';

import { bench, describe } from 'vitest';

import {
  compareGuards,
  createSandbox,
  defaultGuardSpecs,
  runOnce,
  snapshotGuards,
} from '../../scripts/bench/hook-latency.mjs';

// ---------------------------------------------------------------------------
// Shape of the run
// ---------------------------------------------------------------------------

/**
 * A hook spawn costs roughly 0.15-1.3s, so the sample count is set by
 * `iterations` alone and `time` is pinned to 0 to keep tinybench from adding
 * more. Its loop condition is `(totalTime < time || samples.length <
 * iterations)` (tinybench 2.9.0 `Task.loop`); with `time: 0` the left half is
 * false from the first check and only the iteration count governs. `warmupTime:
 * 0` does the same for `Task.warmup`, which calls the same loop with
 * `warmupTime`/`warmupIterations`.
 *
 * Measured with a counter, not inferred: 1 warmup call + 3 timed calls = 4
 * spawns per slot per project, and this file runs under 2 projects (item c),
 * so 8 spawns per slot per invocation. `verifyCallCounts()` re-checks the 4 at
 * the end of every run, so a tinybench change that reinterprets these options
 * fails here instead of quietly inflating the bench.
 */
const BENCH_OPTIONS = {
  iterations: 3,
  warmupIterations: 1,
  time: 0,
  warmupTime: 0,
};

/** 1 warmup + 3 timed. Asserted, not assumed — see verifyCallCounts(). */
const EXPECTED_CALLS_PER_SLOT = BENCH_OPTIONS.warmupIterations + BENCH_OPTIONS.iterations;

/**
 * `strict` (default) or `tolerate`, read once from `ARTIBOT_BENCH_WRITERS`.
 *
 * Anything other than the exact string `tolerate` leaves strict in place, which
 * is how the runner reads its own `--writers` flag — a typo must not silently
 * buy the weaker mode.
 */
const WRITERS_MODE = process.env.ARTIBOT_BENCH_WRITERS === 'tolerate' ? 'tolerate' : 'strict';

/**
 * The 8 slots. Names must match keys of the runner's `SLOTS`; `runOnce` throws
 * on an unknown name, which is the check that keeps this list honest.
 *
 * Chosen as the slots a user actually waits on: the two that gate the start of
 * a turn, the two PreToolUse guards that gate every edit and every shell
 * command, the PostToolUse quality gate, and the three end-of-turn slots.
 */
const SLOT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse:bash-risk-guard',
  'PreToolUse:pre-write',
  'PostToolUse:Write',
  'Stop',
  'SessionEnd',
  'SubagentStop',
];

// ---------------------------------------------------------------------------
// Lifecycle, rebuilt out of the hooks bench mode actually runs
// ---------------------------------------------------------------------------

/** @type {{ home: string, cwd: string, cleanup: () => void } | null} */
let sandbox = null;

/** @type {Array<object> | null} Guard snapshot taken before the first spawn. */
let guardsBefore = null;

/** @type {Promise<void> | null} Memo cell for start(); never re-entered. */
let started = null;

/** @type {Map<string, number>} slot name -> spawns this process actually made. */
const callCounts = new Map();

/** @type {string[]} Slots whose child had to be killed. Any entry fails the run. */
const timedOut = [];

/**
 * Guard specs: the runner's defaults, plus a `ledger.jsonl` leak-scan for every
 * `runtime` directory among them. Derived rather than hardcoded so this keeps
 * covering the parent checkout after a worktree moves.
 *
 * @returns {Array<{ path: string, mode: string }>}
 */
function guardSpecs() {
  const base = defaultGuardSpecs();
  const ledgers = base
    .filter((spec) => path.basename(spec.path) === 'runtime')
    .map((spec) => ({ path: path.join(spec.path, 'ledger.jsonl'), mode: 'leak-scan' }));
  return [...base, ...ledgers];
}

/**
 * Snapshot the guards, then build the sandbox. Order matters: the snapshot has
 * to predate anything this file could possibly write.
 *
 * @returns {Promise<void>}
 */
function start() {
  if (!started) {
    started = (async () => {
      guardsBefore = await snapshotGuards(guardSpecs());
      sandbox = createSandbox();
    })();
  }
  return started;
}

/**
 * One measured spawn. Counts itself so the final bench can prove how many
 * times tinybench actually called it.
 *
 * @param {string} slotName
 * @returns {Promise<void>}
 */
async function spawnSlot(slotName) {
  callCounts.set(slotName, (callCounts.get(slotName) || 0) + 1);
  const result = await runOnce(slotName, sandbox);
  if (result.timedOut) timedOut.push(slotName);
}

// ---------------------------------------------------------------------------
// Verdicts. Thrown, because bench mode has no `expect`.
// ---------------------------------------------------------------------------

/**
 * @param {Array<object>} rows compareGuards() output
 * @returns {string}
 */
function describeGuardRows(rows) {
  return rows
    .map((row) => `  [${row.mode}] ${row.path}\n`
      + `      ${row.before} -> ${row.after}: ${row.verdict}\n`
      + `      strictWouldFail: ${row.strictWouldFail}`)
    .join('\n');
}

/**
 * Whether two guard paths describe the same store, by containment.
 *
 * `path.dirname` is the wrong test and was the bug here: the tree guard on
 * `…/.artibot/runtime` and the leak-scan on `…/.artibot/runtime/ledger.jsonl`
 * have dirnames one level apart, so comparing dirnames left every violation
 * reported without the row that explains it. Containment is checked in both
 * directions so the pairing survives whichever of the two is the violating row.
 *
 * @param {string} a absolute path
 * @param {string} b absolute path
 * @returns {boolean}
 */
function isSameStore(a, b) {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

/**
 * Print every guard row. Not a debug artifact — this IS the verdict bench's
 * report surface, and it runs on a pass as much as on a failure. A tolerated
 * pass is only honest if the rows it tolerated, and their `strictWouldFail`
 * flags, are visible without re-running in the other mode.
 *
 * @param {Array<object>} rows compareGuards() output
 * @returns {void}
 */
function reportGuardRows(rows) {
  const wouldFail = rows.filter((row) => row.strictWouldFail).length;
  // eslint-disable-next-line no-console
  console.log(
    `hook-latency guards: writers=${WRITERS_MODE}; `
    + `${wouldFail} of ${rows.length} guard(s) would fail under strict\n`
    + describeGuardRows(rows),
  );
}

/**
 * Re-snapshot, compare under the selected writers mode, report every row, and
 * throw on any violation. The thrown message carries every row of every store
 * that had one, so the strict `tree` verdict and the attributable `leak-scan`
 * verdict for the same store sit side by side — which is what separates "this
 * bench leaked" from "another session appended".
 *
 * @returns {Promise<void>}
 */
async function verifyGuards() {
  const rows = compareGuards(
    guardsBefore,
    await snapshotGuards(guardSpecs()),
    { writers: WRITERS_MODE },
  );
  reportGuardRows(rows);

  const violations = rows.filter((row) => row.violation);
  if (violations.length === 0) return;

  const context = rows.filter((row) => violations.some((bad) => isSameStore(row.path, bad.path)));
  throw new Error(
    `hook-latency bench touched a guarded store `
    + `(${violations.length} violation(s), writers=${WRITERS_MODE}).\n`
    + `${describeGuardRows(context)}\n`
    + '  A "clean (0 of N generated values found)" leak-scan next to a CHANGED tree on\n'
    + '  the same store means a concurrent session wrote there, not this bench.\n'
    + '  ARTIBOT_BENCH_WRITERS=tolerate passes on unattributed writes — a WEAKER\n'
    + '  result, which is what the strictWouldFail flag on each row is there to say.',
  );
}

/**
 * Prove the iteration options meant what the header says they meant.
 *
 * @returns {void}
 */
function verifyCallCounts() {
  const wrong = SLOT_NAMES
    .map((slotName) => ({ slotName, actual: callCounts.get(slotName) || 0 }))
    .filter((row) => row.actual !== EXPECTED_CALLS_PER_SLOT);
  if (wrong.length === 0) return;
  const detail = wrong.map((row) => `${row.slotName}=${row.actual}`).join(', ');
  throw new Error(
    `Expected ${EXPECTED_CALLS_PER_SLOT} spawns per slot `
    + `(${BENCH_OPTIONS.warmupIterations} warmup + ${BENCH_OPTIONS.iterations} timed); got ${detail}. `
    + 'tinybench changed how time/iterations/warmupTime/warmupIterations are read.',
  );
}

// ---------------------------------------------------------------------------

describe('hook latency (smoke)', () => {
  for (const slotName of SLOT_NAMES) {
    bench(slotName, async () => {
      await spawnSlot(slotName);
    }, { ...BENCH_OPTIONS, setup: () => start() });
  }

  // Last on purpose: the benchmark runner walks tasks in declaration order and
  // awaits each one, so by the time this body runs every spawn above is done.
  // A bench body is the only awaited, throw-reporting hook bench mode offers.
  bench('verdict: guards clean, spawn counts as declared', async () => {
    try {
      if (timedOut.length > 0) {
        throw new Error(`Child had to be killed for: ${[...new Set(timedOut)].join(', ')}`);
      }
      verifyCallCounts();
      await verifyGuards();
    } finally {
      if (sandbox) sandbox.cleanup();
      sandbox = null;
    }
  }, { iterations: 1, warmupIterations: 0, time: 0, warmupTime: 0 });
});
