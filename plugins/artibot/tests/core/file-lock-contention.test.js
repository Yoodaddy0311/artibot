/**
 * Real-process mutual exclusion for withFileLock.
 *
 * `file-lock.test.js` runs inside the vitest process, so it cannot tell
 * whether two processes ever sit inside the locked section together. Every
 * case here runs genuine child processes against a real lock file in a fresh
 * temp dir and observes the outcome:
 *
 *  - contention: N processes x R read-increment-write rounds on one counter
 *    file. Any lost update or any overlap (a second process finding the
 *    in-section marker already present) is a mutual-exclusion failure.
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
 * owns that). Contention is measured at N=4; a larger N or longer sections
 * can push a waiter past LOCK_WAIT_MS, which this file does not probe.
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
 * Contender: waits at the barrier, then runs `rounds` locked
 * read-increment-write cycles on the counter. Inside the section it claims an
 * O_EXCL marker; finding the marker already present means another process is
 * inside too. Prints one JSON line with its own tallies.
 */
const CONTENDER_SOURCE = `
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { withFileLock } from ${JSON.stringify(LOCK_MODULE)};

const cfg = JSON.parse(process.argv[2]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

writeFileSync(cfg.readyPath, String(process.pid));
const deadline = Date.now() + cfg.barrierDeadlineMs;
while (!existsSync(cfg.goPath)) {
  if (Date.now() > deadline) process.exit(98);
  sleep(1);
}

const tally = { overlaps: 0, badReads: 0, writeErrors: 0, maxWaitMs: 0, spans: [] };
for (let i = 0; i < cfg.rounds; i++) {
  const asked = Date.now();
  withFileLock(cfg.counterPath, () => {
    const enter = Date.now();
    tally.maxWaitMs = Math.max(tally.maxWaitMs, enter - asked);
    let marker = null;
    try { marker = openSync(cfg.markerPath, 'wx'); } catch { tally.overlaps++; }
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
    tally.spans.push([enter, Date.now()]);
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
 * Run `processes` contenders against one counter, released together.
 *
 * @param {{ processes: number, rounds: number, holdMs: number, seedLock?: (lockPath: string) => void }} opts
 * @returns {Promise<{ counter: number, expected: number, overlaps: number, badReads: number, writeErrors: number, exits: Array<number|null>, stderr: string[], lockLeft: boolean, overlappingSpans: number, maxWaitMs: number }>}
 */
async function runContention({ processes, rounds, holdMs, seedLock }) {
  const script = path.join(tmpDir, 'contender.mjs');
  await fs.writeFile(script, CONTENDER_SOURCE, 'utf-8');
  const counterPath = path.join(tmpDir, 'counter.txt');
  const lockPath = `${counterPath}.lock`;
  const goPath = path.join(tmpDir, 'go');
  await fs.writeFile(counterPath, '0', 'utf-8');
  if (seedLock) seedLock(lockPath);

  const runs = [];
  for (let i = 0; i < processes; i++) {
    runs.push(spawnChild(script, {
      counterPath,
      markerPath: path.join(tmpDir, 'inside.marker'),
      readyPath: path.join(tmpDir, `ready-${i}`),
      goPath,
      rounds,
      holdMs,
      barrierDeadlineMs: BARRIER_DEADLINE_MS,
    }));
  }
  await waitFor(
    () => runs.every((_, i) => fsSync.existsSync(path.join(tmpDir, `ready-${i}`))),
    BARRIER_DEADLINE_MS,
  );
  await fs.writeFile(goPath, 'go', 'utf-8');
  const results = await Promise.all(runs.map((r) => r.done));

  const tallies = results.map((r) => {
    try { return JSON.parse(r.stdout); } catch { return { overlaps: 0, badReads: 0, writeErrors: 0, spans: [] }; }
  });
  const spans = tallies.flatMap((t) => t.spans.map(([a, b]) => ({ a, b })));
  spans.sort((x, y) => x.a - y.a);
  // A span starting strictly before the latest end seen so far overlaps it
  // (one process's spans are sequential, so the other side is another owner).
  // Same-millisecond boundaries are not evidence of overlap.
  let overlappingSpans = 0;
  let latestEnd = -Infinity;
  for (const span of spans) {
    if (span.a < latestEnd) overlappingSpans++;
    latestEnd = Math.max(latestEnd, span.b);
  }

  return {
    counter: Number.parseInt(fsSync.readFileSync(counterPath, 'utf-8'), 10),
    expected: processes * rounds,
    overlaps: tallies.reduce((s, t) => s + t.overlaps, 0),
    badReads: tallies.reduce((s, t) => s + t.badReads, 0),
    writeErrors: tallies.reduce((s, t) => s + t.writeErrors, 0),
    exits: results.map((r) => r.code),
    stderr: results.map((r) => r.stderr.trim()).filter(Boolean),
    lockLeft: fsSync.existsSync(lockPath),
    overlappingSpans,
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

describe('withFileLock mutual exclusion (real processes)', () => {
  it('N processes x R rounds lose no counter updates and never overlap', async () => {
    const r = await runContention({ processes: 4, rounds: 15, holdMs: 2 });

    // stderr first: an ELOCKTIMEOUT in a child shows up here with its message.
    expect(r.stderr).toEqual([]);
    expect(r.exits).toEqual([0, 0, 0, 0]);
    expect(r.badReads).toBe(0);
    expect(r.writeErrors).toBe(0);
    expect(r.overlaps).toBe(0);
    expect(r.overlappingSpans).toBe(0);
    expect(r.counter).toBe(r.expected);
    expect(r.lockLeft).toBe(false);
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
    expect(r.overlappingSpans).toBe(0);
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

  it.each([
    ['dead-owner JSON', 'json'],
    ['empty', ''],
  ])('reclaims a genuinely stale %s lock well inside the wait budget', async (_label, kind) => {
    const p = probe();
    const content = kind === 'json'
      ? JSON.stringify({ pid: await deadPid(), timestamp: Date.now() - 60_000 })
      : '';
    seedAgedLock(p.lockPath, content, 60_000);

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
