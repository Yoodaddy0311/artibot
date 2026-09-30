/**
 * Shared fixtures for the gate-state suites that spawn the REAL hook scripts
 * (`gate-state-project-scope.test.js`, `stop-review-gate-state.test.js`,
 * `pre-write-guard-state.test.js`).
 *
 * Underscore-prefixed so vitest does not collect it and the review gate's
 * "code without tests" scan skips it (`stop-review-gate.js#checkMissingTests`).
 *
 * WHY REAL PROCESSES. The defect under test is cross-process by nature: one
 * hook process leaves a file, a different process (another project, another
 * session, another plugin version) reads it. A mocked filesystem would let the
 * test and the code agree on a path while production disagrees — the failure
 * mode `rules/verification-discipline.md` §9 names. Every case here therefore
 * builds throwaway git repos and spawns the script the way the dispatcher does:
 * payload on stdin, `CLAUDE_PLUGIN_ROOT` in the environment, cwd = the project.
 *
 * THE "PLUGIN ROOT" IS A THROWAWAY DIRECTORY, SHARED BY EVERY PROJECT A CASE
 * BUILDS. That is the production shape: one installed plugin, many projects.
 * Passing a DIFFERENT throwaway root for a later spawn models a plugin update
 * (each version is its own directory).
 *
 * WHAT THIS CANNOT SEE: the live hook dispatcher wiring (`hooks/hooks.json`),
 * Claude Code's real payload (only the keys the hooks read are sent), and any
 * filesystem where `git worktree` or `mkdtemp` behaves differently from this
 * machine's.
 *
 * @module tests/hooks/_gate-state-harness
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `scripts/hooks` of the plugin under test. */
export const HOOKS_DIR = path.resolve(HERE, '../../scripts/hooks');

/** Absolute path of one hook script. */
export const hookPath = (name) => path.join(HOOKS_DIR, name);

/**
 * Run git with an explicit cwd; throws with git's own words on failure.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} trimmed stdout
 */
export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

/**
 * Canonical spelling of an existing path (resolves Windows 8.3 short names).
 *
 * @param {string} p
 * @returns {string}
 */
export function canonical(p) {
  return realpathSync.native(p);
}

/**
 * A throwaway temp directory, registered for cleanup.
 *
 * @param {string[]} created registry the caller empties in `afterEach`
 * @param {string} label
 * @returns {string}
 */
export function makeDir(created, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `gate-it-${label}-`));
  created.push(dir);
  return dir;
}

/**
 * A throwaway git repo that `isArtibotRepo()` accepts (`plugins/artibot/CLAUDE.md`).
 *
 * `tracked.txt` is committed, then — unless `dirty: false` — modified, so
 * `git diff HEAD` lists exactly one changed file. `extraCommit` adds a SECOND
 * commit that introduces `plugins/artibot/lib/widget.js` (a `console.log` and no
 * test), which is what the review gate's `HEAD~1..HEAD` scan flags.
 *
 * @param {string[]} created
 * @param {string} label
 * @param {{ dirty?: boolean, artibot?: boolean, extraCommit?: boolean }} [opts]
 * @returns {string} repo root
 */
export function makeRepo(created, label, opts = {}) {
  const { dirty = true, artibot = true, extraCommit = false } = opts;
  const repo = makeDir(created, label);
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  git(['config', 'core.autocrlf', 'false'], repo);
  const seeds = ['tracked.txt'];
  writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
  if (artibot) {
    mkdirSync(path.join(repo, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(repo, 'plugins', 'artibot', 'CLAUDE.md'), '# stub\n');
    seeds.push('plugins/artibot/CLAUDE.md');
  }
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(path.join(repo, 'src', 'b.js'), 'export const b = 2;\n');
  seeds.push('src/a.js', 'src/b.js');
  git(['add', ...seeds], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  if (extraCommit) {
    mkdirSync(path.join(repo, 'plugins', 'artibot', 'lib'), { recursive: true });
    // The flagged call is assembled so this helper does not itself contain the
    // pattern the review gate (and the PostToolUse quality gate) scan for.
    const flagged = ['console', 'log'].join('.');
    writeFileSync(
      path.join(repo, 'plugins', 'artibot', 'lib', 'widget.js'),
      `export function widget() {\n  ${flagged}('x');\n}\n`,
    );
    git(['add', 'plugins/artibot/lib/widget.js'], repo);
    git(['commit', '-q', '-m', 'add widget'], repo);
  }
  if (dirty) writeFileSync(path.join(repo, 'tracked.txt'), `dirty ${Date.now()}\n`);
  return repo;
}

/**
 * Spawn a hook script exactly the way the dispatchers do.
 *
 * @param {string} script absolute path ({@link hookPath})
 * @param {object} payload stdin JSON
 * @param {{ cwd: string, pluginRoot: string, env?: Record<string, string|undefined> }} ctx
 * @returns {{ status: number|null, stdout: string, stderr: string, timedOut: boolean }}
 *   `timedOut` is true when THIS harness killed the process at its own limit
 */
export function runHook(script, payload, { cwd, pluginRoot, env = {} }) {
  const childEnv = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    ...env,
  };
  delete childEnv.ARTIBOT_DEV_VERIFY_MODE;
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) delete childEnv[key];
  }
  const r = spawnSync(process.execPath, [script], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    windowsHide: true,
    timeout: SPAWN_LIMIT_MS,
    env: childEnv,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

/**
 * WHAT A BUSY HOST DOES TO THESE CASES, AND WHAT THE HARNESS WILL NOT LET IT DO.
 *
 * Every gate gives each of its git calls 5 s (`execSync({ timeout: 5000 })`) and,
 * when one times out, carries on as if git had said nothing — no repo root, or no
 * changed files — and the dispatchers kill a child at its own budget (8 s for the
 * DEV verify gate). On a host busy enough, that is a LOAD symptom, not a verdict.
 * Observed while this suite ran next to other full test runs: `spawnSync cmd.exe
 * ETIMEDOUT` in the gate's stderr, a dispatcher's `timed out after 8000ms`, and
 * spawns that never finished inside this file's own limit. Left alone it turns a
 * case that expects "fires" into a failure and, worse, a case that expects silence
 * into a VACUOUS pass.
 *
 * So a spawn is INCONCLUSIVE, and is run again, when it printed NO decision and
 *   - this harness killed it (`timedOut`), or
 *   - its stderr carries one of the symptoms above, or
 *   - the caller's own `inconclusive(result)` says the gate saw nothing it should
 *     have seen (the review gate reporting "no changes" in a repo that has some).
 * A spawn that DID print a decision is taken as it is, even when it also logged a
 * timeout or was killed afterwards: it already consumed its fire (saved its
 * fingerprint before printing), and running it again would answer "quiet".
 * Inconclusive after the last attempt, it THROWS — a case that expects silence
 * must not pass on a gate that never got to look.
 *
 * WHAT THIS CANNOT SEE: a git call that timed out WITHOUT saying so (the repo-root
 * and HEAD lookups swallow their errors). A silently wrong `HEAD` makes a
 * fingerprint differ once; no stderr betrays it, so it cannot be retried here.
 */
const LOAD_SYMPTOM = /ETIMEDOUT|timed out after/;
const ATTEMPTS = 3;
const SPAWN_LIMIT_MS = 120_000;

/**
 * {@link runHook}, run again while the answer is inconclusive.
 *
 * @param {string} script
 * @param {object} payload
 * @param {{ cwd: string, pluginRoot: string, env?: Record<string, string|undefined> }} ctx
 * @param {{ inconclusive?: (result: object) => boolean }} [opts] the caller's own test
 * @returns {{ status: number|null, stdout: string, stderr: string, timedOut: boolean }}
 * @throws {Error} when every attempt was inconclusive
 */
export function runHookPatiently(script, payload, ctx, opts = {}) {
  const silent = (r) => r.stdout.trim() === '';
  const inconclusive = (r) => (silent(r) && (r.timedOut || LOAD_SYMPTOM.test(r.stderr)))
    || (typeof opts.inconclusive === 'function' && opts.inconclusive(r));
  let result = runHook(script, payload, ctx);
  for (let attempt = 2; attempt <= ATTEMPTS && inconclusive(result); attempt += 1) {
    result = runHook(script, payload, ctx);
  }
  if (inconclusive(result)) {
    throw new Error(
      `${path.basename(script)} gave no usable answer in ${ATTEMPTS} attempts (host too busy?): `
      + `timedOut=${result.timedOut} stdout=${result.stdout.trim().slice(0, 120)} `
      + `stderr=${result.stderr.trim().slice(0, 300)}`,
    );
  }
  return result;
}

/**
 * The main-agent Edit that `mark-main-agent-edit.js` listens for.
 *
 * @param {string} repo project whose file was edited (also the payload `cwd`)
 * @param {string} pluginRoot
 * @param {string} sessionId
 * @param {{ cwd?: string, processCwd?: string, extra?: object }} [opts] `cwd` is what
 *   the payload reports and, unless `processCwd` is given, where the hook process
 *   runs; `processCwd` runs the PROCESS somewhere else (the host's payload `cwd` and
 *   a hook's own working directory are two facts that can differ); `extra` merges
 *   into the payload
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
export function runEdit(repo, pluginRoot, sessionId, opts = {}) {
  const cwd = opts.cwd ?? repo;
  return runHookPatiently(hookPath('mark-main-agent-edit.js'), {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(repo, 'tracked.txt') },
    session_id: sessionId,
    cwd,
    ...(opts.extra ?? {}),
  }, { cwd: opts.processCwd ?? cwd, pluginRoot });
}

/**
 * A Stop event for the DEV verify gate.
 *
 * @param {string} repo
 * @param {string} pluginRoot
 * @param {string} sessionId
 * @param {{ cwd?: string, processCwd?: string }} [opts] payload `cwd` / process cwd,
 *   as for {@link runEdit}
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
export function runDevVerifyStop(repo, pluginRoot, sessionId, opts = {}) {
  const cwd = opts.cwd ?? repo;
  return runHookPatiently(hookPath('dev-verify-gate.js'), {
    hook_event_name: 'Stop',
    stop_hook_active: false,
    session_id: sessionId,
    cwd,
  }, { cwd: opts.processCwd ?? cwd, pluginRoot });
}

/**
 * A Stop event for the review gate.
 *
 * `expectChanges` (default true) says the repo has a change for the gate to see.
 * The gate swallows its git errors, so a timed-out `git diff` reads as "no changes
 * to review" — an approve that is not an answer about THIS repo — and that is
 * treated as inconclusive. A case that really expects an empty diff passes false.
 *
 * @param {string} repo
 * @param {string} pluginRoot
 * @param {string} sessionId
 * @param {{ expectChanges?: boolean, processCwd?: string }} [opts] `processCwd` runs the
 *   process somewhere other than the payload's `cwd` (see {@link runEdit})
 * @returns {{ status: number|null, stdout: string, stderr: string, timedOut: boolean }}
 */
export function runReviewStop(repo, pluginRoot, sessionId, opts = {}) {
  const { expectChanges = true } = opts;
  const sawNothing = (r) => /No changes to review|No changed files detected|Not in a git repository/
    .test(`${r.stdout}\n${r.stderr}`);
  return runHookPatiently(hookPath('stop-review-gate.js'), {
    hook_event_name: 'Stop',
    stop_hook_active: false,
    session_id: sessionId,
    cwd: repo,
  }, { cwd: opts.processCwd ?? repo, pluginRoot }, { inconclusive: expectChanges ? sawNothing : undefined });
}

/**
 * Did this Stop output BLOCK? Parsed, not substring-matched, so an error
 * message that happens to contain the word cannot pass for a decision.
 *
 * @param {string} stdout
 * @returns {boolean}
 */
export function blocked(stdout) {
  if (!stdout.trim()) return false;
  try {
    return JSON.parse(stdout).decision === 'block';
  } catch {
    return false;
  }
}

/**
 * Remove every registered directory (best effort; Windows may hold a handle).
 *
 * @param {string[]} created emptied in place
 */
export function cleanup(created) {
  while (created.length > 0) {
    const dir = created.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
