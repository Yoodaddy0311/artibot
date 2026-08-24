#!/usr/bin/env node
/**
 * Squash WIP commits into a single commit on the current branch.
 *
 * Used as the backing implementation for the `/squash` slash command and for
 * manual invocation. The flow is intentionally simple — no interactive
 * rebase — so it works reliably across platforms and inside CI:
 *
 *   1. Resolve the range of contiguous WIP commits at the tip of HEAD
 *      (or starting from `--from <ref>` when provided).
 *   2. ABORT if any non-WIP commit is interleaved. The user's intentional
 *      work is never silently rewritten.
 *   3. `git reset --soft <baseRef>` to collapse changes into the index.
 *   4. `git commit -m "<message>"` with a synthesized message (or
 *      `--message` override) to create the single squashed commit.
 *
 * Safety:
 *   - `--dry-run` prints the plan and exits 0 without mutating the repo.
 *   - The squash refuses to run with uncommitted working-tree changes so
 *      partial work cannot be folded into the squash commit unintentionally.
 *   - All git invocations use windowsHide + explicit cwd.
 *   - The CLI entry check goes through `isMainEntry` (scripts/hooks/_main-entry.js),
 *      which is the part that survives a Korean install path or a junction.
 *      It used to be an inline `fileURLToPath(import.meta.url)` compare here;
 *      that symbol is gone from this file, so do not look for it.
 *
 * Exit codes:
 *   0  — success or dry-run
 *   1  — abort (mixed non-WIP commits, dirty tree, or git error)
 *   2  — no WIP commits found (nothing to squash)
 *
 * @module scripts/squash-wip
 */

import { execFileSync } from 'node:child_process';
import { isWipSubject } from '../lib/autopilot/wip-stats.js';
import { isMainEntry } from './hooks/_main-entry.js';

/**
 * Default git runner used by the CLI. Injectable for tests.
 *
 * Uses `execFileSync` with an args array so user-supplied tokens
 * (`--from <ref>`, `-m <msg>`) are passed as discrete argv entries and never
 * interpolated into a shell string — backticks, semicolons, and other shell
 * metacharacters are inert.
 *
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
function defaultGit(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * Parse argv into an options object. Recognized:
 *   --from <ref>     Start ref to walk from (default: HEAD~N where N is
 *                    auto-detected from the contiguous WIP run).
 *   --message <txt>  Override the synthesized squash message.
 *   --dry-run        Print plan and exit without mutating.
 *   --help           Print usage and exit 0.
 *
 * @param {string[]} argv
 * @returns {{ from: string | null, message: string | null, dryRun: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { from: null, message: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--from') { out.from = argv[++i] ?? null; }
    else if (arg === '--message' || arg === '-m') { out.message = argv[++i] ?? null; }
  }
  return out;
}

/**
 * Walk HEAD downward and collect the contiguous WIP run starting at HEAD.
 * Returns an array of objects ordered newest → oldest. Stops at the first
 * non-WIP commit. An optional `from` ref limits the walk so the caller can
 * scope to a range.
 *
 * @param {{ from?: string | null, git?: (args: string[], opts?: object) => string, cwd?: string }} [opts]
 * @returns {{ commits: Array<{ sha: string, subject: string }>, sawNonWipBeforeWip: boolean }}
 */
export function collectWipRun(opts = {}) {
  const git = opts.git ?? defaultGit;
  const range = opts.from ? `${opts.from}..HEAD` : 'HEAD';
  let out;
  try {
    out = git(['log', '--pretty=%H%x09%s', range, '--'], { cwd: opts.cwd });
  } catch {
    return { commits: [], sawNonWipBeforeWip: false };
  }
  if (!out) return { commits: [], sawNonWipBeforeWip: false };

  // git log emits newest first. Walk top-down and accept while WIP. Any
  // non-WIP commit after a WIP commit (i.e. interleaved) is the abort signal.
  const lines = out.split('\n').filter(Boolean);
  const commits = [];
  let hitNonWip = false;
  for (const line of lines) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (isWipSubject(subject)) {
      if (hitNonWip) {
        // Non-WIP commit sat between WIP commits — abort signal for caller.
        return { commits, sawNonWipBeforeWip: true };
      }
      commits.push({ sha, subject });
    } else {
      // Stop the contiguous run; record that more history exists.
      hitNonWip = true;
    }
  }
  return { commits, sawNonWipBeforeWip: false };
}

/**
 * Check whether the working tree is clean. Returns true when there are no
 * staged or unstaged changes (untracked files are allowed since `git reset
 * --soft` won't touch them).
 *
 * @param {{ git?: (args: string[], opts?: object) => string, cwd?: string }} [opts]
 * @returns {boolean}
 */
export function isWorkingTreeClean(opts = {}) {
  const git = opts.git ?? defaultGit;
  try {
    const out = git(['status', '--porcelain', '--untracked-files=no'], { cwd: opts.cwd });
    return out.trim().length === 0;
  } catch {
    // On git failure assume dirty — refuse to squash.
    return false;
  }
}

/**
 * Build a default squash commit message from the collected run.
 *
 * @param {Array<{ subject: string }>} commits
 * @returns {string}
 */
function defaultSquashMessage(commits) {
  const head = `wip: squashed ${commits.length} commit(s)`;
  const summary = commits
    .slice(0, 10)
    .map((c) => `  - ${c.subject}`)
    .join('\n');
  const tail = commits.length > 10 ? `\n  - (+${commits.length - 10} more)` : '';
  return `${head}\n\n${summary}${tail}\n`;
}

/**
 * Run the squash. Returns a structured result for callers (tests + CLI).
 *
 * @param {{
 *   from?: string | null,
 *   message?: string | null,
 *   dryRun?: boolean,
 *   git?: (args: string[], opts?: object) => string,
 *   cwd?: string,
 * }} [opts]
 * @returns {{
 *   status: 'ok' | 'dry-run' | 'nothing-to-do' | 'abort-mixed' | 'abort-dirty' | 'error',
 *   message: string,
 *   squashed?: number,
 *   baseRef?: string,
 * }}
 */
export function runSquash(opts = {}) {
  const git = opts.git ?? defaultGit;
  const cwd = opts.cwd;
  const dryRun = !!opts.dryRun;

  if (!isWorkingTreeClean({ git, cwd })) {
    return {
      status: 'abort-dirty',
      message: 'Working tree has uncommitted changes. Commit or stash them before running /squash.',
    };
  }

  const { commits, sawNonWipBeforeWip } = collectWipRun({ from: opts.from ?? null, git, cwd });
  if (sawNonWipBeforeWip) {
    return {
      status: 'abort-mixed',
      message: 'Non-WIP commit(s) are interleaved with WIP commits. Aborting to protect your work — '
        + 'rebase manually or use --from <ref> to scope the squash to the WIP-only tail.',
    };
  }
  if (commits.length === 0) {
    return { status: 'nothing-to-do', message: 'No WIP commits at HEAD — nothing to squash.' };
  }
  if (commits.length === 1 && !opts.from) {
    return {
      status: 'nothing-to-do',
      message: 'Only one WIP commit at HEAD — squash would be a no-op.',
    };
  }

  const baseRef = `HEAD~${commits.length}`;
  const message = opts.message?.trim() || defaultSquashMessage(commits);

  if (dryRun) {
    return {
      status: 'dry-run',
      message: `Would squash ${commits.length} WIP commit(s) into a single commit on top of ${baseRef}.`,
      squashed: commits.length,
      baseRef,
    };
  }

  try {
    git(['reset', '--soft', baseRef], { cwd });
    git(['commit', '-m', message], { cwd });
  } catch (err) {
    return {
      status: 'error',
      message: `git failed during squash: ${err.message || String(err)}`,
    };
  }

  return {
    status: 'ok',
    message: `Squashed ${commits.length} WIP commit(s) into a single commit on top of ${baseRef}.`,
    squashed: commits.length,
    baseRef,
  };
}

/**
 * Print usage help.
 */
function printHelp() {
  process.stdout.write(
    'Usage: node scripts/squash-wip.mjs [--from <ref>] [--message <text>] [--dry-run]\n'
    + '\n'
    + 'Squashes contiguous WIP commits at HEAD into a single commit.\n'
    + 'Aborts if non-WIP commits are interleaved or the working tree is dirty.\n',
  );
}

/**
 * Map a runSquash result.status to a process exit code.
 *
 * @param {string} status
 * @returns {number}
 */
function exitCodeFor(status) {
  if (status === 'ok' || status === 'dry-run') return 0;
  if (status === 'nothing-to-do') return 2;
  return 1;
}

/**
 * CLI main. Exported for tests.
 *
 * @param {string[]} argv
 * @param {{ git?: (args: string[], opts?: object) => string, cwd?: string }} [opts]
 * @returns {{ code: number, status: string, message: string }}
 */
export function main(argv, opts = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return { code: 0, status: 'help', message: '' };
  }
  const result = runSquash({
    from: args.from,
    message: args.message,
    dryRun: args.dryRun,
    git: opts.git,
    cwd: opts.cwd,
  });
  const code = exitCodeFor(result.status);
  return { code, status: result.status, message: result.message };
}

// CLI entry — only when this file is the launched script (not under import).
// Korean-path AND junction/symlink safe: see scripts/hooks/_main-entry.js.
const isCliEntry = isMainEntry(import.meta.url);

if (isCliEntry) {
  const { code, message } = main(process.argv.slice(2));
  if (message) process.stdout.write(`${message}\n`);
  process.exit(code);
}
