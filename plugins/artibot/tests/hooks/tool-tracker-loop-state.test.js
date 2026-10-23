import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoopDetector } from '../../lib/cognitive/loop-detector.js';

/**
 * The loop detector's persisted state, run the way the host runs the hook: one
 * `node tool-tracker.js` process per PostToolUse payload on stdin.
 *
 * WHERE THE FILE IS. `scripts/hooks/tool-tracker.js` restores the detector's history
 * from, and flushes it to, a `loop-state.json` that is SESSION-scoped when the payload
 * carries a `session_id` — `<state dir>/runtime/sessions/<session_id>/loop-state.json`,
 * the O2 layout of `lib/core/runtime-state.js#resolveScopedStatePath` — and the flat
 * `<state dir>/loop-state.json` (pre-O2 location, byte-identical) when it does not.
 * `<state dir>` is `~/.claude/artibot`, or `ARTIBOT_STATE_DIR` when that override is
 * paired with the home in force (`lib/core/config.js#resolveArtibotDir`).
 *
 * WHY COLD START IS TESTED. Until 2026-10-23 the flush ran only when a loop was
 * detected or on the 10th call of ONE process, and the hook is a new process per call
 * — so on a fresh machine the file was never created, the history never grew past one
 * entry, and the detector could not fire (EXP-A of
 * `.artibot/guides/v5-design/practicality-improvement-20261023/04_VALIDATION_REPORT.md`
 * §7: 6 identical calls, no file, no warning; the owner's PC had no file either,
 * NEXT-SESSION 2026-10-20). The pre-seeded cases below were the only coverage and
 * stayed green through that: a seeded file hides the cold start. The cold-start cases
 * are the ones that were RED before the fix.
 *
 * Every case uses a throwaway home; the real one is never touched. The host session
 * ids and the state-dir seam the vitest setup exports are stripped from the child env
 * unless a case sets them, so each case decides its own layout.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'tool-tracker.js');

const SUBJECT = path.join(os.tmpdir(), 'loop-subject.js');
const CALL = { tool: 'Read', args: { file_path: SUBJECT } };
const SESSION = 'sess-loop-state-sd';

/**
 * How many identical calls must already be on file for the next one to be flagged
 * `warn`, and how many identical calls in total reach `block`. Both derived from the
 * detector itself rather than hard-coded, so a retuned threshold moves them.
 */
const { SEEDED, BLOCK } = (() => {
  const detector = createLoopDetector();
  let calls = 0;
  let firstDetected = null;
  for (;;) {
    calls += 1;
    const r = detector.detectLoop(CALL);
    if (r.detected && firstDetected === null) firstDetected = calls;
    if (r.severity === 'block') return { SEEDED: firstDetected - 1, BLOCK: calls };
  }
})();

describe('tool-tracker — loop-state.json: session-scoped, flushed every call', () => {
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

  /** The state dir the hook resolves without an override: `<home>/.claude/artibot`. */
  const homeRoot = () => path.join(home, '.claude', 'artibot');
  /** Session-scoped file under a state root (O2 layout). */
  const sessionFile = (root, sid = SESSION) => path.join(root, 'runtime', 'sessions', sid, 'loop-state.json');
  /** The flat, sessionless file under a state root (pre-O2 location, unchanged). */
  const flatFile = (root) => path.join(root, 'loop-state.json');

  /** A state file holding `n` identical calls, written the way the hook writes it. */
  function seed(file, n = SEEDED, extra = {}) {
    const detector = createLoopDetector();
    for (let i = 0; i < n; i += 1) detector.detectLoop(CALL);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ history: detector.getLoopHistory(), lastUpdated: Date.now(), ...extra }), 'utf-8');
  }

  /**
   * One firing of the hook.
   * @param {{ dir: string, mintedFor: string } | undefined} override the state-dir pair, or none
   * @param {object} [payloadPatch] fields merged over the default payload (`session_id: null` removes it)
   */
  function fire(override, payloadPatch = {}) {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ARTIBOT_HOOK_FIRED_DIRECT: 'off',
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    };
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
      session_id: SESSION,
      cwd: tmp,
      ...payloadPatch,
    };
    if (payload.session_id === null) delete payload.session_id;
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env,
      cwd: tmp,
      windowsHide: true,
      timeout: 30000,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  /** Fire `n` times; returns the LAST result. */
  function fireTimes(n, override, payloadPatch) {
    let last = null;
    for (let i = 0; i < n; i += 1) {
      last = fire(override, payloadPatch);
      expect(last.status, `spawn ${i + 1}/${n} stderr: ${last.stderr}`).toBe(0);
    }
    return last;
  }

  const read = (file) => JSON.parse(readFileSync(file, 'utf-8'));
  const history = (file) => read(file).history;

  describe('the state-dir override (intents unchanged since v4.71.11, layout now per session)', () => {
    it('restores from and flushes to the file inside the override, and leaves ~/.claude alone', () => {
      seed(sessionFile(stateDir));

      const out = fire({ dir: stateDir, mintedFor: home });

      expect(out.status).toBe(0);
      expect(out.stderr).toContain('LOOP WARNING');
      expect(history(sessionFile(stateDir))).toHaveLength(SEEDED + 1);
      expect(existsSync(homeRoot())).toBe(false);
    });

    it('keeps using <home>/.claude/artibot when no override is set (production invariance)', () => {
      seed(sessionFile(homeRoot()));

      const out = fire();

      expect(out.status).toBe(0);
      expect(out.stderr).toContain('LOOP WARNING');
      expect(history(sessionFile(homeRoot()))).toHaveLength(SEEDED + 1);
      expect(existsSync(stateDir)).toBe(false);
    });

    it('ignores an override minted for another home (a child handed its own HOME)', () => {
      seed(sessionFile(homeRoot()));

      const out = fire({ dir: stateDir, mintedFor: path.join(tmp, 'some-other-home') });

      expect(out.status).toBe(0);
      expect(out.stderr).toContain('LOOP WARNING');
      expect(history(sessionFile(homeRoot()))).toHaveLength(SEEDED + 1);
      expect(existsSync(stateDir)).toBe(false);
    });
  });

  describe('cold start — no file anywhere, one process per call (RED before 2026-10-23)', () => {
    it(`creates the file on the first call and warns on call ${SEEDED + 1}`, () => {
      const first = fire();
      expect(first.status).toBe(0);
      expect(existsSync(sessionFile(homeRoot())), 'first call must flush').toBe(true);
      expect(history(sessionFile(homeRoot()))).toHaveLength(1);
      expect(first.stderr).not.toContain('LOOP');

      const last = fireTimes(SEEDED, undefined);
      expect(last.stderr).toContain('LOOP WARNING');
      expect(history(sessionFile(homeRoot()))).toHaveLength(SEEDED + 1);
    });

    it(`reaches the block label on call ${BLOCK}`, () => {
      const last = fireTimes(BLOCK, undefined);
      expect(last.stderr).toContain('LOOP BLOCKED');
      expect(last.stderr).toContain(`called ${BLOCK}x`);
    });

    it('keeps sessions apart: a repeat in session A says nothing about session B', () => {
      const a = fireTimes(SEEDED + 1, undefined, { session_id: 'sess-A' });
      expect(a.stderr).toContain('LOOP WARNING');

      const b = fire(undefined, { session_id: 'sess-B' });
      expect(b.status).toBe(0);
      expect(b.stderr).not.toContain('LOOP');
      expect(history(sessionFile(homeRoot(), 'sess-B'))).toHaveLength(1);
      expect(history(sessionFile(homeRoot(), 'sess-A'))).toHaveLength(SEEDED + 1);
    });

    it('a payload with no session_id uses the flat file, where it always was', () => {
      const out = fire(undefined, { session_id: null });
      expect(out.status).toBe(0);
      expect(existsSync(flatFile(homeRoot()))).toBe(true);
      expect(history(flatFile(homeRoot()))).toHaveLength(1);
      expect(existsSync(path.join(homeRoot(), 'runtime', 'sessions'))).toBe(false);
    });
  });

  describe('detections — what the file records about a detected loop (D-02 stage 1)', () => {
    it('appends one detection row per detected call, with a hashed fingerprint and no raw arguments', () => {
      fireTimes(SEEDED + 1, undefined);
      const state = read(sessionFile(homeRoot()));

      expect(Array.isArray(state.detections)).toBe(true);
      expect(state.detections).toHaveLength(1);
      const [row] = state.detections;
      expect(Object.keys(row).sort()).toEqual(['count', 'fingerprint_sha12', 'severity', 'tool', 'ts']);
      expect(row.tool).toBe('Read');
      expect(row.severity).toBe('warn');
      expect(row.count).toBe(SEEDED + 1);
      expect(row.fingerprint_sha12).toMatch(/^[0-9a-f]{12}$/);
      expect(typeof row.ts).toBe('number');
      expect(JSON.stringify(state.detections)).not.toContain(SUBJECT);
    });

    it('a file written before detections existed is still restored, and gains the field', () => {
      seed(sessionFile(homeRoot()));
      expect(read(sessionFile(homeRoot())).detections).toBeUndefined();

      const out = fire();

      expect(out.stderr).toContain('LOOP WARNING');
      const state = read(sessionFile(homeRoot()));
      expect(state.history).toHaveLength(SEEDED + 1);
      expect(state.detections).toHaveLength(1);
    });

    it('never writes a JSON document to stdout while the advisory key is off (shipped value)', () => {
      const last = fireTimes(SEEDED + 1, undefined);
      expect(last.stderr).toContain('LOOP WARNING');
      expect(last.stdout).toBe('');
    });
  });
});
