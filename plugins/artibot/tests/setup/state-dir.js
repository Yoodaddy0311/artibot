/**
 * Global test setup — keep cross-session user state out of the real home tree.
 *
 * `lib/core/config.js#resolveArtibotDir` resolves to `~/.claude/artibot` unless
 * `ARTIBOT_STATE_DIR` says otherwise, and that is the correct production
 * default: this data has to outlive the plugin build that wrote it, and the
 * plugin root is a version-scoped cache directory Claude Code replaces on
 * upgrade. The consequence for tests is that anything reaching a user-state
 * writer touches the developer's own files.
 *
 * The checkpoint middleware is the one that bites, because it sits in the
 * DEFAULT pipeline — every `preparePrompt()` test persists a checkpoint.
 * Measured 2026-08-30: with the real store deleted, a plain
 * `npx vitest run tests/runtime tests/core` recreated it with 7 entries, all
 * carrying injected clocks and fixture intents. Before that it had reached the
 * 100-entry cap with 100/100 test-origin rows, having evicted every real one.
 *
 * Opting in per file was tried and rejected: of the files in `tests/runtime`
 * that reach the pipeline, only the ones written alongside the seam used it.
 * An opt-in guard fails open for every test written next, so this is a default.
 *
 * Only set when unset. A test that pins its own value — `checkpoint-state-
 * isolation.test.js` sets and unsets this deliberately — must win over the
 * default, and `afterEach` there restores whatever we put here.
 *
 * REACH: wider than the call-time resolver alone. Setup runs before the test
 * file's module graph loads, so the `ARTIBOT_DIR` constant also picks this value
 * up — 21 modules import that constant (counted by `import { … ARTIBOT_DIR … }`
 * statements under `lib/` and `scripts/`, excluding the definition in
 * `lib/core/config.js` and the re-export at `lib/core/index.js:44`). Measured
 * 2026-08-30: with the real store deleted, `npx vitest run tests/hooks
 * tests/runtime tests/core tests/learning tests/swarm tests/dispatcher`
 * (233 files, 5298 tests) left every file under `~/.claude/artibot`
 * byte-identical and the store still absent.
 *
 * WHAT THIS DOES NOT COVER:
 *   - **A test that changes the env after its imports.** The constant is frozen
 *     by then and only `resolveArtibotDir()` callers follow. That divergence is
 *     deliberate and pinned by the third case in
 *     `tests/runtime/middleware/checkpoint-state-isolation.test.js`.
 *   - **Writers that hardcode a path** instead of going through either the
 *     constant or the resolver. Nothing here can see those.
 *
 * THE HAZARD THIS CREATED, and how it is contained: a spawned child DOES inherit
 * these variables, and several hook suites isolate themselves by handing the
 * child a different HOME instead. The inherited override then outranked the
 * child's own HOME and redirected its writes. Measured 2026-08-30: 4 tests
 * across `tests/hooks/tool-tracker.test.js` (via `lib/learning/tool-history.js`)
 * and `tests/hooks/project-name-resolution.test.js` (via
 * `lib/learning/lifelong-learner.js` — a different module, same class) broke
 * this way, with 9 spawn sites carrying the same latent conflict. Hence the
 * `ARTIBOT_STATE_DIR_HOME` pairing below: `resolveArtibotDir()` drops the
 * override whenever the current home is not the one it was minted for.
 *
 * ---------------------------------------------------------------------------
 * THE AUTOPILOT STORE is the second store this file redirects, for the same
 * reason and on the same terms.
 *
 * It is `<pluginRoot>/runtime/autopilot`, resolved by
 * `lib/autopilot/session-store.js#getStoreDir`. It is NOT tracked — `.gitignore`
 * matches `/runtime/` and `git ls-files runtime` returned nothing on
 * 2026-09-21 — so a stray test write leaves the working copy clean and shows up
 * nowhere in `git status`. That is precisely why it is worth a seam: the damage
 * is silent. Test sessions land in the same directory as real ones and every
 * reader of the store POPULATION then counts them —
 * `session-store.js#listSessions` (which enumerates `*.json` there) and, through
 * it, `lib/autopilot/cross-session-learner.js:37` and
 * `scripts/hooks/bash-risk-guard.js:96` (real module, imported at :128);
 * `scripts/dev/prune-autopilot-store.mjs:303` enumerates the same directory
 * directly via `getStoreDir()`.
 *
 * Five writers reach it and all five go through that one resolver:
 * `saveSession` itself, `lib/autopilot/telemetry.js` (`<id>.events.ndjson`),
 * `lib/autopilot/lock.js` (`locks/`), `lib/autopilot/memory.js` (`memory/`) and
 * `lib/autopilot/worktree-manager.js` (`worktrees/`).
 *
 * Default-on, not opt-in, for the reason the checkpoint store is: most files
 * under `tests/autopilot/` set no override at all, and a guard that only
 * protects the files written alongside it fails open for every file written
 * next. Setting it here also means the test files themselves need no edit.
 *
 * Its temp directory is its OWN, deliberately not a subdirectory of the state
 * dir above. Two reasons. Nesting would make the store's cleanup conditional on
 * a branch it has nothing to do with — an operator running the documented
 * ad-hoc `ARTIBOT_STATE_DIR=/tmp/x npx vitest` skips that block entirely, so
 * the nested store would be created with nothing registered to remove it: the
 * same no-remover shape the 926-directory note in the mint block below records,
 * though that pile had a different cause. And a store nested inside the state
 * dir is an extra entry for every test that enumerates or counts the state dir.
 * One directory per worker per store, each with its own remover, has neither
 * problem.
 *
 * CLEANUP IS `afterAll`, NOT `process.once('exit')` — for BOTH removers in this
 * file. The exit listener they replaced did not run in this environment,
 * measured 2026-09-21: a probe that wrote a marker file as the FIRST statement
 * of the handler produced 0 markers across a 2-worker run, so the handler was
 * never entered — this was not an `rmSync` failure. Vitest appears to tear its
 * pool workers down rather than let them exit normally (mechanism not
 * confirmed). The observable cost had been 23 `artibot-test-autopilot-store-*`
 * and 32 `artibot-test-state-*` directories left in `os.tmpdir()` (counted
 * 2026-09-21). The state-dir pile was the same bug, out of scope when this
 * paragraph was written and since fixed the same way: its remover is the
 * `afterAll` above the `_HOME` stamp, gated by
 * `tests/firewall/state-dir-cleanup.test.js`.
 *
 * `afterAll` runs per test FILE, so the sandbox is removed between files too.
 * That is a feature, not a cost: a test that depended on store contents written
 * by an earlier file would be an order-dependent test, and every writer
 * recreates its own parents. The guard is strict equality against the path this
 * worker minted — an operator-supplied directory, or one a test repointed, is
 * never removed.
 *
 * REACH: a spawned child inherits both variables, so a child that is otherwise
 * unisolated still writes into the sandbox. A child handed a different
 * `CLAUDE_PLUGIN_ROOT` gets the better outcome automatically: the pair no
 * longer matches the root in force, `getStoreDir()` discards the inherited
 * override, and the child lands in its own `<sandbox>/runtime/autopilot`. That
 * is the hazard the `ARTIBOT_STATE_DIR_HOME` note above describes, already
 * solved on this store by construction.
 *
 * WHAT THIS DOES NOT COVER:
 *   - **A test that deletes or repoints the override without restoring it.**
 *     Setup re-runs per test file, so the damage is bounded to the rest of that
 *     file — but within it, later writes land in the real store.
 *   - **A child given the real plugin root AND a matching pair explicitly.**
 *     That is a valid, honored override; nothing here overrules it.
 *   - **Hardcoded paths.** A writer that joins `runtime/autopilot` itself
 *     instead of calling `getStoreDir()` is invisible to this seam. That is a
 *     ratchet in `tests/firewall/autopilot-store-sandbox-required.test.js`,
 *     not something this file can see.
 *   - **Sibling stores.** `~/.artibot/queues`, `~/.artibot/failure-memory` and
 *     `.artibot/runtime/decisions` anchor elsewhere and are out of scope.
 *   - **A worker killed mid-file.** `afterAll` does not run either, so that
 *     worker's directory survives — one per killed worker, not one per run.
 */

import { afterAll } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHomeDir, getPluginRoot } from '../../lib/core/platform.js';

// Keyed on the pid, so this is one directory per worker PROCESS. How many test
// files share one of those is a pool question rather than this file's, and the
// answer is not the one this comment used to assert: measured 2026-09-21 on
// vitest 4.0.18, BOTH projects run the forks pool with a fresh process per test
// file (two files, two pids, in `main` and in `autopilot` alike), so the env
// does not survive from one file to the next today and each file mints its own
// directory. The pid key still does its other job — keeping whatever workers do
// run concurrently off each other's read-modify-write.
//
// Computed OUTSIDE the assignment below because the remover needs it too, and
// has to stay correct under either shape. Where a worker IS reused across files
// — the arrangement the autopilot project asks for — the block is entered by
// the first file only, so a remover registered inside it would fire after that
// one file and leave everything the later files wrote behind. Where it is not
// reused, every file enters the block and the placement costs nothing. Out
// here it is right either way, which is why this does not depend on settling
// the pool question.
const OWN_STATE_DIR = path.join(os.tmpdir(), `artibot-test-state-${process.pid}`);

if (!process.env.ARTIBOT_STATE_DIR) {
  process.env.ARTIBOT_STATE_DIR = OWN_STATE_DIR;
  // Not created here. Every writer that lands in it makes its own parents, so
  // pre-creating only guarantees an empty directory per worker whether or not
  // anything was written. Measured 2026-08-30 before this: 926 of these had
  // accumulated in `os.tmpdir()`, 8 of them holding actual checkpoints.
}

// Removed after the run rather than reused under a fixed name. A fixed name
// would be one directory total, but parallel workers would then share a single
// read-modify-write store, and this file exists to remove a whole class of
// shared-write accident rather than move it somewhere tidier. The contents are
// entirely test-generated, so there is nothing here to preserve.
//
// `afterAll`, not `process.once('exit')`. The exit listener this replaces was
// never entered under vitest's pool workers — 0 firings measured, see the
// CLEANUP paragraph in the header — so it removed nothing and the directories
// simply accumulated. Same shape as the autopilot store remover below,
// including the strict-equality guard: an operator running the documented
// `ARTIBOT_STATE_DIR=/tmp/x npx vitest`, or a test that repointed the variable
// and left it repointed, keeps their directory. Registered for every test file,
// so cleanup also happens BETWEEN files; that is safe because a test depending
// on state written by an earlier file would be order-dependent anyway, and
// every writer recreates its own parents.
afterAll(() => {
  if (process.env.ARTIBOT_STATE_DIR !== OWN_STATE_DIR) return;
  try { fsSync.rmSync(OWN_STATE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Records the home the override in force belongs to. Both variables are
// inherited by spawned children, and a hook test isolates itself by handing the
// child a different HOME; `resolveArtibotDir()` compares the two and lets the
// child's home win. Read through `getHomeDir()` rather than a local
// reimplementation so both sides of that comparison come from one function.
//
// Stamped OUTSIDE the block above on purpose. `resolveArtibotDir()` now discards
// an override that carries no recorded home, so an operator running
// `ARTIBOT_STATE_DIR=/tmp/x npx vitest` — the documented ad-hoc form — would
// otherwise find their redirect silently ignored. Whatever value is in force
// when the suite starts is the one this pairs.
process.env.ARTIBOT_STATE_DIR_HOME = getHomeDir();

// Same per-worker keying as the state dir, and the same not-created-here rule:
// all five writers make their own parents (`session-store.js#saveSession`
// mkdirSync recursive, the other four via `ensureDirSync`), so pre-creating
// would only guarantee an empty directory per worker whether or not a test
// touched the store.
//
// Computed OUTSIDE the assignment below because the remover needs it too, and
// has to hold whether or not a worker is reused across files. Where one IS
// reused the block below is entered by the first file only, and a remover
// registered inside it would fire after file 1 alone, leaving whatever the
// remaining files wrote behind. Measured 2026-09-21: this project's
// `poolOptions.forks.singleFork` is NOT in effect on vitest 4.0.18 — two test
// files in `--project autopilot` reported two pids — so each file currently
// mints its own. Out here the constant is right under either shape.
const OWN_AUTOPILOT_STORE_DIR = path.join(os.tmpdir(), `artibot-test-autopilot-store-${process.pid}`);

if (!process.env.ARTIBOT_AUTOPILOT_STORE_DIR) {
  process.env.ARTIBOT_AUTOPILOT_STORE_DIR = OWN_AUTOPILOT_STORE_DIR;
}

// Registered for every test file, and strict-equality guarded so it can only
// ever remove the directory THIS worker minted. An operator who exported their
// own `ARTIBOT_AUTOPILOT_STORE_DIR`, or a test that repointed it and left it
// repointed, keeps their directory. `force` makes the usual case — nothing was
// ever written — a no-op rather than an error.
afterAll(() => {
  if (process.env.ARTIBOT_AUTOPILOT_STORE_DIR !== OWN_AUTOPILOT_STORE_DIR) return;
  try {
    fsSync.rmSync(OWN_AUTOPILOT_STORE_DIR, { recursive: true, force: true });
  } catch { /* best effort — a locked worktree handle must not fail the suite */ }
});

// Records the plugin root the override in force belongs to; `getStoreDir()`
// honors the override only while this still matches `getPluginRoot()`.
//
// Stamped unconditionally, for the reason given above the `_HOME` line: the
// resolver discards an override that carries no recorded root, so an operator
// who exports only `ARTIBOT_AUTOPILOT_STORE_DIR` would otherwise find their
// redirect silently ignored and their writes back in the real store. When
// the operator supplied the pair correctly this is a no-op; when they supplied
// a stale one it is a correction. The suite runs out of this root, so this is
// the root any override in force at startup belongs to.
process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT = getPluginRoot();
