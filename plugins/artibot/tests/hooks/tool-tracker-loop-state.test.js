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
   * @param {string[]} [nodeArgs] extra `node` flags before the script (e.g. an `--import` preload)
   */
  function fire(override, payloadPatch = {}, nodeArgs = []) {
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
    const res = spawnSync(process.execPath, [...nodeArgs, HOOK], {
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

  // Restored state is validated before the detector sees it (lane C, 2026-11-22).
  //
  // History. F2 (review-fixes 2026-11-21, xcB LOW-2) used `history: [null]` to make
  // the LOCKED body throw (countConsecutiveTrailing reads `.fingerprint` off every
  // trailing entry) and pinned that the throw was logged as itself. A null entry now
  // never reaches the detector, so that throw is gone at its source; the `entered`
  // containment in trackLoop stays, but no data on disk reaches it any more.
  //
  // What was wrong without validation:
  //   - a non-object entry threw inside the lock (logged, call unchecked) and, when
  //     the lock was NOT taken, threw out of the unlocked fallback — which has no
  //     containment — and ended main() before the usage row;
  //   - primitives and partial objects that do not throw were carried forward and
  //     written back on every call, as were unknown keys and malformed detection rows;
  //   - a non-numeric `lastUpdated` never expired (NaN comparisons are false).
  // The history is sequence-sensitive (consecutive repeats), so ONE bad entry
  // discards the whole history rather than closing up the hole; detection rows are
  // an independent log, so a bad row is dropped on its own.
  describe('restored state is validated before use', () => {
    const usageRows = () => Object.values(read(path.join(homeRoot(), 'tool-history.json')).contexts).flat();
    const writeState = (file, state) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state), 'utf-8');
    };
    const goodHistory = (n = SEEDED) => {
      const detector = createLoopDetector();
      for (let i = 0; i < n; i += 1) detector.detectLoop(CALL);
      return detector.getLoopHistory().map((e) => ({ ...e }));
    };
    const DETECTION = { ts: 1, tool: 'Read', severity: 'warn', count: 3, fingerprint_sha12: 'abcdef012345' };
    const DETECTION_KEYS = ['count', 'fingerprint_sha12', 'severity', 'tool', 'ts'];

    const malformed = [
      ['a null entry (the F2 trigger)', [null]],
      ['a string entry', ['Read::{}']],
      ['a number entry', [42]],
      ['an entry without a fingerprint', [{ tool: 'Read' }]],
      ['an entry whose fingerprint is not a string', [{ tool: 'Read', fingerprint: 5 }]],
      ['one null among valid entries', [...goodHistory(), null]],
    ];
    for (const [label, entries] of malformed) {
      it(`discards a history holding ${label}: no throw, no warning, rewritten with this call only`, () => {
        const file = sessionFile(homeRoot());
        writeState(file, { history: entries, lastUpdated: Date.now() });

        const out = fire();

        expect(out.status, out.stderr).toBe(0);
        expect(out.stderr).not.toContain('loop tracking failed');
        expect(out.stderr).not.toContain('LOOP');
        const saved = history(file);
        expect(saved).toHaveLength(1);
        expect(Object.keys(saved[0]).sort()).toEqual(['fingerprint', 'tool']);
        expect(usageRows()).toHaveLength(1);
      });
    }

    it('drops unknown keys from restored entries, and still counts them', () => {
      const file = sessionFile(homeRoot());
      writeState(file, { history: goodHistory().map((e) => ({ ...e, raw: SUBJECT })), lastUpdated: Date.now() });

      const out = fire();

      expect(out.stderr).toContain('LOOP WARNING');
      const saved = history(file);
      expect(saved).toHaveLength(SEEDED + 1);
      for (const e of saved) expect(Object.keys(e).sort()).toEqual(['fingerprint', 'tool']);
    });

    it('treats a lastUpdated that is not a number as expired', () => {
      const file = sessionFile(homeRoot());
      writeState(file, { history: goodHistory(), lastUpdated: 'not-a-time' });

      const out = fire();

      expect(out.stderr).not.toContain('LOOP');
      expect(history(file)).toHaveLength(1);
    });

    it('keeps well-formed detection rows (known keys only) and drops the rest', () => {
      const file = sessionFile(homeRoot());
      writeState(file, {
        history: goodHistory(),
        detections: [DETECTION, null, 'x', { ...DETECTION, ts: 'bad' }, { ...DETECTION, severity: 'none' }, { ...DETECTION, raw: SUBJECT }],
        lastUpdated: Date.now(),
      });

      const out = fire();

      expect(out.stderr).toContain('LOOP WARNING');
      const { detections } = read(file);
      expect(detections).toHaveLength(3); // the two good rows + this call's
      for (const row of detections) expect(Object.keys(row).sort()).toEqual(DETECTION_KEYS);
      expect(JSON.stringify(detections)).not.toContain(SUBJECT);
    });

    it('caps restored detection rows at 50 even on a call that detects nothing', () => {
      const file = sessionFile(homeRoot());
      writeState(file, {
        history: [],
        detections: Array.from({ length: 60 }, (_, i) => ({ ...DETECTION, ts: i })),
        lastUpdated: Date.now(),
      });

      fire();

      const { detections } = read(file);
      expect(detections).toHaveLength(50);
      expect(detections[0].ts).toBe(10); // the newest 50 survive
    });

    // The unlocked fallback runs when the state lock is not taken. It never writes,
    // and it had no containment: before validation a null entry threw out of it.
    it('lock not taken: a malformed history neither throws nor gets written, and the usage row lands', () => {
      const file = sessionFile(homeRoot());
      writeState(file, { history: [null], lastUpdated: Date.now() });
      const before = readFileSync(file, 'utf-8');
      // A live holder on this host (this test runner's pid, fresh timestamp): never stale.
      writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'held-by-test', timestamp: Date.now() }));

      const out = fire();

      expect(out.status, out.stderr).toBe(0);
      expect(out.stderr.split('lock not taken').length - 1).toBe(1);
      expect(out.stderr).not.toContain('loop tracking failed');
      expect(readFileSync(file, 'utf-8')).toBe(before);
      expect(usageRows()).toHaveLength(1);
    }, 30_000);
  });

  // Lane D cross-review 2026-11-22: loadLoopState read every error as "no file", so one
  // EBUSY on the read under the lock wrote a fresh one-entry history over the real one
  // (measured: 1,2,3,1 — the warn and the BLOCK never came). The read rule is now the
  // allowlist of core/file.js#readTextAllowMissing: ENOENT and unparseable content are
  // "no state"; any other error checks this call without history and persists NOTHING.
  // The fault is a preload in the hook process (one EBUSY on that path, a marker file
  // proves it fired); `syncBuiltinESMExports` makes the named and default imports agree.
  describe('a loop-state file that exists but cannot be read is not overwritten', () => {
    const PRELOAD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realRead = fs.readFileSync;
let left = 1;
fs.readFileSync = function faulty(p, ...rest) {
  if (left > 0 && String(p) === process.env.LOOP_FAULT_FILE) {
    left -= 1;
    fs.writeFileSync(process.env.LOOP_FAULT_MARK, 'fired');
    throw Object.assign(new Error('EBUSY: injected read failure'), { code: 'EBUSY' });
  }
  return realRead.call(this, p, ...rest);
};
syncBuiltinESMExports();
`;

    /** Fire once with ONE EBUSY on `file`; returns the result and the marker path. */
    function fireWithReadFault(file) {
      const preload = path.join(tmp, 'read-fault.mjs');
      const mark = path.join(tmp, 'read-fault.fired');
      writeFileSync(preload, PRELOAD, 'utf-8');
      process.env.LOOP_FAULT_FILE = file;
      process.env.LOOP_FAULT_MARK = mark;
      try {
        return { out: fire(undefined, {}, ['--import', `file:///${preload.split(path.sep).join('/')}`]), mark };
      } finally {
        delete process.env.LOOP_FAULT_FILE;
        delete process.env.LOOP_FAULT_MARK;
      }
    }

    it('EBUSY on the read under the lock: history kept byte for byte, and the next call still counts it', () => {
      const file = sessionFile(homeRoot());
      seed(file);
      const before = readFileSync(file, 'utf-8');

      const { out, mark } = fireWithReadFault(file);

      expect(out.status, out.stderr).toBe(0);
      expect(existsSync(mark)).toBe(true); // the injected failure actually fired
      expect(history(file)).toHaveLength(SEEDED); // not reset to this one call
      expect(readFileSync(file, 'utf-8')).toBe(before);
      expect(out.stderr).toContain('loop-state unreadable (EBUSY)');

      const next = fire();
      expect(next.stderr).toContain('LOOP WARNING');
      expect(history(file)).toHaveLength(SEEDED + 1);
    });

    it('control — content that does not parse is still "no state" and is replaced', () => {
      const file = sessionFile(homeRoot());
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{ half-written', 'utf-8');

      const out = fire();

      expect(out.status, out.stderr).toBe(0);
      expect(out.stderr).not.toContain('loop-state unreadable');
      expect(history(file)).toHaveLength(1);
    });
  });
});
