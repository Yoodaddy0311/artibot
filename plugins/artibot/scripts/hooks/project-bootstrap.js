#!/usr/bin/env node
/**
 * SessionStart hook — project bootstrap for plugin use in OTHER projects.
 *
 * Does two things for a project that got Artibot from the marketplace alone:
 *
 *   1. Writes a managed block into `<git common dir>/info/exclude` so the
 *      `.artibot/` runtime files the hooks create (state.yaml, runtime/, ledger/,
 *      transcripts/, ...) are not swept into the user's commits by `git add .`.
 *      Idempotent, untracked, shared by every linked worktree, and a no-op
 *      outside a git repository.
 *   2. When `~/.claude/rules/artibot/` holds no rules — `plugin.json#rules` is not
 *      loaded by the host, so a pure marketplace install has none — injects a
 *      ≤1,500-byte digest of them as `additionalContext`, with the path of the full
 *      text to read on demand. On a machine that has the rules it injects nothing.
 *
 * All decisions live in `lib/project-state/project-bootstrap.js`; this file is I/O.
 * Opt out with `projectBootstrap.gitExclude` / `projectBootstrap.rulesDigest` in
 * `artibot.config.json`, or for both at once with env `ARTIBOT_PROJECT_BOOTSTRAP=off`.
 *
 * Safety properties (same class as session-readback.mjs):
 *   - Errors go to stderr ONLY; the process always exits 0 and never throws.
 *   - Nothing is written to stdout unless there is a digest to inject.
 *   - No network. The only process it can spawn is `git rev-parse`, and only when
 *     GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE redirect git's own discovery.
 *   - The library is loaded by dynamic import() inside try/catch, so a
 *     momentarily-absent module degrades silently instead of crashing the load.
 *
 * Hook attachment (hooks/dispatch-table.json): SessionStart slot (parallel-spawn).
 * Stdin: Claude Code hook payload JSON (`cwd` is the project directory).
 * Stdout: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
 *         — only when a digest exists.
 *
 * @module scripts/hooks/project-bootstrap
 */

import { readStdin, writeStdout } from '../utils/index.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'project-bootstrap';

/** Parse the payload; anything unreadable or not an object becomes `{}`. */
function parsePayload(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Say what the exclude job did — once, and only when something happened or went
 * wrong. A steady-state session (`unchanged`, `skipped`) is silent.
 *
 * @param {object|null} exclude - The job's result, or `null` when it did not run.
 */
function reportExclude(exclude) {
  if (exclude === null || exclude === undefined) return;
  if (exclude.ok === false) {
    const detail = exclude.error ? `: ${exclude.error}` : '';
    process.stderr.write(`[artibot:${HOOK_NAME}] runtime exclude not written (${exclude.reason})${detail}\n`);
    return;
  }
  if (exclude.action === 'inserted' || exclude.action === 'replaced') {
    process.stderr.write(`[artibot:${HOOK_NAME}] runtime exclude ${exclude.action}: ${exclude.file}\n`);
  }
}

export async function main() {
  const payload = parsePayload(await readStdin().catch(() => ''));

  let runProjectBootstrap;
  try {
    ({ runProjectBootstrap } = await import('../../lib/project-state/project-bootstrap.js'));
  } catch {
    return; // library not available: degrade silently, no stdout
  }

  let result;
  try {
    result = runProjectBootstrap({ payload });
  } catch (err) {
    process.stderr.write(`[artibot:${HOOK_NAME}] ${err?.message || 'failed'}\n`);
    return;
  }

  reportExclude(result.exclude);

  if (result.additionalContext) {
    writeStdout({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.additionalContext,
      },
    });
  }
}

// Direct-run guard: importing this module (tests) must not run main(), which
// blocks on stdin. The dispatcher spawns this file as argv[1], so production is
// unaffected.
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    // Last-resort guard: a bootstrap failure must never surface to the host.
    process.stderr.write(`[artibot:${HOOK_NAME}] ${err?.message || 'failed'}\n`);
  });
}
