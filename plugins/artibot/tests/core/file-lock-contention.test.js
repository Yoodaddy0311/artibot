/**
 * Real-process mutual exclusion for withFileLock.
 *
 * `file-lock.test.js` runs inside the vitest process, so it cannot tell
 * whether two processes ever sit inside the locked section together. Every
 * case here runs genuine child processes against a real lock file in a fresh
 * temp dir and observes the outcome:
 *
 *  - contention: N processes x R read-increment-write rounds on one counter
 *    file. Any lost update or any overlap is a mutual-exclusion failure.
 *    Overlap is judged two ways, neither by clock: a second process finding
 *    the O_EXCL in-section marker already present, and a break in the strict
 *    E/X alternation of an O_APPEND ledger each holder writes on entry and
 *    exit. A positive control runs the same harness with no lock and asserts
 *    both checks fire.
 *  - a FRESH lock file that is empty or half-written belongs to a holder that
 *    has created it but not finished writing it; a contender must wait.
 *  - a genuinely stale lock (old mtime, old timestamp, dead owner pid) is
 *    reclaimed well inside the wait budget.
 *  - release removes only our own lock: a lock file that another owner put in
 *    place while we were inside the section survives our release.
 *  - several contenders racing to reclaim the same stale lock: exactly one is
 *    inside the section at a time, and every one of them gets in.
 *
 * What this file does NOT cover: SIGKILL/crash mid-section (see
 * file-lock-signal.test.js for signals), network filesystems, and the
 * ELOCKTIMEOUT path for a live holder that never releases (file-lock.test.js
 * owns that), and sustained hot re-locking. The lib keeps no wait queue (its
 * header, "Fairness"), so a process that releases and re-locks at once
 * usually wins again: N contenders each re-locking R times back to back push
 * the last waiter to about (N-1) x R x S of waiting (S = one section), past
 * LOCK_WAIT_MS on a slow run. Before this file yielded, one contender took
 * all 15 rounds in a row in each of 214 measured no-load runs (2026-09-28),
 * and a resulting ELOCKTIMEOUT surfaced as a child's stderr. Production does
 * not re-lock like that: each caller locks once per hook run, or a few times
 * in a row at most (a CAS write, one retry, then a lease claim:
 * recordMissionState in lib/runtime/middleware/tasks.js, feedLimb in
 * scripts/split/task-feed.mjs).
 * So contenders in the contention case sleep 10-25ms (the lib's own poll
 * jitter) outside the lock between rounds, and this file does not probe that
 * pattern. That removes the monopoly and the wait budget it used: in 150
 * no-load runs per arm, the longest same-pid streak went from p50 15 to 4 and
 * the longest successful wait from 1,627 to 1,211ms. It does not make the
 * wait budget safe under sustained machine overload: with 32 CPU spinners
 * both arms failed every run, since each section itself slows down, and that
 * can still push a waiter past LOCK_WAIT_MS. The yield also strengthens the
 * mutual-exclusion check: without it the lock changed hands between
 * processes about 6 times per run (1,263 in 214 runs), with it about 47
 * (7,066 in the 150 no-load yield runs; at most N x R - 1 = 59).
 *
 * How the case pins the yield, without a clock: each contender drops a
 * waiting marker before it asks for the lock and removes it on entry, and on
 * entry records whether another contender's marker was there. In ledger
 * order, an entry by a different pid is a handoff, and an entry by the
 * previous holder while someone was waiting is a retake; a re-entry nobody was
 * waiting for is neither. The case asserts retakes < handoffs AND that no
 * single pid made R - 1 retakes: the ratio alone misses one contender that
 * re-locks all R rounds straight (R - 1 = 14 retakes) while the other three
 * yield and hand off about 45 times. The earlier
 * pin, "no pid took all R rounds in a row", could not tell a monopoly from a
 * contender that had not asked yet: with the yield one process runs its R
 * rounds in about 300ms, so a 300ms stall of the other three after the
 * barrier turned it red with no exclusion fault. A contender stalled before
 * asking holds no marker, so its absence is not counted. Measured 2026-09-28,
 * no load, 25 runs per arm with the markers in place: with the yield retakes
 * 0-3 against handoffs 50-59; without it retakes 39-54 against handoffs 3-6,
 * red in 25 of 25 (the streak pin: 25 of 25). A contested streak with the
 * same threshold was rejected: in 1 of those 25 no-yield runs the first 3
 * re-entries had nobody waiting, and it read 12, not 15.
 * What the pin still cannot absorb: waiters stalled after asking (in the
 * lib's poll sleep) while the holder keeps running count as retakes. One such
 * burst adds at most R - 1 = 14 retakes; red needs retakes to reach the run's
 * handoffs (50-59 above). This was reasoned, not measured under load. The
 * marker check runs after the lock is taken, so a contender that asked just
 * after the holder got in also counts as waiting (more retakes, toward red).
 * The marker I/O throws rather than being swallowed. A swallowed failed write
 * would hide a waiter (fewer retakes, toward green); a swallowed failed unlink
 * would leave a stale marker that reads as a waiter (toward red). Either way
 * the crash lands in the child's stderr. Its cost: an antivirus or indexer
 * holding a marker on Windows can raise EPERM/EBUSY and fail a run with no
 * lock fault; that rate was not measured (none in the 50 runs above).
 *
 * Why no wall-clock spans: an earlier version compared Date.now() [enter,
 * exit] spans across processes. On Windows each process anchors Date.now()
 * at its own start, so processes disagree by a few ms, and a serial handoff
 * can read as an overlap (CI saw overlappingSpans=1 with marker overlaps=0).
 * `wallClockOverlaps` survives only to pin that in a no-process test.
 *
 * What the ledger check cannot see: it assumes each appendFileSync of one
 * short line lands whole and in order on Windows as on POSIX; that is guarded
 * only by the exact line-count assertion (2 x N x R) and by counting any
 * malformed line as a violation, not proven. Under a working lock the appends
 * never race (both are inside the section), so the green path does not rest
 * on that assumption; only a breach or the no-lock control does, and there a
 * torn or lost line turns the check red. The ledger shows order, not
 * duration: E is written after the lock is taken and X before it is released,
 * so an overlap confined to the lock's own acquire/release code is outside
 * it (the marker has the same limit). CI runner timer granularity and clock
 * spread were not measured; this file no longer depends on either.
 *
 * Bounding: children spin on a start barrier with their own deadline, the
 * parent kills any child still alive when a case ends, and each case carries
 * an explicit vitest timeout. Temp dirs are removed in afterEach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE = pathToFileURL(
  path.join(HERE, '..', '..', 'lib', 'core', 'file-lock.js'),
).href;

/** How long a child may wait at the start barrier before giving up. */
const BARRIER_DEADLINE_MS = 20_000;

/** Upper bound on one scenario's wall time before the parent kills it. */
const SCENARIO_DEADLINE_MS = 40_000;

/**
 * Between-round yield bounds (ms) for the contention case: the lib's own poll
 * jitter, LOCK_RETRY_MIN_MS / LOCK_RETRY_MAX_MS at
 * lib/core/file-lock.js:132-133, copied here because the lib does not export
 * them.
 */
const YIELD_MIN_MS = 10;
const YIELD_MAX_MS = 25;

/** Rounds per contender (R) in the contention case; the yield pin derives its cap from it. */
const CONTENTION_ROUNDS = 15;

/**
 * Contender: waits at the barrier, then runs `rounds` locked
 * read-increment-write cycles on the counter. Inside the section it claims an
 * O_EXCL marker; finding the marker already present means another process is
 * inside too. It also appends `E <pid>` as the first and `X <pid>` as the last
 * act of the section to a shared O_APPEND ledger. Prints one JSON line with
 * its own tallies.
 *
 * cfg.jitter ([min, max] ms, optional): before every round but the first,
 * sleep a uniform time in that range outside the lock (see the file header).
 * The wait measured for maxWaitMs starts after that sleep.
 * cfg.waitDir: before asking for the lock it creates a marker named by its
 * pid there, and removes it as it enters. Inside, it records in
 * tally.contested whether another contender's marker was present.
 * cfg.noLock (positive control only): run the section with no lock at all.
 * cfg.arriveDir (positive control only): after claiming the marker, wait until
 * cfg.processes contenders are inside, so the breach is certain, not likely.
 */
const CONTENDER_SOURCE = `
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(process.argv[2]);
const { withFileLock } = cfg.noLock
  ? { withFileLock: (_p, fn) => fn() }
  : await import(${JSON.stringify(LOCK_MODULE)});
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

writeFileSync(cfg.readyPath, String(process.pid));
const deadline = Date.now() + cfg.barrierDeadlineMs;
while (!existsSync(cfg.goPath)) {
  if (Date.now() > deadline) process.exit(98);
  sleep(1);
}

const tally = { pid: String(process.pid), overlaps: 0, badReads: 0, writeErrors: 0, maxWaitMs: 0, contested: [] };
const waitingMarker = cfg.waitDir ? join(cfg.waitDir, String(process.pid)) : null;
for (let i = 0; i < cfg.rounds; i++) {
  if (i > 0 && cfg.jitter) sleep(cfg.jitter[0] + Math.random() * (cfg.jitter[1] - cfg.jitter[0]));
  if (waitingMarker) writeFileSync(waitingMarker, '');
  const asked = Date.now();
  withFileLock(cfg.counterPath, () => {
    appendFileSync(cfg.ledgerPath, 'E ' + process.pid + '\\n');
    if (waitingMarker) {
      unlinkSync(waitingMarker);
      tally.contested.push(readdirSync(cfg.waitDir).some((name) => name !== tally.pid));
    }
    const enter = Date.now();
    tally.maxWaitMs = Math.max(tally.maxWaitMs, enter - asked);
    let marker = null;
    try { marker = openSync(cfg.markerPath, 'wx'); } catch { tally.overlaps++; }
    if (cfg.arriveDir) {
      writeFileSync(join(cfg.arriveDir, String(process.pid)), '');
      while (readdirSync(cfg.arriveDir).length < cfg.processes) {
        if (Date.now() > deadline) process.exit(97);
        sleep(1);
      }
    }
    let n = NaN;
    try { n = Number.parseInt(readFileSync(cfg.counterPath, 'utf-8'), 10); } catch { /* counted below */ }
    if (!Number.isFinite(n)) {
      tally.badReads++;
    } else {
      if (cfg.holdMs > 0) sleep(cfg.holdMs);
      try { writeFileSync(cfg.counterPath, String(n + 1)); } catch { tally.writeErrors++; }
    }
    if (marker !== null) {
      closeSync(marker);
      try { unlinkSync(cfg.markerPath); } catch { /* next claimant reports it */ }
    }
    appendFileSync(cfg.ledgerPath, 'X ' + process.pid + '\\n');
  });
}
process.stdout.write(JSON.stringify(tally));
`;

/**
 * Single-shot probe: announces it is about to lock, then records when it got
 * in. Used for the fresh-lock, stale-lock and own-token cases.
 * cfg.replaceWith (optional): inside the section, remove the lock file and
 * create a foreign one in its place — what a second owner would do after
 * judging ours stale.
 */
const PROBE_SOURCE = `
import { closeSync, openSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { withFileLock } from ${JSON.stringify(LOCK_MODULE)};

const cfg = JSON.parse(process.argv[2]);
const lockPath = cfg.targetPath + '.lock';
writeFileSync(cfg.readyPath, String(Date.now()));
const t0 = Date.now();
withFileLock(cfg.targetPath, () => {
  writeFileSync(cfg.enteredPath, String(Date.now() - t0));
  if (cfg.replaceWith) {
    unlinkSync(lockPath);
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, cfg.replaceWith);
    closeSync(fd);
  }
});
process.stdout.write('RELEASED');
`;

let tmpDir;
let liveChildren;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artibot-lockrace-'));
  liveChildren = new Set();
});

afterEach(async () => {
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  liveChildren.clear();
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Spawn a node child running `source` with one JSON argv, tracked for cleanup.
 *
 * @param {string} scriptPath
 * @param {object} cfg
 * @returns {{ child: import('node:child_process').ChildProcess, done: Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string }> }}
 */
function spawnChild(scriptPath, cfg) {
  const child = spawn(process.execPath, [scriptPath, JSON.stringify(cfg)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });
  const done = new Promise((resolve, reject) => {
    const killer = setTimeout(() => child.kill('SIGKILL'), SCENARIO_DEADLINE_MS);
    child.on('error', (err) => { clearTimeout(killer); reject(err); });
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      liveChildren.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}

/**
 * Resolve once `predicate()` is true, or reject after `timeoutMs`.
 *
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The retired wall-clock check: a span starting strictly before the latest
 * end seen so far overlaps it. Kept only so a test can pin why it was
 * retired — spans from different processes carry different clocks.
 *
 * @param {Array<[number, number]>} spans [enter, exit] Date.now() pairs
 * @returns {number}
 */
function wallClockOverlaps(spans) {
  const sorted = [...spans].sort((x, y) => x[0] - y[0]);
  let overlapping = 0;
  let latestEnd = -Infinity;
  for (const [enter, exit] of sorted) {
    if (enter < latestEnd) overlapping++;
    latestEnd = Math.max(latestEnd, exit);
  }
  return overlapping;
}

/**
 * Count breaks in strict alternation `E p, X p, E q, X q, ...` of the section
 * ledger: an entry while another holder is inside, an exit by a pid that is
 * not the open holder, an exit with nothing open, a line that is neither, and
 * a holder still open at the end. The order is the file's append order, so no
 * clock is involved.
 *
 * @param {string[]} lines ledger lines without their trailing newline
 * @returns {number}
 */
function ledgerViolations(lines) {
  let open = null;
  let violations = 0;
  for (const line of lines) {
    const [kind, pid, extra] = line.split(' ');
    if (!pid || extra !== undefined) {
      violations++;
    } else if (kind === 'E') {
      if (open !== null) violations++;
      open = pid;
    } else if (kind === 'X') {
      if (open !== pid) violations++;
      open = null;
    } else {
      violations++;
    }
  }
  if (open !== null) violations++;
  return violations;
}

/**
 * Classify every ledger entry after the first, in append order: a handoff
 * when the lock went to a different pid, a retake when the previous holder
 * took it again while another contender was waiting for it. A re-entry that
 * nobody else was waiting for is neither — there was no one to hand it to.
 *
 * @param {string[]} lines ledger lines without their trailing newline
 * @param {Record<string, boolean[]>} contestedByPid per pid, one flag per
 *   entry of that pid in order: was another contender waiting when it got in.
 *   A missing flag counts as waiting, toward a retake.
 * @returns {{ handoffs: number, retakes: number, retakesByPid: Record<string, number> }}
 */
function ledgerHandoffs(lines, contestedByPid) {
  const entriesSeen = {};
  const retakesByPid = {};
  let last = null;
  let handoffs = 0;
  let retakes = 0;
  for (const line of lines) {
    const [kind, pid] = line.split(' ');
    if (kind !== 'E') continue;
    const k = entriesSeen[pid] ?? 0;
    entriesSeen[pid] = k + 1;
    if (last !== null && pid !== last) {
      handoffs++;
    } else if (pid === last && (contestedByPid[pid]?.[k] ?? true)) {
      retakes++;
      retakesByPid[pid] = (retakesByPid[pid] ?? 0) + 1;
    }
    last = pid;
  }
  return { handoffs, retakes, retakesByPid };
}

/**
 * The yield pin: the lock changed hands more often than holders re-took it
 * over a waiter, and no one pid re-took it R - 1 times — what a single
 * contender re-locking all R rounds straight over waiters would do.
 *
 * @param {{ handoffs: number, retakes: number, retakesByPid: Record<string, number> }} turns
 * @param {number} rounds R, rounds per contender
 * @returns {boolean}
 */
function yieldHandsOn(turns, rounds) {
  const worstPid = Math.max(0, ...Object.values(turns.retakesByPid));
  return turns.retakes < turns.handoffs && worstPid < rounds - 1;
}

/**
 * Split a ledger file into lines; a missing file is an empty ledger.
 *
 * @param {string} ledgerPath
 * @returns {string[]}
 */
function readLedger(ledgerPath) {
  if (!fsSync.existsSync(ledgerPath)) return [];
  const lines = fsSync.readFileSync(ledgerPath, 'utf-8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Run `processes` contenders against one counter, released together.
 * `noLock` + `inSectionBarrier` turn the run into a positive control: no lock,
 * and every contender waits inside the section until all of them are there.
 *
 * `jitter` ([min, max] ms) makes each contender yield outside the lock between
 * rounds.
 *
 * @param {{ processes: number, rounds: number, holdMs: number, jitter?: [number, number]|null, seedLock?: (lockPath: string) => void, noLock?: boolean, inSectionBarrier?: boolean }} opts
 * @returns {Promise<{ counter: number, expected: number, overlaps: number, badReads: number, writeErrors: number, exits: Array<number|null>, stderr: string[], lockLeft: boolean, ledgerLines: number, ledgerViolations: number, ledgerTurns: ReturnType<typeof ledgerHandoffs>, maxWaitMs: number }>}
 */
async function runContention({ processes, rounds, holdMs, jitter = null, seedLock, noLock = false, inSectionBarrier = false }) {
  const script = path.join(tmpDir, 'contender.mjs');
  await fs.writeFile(script, CONTENDER_SOURCE, 'utf-8');
  const counterPath = path.join(tmpDir, 'counter.txt');
  const lockPath = `${counterPath}.lock`;
  const goPath = path.join(tmpDir, 'go');
  const ledgerPath = path.join(tmpDir, 'section.ledger');
  const arriveDir = inSectionBarrier ? path.join(tmpDir, 'arrived') : null;
  const waitDir = path.join(tmpDir, 'waiting');
  await fs.writeFile(counterPath, '0', 'utf-8');
  if (arriveDir) await fs.mkdir(arriveDir);
  await fs.mkdir(waitDir);
  if (seedLock) seedLock(lockPath);

  const runs = [];
  for (let i = 0; i < processes; i++) {
    runs.push(spawnChild(script, {
      counterPath,
      markerPath: path.join(tmpDir, 'inside.marker'),
      ledgerPath,
      readyPath: path.join(tmpDir, `ready-${i}`),
      goPath,
      rounds,
      holdMs,
      jitter,
      barrierDeadlineMs: BARRIER_DEADLINE_MS,
      noLock,
      arriveDir,
      waitDir,
      processes,
    }));
  }
  await waitFor(
    () => runs.every((_, i) => fsSync.existsSync(path.join(tmpDir, `ready-${i}`))),
    BARRIER_DEADLINE_MS,
  );
  await fs.writeFile(goPath, 'go', 'utf-8');
  const results = await Promise.all(runs.map((r) => r.done));

  const tallies = results.map((r) => {
    try { return JSON.parse(r.stdout); } catch { return { overlaps: 0, badReads: 0, writeErrors: 0 }; }
  });
  const ledger = readLedger(ledgerPath);
  const turns = ledgerHandoffs(ledger, Object.fromEntries(tallies.map((t) => [t.pid, t.contested])));

  return {
    counter: Number.parseInt(fsSync.readFileSync(counterPath, 'utf-8'), 10),
    expected: processes * rounds,
    overlaps: tallies.reduce((s, t) => s + t.overlaps, 0),
    badReads: tallies.reduce((s, t) => s + t.badReads, 0),
    writeErrors: tallies.reduce((s, t) => s + t.writeErrors, 0),
    exits: results.map((r) => r.code),
    stderr: results.map((r) => r.stderr.trim()).filter(Boolean),
    lockLeft: fsSync.existsSync(lockPath),
    ledgerLines: ledger.length,
    ledgerViolations: ledgerViolations(ledger),
    ledgerTurns: turns,
    maxWaitMs: Math.max(0, ...tallies.map((t) => t.maxWaitMs ?? 0)),
  };
}

/**
 * Pid of a process that has already exited — a dead owner for stale locks.
 *
 * @returns {Promise<number>}
 */
async function deadPid() {
  const script = path.join(tmpDir, 'noop.mjs');
  await fs.writeFile(script, '', 'utf-8');
  const { child, done } = spawnChild(script, {});
  await done;
  return child.pid;
}

/**
 * Write a lock file whose mtime and recorded timestamp are both `ageMs` old.
 *
 * @param {string} lockPath
 * @param {string} content
 * @param {number} ageMs
 */
function seedAgedLock(lockPath, content, ageMs) {
  fsSync.writeFileSync(lockPath, content);
  const when = new Date(Date.now() - ageMs);
  fsSync.utimesSync(lockPath, when, when);
}

describe('overlap analyzers (no processes)', () => {
  /**
   * Strictly serial holders in true time, each stamped by its own clock.
   *
   * @param {string[]} pids round-robin order of holders
   * @param {number} rounds
   * @param {number} holdMs true time each holder spends inside
   * @param {Record<string, number>} offsetMs per-process Date.now() offset
   * @returns {{ spans: Array<[number, number]>, lines: string[] }}
   */
  function serialHolders(pids, rounds, holdMs, offsetMs) {
    const spans = [];
    const lines = [];
    let t = 1000;
    for (let r = 0; r < rounds; r++) {
      for (const pid of pids) {
        spans.push([t + offsetMs[pid], t + holdMs + offsetMs[pid]]);
        lines.push(`E ${pid}`, `X ${pid}`);
        t += holdMs;
      }
    }
    return { spans, lines };
  }

  it('CI signature: skewed clocks make the wall-clock check red, the ledger stays green', () => {
    // B entered after A left, but B's clock runs 1ms behind A's.
    expect(wallClockOverlaps([[100, 103], [102, 106]])).toBe(1);
    expect(ledgerViolations(['E A', 'X A', 'E B', 'X B'])).toBe(0);
  });

  it('per-process clock offsets alone produce wall-clock "overlaps" on a serial run', () => {
    const pids = ['A', 'B', 'C', 'D'];
    const same = serialHolders(pids, 15, 3, { A: 0, B: 0, C: 0, D: 0 });
    const skewed = serialHolders(pids, 15, 3, { A: 0, B: 5, C: 2, D: 7 });

    expect(wallClockOverlaps(same.spans)).toBe(0);
    expect(wallClockOverlaps(skewed.spans)).toBeGreaterThan(0);
    expect(ledgerViolations(skewed.lines)).toBe(0);
  });

  it('counts an entry while another holder is inside', () => {
    // E B while A open, X A while B open, X B with nothing open.
    expect(ledgerViolations(['E A', 'E B', 'X A', 'X B'])).toBe(3);
  });

  it('counts an exit by a pid that is not the open holder', () => {
    expect(ledgerViolations(['E A', 'X B'])).toBe(1);
  });

  it('counts an exit with nothing open', () => {
    expect(ledgerViolations(['X A'])).toBe(1);
    expect(ledgerViolations(['E A', 'X A', 'X A'])).toBe(1);
  });

  it('counts a holder still open at the end (truncated ledger)', () => {
    // The line-count assertion in the harness catches this too (3 != 4).
    expect(ledgerViolations(['E A', 'X A', 'E B'])).toBe(1);
  });

  it('counts a line that is neither an entry nor an exit (torn append)', () => {
    expect(ledgerViolations(['E A', 'X', 'E B', 'X B'])).toBeGreaterThan(0);
    expect(ledgerViolations(['E A', 'garbage', 'X A'])).toBe(1);
  });

  it('counts a change of holder as a handoff and a re-entry over a waiter as a retake', () => {
    const lines = ['E A', 'X A', 'E A', 'X A', 'E B', 'X B', 'E B', 'X B', 'E A', 'X A'];
    // A's second entry had a waiter, B's second did not.
    expect(ledgerHandoffs(lines, { A: [false, true, true], B: [true, false] }))
      .toEqual({ handoffs: 2, retakes: 1, retakesByPid: { A: 1 } });
  });

  it('does not count a holder that runs alone as a monopoly', () => {
    // A takes all its rounds before anyone else asks: the stall signature.
    const R = CONTENTION_ROUNDS;
    const lines = [...Array.from({ length: R }, () => ['E A', 'X A']).flat(), 'E B', 'X B'];
    const turns = ledgerHandoffs(lines, { A: Array(R).fill(false), B: [false] });
    expect(turns).toEqual({ handoffs: 1, retakes: 0, retakesByPid: {} });
    expect(yieldHandsOn(turns, R)).toBe(true);
  });

  it('catches one contender re-locking all R rounds over waiters while the rest hand off', () => {
    // A never yields: R entries straight, waiters present from its second on.
    // B, C, D then take turns, one handoff per entry.
    const R = CONTENTION_ROUNDS;
    const straight = Array.from({ length: R }, () => ['E A', 'X A']).flat();
    const rotating = Array.from({ length: R }, () => ['B', 'C', 'D'].map((p) => [`E ${p}`, `X ${p}`]).flat()).flat();
    const turns = ledgerHandoffs([...straight, ...rotating], {
      A: [false, ...Array(R - 1).fill(true)], B: Array(R).fill(true), C: Array(R).fill(true), D: Array(R).fill(true),
    });
    expect(turns).toEqual({ handoffs: 3 * R, retakes: R - 1, retakesByPid: { A: R - 1 } });
    // The ratio alone passes it; the per-pid cap does not.
    expect(turns.retakes).toBeLessThan(turns.handoffs);
    expect(yieldHandsOn(turns, R)).toBe(false);
  });

  it('counts a re-entry with no recorded flag as a retake', () => {
    expect(ledgerHandoffs(['E A', 'X A', 'E A', 'X A'], {}))
      .toEqual({ handoffs: 0, retakes: 1, retakesByPid: { A: 1 } });
  });
});

describe('withFileLock mutual exclusion (real processes)', () => {
  it('N processes x R rounds lose no counter updates and never overlap', async () => {
    const r = await runContention({
      processes: 4, rounds: CONTENTION_ROUNDS, holdMs: 2, jitter: [YIELD_MIN_MS, YIELD_MAX_MS],
    });

    // stderr first: an ELOCKTIMEOUT in a child shows up here with its message.
    expect(r.stderr).toEqual([]);
    expect(r.exits).toEqual([0, 0, 0, 0]);
    expect(r.badReads).toBe(0);
    expect(r.writeErrors).toBe(0);
    expect(r.overlaps).toBe(0);
    expect(r.ledgerLines).toBe(2 * r.expected);
    expect(r.ledgerViolations).toBe(0);
    // The yield hands the lock on: holders re-took it over a waiting contender
    // less often than it changed hands, and no one pid re-took it R - 1 times.
    // Without the yield both fail in every measured run. See the header.
    expect(yieldHandsOn(r.ledgerTurns, CONTENTION_ROUNDS), JSON.stringify(r.ledgerTurns)).toBe(true);
    expect(r.counter).toBe(r.expected);
    expect(r.lockLeft).toBe(false);
  }, 60_000);

  it('positive control: with no lock, both overlap checks catch contenders inside together', async () => {
    // Every contender claims the marker, then waits in the section until all
    // four are there (bounded by BARRIER_DEADLINE_MS, exit 97 past it). So all
    // four E lines precede every X line, and the three non-first claimants
    // each find the marker held.
    const r = await runContention({
      processes: 4, rounds: 1, holdMs: 0, noLock: true, inSectionBarrier: true,
    });

    expect(r.stderr).toEqual([]);
    expect(r.exits).toEqual([0, 0, 0, 0]);
    expect(r.ledgerLines).toBe(2 * r.expected);
    // Four E lines before any X: 3 entries-while-open, then every X after the
    // first finds nothing open (3), plus 1 if the first X is not the last E's pid.
    expect(r.ledgerViolations).toBeGreaterThanOrEqual(6);
    expect(r.overlaps).toBe(3);
  }, 60_000);

  it('racing reclaim of one stale lock admits one contender at a time', async () => {
    const pid = await deadPid();
    const r = await runContention({
      processes: 4,
      rounds: 1,
      holdMs: 150,
      seedLock: (lockPath) => seedAgedLock(
        lockPath,
        JSON.stringify({ pid, timestamp: Date.now() - 60_000 }),
        60_000,
      ),
    });

    expect(r.exits).toEqual([0, 0, 0, 0]);
    expect(r.overlaps).toBe(0);
    expect(r.ledgerLines).toBe(2 * r.expected);
    expect(r.ledgerViolations).toBe(0);
    expect(r.counter).toBe(4);
    expect(r.lockLeft).toBe(false);
  }, 60_000);
});

describe('withFileLock lock-file ownership (real processes)', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(tmpDir, 'probe.mjs'), PROBE_SOURCE, 'utf-8');
  });

  /**
   * @param {object} [extra]
   * @returns {{ targetPath: string, lockPath: string, readyPath: string, enteredPath: string, run: () => ReturnType<typeof spawnChild> }}
   */
  function probe(extra = {}) {
    const targetPath = path.join(tmpDir, 'state.json');
    const cfg = {
      targetPath,
      readyPath: path.join(tmpDir, 'probe-ready'),
      enteredPath: path.join(tmpDir, 'probe-entered'),
      ...extra,
    };
    return {
      ...cfg,
      lockPath: `${targetPath}.lock`,
      run: () => spawnChild(path.join(tmpDir, 'probe.mjs'), cfg),
    };
  }

  it.each([
    ['empty', ''],
    ['half-written', '{"pid":12'],
  ])('does not steal a fresh %s lock file — waits for the holder', async (_label, content) => {
    const p = probe();
    fsSync.writeFileSync(p.lockPath, content);

    const { done } = p.run();
    await waitFor(() => fsSync.existsSync(p.readyPath), BARRIER_DEADLINE_MS);
    await sleep(700);

    // The holder is still mid-write: the contender must not be inside, and
    // must not have removed the holder's file.
    expect(fsSync.existsSync(p.enteredPath)).toBe(false);
    expect(fsSync.existsSync(p.lockPath)).toBe(true);

    // Holder releases; the contender now gets in.
    fsSync.unlinkSync(p.lockPath);
    const result = await done;
    expect(result.code).toBe(0);
    expect(fsSync.existsSync(p.enteredPath)).toBe(true);
    expect(fsSync.existsSync(p.lockPath)).toBe(false);
  }, 60_000);

  // Each seed is stale by exactly one rule, so each rule is exercised alone:
  // a fresh timestamp from this host with a dead pid; an old timestamp from
  // another host (pid liveness is not consulted); an unparseable file by mtime.
  it.each([
    ['dead-owner (this host, fresh timestamp)', async () => JSON.stringify({
      pid: await deadPid(), host: os.hostname(), token: 'dead', timestamp: Date.now(),
    })],
    ['old-timestamp (other host)', async () => JSON.stringify({
      pid: process.pid, host: 'elsewhere', token: 'old', timestamp: Date.now() - 60_000,
    })],
    ['empty (old mtime)', async () => ''],
  ])('reclaims a genuinely stale %s lock well inside the wait budget', async (_label, makeContent) => {
    const p = probe();
    seedAgedLock(p.lockPath, await makeContent(), 60_000);

    const result = await p.run().done;

    expect(result.code).toBe(0);
    // Waited-for ms, recorded by the child. Half of LOCK_WAIT_MS (2s): a
    // reclaim is immediate, not a wait that happens to fit the budget.
    const waitedMs = Number(fsSync.readFileSync(p.enteredPath, 'utf-8'));
    expect(waitedMs).toBeLessThan(1000);
    expect(fsSync.existsSync(p.lockPath)).toBe(false);
  }, 60_000);

  it('release leaves a lock file that another owner put in place', async () => {
    const foreign = JSON.stringify({ pid: 424242, nonce: 'someone-else', timestamp: Date.now() });
    const p = probe({ replaceWith: foreign });

    const result = await p.run().done;

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('RELEASED');
    expect(fsSync.existsSync(p.lockPath)).toBe(true);
    expect(fsSync.readFileSync(p.lockPath, 'utf-8')).toBe(foreign);
  }, 60_000);
});
