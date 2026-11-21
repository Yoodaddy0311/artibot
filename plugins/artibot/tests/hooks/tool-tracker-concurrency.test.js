/**
 * Concurrency regression for the two read-modify-write files the PostToolUse
 * tracker owns (M2, review-fixes 2026-11-21):
 *
 *   - `<state>/runtime/sessions/<id>/loop-state.json` (tool-tracker.js#trackLoop)
 *   - `<state>/tool-history.json` (lib/learning/tool-history.js#saveHistory)
 *
 * The host fires PostToolUse for parallel tool calls at the same time, and each
 * fire is a fresh process. Without a lock every process read the same old file,
 * appended its one entry and wrote — the last writer won, the rest vanished
 * (review measurement: N=16 kept tool-history 1/16, loop-state 3/16).
 *
 * This spawns N real hook processes at once against one throwaway HOME and one
 * session id, and asserts that every one of the N calls survives in both files.
 * N stays at 16 so it fits the loop detector's 20-entry history window.
 *
 * What this does NOT prove: that the lock holds across hosts, or under a load
 * heavy enough to push a waiter past the lock's 2s budget — in that case the
 * hook drops its own update by design (it never overwrites unlocked), and this
 * test would fail. The assertion compares every round at once, so a red diff
 * shows the per-round counts. Latency is not asserted here (measured
 * separately for the review report).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACKER = path.resolve(HERE, '..', '..', 'scripts', 'hooks', 'tool-tracker.js');

const N = 16;
const ROUNDS = 3;
const SESSION = 'concurrency-regression';

/**
 * @param {string} home
 * @param {number} i
 * @returns {Promise<number|null>} exit code
 */
function runOne(home, i) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TRACKER], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    child.on('exit', (code) => resolve(code));
    child.stdin.end(JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: `concurrency-${i}`, output_mode: 'content' },
      tool_response: { mode: 'content', numFiles: 0, filenames: [], content: '', numLines: 0 },
      session_id: SESSION,
    }));
  });
}

/**
 * One round: N simultaneous hooks, then count what each file kept.
 * @returns {Promise<{ history: number, loop: number, codes: Array<number|null> }>}
 */
async function round() {
  const home = mkdtempSync(path.join(tmpdir(), 'tt-conc-'));
  try {
    const codes = await Promise.all(Array.from({ length: N }, (_, i) => runOne(home, i)));
    const state = path.join(home, '.claude', 'artibot');
    const historyFile = path.join(state, 'tool-history.json');
    const loopFile = path.join(state, 'runtime', 'sessions', SESSION, 'loop-state.json');
    const history = existsSync(historyFile)
      ? Object.values(JSON.parse(readFileSync(historyFile, 'utf-8')).contexts || {})
        .reduce((n, rows) => n + rows.length, 0)
      : 0;
    const loop = existsSync(loopFile)
      ? JSON.parse(readFileSync(loopFile, 'utf-8')).history.length
      : 0;
    return { history, loop, codes };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe(`tool-tracker under ${N} concurrent PostToolUse fires`, () => {
  it(`keeps all ${N} calls in tool-history.json and loop-state.json (${ROUNDS} rounds)`, async () => {
    const results = [];
    for (let r = 0; r < ROUNDS; r += 1) results.push(await round());
    // One structural assertion, so a red run's diff shows the loss of every
    // round at once rather than stopping at the first.
    expect(results.map((x) => ({
      exits: x.codes.every((c) => c === 0),
      history: x.history,
      loop: x.loop,
    }))).toEqual(Array.from({ length: ROUNDS }, () => ({ exits: true, history: N, loop: N })));
  }, 120_000);
});
