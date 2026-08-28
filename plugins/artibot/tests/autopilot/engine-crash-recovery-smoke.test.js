/**
 * Crash-recovery detector — REAL PATH smoke test.
 *
 * Why this file exists: `engine-recovery.test.js` covered the detector with
 * hand-built fixtures for years while the detector was, in production,
 * unconditionally `{interrupted:false}`. It read `state.timeline`, a field no
 * production code ever appended to, so every one of those green tests proved
 * only that the fixture format parsed. Nothing exercised the path an actual
 * crashed session takes.
 *
 * So this test refuses to build the input. It spawns a **real child process**,
 * runs the **real** `startAutopilot` + `runPhase1Plan`, lets the real `tick()`
 * write real `phase-start` records to the real NDJSON log, and then **SIGKILLs
 * the child while a phase is open** — an uncatchable death with no cleanup,
 * exit handlers, or flush. The parent then reads the session back from disk
 * exactly as `resume` would, and asserts the detector notices.
 *
 * Honest limit: the child chooses the instant it dies. That is the one
 * synthetic element and it is deliberate — a fixture that dies at a
 * *random* moment is flaky, and a phase body here completes in microseconds so
 * there is no window to race into. Everything else (session store, telemetry
 * writer, NDJSON format, file layout, read path) is production code.
 *
 * Platform: CI (Linux) is the source of truth. Local Windows runs under a
 * Korean-character path have a known intermittent vitest collection failure
 * (see MEMORY.md `reference_vitest_korean_path_collection_fail`), unrelated to
 * this logic. The spawn is guarded so an environment without a usable child
 * process reports skip rather than a false red.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildRecoveryNote,
  detectInterruptedPhase,
} from '../../lib/autopilot/_engine-helpers.js';
import { reconcileAttemptOnResume } from '../../lib/autopilot/phase-attempt.js';
import { deleteSessionArtifacts, loadSession } from '../../lib/autopilot/session-store.js';
import { getEventsPath } from '../../lib/autopilot/telemetry.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';

// `fileURLToPath`, never `URL.pathname`: this repo lives under a Korean path
// (`바탕 화면`) and `.pathname` hands back a percent-encoded string. The first
// draft of this file used it, `spawnSync` got a cwd that does not exist, every
// spawn failed, and both tests passed in 5ms without ever starting a child —
// a false green of exactly the kind this file was written to eliminate.
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Sessions created by this file, cleaned up at the end. */
const created = new Set();

// Artifact root for the children. `startAutopilot` runs the real
// `generatePRD`, whose `projectRoot` falls back to the resolved project root
// (`lib/autopilot/prd-generator.js:220`) — so without this every run wrote three
// real files into the developer's `docs/PRD/`. `engine.js:135` forwards
// `state.options.projectRoot` to the generator (and `:561`/`:955` forward the
// same value to `generateReport`), so pointing it at a tmpdir keeps the whole
// artifact side of the engine out of the repo.
//
// It is not artifact-only, though: `resolveLockScope` takes the same value as
// its cwd (`engine.js:618`), and a tmpdir is not a git repo — so the feature
// lock resolves to no repo identity, falls back to its legacy unscoped key, and
// emits one extra `lock-scope-unresolved` event (measured: 4 events with the
// tmpdir root vs 3 with the real one). Harmless here, but do not read
// `projectRoot` as a pure artifact switch.
//
// The assertions are unaffected either way: they read the session and NDJSON
// through `getStoreDir()`, which is independent of this path, and none of them
// count events or assert on the lock.
const ARTIFACT_ROOT = mkdtempSync(path.join(tmpdir(), 'artibot-crash-smoke-'));

/**
 * Child program: real engine, real telemetry, then a hard kill with the
 * EXECUTE phase still open. `process.kill(process.pid, 'SIGKILL')` is used
 * rather than `process.exit()` on purpose — exit() is a *clean* shutdown and
 * would not reproduce a crash.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function crashChildProgram(sessionId) {
  return `
    const { startAutopilot, runPhase1Plan } = await import('./lib/autopilot/engine.js');
    const { loadSession } = await import('./lib/autopilot/session-store.js');
    const { tick } = await import('./lib/autopilot/_engine-helpers.js');
    await startAutopilot({
      task: 'crash recovery smoke',
      mode: 'default',
      options: {
        keepAwake: false, tui: false,
        projectRoot: ${JSON.stringify(ARTIFACT_ROOT)},
      },
      sessionId: ${JSON.stringify(sessionId)},
    });
    const state = loadSession(${JSON.stringify(sessionId)});
    runPhase1Plan(state);
    // Open a phase through the production emitter and never close it.
    tick(state.sessionId, {
      phase: 'EXECUTE', type: 'phase-start', level: 'info',
      message: 'Phase 2 EXECUTE 시작',
    });
    process.kill(process.pid, 'SIGKILL');
  `;
}

/**
 * Run a child program and fail loudly if it could not be started.
 *
 * Deliberately NOT a silent skip. A `return` on spawn failure makes "the
 * environment could not run this" indistinguishable from "the assertion
 * passed", which is how the first draft of this file reported green while
 * never launching a process. If the spawn breaks, this must be red.
 *
 * @param {string} program
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runChild(program) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', program],
    { cwd: PLUGIN_ROOT, encoding: 'utf-8', timeout: 60_000 },
  );
  expect(result.error, `child failed to spawn in ${PLUGIN_ROOT}: ${result.error?.message}`)
    .toBeUndefined();
  return result;
}

afterAll(() => {
  for (const id of created) {
    // Artifacts, not just the session JSON: each case writes a real
    // `.events.ndjson` that `deleteSession` alone would leave in
    // `runtime/autopilot/` forever.
    try { deleteSessionArtifacts(id); } catch { /* best-effort */ }
  }
  rmSync(ARTIFACT_ROOT, { recursive: true, force: true });
});

describe('crash recovery — real session, real NDJSON, real process death', () => {
  it('detects the open phase left behind by a SIGKILLed autopilot process', () => {
    const sessionId = `crash-smoke-${process.pid}-${Date.now()}`;
    created.add(sessionId);

    const child = runChild(crashChildProgram(sessionId));

    // Precondition 1: the child really died, it did not exit cleanly.
    // On POSIX this surfaces as signal SIGKILL; on Windows Node maps the kill
    // to TerminateProcess and reports a non-zero status instead.
    expect(child.status === null || child.status !== 0).toBe(true);

    // Precondition 2: production actually wrote the log we are about to read.
    // Without this the assertion below could pass on an empty file for the
    // wrong reason.
    expect(existsSync(getEventsPath(sessionId))).toBe(true);
    const events = readEvents(sessionId);
    const phaseEvents = events
      .filter((e) => e.type === 'phase-start' || e.type === 'phase-end')
      .map((e) => `${e.type}:${e.phase}`);
    expect(phaseEvents).toContain('phase-start:EXECUTE');
    expect(phaseEvents).not.toContain('phase-end:EXECUTE');

    // The actual subject: resume reads the session from disk and asks.
    const state = loadSession(sessionId);
    expect(state).toBeTruthy();
    const result = detectInterruptedPhase(state);
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe('EXECUTE');
    expect(result.startedAt).toEqual(expect.any(String));

    // And the user-facing banner is produced from the same reading.
    const note = buildRecoveryNote(state);
    expect(note).toContain('이전 세션');
    expect(note).toContain('EXECUTE');
    expect(note).toContain('재진입');
  });

  it('detects a crash between EXECUTE delegation and its acknowledgement', () => {
    // ADR-005 stage 2's existence proof. This case was UNDETECTABLE by stage 1
    // on principle, not by oversight: `runPhase2Execute` used to emit
    // `phase-end` at delegation time, so by the moment the real EXECUTE work
    // began the NDJSON log already showed a cleanly paired phase. Pairing
    // cannot see a crash that happens after the pair is complete.
    //
    // The durable attempt is what closes it: the child hands work out (which
    // now records an open attempt instead of a phase-end) and dies before any
    // result comes back — exactly the sequence a real mid-EXECUTE crash
    // produces.
    const sessionId = `attempt-smoke-${process.pid}-${Date.now()}`;
    created.add(sessionId);

    const child = runChild(`
        const { startAutopilot, runPhase1Plan, runPhase2Execute } = await import('./lib/autopilot/engine.js');
        const { loadSession } = await import('./lib/autopilot/session-store.js');
        await startAutopilot({
          task: 'attempt crash smoke',
          mode: 'default',
          options: {
            keepAwake: false, tui: false,
            projectRoot: ${JSON.stringify(ARTIFACT_ROOT)},
          },
          sessionId: ${JSON.stringify(sessionId)},
        });
        const state = loadSession(${JSON.stringify(sessionId)});
        runPhase1Plan(state);
        runPhase2Execute(state);
        // No recordPhaseResult: the team never reported back.
        process.kill(process.pid, 'SIGKILL');
      `);
    expect(child.status === null || child.status !== 0).toBe(true);

    // Precondition that makes this test meaningful: the log really does NOT
    // look interrupted to stage-1 pairing. If a phase-end for EXECUTE were
    // still written here, this test would pass for the wrong reason.
    const phaseEvents = readEvents(sessionId)
      .filter((e) => e.type === 'phase-start' || e.type === 'phase-end')
      .map((e) => `${e.type}:${e.phase}`);
    expect(phaseEvents).toContain('phase-start:EXECUTE');
    expect(phaseEvents).not.toContain('phase-end:EXECUTE');

    // The durable record survived the kill, unacknowledged.
    const state = loadSession(sessionId);
    expect(state.activePhaseAttempt).toMatchObject({
      phase: 'EXECUTE',
      status: 'started',
    });
    expect(reconcileAttemptOnResume(state)).toMatchObject({ action: 'pause' });
    expect(detectInterruptedPhase(state).interrupted).toBe(true);
  });

  it('reports no interruption for a session whose phases all closed', () => {
    // Negative control on the same real machinery: identical spawn, but the
    // child exits cleanly with every phase closed. If this also returned
    // interrupted:true, the test above would be measuring "a session exists"
    // rather than "a phase was left open".
    const sessionId = `clean-smoke-${process.pid}-${Date.now()}`;
    created.add(sessionId);

    runChild(`
        const { startAutopilot, runPhase1Plan } = await import('./lib/autopilot/engine.js');
        const { loadSession } = await import('./lib/autopilot/session-store.js');
        await startAutopilot({
          task: 'clean shutdown smoke',
          mode: 'default',
          options: {
            keepAwake: false, tui: false,
            projectRoot: ${JSON.stringify(ARTIFACT_ROOT)},
          },
          sessionId: ${JSON.stringify(sessionId)},
        });
        runPhase1Plan(loadSession(${JSON.stringify(sessionId)}));
        process.exit(0);
      `);

    expect(existsSync(getEventsPath(sessionId))).toBe(true);
    const state = loadSession(sessionId);
    expect(detectInterruptedPhase(state)).toEqual({ interrupted: false });
    expect(buildRecoveryNote(state)).toBeNull();
  });
});
