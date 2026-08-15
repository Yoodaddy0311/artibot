#!/usr/bin/env node
/**
 * Installs the Artibot git hooks by copying them into `.git/hooks/`.
 *
 * WHY A COPY AND NOT `core.hooksPath`
 *
 * `core.hooksPath` pointed at `plugins/artibot/scripts/git-hooks` puts the hook
 * inside the work tree, and the work tree is supplied by whatever branch is
 * checked out. Review a hostile PR, run `git push`, and that branch's `pre-push`
 * runs on your machine. The same branch can also neuter the gate by putting
 * `exit 0` at the top. A copy under `.git/` is pinned at install time: checking
 * out a branch cannot rewrite it, and the copy compares itself to the tracked
 * source on every run so a modified source is reported instead of executed.
 *
 * WHAT THIS DOES NOT FIX (read before calling the hook a sandbox)
 *
 * The hook runs `node scripts/ci/validate-*.js` and `npx eslint` **from the work
 * tree**. A hostile branch that edits one of those scripts still gets code
 * execution at push time. Copying the hook removes the self-disabling property
 * and the "the gate itself is attacker-controlled" property; it does not and
 * cannot make pushing from a hostile checkout safe. Nothing short of not running
 * repo scripts would, and that would leave no gate. Treat "I have a hostile
 * branch checked out" as already dangerous -- `npm ci`, `npm test` and every
 * editor plugin have the same exposure.
 *
 * `.git/` is never committed, so this cannot be made automatic by any tracked
 * file. It is deliberately not a `postinstall`/`prepare` script either: this
 * plugin is installed into other people's machines, and silently writing to
 * their `.git/hooks/` from a dependency install is exactly the behaviour a
 * security gate should not model.
 *
 * Usage:
 *   npm run hooks:install            install / refresh
 *   npm run hooks:install -- --check report drift, change nothing (exit 1 if stale)
 *   npm run hooks:install -- --force overwrite a foreign hook without asking
 *
 * @module scripts/git-hooks/install
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Hook files this installer manages. */
const HOOKS = ['pre-push'];
/** Marker that identifies a hook as ours, so we never clobber someone else's. */
const OWNERSHIP_MARKER = 'Artibot pre-push gate.';

/** @param {string} message */
function fail(message) {
  process.stderr.write(`hooks:install: ${message}\n`);
  process.exit(1);
}

/** @param {string} message */
function log(message) {
  process.stdout.write(`hooks:install: ${message}\n`);
}

/**
 * Resolves the real hooks directory for this checkout.
 *
 * `--git-path hooks` is used rather than joining `.git/hooks` by hand: it
 * resolves correctly for linked worktrees and for `.git`-as-a-file setups, and
 * it already honours `core.hooksPath` when one is set.
 *
 * @returns {{ hooksDir: string, hooksPathConfig: string | null }}
 */
function resolveHooksDir() {
  let hooksDir;
  try {
    // `--git-path` yields a path relative to the CWD git was invoked from, not
    // to the repository root. Resolving it against the toplevel instead walks
    // out of the repo entirely and installs into whatever git dir happens to
    // sit above it -- observed writing to an ancestor temp dir's .git during
    // testing. Resolve against the same cwd that was passed to git.
    hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: __dirname,
      encoding: 'utf-8',
    }).trim();
  } catch {
    fail('not inside a git work tree (git rev-parse failed)');
  }

  let hooksPathConfig = null;
  try {
    hooksPathConfig = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: __dirname,
      encoding: 'utf-8',
    }).trim();
  } catch {
    // exit 1 from `git config --get` means "not set", which is the common case.
  }

  return { hooksDir: resolve(__dirname, hooksDir), hooksPathConfig: hooksPathConfig || null };
}

/**
 * @param {string} file
 * @returns {string | null} file contents, or null when absent
 */
function readOrNull(file) {
  return existsSync(file) ? readFileSync(file, 'utf-8') : null;
}

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const force = argv.includes('--force');

  const { hooksDir, hooksPathConfig } = resolveHooksDir();

  // A configured core.hooksPath wins over .git/hooks in git's lookup, so
  // installing into .git/hooks while it is set produces a copy that never runs.
  // Refuse rather than hand back a hook that looks installed and is inert.
  if (hooksPathConfig) {
    fail(
      `core.hooksPath is set to "${hooksPathConfig}", which overrides .git/hooks and would ` +
        'make this install inert.\n' +
        '                Unset it first:  git config --unset core.hooksPath\n' +
        '                (Aiming hooksPath inside the work tree also lets a checked-out ' +
        'branch supply the hook. See CONTRIBUTING.md "Trust boundary".)',
    );
  }

  // --check must not touch the filesystem at all.
  if (!checkOnly && !existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  let stale = 0;
  for (const hook of HOOKS) {
    const source = join(__dirname, hook);
    if (!existsSync(source)) fail(`source hook missing: ${source}`);

    const target = join(hooksDir, hook);
    const sourceText = readFileSync(source, 'utf-8');
    const targetText = readOrNull(target);

    if (targetText === sourceText) {
      log(`${hook}: up to date`);
      continue;
    }

    stale += 1;

    if (checkOnly) {
      log(`${hook}: STALE (${targetText === null ? 'not installed' : 'differs from source'})`);
      continue;
    }

    // Never silently destroy a hook we did not write.
    if (targetText !== null && !targetText.includes(OWNERSHIP_MARKER) && !force) {
      const backup = `${target}.backup`;
      renameSync(target, backup);
      log(`${hook}: existing non-Artibot hook moved to ${backup}`);
    }

    // copyFileSync is byte-for-byte. The hook's own drift check hashes raw
    // bytes, so any line-ending rewrite here would make it fail on Windows.
    copyFileSync(source, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // Windows filesystems ignore the exec bit; git for Windows does not need it.
    }
    log(`${hook}: installed -> ${target}`);
  }

  if (checkOnly && stale > 0) {
    fail(`${stale} hook(s) stale. Run: npm run hooks:install`);
  }

  if (!checkOnly) {
    log('done. Verify with: npm run hooks:install -- --check');
  }
}

main();
