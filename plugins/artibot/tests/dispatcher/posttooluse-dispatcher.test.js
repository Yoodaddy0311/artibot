import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';

/**
 * PostToolUse dispatcher integration tests.
 *
 * Verifies:
 *   - Per-tool routing: only hooks declaring the active tool are spawned.
 *   - Exit 0 in every failure path.
 *   - Env-disable behavior (slot + global).
 *   - JSON merge correctness.
 *
 * These spawn the REAL dispatcher, whose universal `tool-tracker` hook appends
 * every payload to `<home>/.claude/artibot/`. The home directory is therefore
 * redirected to a throwaway temp dir for the whole file — same reasoning and
 * same mechanism as `sessionend-dispatcher.test.js`. Without it the fixtures
 * land in the developer's own learning store: `category:'NonexistentToolXYZ'`
 * rows (a tool that does not exist) were measured there. Disabling
 * checkpoint/memory below is not enough — the tracker writes elsewhere.
 *
 * TWO redirections, for two different blast radii — the second one matches
 * `sessionstart-dispatcher.test.js`, which had to add it after a measured
 * incident. `spawnHook` passes no `cwd`
 * (`scripts/hooks/_dispatcher-utils.js#spawnHook`), so every grand-child inherits
 * whatever cwd this file hands the dispatcher: the cwd below is load-bearing,
 * not incidental.
 *
 *  - HOME/USERPROFILE -> throwaway dir (above).
 *
 *  - cwd -> throwaway NON-git dir. None of the 12 PostToolUse hooks is a
 *    git-autopilot hook (11 measured 2026-09-04T05:03Z against `HOOKS`; the
 *    12th, `tool-used-record.js`, added 2026-09-15 and read here — it touches
 *    git only through `resolveProjectRoot(payload.cwd)`, and the round-trip
 *    case below hands it a `mkdtemp` repo of its own), so
 *    unlike SessionStart there is no `checkout -b` to prevent here. Three
 *    hooks do reach the repository through `process.cwd()`, and all three
 *    reads are read-only:
 *      * `pre-write-guard.js:73-79` resolves the repo root from cwd and tests
 *        it for the Artibot marker, purely to decide whether to advise.
 *      * `post-write-tdd.js:102` gates on `isArtibotRepo(getRepoRoot())`.
 *      * `tool-tracker.js:239` takes `basename(resolveProjectRoot(...))` as a
 *        label; with no payload `cwd`, `resolveProjectRoot` falls back to
 *        `process.cwd()` (`lib/git/project-root.js:122-124`) and the label
 *        becomes the sandbox directory name. The row itself is written under
 *        the sandbox HOME either way.
 *    MEASURED, baseline run 2026-09-04T05:03:18Z (31/31 pass across the three
 *    dispatcher suites): no repo artifact moved — worktree `autopilot.json`
 *    absent before and after, HEAD/branch/reflog/`artibot/*` identical,
 *    `git status --porcelain` 0 lines both sides.
 *
 *    The redirection is therefore defense in depth plus uniformity, not a
 *    repair of an observed leak: it makes the cwd of every dispatcher suite
 *    structurally incapable of reaching a repository, which is what
 *    `tests/firewall/dispatcher-cwd-sandbox-required.test.js` enforces.
 *
 *    NOT output-neutral in one direction, and the assertions below survive it:
 *    `pre-write-guard` now takes its "not an Artibot repo" early return and
 *    stops advising. Nothing here asserts on its advice — the one positive
 *    stdout assertion is `zero-result-guard`, which is cwd-independent.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', '_posttooluse-dispatcher.js');

/**
 * SH-09: the AskUserQuestion payload. DOCUMENT-BASED, NOT LIVE-CAPTURED
 * (문서 기반, 라이브 미캡처) -- the fixture's own `_note` says why: the real
 * PostToolUse fires only after a human answers, so no unattended probe froze it.
 * Its `cwd` is a placeholder; every case below overwrites it with a sandbox repo.
 */
const ASK_FIXTURE = JSON.parse(readFileSync(
  path.join(PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'askuser', 'PostToolUse.AskUserQuestion.json'),
  'utf-8',
));

/** Throwaway home and working directory for the spawned dispatcher. */
let sandboxHome;
let sandboxCwd;
/**
 * A THIRD throwaway directory, this one a real repository, used only as the
 * `cwd` FIELD OF A PAYLOAD — never as the spawn's cwd.
 *
 * `tool-used-record.js` resolves its project root from `payload.cwd` and
 * writes a ledger line under it, so the round-trip case needs a root it may
 * write into. Pointing the SPAWN at it instead would put a git repository
 * above every grand-child's cwd, which is precisely the isolation
 * `tests/firewall/dispatcher-cwd-sandbox-required.test.js` exists to prevent.
 * The two stay separate: spawn cwd non-git, payload cwd a sandbox repo.
 */
let ledgerRepo;

/**
 * Every directory this file made, so `afterAll` can remove the ones the
 * `hook.fired` cases create on demand. Each of those cases needs its OWN repo:
 * the carrier appends one row per dispatch, so two cases sharing a root would
 * have to subtract each other's rows to count their own — an assertion that
 * silently weakens the moment a third case is added.
 */
const extraRepos = [];

/** A throwaway git repository, used only as a payload `cwd`. */
function makeLedgerRepo(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `artibot-posttooluse-${tag}-`));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  extraRepos.push(dir);
  return dir;
}

/** Parsed ledger lines for a root, `[]` when the file was never created. */
function readLedger(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeAll(() => {
  sandboxHome = mkdtempSync(path.join(tmpdir(), 'artibot-posttooluse-'));
  sandboxCwd = mkdtempSync(path.join(tmpdir(), 'artibot-posttooluse-cwd-'));
  ledgerRepo = mkdtempSync(path.join(tmpdir(), 'artibot-posttooluse-ledger-'));
  // ADR-011 puts the ledger inside the git common dir; without a real `.git`
  // the root resolves to an ancestor of the temp dir.
  execFileSync('git', ['init'], { cwd: ledgerRepo, stdio: 'ignore', windowsHide: true });
});

afterAll(() => {
  if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  if (sandboxCwd) rmSync(sandboxCwd, { recursive: true, force: true });
  if (ledgerRepo) rmSync(ledgerRepo, { recursive: true, force: true });
  for (const dir of extraRepos) rmSync(dir, { recursive: true, force: true });
});

/**
 * Budget multiplier every dispatch in this file is spawned with
 * (`ARTIBOT_DISPATCH_TIMEOUT_SCALE`, read and clamped to [1, 10] by
 * `scripts/hooks/_dispatcher-utils.js#resolveTimeoutScale`; 10 is its cap).
 *
 * WHY. The `hook.fired` cases assert `data.failed` is `[]`. `failed` names a
 * handler whose child was still running when its budget ran out, and the timer
 * starts at spawn(), so the tightest Edit-route budget (post-write-tdd, in
 * `hooks/dispatch-table.json`) also has to cover a node cold start. On a loaded
 * machine that race is lost and the assertion fails for a reason unrelated to
 * the code under test. The assertion stays STRICT; the budget stops racing the
 * machine. The same scale covers the other cases here that need a handler to
 * finish (zero-result-guard's advice, the two `tool.used` rows).
 *
 * WHAT STAYS STRICT. `failed` keeps its meaning (a handler that timed out or
 * failed to spawn) and the assertions on it are unchanged. A handler that really
 * hangs still fails these cases: one whose scaled budget is under the 35 s spawn
 * timeout below is recorded in `failed`, and a longer one outlasts that timeout
 * so `status` goes non-zero. The delay-injection cases at the bottom of this
 * file pin both directions: a delay past the SHIPPED budget IS recorded in
 * `failed`, and the same delay under this scale is NOT.
 *
 * WHAT THIS NO LONGER SEES. Inside these cases the effective timeout is 10x the
 * declared budget, so a handler that merely got slower (say 0.3 s to 5 s, inside
 * its 10x) is no longer reported here. It was only ever reported here when the
 * machine happened to be busy, which is the coupling being removed; declared
 * budgets are gated by tests/firewall/hook-timeout-budget.test.js and measured
 * latency by scripts/bench/hook-latency.mjs.
 *
 * WHY ONLY THIS SUITE. PostToolUse is the only dispatcher that opts in (it passes
 * `allowTimeoutScale: true` to spawnHook); the other four keep their declared
 * budgets whatever the variable holds, since a stretched budget there can outlive
 * the host's slot timeout and lose the merged output (Stop's blocking decisions
 * included). Here it is bounded, not free: the slot is 30 s and post-edit-format is
 * declared 10 s, so at 10x a child that REALLY hangs gets the dispatcher cancelled
 * first, and a quality-gate decision:'block' goes with it. The timer-spy case at
 * the bottom pins that the scale IS applied.
 */
const GENEROUS_TIMEOUT_SCALE = '10';

/**
 * Spawn options for the dispatcher, in ONE place so the isolation self-check
 * at the bottom reads the same `cwd` the real spawns use. Inlining `cwd:` at
 * the call site instead lets the two drift, and the self-check then passes
 * vacuously: measured 2026-09-04T05:13Z, the first draft of this file kept
 * asserting on the sandbox while the spawn had been pointed back at the
 * checkout, and reported green. The indirection is the detector.
 *
 * @param {Record<string,string>} [env] extra environment for this spawn
 * @returns {import('node:child_process').ExecFileSyncOptions}
 */
function spawnOptions(env = {}) {
  return {
    cwd: sandboxCwd,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      // getHomeDir() reads USERPROFILE then HOME — both must point at the
      // sandbox or the real learning store gets the fixtures.
      USERPROFILE: sandboxHome,
      HOME: sandboxHome,
      ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
      ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
      // Scaled budgets, see GENEROUS_TIMEOUT_SCALE. A per-call `env` may
      // override it, and the delay-injection cases at the bottom do.
      ARTIBOT_DISPATCH_TIMEOUT_SCALE: GENEROUS_TIMEOUT_SCALE,
      ...env,
    },
    encoding: 'utf-8',
    timeout: 35000,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function runDispatcher(payload, env = {}) {
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [SCRIPT_PATH],
      { ...spawnOptions(env), input: JSON.stringify(payload) },
    );
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout?.toString('utf-8') || '';
  }
  return { stdout: stdout.trim(), status };
}

describe('_posttooluse-dispatcher (integration)', () => {
  it('exits 0 for empty payload', () => {
    const { status } = runDispatcher({});
    expect(status).toBe(0);
  });

  it('exits 0 for unknown tool', () => {
    const { status } = runDispatcher({ tool: 'NonexistentToolXYZ' });
    expect(status).toBe(0);
  });

  it('exits 0 for Bash payload (post-bash + post-bash-failure + tool-tracker)', () => {
    const { status } = runDispatcher({
      tool: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: 'hi\n' },
    });
    expect(status).toBe(0);
  });

  it('exits 0 for Edit payload (quality-gate + post-edit-format + post-edit-recovery + post-write-tdd + mark-main-agent-edit + tool-tracker)', () => {
    const { status } = runDispatcher({
      tool: 'Edit',
      tool_input: { file_path: '/tmp/nonexistent.txt', old_string: 'a', new_string: 'b' },
    });
    expect(status).toBe(0);
  });

  it('respects ARTIBOT_DISABLE_POSTTOOLUSE_DISPATCHER=1', () => {
    const { stdout, status } = runDispatcher(
      { tool: 'Edit' },
      { ARTIBOT_DISABLE_POSTTOOLUSE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('respects ARTIBOT_DISABLE_DISPATCHER=1 (global)', () => {
    const { stdout, status } = runDispatcher(
      { tool: 'Edit' },
      { ARTIBOT_DISABLE_DISPATCHER: '1' },
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('emits at most one valid JSON document on stdout', () => {
    const { stdout, status } = runDispatcher({ tool: 'Bash', tool_input: { command: 'true' } });
    expect(status).toBe(0);
    if (stdout.length > 0) {
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  it('registers all 12 wrapped hooks', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    expect(mod.HOOKS).toHaveLength(12);
  });

  it('selectHooks() routes Grep and Glob to zero-result-guard + tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    for (const tool of ['Grep', 'Glob']) {
      const selected = mod.selectHooks(tool).map((h) => h.name);
      expect(selected).toContain('zero-result-guard');
      expect(selected).toContain('tool-tracker');
      expect(selected).not.toContain('quality-gate');
      expect(selected).not.toContain('post-bash');
    }
    // The guard must not reach tools whose responses it cannot interpret.
    expect(mod.selectHooks('Edit').map((h) => h.name)).not.toContain('zero-result-guard');
  });

  // Positive end-to-end assertion: the guard's advice must survive the
  // dispatcher's spawn + mergeResults path, not merely exist in isolation.
  // `No matches found` is the string a live Grep returns for a zero-result
  // content-mode query (measured 2026-08-10).
  it('surfaces zero-result-guard advice through the merged dispatcher output', () => {
    const { stdout, status } = runDispatcher({
      tool: 'Grep',
      tool_name: 'Grep',
      tool_input: { pattern: 'resolveModel', path: 'src/', output_mode: 'content' },
      tool_response: 'No matches found',
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('[artibot:zero-result-guard]');
    expect(out.hookSpecificOutput.additionalContext).toContain('resolveModel');
    expect(out.decision).toBeUndefined();
  });

  it('selectHooks() routes Edit tool to quality-gate, post-edit-format, etc. + universal tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Edit').map((h) => h.name);
    expect(selected).toContain('quality-gate');
    expect(selected).toContain('post-edit-format');
    expect(selected).toContain('post-edit-recovery');
    expect(selected).toContain('post-write-tdd');
    expect(selected).toContain('mark-main-agent-edit');
    expect(selected).toContain('tool-tracker');
    // Edit should NOT fire post-bash or webfetch hooks.
    expect(selected).not.toContain('post-bash');
    expect(selected).not.toContain('webfetch-cache-post');
  });

  it('selectHooks() routes Bash to post-bash + post-bash-failure + tool-tracker only', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Bash').map((h) => h.name);
    expect(selected).toContain('post-bash');
    expect(selected).toContain('post-bash-failure');
    expect(selected).toContain('tool-tracker');
    expect(selected).not.toContain('quality-gate');
    expect(selected).not.toContain('post-edit-format');
  });

  it('selectHooks() routes Read to pre-write-guard + tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Read').map((h) => h.name);
    expect(selected).toContain('pre-write-guard');
    expect(selected).toContain('tool-tracker');
    expect(selected).not.toContain('quality-gate');
  });

  it('selectHooks() routes WebFetch to webfetch-cache-post + tool-tracker only', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('WebFetch').map((h) => h.name);
    expect(selected).toContain('webfetch-cache-post');
    expect(selected).toContain('tool-tracker');
    expect(selected).not.toContain('quality-gate');
  });

  it('selectHooks(null) still triggers the universal tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks(null).map((h) => h.name);
    expect(selected).toEqual(['tool-tracker']);
  });

  it('selectHooks() routes Skill to tool-used-record + tool-tracker only', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Skill').map((h) => h.name);
    expect(selected).toContain('tool-used-record');
    expect(selected).toContain('tool-tracker');
    expect(selected).not.toContain('quality-gate');
    expect(selected).not.toContain('pre-write-guard');
    // The writer must not ride along on tools it cannot name a skill for.
    for (const tool of ['Read', 'Edit', 'Bash', 'Grep']) {
      expect(mod.selectHooks(tool).map((h) => h.name)).not.toContain('tool-used-record');
    }
  });

  // SH-09. Two handlers, in table order: the universal tracker (which skips this
  // tool itself, SKIP_TOOLS) and the ledger writer. Nothing else may ride along.
  it('selectHooks() routes AskUserQuestion to tool-tracker + tool-used-record only (SH-09)', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    expect(mod.selectHooks('AskUserQuestion').map((h) => h.name))
      .toEqual(['tool-tracker', 'tool-used-record']);
  });

  /**
   * END-TO-END for the `tool.used` writer: the row must survive the REAL
   * dispatcher's spawn, not merely exist when the module is imported.
   *
   * This is the measurement SH-29 asked for. `tool.used` was a registered
   * event with no emitter — 0 rows of 1,052 in the live ledger, measured
   * 2026-09-15 ~10:5x KST — so nothing had ever proven a line could reach the
   * file through the dispatcher at all.
   *
   * A REJECTION IS ALSO A WRITTEN LINE (`ledger.rejected`), so counting rows
   * alone would read one as a success. Both streams are asserted.
   */
  it('writes one accepted tool.used row through the real dispatcher (Skill route)', () => {
    const { status } = runDispatcher({
      hook_event_name: 'PostToolUse',
      tool_name: 'Skill',
      tool_use_id: 'toolu_posttooluse_skill_1',
      session_id: 'sess-posttooluse-dispatcher-0001',
      cwd: ledgerRepo,
      tool_input: { skill: 'artibot:split' },
    });
    expect(status).toBe(0);

    const file = ledgerFilePath(ledgerRepo);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    const used = lines.filter((l) => l.event === 'tool.used');
    expect(used).toHaveLength(1);
    expect(used[0].data.skill).toBe('artibot:split');
    expect(used[0].data.tool).toBe('Skill');
    expect(used[0].source).toBe('hook');

    // SH-29 (O8=a1): the two carriers COEXIST on one dispatch and describe
    // different things — `tool.used` names the skill the host invoked,
    // `hook.fired` names the handlers Artibot ran because of it. The Skill
    // route selects exactly two, and the carrier is not one of them.
    const fired = lines.filter((l) => l.event === 'hook.fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].data.slot).toBe('PostToolUse');
    expect(fired[0].data.tool).toBe('Skill');
    expect(fired[0].data.hooks).toEqual(['tool-tracker', 'tool-used-record']);
    // STRICT on purpose: budgets are scaled (GENEROUS_TIMEOUT_SCALE), so a name
    // in `failed` is a real timeout or spawn error, not a slow machine.
    expect(fired[0].data.failed).toEqual([]);
    expect(fired[0].data.count).toBe(2);
    expect(fired[0].data.hooks).not.toContain('_hook-fired-record');
    expect(fired[0].action_id).toBe('toolu_posttooluse_skill_1');
    expect(fired[0].source).toBe('hook');
  });

  /**
   * END-TO-END for the SH-09 AskUserQuestion carrier: the row must survive the
   * REAL dispatcher's spawn, not merely exist when the module is imported.
   *
   * SH-09's purpose is the question-frequency EFFECT of the constitution stage B
   * change, and that had no live carrier: `human.asked` rows are guard blocks,
   * not questions. One `tool.used` row per question call is the carrier.
   *
   * MUTE: the dispatcher merges every child's stdout into hook output the host
   * acts on, so stdout is asserted EMPTY, not merely valid JSON. A REJECTION IS
   * ALSO A WRITTEN LINE, so `ledger.rejected` is asserted empty on its own.
   *
   * WHAT THIS DOES NOT PROVE: the payload is the DOCUMENT-BASED fixture, so it
   * shows the pipeline works for the documented shape, not that the host sends it.
   */
  it('writes one accepted tool.used row through the real dispatcher (AskUserQuestion route, SH-09)', () => {
    const repo = makeLedgerRepo('ask-e2e');
    const { stdout, status } = runDispatcher({ ...structuredClone(ASK_FIXTURE.payload), cwd: repo });
    expect(status).toBe(0);
    expect(stdout).toBe('');

    const lines = readLedger(repo);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    const used = lines.filter((l) => l.event === 'tool.used');
    expect(used).toHaveLength(1);
    expect(used[0].data).toEqual({ tool: 'AskUserQuestion', ok: true, duration_ms: 15234 });
    expect(used[0].source).toBe('hook');
    expect(used[0].action_id).toBe(ASK_FIXTURE.payload.tool_use_id);

    // The two carriers COEXIST on one dispatch and describe different things:
    // `tool.used` names the tool the host ran, `hook.fired` names the handlers
    // Artibot ran because of it.
    const fired = lines.filter((l) => l.event === 'hook.fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].data.tool).toBe('AskUserQuestion');
    expect(fired[0].data.hooks).toEqual(['tool-tracker', 'tool-used-record']);
    // STRICT on purpose, same reason as the Skill route above.
    expect(fired[0].data.failed).toEqual([]);
    expect(fired[0].data.count).toBe(2);
  });

  // FAIL OPEN, through the dispatcher. A recording failure must not surface as a
  // non-zero exit or as stdout, whichever child hit it.
  it('exits 0 and stays silent through the dispatcher when the ledger cannot be written (SH-09)', () => {
    const blocked = makeLedgerRepo('ask-blocked');
    writeFileSync(path.dirname(ledgerFilePath(blocked)), 'not a dir', 'utf-8');
    const { stdout, status } = runDispatcher({ ...structuredClone(ASK_FIXTURE.payload), cwd: blocked });
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(ledgerFilePath(blocked))).toBe(false);
  });

  /**
   * END-TO-END for the `hook.fired` carrier on the busiest PostToolUse route.
   *
   * ONE ROW PER DISPATCH, NOT ONE PER HANDLER (owner O8=a1, 2026-09-17). An
   * Edit payload runs six handlers; the rejected alternative would have written
   * six lines for one tool call. The row count is therefore the assertion that
   * carries the decision, and `data.hooks` is what keeps the identities the
   * Existence Audit needs (`lib/replay/existence-audit.js#CARRIERS.hooks` was
   * null until this event existed).
   *
   * A REJECTION IS ALSO A WRITTEN LINE (`ledger.rejected`) — the arrays in
   * `data` are the first arrays any Artibot ledger event carries, so both
   * streams are asserted rather than the row count alone.
   */
  it('writes exactly one accepted hook.fired row per Edit dispatch (6 handlers folded in)', () => {
    const repo = makeLedgerRepo('fired-edit');
    const { status } = runDispatcher({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'x.js' },
      tool_use_id: 'toolu_posttooluse_edit_1',
      session_id: 'sess-posttooluse-dispatcher-0002',
      cwd: repo,
    });
    expect(status).toBe(0);

    const lines = readLedger(repo);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    const fired = lines.filter((l) => l.event === 'hook.fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].data.slot).toBe('PostToolUse');
    expect(fired[0].data.tool).toBe('Edit');
    expect(fired[0].data.count).toBe(6);
    expect([...fired[0].data.hooks].sort()).toEqual([
      'mark-main-agent-edit', 'post-edit-format', 'post-edit-recovery',
      'post-write-tdd', 'quality-gate', 'tool-tracker',
    ]);
    // STRICT on purpose, same reason as the Skill route above. This is the case
    // that lost the race in CI: post-write-tdd has the tightest Edit budget.
    expect(fired[0].data.failed).toEqual([]);
    // Edit selects no `tool.used` writer, so the two carriers are independent.
    expect(lines.filter((l) => l.event === 'tool.used')).toEqual([]);
  });

  /**
   * FAIL-CLOSED, and silent. A payload with no session id cannot produce a
   * mission id, so `buildHookFiredEnvelope` returns null and NOTHING is
   * written — not a partial row, and not a `ledger.rejected` either, because
   * the carrier never hands the writer an envelope it knows is incomplete.
   * The dispatcher still exits 0 and still merges its handlers' stdout.
   */
  it('writes no hook.fired row when the payload names no session', () => {
    const repo = makeLedgerRepo('fired-nosession');
    const { status } = runDispatcher({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'x.js' },
      cwd: repo,
    });
    expect(status).toBe(0);
    expect(readLedger(repo)).toEqual([]);
  });

  it('selectHooks() routes MultiEdit to mark-main-agent-edit + tool-tracker', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('MultiEdit').map((h) => h.name);
    expect(selected).toContain('mark-main-agent-edit');
    expect(selected).toContain('tool-tracker');
  });

  /**
   * Isolation self-check — asserted, not assumed.
   *
   * STRUCTURAL, not data-driven: the cwd handed to the dispatcher is not
   * inside any git repository, so every `git rev-parse --show-toplevel` a
   * grand-child runs from it fails and the hook returns before reading or
   * writing. That is what makes the isolation independent of a mutable flag —
   * see `sessionstart-dispatcher.test.js`, where gating on data was the bug.
   *
   * The second half re-reads the working tree afterwards: a hook that writes
   * a formatted file or a recovery artifact into the checkout would show up
   * as a `git status --porcelain` line. `-z` because this repository has
   * Korean paths and `core.quotepath` is on by default — the byte count is
   * compared, not a parsed list, so the assertion needs no path decoding.
   *
   * WHAT THIS DOES NOT COVER: writes a hook reaches by absolute path rather
   * than through HOME or cwd. `CLAUDE_PLUGIN_ROOT` still points at the real
   * plugin, so writes under `plugins/artibot/runtime/` still land in the repo;
   * they are gitignored (`plugins/artibot/.gitignore:10`) and therefore
   * invisible to porcelain, which is why they are left alone. It also cannot
   * see a concurrent operator edit — a failure here means read the diff
   * before assuming the dispatcher did it.
   */
  it('leaves the real repository untouched (non-git cwd, working tree unchanged)', () => {
    // Read through spawnOptions(), never from `sandboxCwd` directly — that is
    // what makes this assertion go red if the spawn cwd is pointed back at
    // the checkout.
    expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: spawnOptions().cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })).toThrow();

    const porcelain = () => {
      try {
        return execFileSync('git', ['status', '--porcelain', '-z'], {
          cwd: PLUGIN_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        return '';
      }
    };

    const before = porcelain();
    const { status } = runDispatcher({
      tool: 'Edit',
      tool_input: { file_path: '/tmp/nonexistent.txt', old_string: 'a', new_string: 'b' },
    });
    expect(status).toBe(0);
    expect(porcelain()).toBe(before);
  });
});

/**
 * Preload for NODE_OPTIONS=--require, written into the sandbox home by the
 * suite below. It busy-waits before ONE named hook script runs and touches
 * nothing else: it keys on the script's basename inside a `hooks` directory,
 * so the dispatcher (its file name starts with an underscore), vitest, git and
 * every sibling handler are unaffected. Atomics.wait blocks synchronously, so
 * the delay does not depend on scheduling or on how busy the machine is.
 */
const HOOK_DELAY_PRELOAD = [
  "'use strict';",
  "const path = require('node:path');",
  "const file = String(process.argv[1] || '');",
  "const only = String(process.env.ARTIBOT_TEST_HOOK_DELAY_ONLY || '').split(',').filter(Boolean);",
  'const ms = Number(process.env.ARTIBOT_TEST_HOOK_DELAY_MS || 0);',
  "const inHooksDir = path.basename(path.dirname(file)) === 'hooks';",
  "if (ms > 0 && inHooksDir && only.includes(path.basename(file, '.js'))) {",
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
  '}',
].join('\n');

/**
 * DELAY INJECTION -- the deterministic half of the timeout accounting.
 *
 * The `hook.fired` cases above prove `failed` is `[]` when nothing is slow. They
 * cannot prove the field means anything: if the dispatcher stopped recording
 * timeouts, or the budget scale leaked into the default path, they would stay
 * green. These cases make ONE handler slow on purpose, by a fixed amount instead
 * of by machine load, and check that the accounting moves in both directions:
 *
 *   shipped budgets (scale unset)  + a delay past the budget -> the handler IS in `failed`
 *   scaled budgets  (the default)  + the same delay          -> `failed` is `[]`
 *
 * Why the first is deterministic: the child cannot exit before the delay has
 * elapsed, and the dispatcher's timer for it started before the child did. The
 * delay is derived from the dispatch table (budget + margin), so a budget change
 * moves the pin with it instead of quietly making it vacuous. The child is
 * killed at its budget in that case, so a large margin costs no test time there.
 *
 * WHAT THIS DOES NOT SEE. It fixes one handler (post-write-tdd, the tightest
 * budget on the Edit route) on one route, and says nothing about how often a real
 * cold start beats a real budget; that is a load question. Load can ADD names to
 * `failed`, so the positive case asserts inclusion and shape, never equality.
 * The one way this pin can fail on a healthy tree is a dispatcher process
 * descheduled for longer than DELAY_MARGIN_MS while its timer and the child's
 * exit both fall due; the margin is sized against that, not proven against it.
 */
describe('_posttooluse-dispatcher timeout accounting (delay injection)', () => {
  /**
   * Past the budget by enough that the delayed child cannot beat the timer. The
   * timer is due at most `budget` after spawn; the child cannot exit before
   * `budget + margin` after spawn. 1.5 s is a margin, not a measurement: under
   * the 16-parallel harness a whole dispatch took ~9-11 s, but how late an
   * already-running dispatcher wakes under that load was not measured.
   */
  const DELAY_MARGIN_MS = 1500;
  let preloadPath;

  beforeAll(() => {
    preloadPath = path.join(sandboxHome, 'delay-hook-preload.cjs');
    writeFileSync(preloadPath, HOOK_DELAY_PRELOAD, 'utf-8');
  });

  /** One Edit dispatch with post-write-tdd held back for (budget + margin) ms. */
  async function editWithSlowPostWriteTdd(tag, env) {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const budget = mod.HOOKS.find((h) => h.name === 'post-write-tdd').timeoutMs;
    const repo = makeLedgerRepo(tag);
    const preload = `--require "${preloadPath.split(path.sep).join('/')}"`;
    const { status } = runDispatcher({
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'x.js' },
      tool_use_id: `toolu_posttooluse_${tag}`,
      session_id: 'sess-posttooluse-dispatcher-0003',
      cwd: repo,
    }, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
      ARTIBOT_TEST_HOOK_DELAY_ONLY: 'post-write-tdd',
      ARTIBOT_TEST_HOOK_DELAY_MS: String(budget + DELAY_MARGIN_MS),
      ...env,
    });
    const lines = readLedger(repo);
    return { status, budget, lines, fired: lines.filter((l) => l.event === 'hook.fired') };
  }

  it('records a handler that outruns its SHIPPED budget in data.failed (scale unset)', async () => {
    const { status, budget, lines, fired } = await editWithSlowPostWriteTdd('slow-shipped', {
      ARTIBOT_DISPATCH_TIMEOUT_SCALE: undefined,
    });
    expect(status).toBe(0);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    expect(fired).toHaveLength(1);

    const { count, failed, hooks } = fired[0].data;
    expect(count).toBe(6);
    // POSITIVE PIN. This is what makes `failed: []` elsewhere in this file mean
    // something: the same field does go non-empty when a handler is too slow.
    expect(failed, `post-write-tdd was held past its ${budget}ms budget`).toContain('post-write-tdd');
    // Shape that holds under any load: load can add names, it cannot invent one.
    expect(new Set(failed).size).toBe(failed.length);
    expect(failed.every((name) => hooks.includes(name))).toBe(true);
  });

  it('keeps data.failed strictly empty for the SAME slow handler under scaled budgets', async () => {
    const { status, lines, fired } = await editWithSlowPostWriteTdd('slow-scaled', {});
    expect(status).toBe(0);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    expect(fired).toHaveLength(1);
    expect(fired[0].data.count).toBe(6);
    // Strict, and load-proof: the handler is late by design, yet inside 10x its budget.
    expect(
      fired[0].data.failed,
      'a slow handler inside the scaled budget must not be reported; is ARTIBOT_DISPATCH_TIMEOUT_SCALE still set by spawnOptions()?',
    ).toEqual([]);
  });
});

/**
 * Preload for NODE_OPTIONS=--require: in the ONE process whose script basename
 * equals ARTIBOT_TEST_TIMER_SPY_ONLY it appends every setTimeout delay to
 * ARTIBOT_TEST_TIMER_SPY_FILE, then arms the real timer unchanged. The handlers
 * the dispatcher spawns inherit NODE_OPTIONS but never match that basename.
 */
const TIMER_SPY_PRELOAD = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const only = String(process.env.ARTIBOT_TEST_TIMER_SPY_ONLY || '');",
  "const out = String(process.env.ARTIBOT_TEST_TIMER_SPY_FILE || '');",
  "if (only && out && path.basename(String(process.argv[1] || '')) === only) {",
  '  const real = globalThis.setTimeout;',
  '  const spy = function setTimeout(fn, ms, ...rest) {',
  "    try { fs.appendFileSync(out, String(ms) + '\\n'); } catch { /* ignore */ }",
  '    return real.call(this, fn, ms, ...rest);',
  '  };',
  // Carry util.promisify.custom (a symbol) over so nothing promisifying setTimeout notices.
  '  for (const sym of Object.getOwnPropertySymbols(real)) spy[sym] = real[sym];',
  '  globalThis.setTimeout = spy;',
  '}',
].join('\n');

/**
 * POSITIVE control for the opt-in: the test-only budget scale IS applied on this
 * dispatcher, the one place it is meant to be (the Stop and SubagentStop suites
 * hold the matching negative case). It reads the delay the DISPATCHER hands to
 * setTimeout for each selected handler, armed synchronously at spawn, so it does
 * not depend on machine load. Unlike the delay-injection pair above it is also red
 * for a change that keeps the behaviour but drops the scale or the opt-in. Only the
 * Edit route is driven.
 */
describe('_posttooluse-dispatcher under the test-only budget scale (timer spy)', () => {
  let preloadPath;

  beforeAll(() => {
    preloadPath = path.join(sandboxHome, 'timer-spy-preload.cjs');
    writeFileSync(preloadPath, TIMER_SPY_PRELOAD, 'utf-8');
  });

  it('arms every Edit-route handler at 10x its declared budget with the scale at its cap', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    const selected = mod.selectHooks('Edit');
    expect(selected.length, 'the Edit route selects handlers').toBeGreaterThan(0);
    const declared = selected.map((h) => h.timeoutMs);
    const scaled = declared.map((ms) => ms * 10);
    expect(scaled.filter((ms) => declared.includes(ms))).toEqual([]);

    const spyFile = path.join(sandboxHome, 'timer-spy-posttooluse-cap.txt');
    const preload = `--require "${preloadPath.split(path.sep).join('/')}"`;
    const { status } = runDispatcher({
      tool: 'Edit',
      tool_input: { file_path: '/tmp/nonexistent.txt', old_string: 'a', new_string: 'b' },
    }, {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
      ARTIBOT_TEST_TIMER_SPY_ONLY: '_posttooluse-dispatcher.js',
      ARTIBOT_TEST_TIMER_SPY_FILE: spyFile,
      ARTIBOT_DISPATCH_TIMEOUT_SCALE: '10',
    });
    const armed = existsSync(spyFile)
      ? readFileSync(spyFile, 'utf-8').split('\n').filter(Boolean).map(Number)
      : [];

    expect(status).toBe(0);
    // Inclusion of the 10x values: an empty spy file, or a dispatcher that dropped
    // the opt-in (and so armed the declared budgets), both fail this line.
    expect(armed).toEqual(expect.arrayContaining(scaled));
  });
});
