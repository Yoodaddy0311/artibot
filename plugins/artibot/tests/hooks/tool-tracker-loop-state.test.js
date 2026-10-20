import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoopDetector } from '../../lib/cognitive/loop-detector.js';

/**
 * The loop detector's persisted state follows the state-dir resolver (child process).
 *
 * `scripts/hooks/tool-tracker.js` restores the detector's history from, and flushes it to,
 * `loop-state.json` — `~/.claude/artibot/loop-state.json`, whatever `ARTIBOT_STATE_DIR` said. The
 * flush happens when a loop is detected (or at every 10th call inside one process), so a hooked,
 * non-interactive session handed an override that repeated one tool call wrote the REAL file (found by
 * the 2026-10-20 hook-writer census after the owner's promptfoo PoC; no test covered this file at all).
 *
 * This runs the hook the way the host runs it — `node tool-tracker.js`, a PostToolUse payload on
 * stdin — with the state file pre-seeded by the real detector so that ONE more identical call
 * crosses the warn threshold. That makes a single spawn exercise both directions: the history is
 * RESTORED from the file in force (otherwise the fresh detector sees one call and detects nothing)
 * and FLUSHED back to it (the entry count grows by one).
 *
 * Every case uses a throwaway home; the real one is never touched.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'tool-tracker.js');

const CALL = { tool: 'Read', args: { file_path: path.join(os.tmpdir(), 'loop-subject.js') } };

/**
 * How many identical calls must already be on file for the next one to be flagged. Derived from the
 * detector itself rather than hard-coded, so a retuned warn threshold moves this with it.
 */
const SEEDED = (() => {
  const detector = createLoopDetector();
  let calls = 0;
  do { calls += 1; } while (!detector.detectLoop(CALL).detected);
  return calls - 1;
})();

describe('tool-tracker — loop-state.json follows ARTIBOT_STATE_DIR', () => {
  let tmp;
  let home;
  let stateDir;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-tt-ls-')));
    home = path.join(tmp, 'home');
    stateDir = path.join(tmp, 'state');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const homeFile = () => path.join(home, '.claude', 'artibot', 'loop-state.json');
  const stateFile = () => path.join(stateDir, 'loop-state.json');

  /** A state file holding `SEEDED` identical calls, written the way the hook writes it. */
  function seed(file) {
    const detector = createLoopDetector();
    for (let i = 0; i < SEEDED; i += 1) detector.detectLoop(CALL);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ history: detector.getLoopHistory(), lastUpdated: Date.now() }), 'utf-8');
  }

  /** One firing of the same call; `override` is `undefined` for none, or the `{ dir, mintedFor }` pair. */
  function fire(override) {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ARTIBOT_HOOK_FIRED_DIRECT: 'off',
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    };
    // The host session ids and the state-dir seam must not leak into the child unless a case sets them.
    for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME']) {
      delete env[key];
    }
    if (override) {
      env.ARTIBOT_STATE_DIR = override.dir;
      env.ARTIBOT_STATE_DIR_HOME = override.mintedFor;
    }
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: CALL.tool,
      tool_input: CALL.args,
      tool_response: { content: 'a result that is long enough to count as substantive output' },
      session_id: 'sess-loop-state-sd',
      cwd: tmp,
    };
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env,
      cwd: tmp,
      windowsHide: true,
      timeout: 30000,
    });
    return { status: res.status, stderr: String(res.stderr || '') };
  }

  const history = (file) => JSON.parse(readFileSync(file, 'utf-8')).history;

  it('restores from and flushes to the file inside the override, and leaves ~/.claude alone', () => {
    seed(stateFile());

    const out = fire({ dir: stateDir, mintedFor: home });

    expect(out.status).toBe(0);
    expect(out.stderr).toContain('LOOP WARNING');
    expect(history(stateFile())).toHaveLength(SEEDED + 1);
    expect(existsSync(homeFile())).toBe(false);
  });

  it('keeps using ~/.claude/artibot/loop-state.json when no override is set (production invariance)', () => {
    seed(homeFile());

    const out = fire();

    expect(out.status).toBe(0);
    expect(out.stderr).toContain('LOOP WARNING');
    expect(history(homeFile())).toHaveLength(SEEDED + 1);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    seed(homeFile());

    const out = fire({ dir: stateDir, mintedFor: path.join(tmp, 'some-other-home') });

    expect(out.status).toBe(0);
    expect(out.stderr).toContain('LOOP WARNING');
    expect(history(homeFile())).toHaveLength(SEEDED + 1);
    expect(existsSync(stateFile())).toBe(false);
  });
});
