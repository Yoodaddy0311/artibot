import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoopDetector } from '../../lib/cognitive/loop-detector.js';
import { makeLinkedPluginRoot } from '../helpers/linked-plugin-root.js';

/**
 * `cognitive.loopDetector.advisory` — the one key that lets a detected loop reach the
 * model (D-02 stage 2, Canary, shipped `false`).
 *
 * WHY A KEY. The hook's `[artibot:LOOP …]` line goes to stderr with exit 0, and the
 * host documents that Claude never sees the stderr of a hook that exits 0 — so the
 * detector had no effect on behaviour at all (04_VALIDATION_REPORT §2.2). The host
 * does read `hookSpecificOutput.additionalContext` from a PostToolUse (and
 * PostToolUseFailure) hook and inserts it beside the tool result, and the PostToolUse
 * dispatcher concatenates that field from every child
 * (`scripts/hooks/_dispatcher-utils.js#mergeResults`). With the key ON the hook writes
 * exactly one such document to stdout on a detected loop; with the key OFF, or no
 * detection, or an unreadable config, stdout stays empty — byte-identical to before.
 *
 * The ON cases run against a LINKED plugin root (`tests/helpers/linked-plugin-root.js`)
 * whose `artibot.config.json` is the real one with the key flipped, so the hook's
 * dynamic imports still resolve the real `lib/` and only the config differs.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'tool-tracker.js');
const REAL_CONFIG = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));

const CALL = { tool: 'Read', args: { file_path: path.join(os.tmpdir(), 'advisory-subject.js') } };
const SESSION = 'sess-advisory';

const SEEDED = (() => {
  const detector = createLoopDetector();
  let calls = 0;
  do { calls += 1; } while (!detector.detectLoop(CALL).detected);
  return calls - 1;
})();

describe('tool-tracker — the advisory key (cognitive.loopDetector.advisory)', () => {
  let tmp;
  let home;
  let root;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-tt-adv-')));
    home = path.join(tmp, 'home');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    root = makeLinkedPluginRoot(path.join(tmp, 'plugin-root'));
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /** Overwrite the linked root's config: the real one with `cognitive.loopDetector` replaced. */
  function configure(loopDetector) {
    const cfg = { ...REAL_CONFIG, cognitive: { ...REAL_CONFIG.cognitive, loopDetector } };
    writeFileSync(path.join(root, 'artibot.config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
  }

  /** Pre-seed this session's file so the NEXT identical call is the first detection. */
  function seed(sid = SESSION) {
    const detector = createLoopDetector();
    for (let i = 0; i < SEEDED; i += 1) detector.detectLoop(CALL);
    const file = path.join(home, '.claude', 'artibot', 'runtime', 'sessions', sid, 'loop-state.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ history: detector.getLoopHistory(), lastUpdated: Date.now() }), 'utf-8');
  }

  function fire(patch = {}) {
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ARTIBOT_HOOK_FIRED_DIRECT: 'off',
      CLAUDE_PLUGIN_ROOT: root,
    };
    for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME']) {
      delete env[key];
    }
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: CALL.tool,
      tool_input: CALL.args,
      tool_response: { content: 'a result that is long enough to count as substantive output' },
      session_id: SESSION,
      cwd: tmp,
      ...patch,
    };
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

  it('the shipped config has the key, and it is off', () => {
    expect(REAL_CONFIG.cognitive.loopDetector).toBeDefined();
    expect(REAL_CONFIG.cognitive.loopDetector.advisory).toBe(false);
    expect(typeof REAL_CONFIG.cognitive.loopDetector.comment).toBe('string');
  });

  it('OFF (shipped): a detected loop is stderr only, stdout is empty', () => {
    seed();
    const out = fire();
    expect(out.status).toBe(0);
    expect(out.stderr).toContain('LOOP WARNING');
    expect(out.stdout).toBe('');
  });

  it('ON: a detected loop writes one hookSpecificOutput document with additionalContext', () => {
    configure({ advisory: true, comment: 'test' });
    seed();
    const out = fire();
    expect(out.status).toBe(0);
    expect(out.stderr).toContain('LOOP WARNING');
    const doc = JSON.parse(out.stdout);
    expect(Object.keys(doc)).toEqual(['hookSpecificOutput']);
    expect(doc.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(doc.hookSpecificOutput.additionalContext).toMatch(
      new RegExp(`^\\[artibot:loop\\] Read called ${SEEDED + 1}x with identical arguments \\(severity: warn\\)\\.`),
    );
    expect(doc.hookSpecificOutput.additionalContext).toContain('Change the input or the approach');
    expect(out.stdout).not.toContain(CALL.args.file_path);
  });

  it('ON: the document names the event it was fired for (the direct PostToolUseFailure registration)', () => {
    configure({ advisory: true, comment: 'test' });
    seed();
    const out = fire({ hook_event_name: 'PostToolUseFailure', tool_response: undefined, error: 'Exit code 1' });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
  });

  it('ON: no detection, no document', () => {
    configure({ advisory: true, comment: 'test' });
    const out = fire();
    expect(out.status).toBe(0);
    expect(out.stderr).not.toContain('LOOP');
    expect(out.stdout).toBe('');
  });

  it('only the literal true reads ON: "true", 1 and a missing key stay off', () => {
    for (const value of [{ advisory: 'true' }, { advisory: 1 }, {}]) {
      rmSync(path.join(home, '.claude', 'artibot'), { recursive: true, force: true });
      configure(value);
      seed();
      const out = fire();
      expect(out.status).toBe(0);
      expect(out.stderr).toContain('LOOP WARNING');
      expect(out.stdout, JSON.stringify(value)).toBe('');
    }
  });

  it('an unreadable config reads OFF and still never breaks the hook', () => {
    writeFileSync(path.join(root, 'artibot.config.json'), '{ "cognitive": { "loopDetector": { "advisory": true', 'utf-8');
    seed();
    const out = fire();
    expect(out.status).toBe(0);
    expect(out.stderr).toContain('LOOP WARNING');
    expect(out.stdout).toBe('');
  });
});
