import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readSpawns } from '../../lib/learning/ledger/spawn-ledger.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';

/**
 * A contended team-state lock must cost the hook its team-state update and
 * nothing else.
 *
 * `withFileLock` is fail-closed (lib/core/file-lock.js): past its wait budget it
 * throws ELOCKTIMEOUT without running the callback. The lock guards ONE file,
 * `~/.claude/artibot-state.json`; the spawn record and the `review.completed`
 * line live in the project's ledgers and never needed it. So a hook that loses
 * the race still writes both, still exits 0 with its usual stdout, and leaves
 * the state file byte-for-byte alone.
 *
 * NO MOCKS. The lock is held by a REAL second process through the real
 * `withFileLock`, so the hook meets a live owner (same host, live pid, fresh
 * record) — the one case the stale-lock reclaim must NOT resolve for it. The
 * positive control runs the same hook with no holder and must see the state
 * change, so "unchanged" above is not an artefact of a hook that never writes.
 *
 * WHAT GREEN HERE DOES NOT PROVE:
 *   - The latency bound is one run on this machine against the hooks.json
 *     5 s timeout; it is not a distribution.
 *   - Contention from more than one holder, or a holder that releases while
 *     the hook is still waiting, is not exercised (file-lock's own suite owns
 *     acquisition behaviour).
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');
const FILE_LOCK_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'core', 'file-lock.js')).href;

const SID = 'sess-lock-timeout';
const AGENT_ID = 'agent-lock-timeout';
const MODEL = 'claude-fable-5-1';

/** SubagentStart/Stop timeout in hooks.json (`"timeout": 5`, seconds). */
const HOOK_BUDGET_MS = 5000;

/** The hook's stdout, which a contended lock must not change (asserted uncontended too). */
const START_STDOUT = `{"message":"[team] Agent registered: ${AGENT_ID} (code-reviewer)"}`;
const STOP_STDOUT = `{"message":"[team] Agent deregistered: ${AGENT_ID}"}`;

/**
 * Holds `withFileLock(target)` until killed: writes a marker once inside the
 * lock, then blocks. The hold is capped under the lock's stale age so a
 * forgotten holder cannot outlive the test either way.
 */
const HOLDER_SRC = [
  `import { writeFileSync } from 'node:fs';`,
  `import { withFileLock } from ${JSON.stringify(FILE_LOCK_URL)};`,
  'withFileLock(process.env.LOCK_TARGET, () => {',
  "  writeFileSync(process.env.LOCK_READY, 'held');",
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 9000);',
  '});',
].join('\n');

/** A valid reviewOutputV2 answer (same shape as subagent-handler-review-writer.test.js). */
function answer() {
  const doc = {
    schema_version: 2,
    verdict: 'PASS',
    findings: [],
    evidence: [{ kind: 'file', file: 'scripts/hooks/subagent-handler.js', line: 1 }],
    recommended_action: 'proceed',
    mission_id: 'M-20260923-001',
    intent_revision: 1,
    plan_revision: 1,
    diff_ref: 'HEAD~1..HEAD',
    test_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    regression_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    verification_id: 'v-lock',
    next_steps: [],
  };
  return ['INSPECTION REPORT', '', '```json', JSON.stringify(doc, null, 2), '```', ''].join('\n');
}

describe('subagent-handler under a held team-state lock (child processes, no mocks)', () => {
  let tmp;
  let home;
  let repo;
  let statePath;
  let transcript;
  let holder;

  /**
   * Run the hook as the dispatcher does. The host's session variables are
   * blanked so a live session id cannot leak into the records.
   */
  function runHook(action, input) {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [HOOK, action], {
      input: JSON.stringify(input), encoding: 'utf-8', env, windowsHide: true, timeout: 20000,
    });
    return {
      status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''),
      elapsedMs: Date.now() - t0,
    };
  }

  function payload(event) {
    return {
      agent_id: AGENT_ID,
      agent_type: 'code-reviewer',
      agent_transcript_path: transcript,
      cwd: repo,
      hook_event_name: event,
      last_assistant_message: answer(),
      prompt_id: 'pid-lock-timeout',
      session_id: SID,
    };
  }

  /** Start the holder and wait until it is inside the lock. */
  async function holdLock() {
    const ready = path.join(tmp, 'holder.ready');
    holder = spawn(process.execPath, ['--input-type=module', '-e', HOLDER_SRC], {
      env: { ...process.env, LOCK_TARGET: statePath, LOCK_READY: ready },
      stdio: 'ignore',
      windowsHide: true,
    });
    const deadline = Date.now() + 10000;
    while (!existsSync(ready)) {
      if (holder.exitCode !== null || Date.now() > deadline) throw new Error('lock holder never acquired');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(`${statePath}.lock`)).toBe(true);
  }

  const stopRecords = () => readSpawns(repo, { sessionId: SID });

  function reviewLines() {
    const file = ledgerFilePath(repo);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => l.event === 'review.completed');
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-lock-timeout-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    statePath = path.join(home, '.claude', 'artibot-state.json');
    transcript = path.join(tmp, `${AGENT_ID}.jsonl`);
    const message = { role: 'assistant', model: MODEL, content: [{ type: 'text', text: answer() }] };
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message })}\n`, 'utf-8');
    holder = null;
  });

  afterEach(async () => {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const exited = new Promise((r) => holder.once('exit', r));
      holder.kill();
      await exited;
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('SubagentStart: skips the state update, still writes the spawn record and its stdout', async () => {
    const seeded = JSON.stringify({ agents: {}, seeded: true });
    writeFileSync(statePath, seeded, 'utf-8');
    await holdLock();

    const res = runHook('start', payload('SubagentStart'));

    expect(res.status).toBe(0);
    expect(stopRecords().filter((r) => r.event === 'start')).toHaveLength(1);
    expect(readFileSync(statePath, 'utf-8')).toBe(seeded);
    expect(res.stdout.trim()).toBe(START_STDOUT);
    expect(res.stderr).toContain('[artibot:subagent-handler] team state not updated: ');
    // It waited out the lock (so the lock really was contended) and still fit the hook budget.
    expect(res.elapsedMs).toBeGreaterThanOrEqual(1900);
    expect(res.elapsedMs).toBeLessThan(HOOK_BUDGET_MS);
  });

  it('SubagentStop: skips the state update, still writes the stop record and review.completed', async () => {
    const startedAt = new Date(Date.now() - 60000).toISOString();
    const seeded = JSON.stringify({
      agents: { [AGENT_ID]: { role: 'teammate', agentType: 'code-reviewer', active: true, startedAt } },
    });
    writeFileSync(statePath, seeded, 'utf-8');
    await holdLock();

    const res = runHook('stop', payload('SubagentStop'));

    expect(res.status).toBe(0);
    expect(reviewLines()).toHaveLength(1);
    expect(reviewLines()[0].data.verdict).toBe('PASS');
    const stops = stopRecords().filter((r) => r.event === 'stop');
    expect(stops).toHaveLength(1);
    // The START fields still reach the record: the state was read, only the write was skipped.
    expect(stops[0].durationMs).toBeGreaterThanOrEqual(60000);
    expect(readFileSync(statePath, 'utf-8')).toBe(seeded);
    expect(res.stdout.trim()).toBe(STOP_STDOUT);
    expect(res.stderr).toContain('[artibot:subagent-handler] team state not updated: ');
    expect(res.elapsedMs).toBeGreaterThanOrEqual(1900);
    expect(res.elapsedMs).toBeLessThan(HOOK_BUDGET_MS);
  });

  it('positive control: with no holder the same runs update the state file', () => {
    const start = runHook('start', payload('SubagentStart'));
    expect(start.status).toBe(0);
    expect(start.stdout.trim()).toBe(START_STDOUT);
    const afterStart = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(afterStart.agents[AGENT_ID].active).toBe(true);

    const stop = runHook('stop', payload('SubagentStop'));
    expect(stop.status).toBe(0);
    expect(stop.stdout.trim()).toBe(STOP_STDOUT);
    const afterStop = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(afterStop.agents[AGENT_ID].active).toBe(false);
    expect(stopRecords().map((r) => r.event)).toEqual(['start', 'stop']);
    expect(reviewLines()).toHaveLength(1);
    expect(existsSync(`${statePath}.lock`)).toBe(false);
  });
});
