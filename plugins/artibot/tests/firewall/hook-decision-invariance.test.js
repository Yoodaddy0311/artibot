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
 * B is built by making the ledger's own PARENT DIRECTORY a regular FILE, so the
 * writer's `mkdirSync` of it fails (EEXIST on Node 24 — the mkdir target
 * itself is the file; the pre-ADR-011 fixture blocked the parent's parent and
 * got ENOTDIR) (lib/runtime/event-writer.js#appendLedgerLine). Every root here
 * has a `.git` directory, so after ADR-011 that parent is `<root>/.git/artibot`
 * rather than `<root>/.artibot/runtime` — the fixture names the same writer
 * failure at the path the writer now uses. The writer drops on ANY throw, so
 * the exact code is not load-bearing; a blocking file is portable while a
 * read-only directory bit is not enforced for the owner on Windows.
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
 * TIMEOUT BUDGET — the first test in this file spawns 28 child processes, so it
 * overruns the 30s per-test cap under the parallel firewall run (T-41
 * observation, 2026-09-02; 20.4s standalone). The budget below buys headroom for
 * load, not for a slow assertion: nothing here waits on a timer, so a run that
 * approaches it is a signal to look at the machine, not to raise the number again.
 *
 * A SECOND SUITE at the end of this file (CA-04 L4) is about a different hook and
 * a different property: the write-before-read exemption decisions of
 * pre-write-guard. It spawns that hook once per case, each in its own test, and
 * carries its own "cannot see" list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Safe to import: the hook's direct-run guard keeps `main()` from firing when
// the module is imported rather than spawned as argv[1].
import { buildQuestionId } from '../../scripts/hooks/pre-bash.js';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-bash.js');
const GUARD_HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'pre-write-guard.js');

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
    // The ledger's parent directory, as a FILE. Derived from the writer's own
    // path rule so the fixture cannot drift away from where it writes.
    writeFileSync(path.dirname(ledgerFilePath(root)), 'not a directory\n', 'utf-8');
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
  const file = ledgerFilePath(root);
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

  it('passes the safe commands through (no decision) and blocks the dangerous ones', () => {
    const { cwd } = condition('A');
    for (const command of APPROVED) {
      const out = runHook({ tool_name: 'Bash', tool_input: { command }, cwd, session_id: SESSION_ID });
      // Passthrough (CA-04): a command no guard blocks is not GRANTED, so stdout is zero bytes.
      expect(out.status, `exit code for: ${command}`).toBe(0);
      expect(out.stdout, `expected zero bytes for: ${command}`).toBe('');
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

/**
 * CA-04 L4 — the write-before-read exemption, decided by the REAL pre-write-guard.
 *
 * `isWhitelisted` (scripts/hooks/pre-write-guard.js) was narrowed from "any path
 * containing `.claude/`" to an allowlist. The one consumer that must not notice
 * is /split: a limb window edits files under `<repo>/.claude/worktrees/<name>/`
 * and has always done so without a prior-Read check on each. So this suite runs
 * the actual hook (it reads stdin; it cannot be exercised in-process) against a
 * sandbox shaped like a split repository and pins the stdout BYTES:
 *
 *   - every ordinary worktree file  → zero bytes on stdout (a pass, no decision);
 *   - the same situation elsewhere  → the guard's block, exactly as before
 *     (this is what makes the pass above mean "exempt" and not "guard idle");
 *   - config that used to ride in on the substring → now the guard's block;
 *   - a junction to a project root reaches the REAL .mcp.json / artibot.config.json /
 *     hooks.json → the guard's block, while the same names as the worktree's OWN
 *     copy (source) and ordinary files behind that junction still approve;
 *   - a relative spelling → no exemption, so the guard's ordinary check applies.
 *
 * A case counts only when the file EXISTS and the tracking file is empty: a new
 * file passes before the exemption is consulted, and a missing tracking
 * file takes the guard's degraded branch, so either would make every row pass.
 *
 * ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
 *  - **The live host payload.** `file_path` here is `path.join` output. How the
 *    host spells a Windows path in a real payload (drive-letter case, short
 *    names, slash direction) is not observed; the lexical table in
 *    tests/hooks/pre-write-guard.test.js covers the spellings, not their origin.
 *    The RELATIVE rows are constructed to pin the contract, not observed traffic:
 *    all 47 Write/Edit block records in the central ledger (2026-09-10..29) were
 *    absolute drive paths, and that ledger only sees blocks.
 *  - **Skipped is not passed.** The case-alias and 8.3-alias rows run on Windows
 *    only, and the 8.3 row skips itself when the volume has short names off.
 *  - **Out-of-scope paths.** A file outside cwd and the plugin root never reaches
 *    the guard's exemption at all (Tier 2), e.g. `~/.claude/settings.json` from a
 *    project cwd. Nothing here says anything about those; the human gate for them
 *    is a different layer (CA-04 L2).
 *  - **A race.** The junction target is resolved when the hook runs; a target
 *    swapped between the hook and the write is not observed.
 *  - **Network paths.** UNC and `\\?\` spellings are refused by the lexical
 *    rules and never reach the filesystem here.
 */
describe('pre-write-guard hook: write-before-read exemption decisions (CA-04 L4)', () => {
  const PASS = '';
  /** @type {string} */
  let box;
  /** @type {string[]} */
  let trackingFiles = [];

  /** The guard's block stdout for one tool and path, byte for byte. */
  function blockStdout(tool, target) {
    return JSON.stringify({
      decision: 'block',
      reason: `[WRITE-BEFORE-READ] ${tool} blocked for "${target}". `
        + 'File exists but was not Read in this session. '
        + `Read the file first to understand its contents before modifying, then retry the same ${tool}.`,
    });
  }

  /**
   * A repository with one split worktree. Every file a case targets is created,
   * because the guard only acts on files that exist. Both checkouts carry the
   * `artibot.config.json` marker the guard's Tier 1 looks for.
   */
  function makeSplitSandbox() {
    const proj = path.join(box, 'proj');
    const wt = path.join(proj, '.claude', 'worktrees', 'limb-a');
    const shared = path.join(box, 'shared');
    const put = (file) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '// fixture\n', 'utf-8');
    };
    for (const root of [proj, wt]) {
      mkdirSync(path.join(root, '.git'), { recursive: true });
      writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
      put(path.join(root, 'CLAUDE.md'));
      put(path.join(root, 'src', 'a.js'));
      put(path.join(root, 'plugins', 'artibot', 'lib', 'x.js'));
      put(path.join(root, '.claude', 'settings.local.json'));
      put(path.join(root, '.claude', 'rules', 'r.md'));
      // A checkout's own plugin config: SOURCE inside a worktree, the running config in the main one.
      put(path.join(root, 'plugins', 'artibot', 'artibot.config.json'));
      put(path.join(root, 'plugins', 'artibot', 'hooks', 'hooks.json'));
    }
    put(path.join(proj, 'worktrees', 'limb-a', 'src', 'a.js'));
    put(path.join(shared, '.claude', 'settings.local.json'));
    put(path.join(shared, 'node_modules', 'pkg', 'index.js'));
    // A project root elsewhere, with the real config names in it.
    put(path.join(shared, 'root', '.mcp.json'));
    put(path.join(shared, 'root', 'artibot.config.json'));
    put(path.join(shared, 'root', 'plugins', 'artibot', 'hooks', 'hooks.json'));
    put(path.join(shared, 'root', 'src', 'a.js'));
    // Junctions out of the worktree. `lnk` and `jx` land INSIDE .claude config (`jx` sits
    // under plugins/artibot/ so a RELATIVE spelling of it is in the guard's scope);
    // node_modules is the shape scripts/split/worktree-setup.mjs creates; `jRoot`
    // lands on a project root, so its .mcp.json / artibot.config.json / hooks.json
    // are the real ones under a path that looks like worktree source.
    symlinkSync(path.join(shared, '.claude'), path.join(wt, 'lnk'), 'junction');
    symlinkSync(path.join(shared, '.claude'), path.join(wt, 'plugins', 'artibot', 'jx'), 'junction');
    symlinkSync(path.join(shared, 'root'), path.join(wt, 'jRoot'), 'junction');
    symlinkSync(
      path.join(shared, 'node_modules'),
      path.join(wt, 'plugins', 'artibot', 'node_modules'),
      'junction',
    );
    return { proj, wt };
  }

  /**
   * Spawn the real guard for one Write/Edit of `target`, with `cwd` as the
   * process cwd — which is what puts the file in the guard's scope.
   * @returns {{stdout: string, status: number|null}}
   */
  function runGuard({ cwd, target, tool = 'Write' }, tag) {
    // Unique per case (the loop guard downgrades a repeated block to a pass) and
    // a legal file name: the tracking file is named after it.
    const sid = `wbr-l4-${process.pid}-${String(tag).replace(/[^A-Za-z0-9]+/g, '-')}`;
    const tracking = path.join(os.tmpdir(), `artibot-read-tracking-${sid}.json`);
    // Exists and empty: without it the guard takes its degraded branch and passes.
    writeFileSync(tracking, '[]', 'utf-8');
    trackingFiles.push(tracking);
    const res = spawnSync(process.execPath, [GUARD_HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: { file_path: target },
        session_id: sid,
      }),
      encoding: 'utf-8',
      windowsHide: true,
      cwd,
      env: {
        ...process.env,
        // Keep the block fingerprint out of the real plugin `runtime/` dir, and
        // pin block mode so a host env var cannot turn the block into a warning.
        CLAUDE_PLUGIN_ROOT: path.join(box, 'plugin'),
        ARTIBOT_WRITE_GUARD_MODE: 'block',
      },
    });
    return { stdout: String(res.stdout || ''), status: res.status };
  }

  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-hook-inv-wbr-')));
  });
  afterEach(() => {
    for (const file of trackingFiles) {
      try { rmSync(file, { force: true }); } catch { /* noop */ }
    }
    trackingFiles = [];
    try { rmSync(box, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /** `checkout`: 'wt' = the split worktree (also the hook's cwd), 'proj' = the main checkout. */
  const ROWS = [
    // ── the split invariant: unchanged bytes ────────────────────────────────
    { label: 'worktree: ordinary source file', checkout: 'wt', below: ['src', 'a.js'], expectation: 'pass', tool: 'Write' },
    { label: 'worktree: ordinary source file', checkout: 'wt', below: ['src', 'a.js'], expectation: 'pass', tool: 'Edit' },
    { label: 'worktree: plugin source file', checkout: 'wt', below: ['plugins', 'artibot', 'lib', 'x.js'], expectation: 'pass', tool: 'Write' },
    { label: 'worktree: file behind the node_modules junction', checkout: 'wt', below: ['plugins', 'artibot', 'node_modules', 'pkg', 'index.js'], expectation: 'pass', tool: 'Edit' },
    { label: 'worktree: rules markdown', checkout: 'wt', below: ['.claude', 'rules', 'r.md'], expectation: 'pass', tool: 'Write' },
    { label: 'worktree: CLAUDE.md', checkout: 'wt', below: ['CLAUDE.md'], expectation: 'pass', tool: 'Edit' },
    { label: 'main checkout: rules markdown', checkout: 'proj', below: ['.claude', 'rules', 'r.md'], expectation: 'pass', tool: 'Write' },
    { label: 'main-checkout window edits a file inside a worktree', checkout: 'proj', below: ['.claude', 'worktrees', 'limb-a', 'src', 'a.js'], expectation: 'pass', tool: 'Write' },
    // A worktree's own copy of the plugin config is SOURCE, not the running config.
    { label: 'worktree: its own plugins/artibot/artibot.config.json (source copy)', checkout: 'wt', below: ['plugins', 'artibot', 'artibot.config.json'], expectation: 'pass', tool: 'Edit' },
    { label: 'worktree: its own plugins/artibot/hooks/hooks.json (source copy)', checkout: 'wt', below: ['plugins', 'artibot', 'hooks', 'hooks.json'], expectation: 'pass', tool: 'Write' },
    // A junction to a project root keeps the old exemption for ordinary files (as node_modules does)...
    { label: 'worktree: ordinary file behind a junction to a project root', checkout: 'wt', below: ['jRoot', 'src', 'a.js'], expectation: 'pass', tool: 'Write' },
    // ── what the narrowing removes ──────────────────────────────────────────
    { label: 'worktree: its own .claude/settings.local.json', checkout: 'wt', below: ['.claude', 'settings.local.json'], expectation: 'block', tool: 'Write' },
    { label: 'worktree: file behind a junction into .claude config', checkout: 'wt', below: ['lnk', 'settings.local.json'], expectation: 'block', tool: 'Edit' },
    { label: 'main checkout: .claude/settings.local.json', checkout: 'proj', below: ['.claude', 'settings.local.json'], expectation: 'block', tool: 'Write' },
    // ...but not for the names it protects (review m2).
    { label: 'worktree: .mcp.json behind a junction to a project root', checkout: 'wt', below: ['jRoot', '.mcp.json'], expectation: 'block', tool: 'Edit' },
    { label: 'worktree: artibot.config.json behind a junction to a project root', checkout: 'wt', below: ['jRoot', 'artibot.config.json'], expectation: 'block', tool: 'Write' },
    { label: 'worktree: hooks.json behind a junction to a project root', checkout: 'wt', below: ['jRoot', 'plugins', 'artibot', 'hooks', 'hooks.json'], expectation: 'block', tool: 'Edit' },
    // Relative spellings get no exemption (review m1). They reach the guard's scope through
    // `plugins/artibot/`, and the hook's cwd resolves them to real files.
    { label: 'relative spelling: settings behind a junction', checkout: 'proj', relative: true, below: ['.claude', 'worktrees', 'limb-a', 'plugins', 'artibot', 'jx', 'settings.local.json'], expectation: 'block', tool: 'Edit' },
    { label: 'relative spelling: an ordinary worktree file', checkout: 'proj', relative: true, below: ['.claude', 'worktrees', 'limb-a', 'plugins', 'artibot', 'lib', 'x.js'], expectation: 'block', tool: 'Write' },
    // ── controls: the guard is live, and the exemption is specific ──────────
    { label: 'CONTROL main checkout: ordinary source file', checkout: 'proj', below: ['src', 'a.js'], expectation: 'block', tool: 'Write' },
    { label: 'CONTROL look-alike worktree outside .claude/', checkout: 'proj', below: ['worktrees', 'limb-a', 'src', 'a.js'], expectation: 'block', tool: 'Edit' },
  ];

  it.each(ROWS)('$label → $expectation ($tool)', ({ label, checkout, below, expectation, tool, relative = false }) => {
    const { proj, wt } = makeSplitSandbox();
    const cwd = checkout === 'wt' ? wt : proj;
    // A `relative` row sends the path the way a model could write it: no drive, no root.
    const target = relative ? below.join('/') : path.join(cwd, ...below);
    const out = runGuard({ cwd, target, tool }, `${label}-${tool}`);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(expectation === 'pass' ? PASS : blockStdout(tool, target));
  });

  describe.runIf(process.platform === 'win32')('Windows: NTFS is case-insensitive', () => {
    it('does not exempt a case-aliased .CLAUDE directory inside the worktree', () => {
      const { wt } = makeSplitSandbox();
      const target = path.join(wt, '.CLAUDE', 'settings.local.json');
      // Same file to NTFS, so the guard sees an existing unread file and blocks.
      const out = runGuard({ cwd: wt, target }, 'alias-case');
      expect(out.stdout).toBe(blockStdout('Write', target));
    });
  });
});
