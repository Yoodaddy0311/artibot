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
 */

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHomeDir } from '../../lib/core/platform.js';

if (!process.env.ARTIBOT_STATE_DIR) {
  // Per worker process, not per file: setup runs once per test file but the
  // env persists in the worker, and a per-file directory would leave one
  // temp tree behind for every file in the suite. Keying on the pid also
  // keeps parallel workers off each other's read-modify-write.
  const dir = path.join(os.tmpdir(), `artibot-test-state-${process.pid}`);
  process.env.ARTIBOT_STATE_DIR = dir;
  // Not created here. Every writer that lands in it makes its own parents, so
  // pre-creating only guarantees an empty directory per worker whether or not
  // anything was written. Measured 2026-08-30 before this: 926 of these had
  // accumulated in `os.tmpdir()`, 8 of them holding actual checkpoints.
  //
  // Removed on exit rather than reused under a fixed name. A fixed name would
  // be one directory total, but parallel workers would then share a single
  // read-modify-write store, and this file exists to remove a whole class of
  // shared-write accident rather than move it somewhere tidier. The contents
  // are entirely test-generated, so there is nothing here to preserve.
  process.once('exit', () => {
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}

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
