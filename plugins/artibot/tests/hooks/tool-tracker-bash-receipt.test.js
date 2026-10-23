import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoopDetector } from '../../lib/cognitive/loop-detector.js';

/**
 * Every Bash call leaves a learning row, whatever its shape (D-03).
 *
 * Until 2026-10-23 `scripts/hooks/tool-tracker.js#buildContext` returned `null` for a
 * Bash command whose LEADING token no classifier regex matched, and `main()` returned
 * before scoring, before loop detection and before any row was written. `cd x && npm
 * test`, `CI=1 npm test`, `bash scripts/run.sh` and a pipeline therefore left nothing
 * (EXP-B of `.artibot/guides/v5-design/practicality-improvement-20261023/
 * 04_VALIDATION_REPORT.md` §7: 6 shapes, 4 without a row). The module's own comment
 * had called `cd x && …` "the dominant command shape in this repo".
 *
 * Now: a command the classifier cannot name is `bash:unknown:shell`, two prefixes are
 * stripped before classifying (ONE leading `cd <path> &&`/`;`, then leading
 * `NAME=value` assignments — an allowlist of two, not a growing regex), `vitest` is a
 * test runner, and the command TEXT is still never persisted — only the context key,
 * the score and a timestamp are, which is what the sentinel assertions pin.
 *
 * These spawn the real hook with HOME redirected to a throwaway directory, like
 * `tests/hooks/tool-tracker.test.js` (registered in
 * `tests/firewall/dispatcher-cwd-sandbox-required.test.js#SCOPE_EXCLUSIONS` as a
 * single-hook spawn whose only writes go under the redirected home).
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'tool-tracker.js');

/** A substring that appears in no classifier and in no other fixture. */
const SENTINEL = 'SENTINEL-9f3a-not-a-real-path';

/** The six shapes of 02_BASELINE_ROI_PROTOCOL §3 Phase 0 #2, with the context each must land in. */
const SHAPES = [
  ['npm test', 'bash:test:shell'],
  [`cd /tmp/${SENTINEL} && npm test`, 'bash:test:shell'],
  ['CI=1 npm test', 'bash:test:shell'],
  ['npx vitest run tests/x.test.js', 'bash:test:shell'],
  [`bash scripts/${SENTINEL}.sh`, 'bash:unknown:shell'],
  ['echo hi | grep h', 'bash:unknown:shell'],
];

const SEEDED = (() => {
  const detector = createLoopDetector();
  const call = { tool: 'Bash', args: { command: 'x' } };
  let calls = 0;
  do { calls += 1; } while (!detector.detectLoop(call).detected);
  return calls - 1;
})();

describe('tool-tracker — every Bash shape leaves a row (D-03)', () => {
  let tmp;
  let home;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-tt-bash-')));
    home = path.join(tmp, 'home');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const historyFile = () => path.join(home, '.claude', 'artibot', 'tool-history.json');
  const experiencesFile = () => path.join(home, '.claude', 'artibot', 'daily-experiences.json');

  function fire(command, patch = {}) {
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
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: 'ok ok ok ok ok ok', exit_code: 0 },
      session_id: 'sess-bash-receipt',
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

  /** `{ context: rowCount }` from the learner's store, `{}` when it was never written. */
  function rows() {
    if (!existsSync(historyFile())) return {};
    const parsed = JSON.parse(readFileSync(historyFile(), 'utf-8'));
    return Object.fromEntries(Object.entries(parsed.contexts || {}).map(([k, v]) => [k, v.length]));
  }

  it.each(SHAPES)('"%s" writes exactly one row, in %s', (command, context) => {
    const out = fire(command);
    expect(out.status, out.stderr).toBe(0);
    expect(rows()).toEqual({ [context]: 1 });
  });

  it('the command text is never persisted — only the context key, score and time', () => {
    for (const [command] of SHAPES) fire(command);
    expect(existsSync(historyFile())).toBe(true);
    expect(existsSync(experiencesFile())).toBe(true);
    expect(readFileSync(historyFile(), 'utf-8')).not.toContain(SENTINEL);
    expect(readFileSync(experiencesFile(), 'utf-8')).not.toContain(SENTINEL);
    expect(readFileSync(historyFile(), 'utf-8')).not.toContain('npm test');
  });

  it('a failed unclassifiable command still scores 0.0 (the PostToolUseFailure shape)', () => {
    const out = fire(`bash scripts/${SENTINEL}.sh`, {
      hook_event_name: 'PostToolUseFailure',
      tool_response: undefined,
      error: 'Exit code 1\nboom',
    });
    expect(out.status, out.stderr).toBe(0);
    const parsed = JSON.parse(readFileSync(historyFile(), 'utf-8'));
    expect(parsed.contexts['bash:unknown:shell']).toHaveLength(1);
    expect(parsed.contexts['bash:unknown:shell'][0].score).toBe(0);
  });

  it('an unclassifiable command is still loop-detected (detection runs before classification)', () => {
    let last = null;
    for (let i = 0; i < SEEDED + 1; i += 1) {
      last = fire(`bash scripts/${SENTINEL}.sh`, { session_id: 'sess-bash-loop' });
      expect(last.status, last.stderr).toBe(0);
    }
    expect(last.stderr).toContain('LOOP WARNING');
    expect(last.stderr).toContain('Tool "Bash"');
  });

  it('a non-Bash row is untouched by the Bash changes (Read still lands in read:<ext>:file)', () => {
    const out = fire('ignored', {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a.md' },
      tool_response: { content: 'a result that is long enough to count as substantive output' },
    });
    expect(out.status, out.stderr).toBe(0);
    expect(rows()).toEqual({ 'read:md:file': 1 });
  });
});
