/**
 * Firewall — the pre-Bash hook's stdout must not depend on the ledger.
 *
 * T-39 made `scripts/hooks/pre-bash.js` append a `human.asked` line at the
 * points where it already blocked. The whole value of that record rests on one
 * property: the hook decides exactly what it decided before. A recorder that
 * can change a `block` into an approve — or merely reshape the reason string —
 * is not observability, it is a new gate nobody reviewed.
 *
 * So this gate runs the REAL hook as a child process (it reads stdin, so it
 * cannot be exercised in-process) once per command per ledger condition, and
 * requires the stdout bytes to be identical across conditions:
 *
 *   A  writable project root            → the record lands
 *   B  ledger path unwritable           → the record is dropped
 *   C  no `cwd` in the payload           → the record is never attempted
 *   D  project root exists, ledger tree does not → the writer creates it
 *
 * B is built by making `<root>/.artibot` a regular FILE, so
 * `mkdirSync(<root>/.artibot/runtime)` fails with ENOTDIR
 * (lib/runtime/event-writer.js:875). That is portable; a read-only directory
 * bit is not enforced for the owner on Windows.
 *
 * D exists because the brief's third condition — "a path that does not exist" —
 * is NOT a failure mode: the writer creates the tree recursively at that same
 * line. Asserting a failure there would assert a property the code does not
 * have, so the absent-path case is split into what actually happens (D, the
 * record lands) and what the brief was reaching for (C, no root at all).
 *
 * WHY CHANGING `cwd` IS A SOUND LEVER HERE — `executeChain` drops
 * `artibot-policy` guards when the cwd is outside the Artibot repo
 * (lib/core/guard-registry.js:88-93), which for other tools would make the
 * decision itself cwd-dependent. All three pre-phase Bash guards are
 * `security-critical` (lib/core/guard-registry.js:548-570), so for Bash the
 * guard set is the same in every condition and the only thing `cwd` moves is
 * where the ledger goes.
 *
 * ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
 *  - **The live hook payload.** The payloads here are hand-built. Nothing
 *    verifies that Claude Code's real PreToolUse JSON carries `cwd` and
 *    `session_id` in the shape the recorder reads; if it does not, production
 *    records nothing and this gate stays green.
 *  - **Recall.** Three blocked commands are measured, chosen to cover 0, 1 and
 *    2 human-gate hits. What fraction of real blocks carry a gate id is
 *    unmeasured — this says nothing about how often the record is useful.
 *  - **The error path with a payload.** The hook-error case reaches the
 *    fail-closed tail through a genuine `main()` rejection, but the rejection
 *    happens while READING stdin, so no payload was ever parsed and no root can
 *    be injected. The tail's append is therefore exercised only in its
 *    no-root branch. A hook error after parsing is not reachable from any
 *    stdin content: `parseJSON` swallows malformed input
 *    (scripts/utils/index.js:37-43) and `executeChain` turns a throwing guard
 *    into an ordinary block (lib/core/guard-registry.js:97-105).
 *  - **Ordering under a kill.** The append runs after `writeStdout`. If a
 *    parent reads stdout and kills the process, the line is lost. These runs
 *    wait for exit, so that window is never observed here.
 *
 * TIMEOUT BUDGET — this file spawns 28 child processes, so it overruns the 30s
 * per-test cap under the parallel firewall run (T-41 observation, 2026-09-02;
 * 20.4s standalone). The budget below buys headroom for load, not for a slow
 * assertion: nothing here waits on a timer, so a run that approaches it is a
 * signal to look at the machine, not to raise the number again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Safe to import: the hook's direct-run guard keeps `main()` from firing when
// the module is imported rather than spawned as argv[1].
import { buildQuestionId } from '../../scripts/hooks/pre-bash.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-bash.js');

/** Commands whose decision this gate pins, with the record each must produce. */
const APPROVED = ['ls -la', 'git status', 'echo hello'];

/**
 * Blocked commands, chosen for their human-gate hit count: none, one, two.
 * `git push --force …` is blocked by BLOCKED_PATTERNS; the `main` in it also
 * matches HG-07 (lib/security/human-gates.js:181) and `--no-verify` matches
 * HG-13 (lib/security/human-gates.js:299).
 */
const BLOCKED = [
  { command: 'rm -rf /tmp/data', hits: [] },
  { command: 'git push --force origin main', hits: ['HG-07'] },
  { command: 'git push --force --no-verify origin main', hits: ['HG-07', 'HG-13'] },
];

const SESSION_ID = 'sess1234abcd';

let tmp;

/**
 * Build one ledger condition and return the payload `cwd` it implies plus the
 * project root its records would land under.
 *
 * @param {'A'|'B'|'C'|'D'} name
 * @returns {{cwd: string|null, root: string|null, landsRecords: boolean}}
 */
function condition(name) {
  const root = path.join(tmp, `proj-${name}`);
  if (name === 'C') return { cwd: null, root: null, landsRecords: false };
  mkdirSync(path.join(root, '.git'), { recursive: true });
  if (name === 'B') {
    writeFileSync(path.join(root, '.artibot'), 'not a directory\n', 'utf-8');
    return { cwd: root, root, landsRecords: false };
  }
  if (name === 'D') {
    return { cwd: path.join(root, 'no', 'such', 'dir'), root, landsRecords: true };
  }
  return { cwd: root, root, landsRecords: true };
}

/**
 * Spawn the hook with one payload and return its raw stdout.
 * @param {object} payload
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runHook(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    windowsHide: true,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/**
 * Spawn the fail-closed tail through a real `main()` rejection: the runner
 * swaps in a `process.stdin` whose `setEncoding` throws, which rejects the
 * promise `readStdin` returns from inside its executor (lib/core/io.js:37-46).
 *
 * The stub is installed as a VALUE, not a throwing accessor. An accessor is
 * read while Node builds the ESM facade for `node:process`, so it fires during
 * the first import rather than inside `readStdin`, and the process dies before
 * the hook is even loaded.
 *
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runHookError() {
  const runner = path.join(tmp, 'hook-error-runner.mjs');
  writeFileSync(runner, [
    "Object.defineProperty(process, 'stdin', {",
    '  configurable: true,',
    "  value: { setEncoding() { throw new Error('stdin read failed'); }, on() {}, resume() {} },",
    '});',
    `const mod = await import(${JSON.stringify(pathToFileURL(HOOK).href)});`,
    'await mod.main().catch(mod.handleHookError);',
    '',
  ].join('\n'), 'utf-8');
  const res = spawnSync(process.execPath, [runner], { encoding: 'utf-8', windowsHide: true });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/**
 * Every well-formed event in a project's ledger.
 * @param {string|null} root
 * @returns {object[]}
 */
function ledgerEvents(root) {
  if (root === null) return [];
  const file = path.join(root, '.artibot', 'runtime', 'ledger.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

describe('pre-bash hook: decision invariance under ledger conditions', () => {
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-hook-inv-')));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('emits byte-identical stdout for every command in every ledger condition', () => {
    const commands = [...APPROVED, ...BLOCKED.map((b) => b.command)];
    /** @type {Map<string, string[]>} */
    const byCommand = new Map(commands.map((c) => [c, []]));
    const errorStdouts = [];

    for (const name of ['A', 'B', 'C', 'D']) {
      const { cwd } = condition(name);
      for (const command of commands) {
        const payload = { tool_name: 'Bash', tool_input: { command }, session_id: SESSION_ID };
        if (cwd !== null) payload.cwd = cwd;
        byCommand.get(command).push(runHook(payload).stdout);
      }
      errorStdouts.push(runHookError().stdout);
    }

    for (const [command, outputs] of byCommand) {
      expect(outputs, `stdout drifted across ledger conditions for: ${command}`)
        .toEqual([outputs[0], outputs[0], outputs[0], outputs[0]]);
    }
    expect(errorStdouts).toEqual([
      errorStdouts[0], errorStdouts[0], errorStdouts[0], errorStdouts[0],
    ]);
  });

  it('still approves the safe commands and blocks the dangerous ones', () => {
    const { cwd } = condition('A');
    for (const command of APPROVED) {
      const out = runHook({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: SESSION_ID });
      expect(JSON.parse(out.stdout), `expected approve for: ${command}`)
        .toEqual({ decision: 'approve' });
    }
    for (const { command } of BLOCKED) {
      const parsed = JSON.parse(runHook({
        tool_name: 'Bash', tool_input: { command }, cwd, session_id: SESSION_ID,
      }).stdout);
      expect(parsed.decision, `expected block for: ${command}`).toBe('block');
      expect(typeof parsed.reason).toBe('string');
      expect(Object.keys(parsed)).toEqual(['decision', 'reason']);
    }
  });

  it('fails closed on a hook error without an extra stdout field', () => {
    const out = runHookError();
    expect(JSON.parse(out.stdout)).toEqual({
      decision: 'block',
      reason: 'Safety check failed due to hook error. Blocking by default.',
    });
  });

  it.each(['A', 'D'])('writes one human.asked per block under condition %s', (name) => {
    const { cwd, root } = condition(name);
    for (const command of [...APPROVED, ...BLOCKED.map((b) => b.command)]) {
      runHook({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: SESSION_ID });
    }

    const events = ledgerEvents(root);
    const asked = events.filter((e) => e.event === 'human.asked');
    expect(asked).toHaveLength(BLOCKED.length);
    // A rejected line means the record violated its own contract and was lost.
    expect(events.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
    expect(new Set(asked.map((e) => e.data.question_id)).size).toBe(BLOCKED.length);

    for (const [i, spec] of BLOCKED.entries()) {
      const data = asked[i].data;
      expect(asked[i].source).toBe('hook');
      expect(asked[i].session_id).toBe(SESSION_ID);
      expect(data.decision).toBe('block');
      expect(data.reason).toContain(spec.command);
      expect(data.hits).toEqual(spec.hits);
      // `gate` is the strictest hit and is OMITTED, never null, when there is
      // none — the allowlist types it as a string.
      if (spec.hits.length === 0) {
        expect(Object.prototype.hasOwnProperty.call(data, 'gate')).toBe(false);
      } else {
        expect(data.gate).toBe(spec.hits[0]);
      }
      // The id the spawned hook wrote is the one the exported builder makes:
      // the format has a single definition, not a copy inside the hook.
      expect(data.question_id)
        .toBe(buildQuestionId(SESSION_ID, spec.hits[0] ?? null, spec.command));
    }
  });

  it.each(['B', 'C'])('records nothing and stays silent under condition %s', (name) => {
    const { cwd, root } = condition(name);
    for (const { command } of BLOCKED) {
      const payload = { tool_name: 'Bash', tool_input: { command }, session_id: SESSION_ID };
      if (cwd !== null) payload.cwd = cwd;
      const out = runHook(payload);
      expect(JSON.parse(out.stdout).decision).toBe('block');
      expect(out.stderr).toBe('');
    }
    expect(ledgerEvents(root)).toEqual([]);
  });

  it('records nothing on the approve path', () => {
    const { cwd, root } = condition('A');
    for (const command of APPROVED) {
      runHook({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: SESSION_ID });
    }
    expect(ledgerEvents(root)).toEqual([]);
  });
});

/**
 * `question_id` format — ruled by the leader for T-39 (2026-09-02) and defined
 * in exactly one place, `scripts/hooks/pre-bash.js#buildQuestionId`.
 *
 * It is checked here rather than in a unit suite because it guards the same
 * property this file exists for: a record whose join key is not reproducible
 * cannot be paired with the `human.resolved` that answers it, and the
 * ask-without-resolution signal (design §3.4 OD-5) silently degrades into a
 * backlog nobody can close.
 */
describe('human.asked question_id format', () => {
  it('is deterministic in session, gate and command', () => {
    const id = buildQuestionId('sess1234abcd', 'HG-07', 'git push --force origin main');
    expect(buildQuestionId('sess1234abcd', 'HG-07', 'git push --force origin main')).toBe(id);
    expect(id).toMatch(/^q-sess1234-[0-9a-f]{12}$/);

    // The gate is part of the question's identity: the same command reaching a
    // different gate is a different thing to ask about.
    expect(buildQuestionId('sess1234abcd', 'HG-07', 'x'))
      .not.toBe(buildQuestionId('sess1234abcd', 'HG-13', 'x'));
    expect(buildQuestionId('sess1234abcd', null, 'x'))
      .not.toBe(buildQuestionId('sess1234abcd', 'HG-07', 'x'));
    expect(buildQuestionId('sess1234abcd', 'HG-07', 'x'))
      .not.toBe(buildQuestionId('sess1234abcd', 'HG-07', 'y'));

    // Two sessions blocking the same command ask two questions, not one.
    expect(buildQuestionId('sess1234abcd', 'HG-07', 'x'))
      .not.toBe(buildQuestionId('other999zzz', 'HG-07', 'x'));

    // A payload with no session id gets the declared placeholder rather than an
    // empty slot that would collide with every other session-less ask's prefix
    // being absent entirely.
    expect(buildQuestionId(undefined, null, 'x')).toMatch(/^q-nosess-[0-9a-f]{12}$/);
    expect(buildQuestionId('', null, 'x')).toBe(buildQuestionId(undefined, null, 'x'));
  });
});
