/**
 * Checkpoint state isolation — a test must not write the developer's own
 * `~/.claude/artibot/runtime/checkpoints.json`.
 *
 * The checkpoint middleware is part of the DEFAULT pipeline, so every test that
 * calls `preparePrompt()` persists a checkpoint. Its path came from the
 * `ARTIBOT_DIR` constant, which is `~/.claude/artibot` and is captured at import
 * — `CLAUDE_PLUGIN_ROOT` does not move it, so `useTrailSandbox` did not either.
 * Measured 2026-08-30 on the real install: 4 entries within 90ms carrying the
 * score of a test fixture, plus one stamped `1970-01-01T00:00:01.000Z` from an
 * injected clock. Those are suite runs, in a user state file.
 *
 * `ARTIBOT_DIR` itself is NOT the bug. Cross-session user state belongs in the
 * home directory precisely because it must outlive the plugin build that wrote
 * it: in production the plugin root is a version-scoped cache directory that
 * Claude Code replaces on upgrade. What was missing is a way to redirect that
 * state in a test without moving it in production, which is what
 * `resolveArtibotDir()` / `ARTIBOT_STATE_DIR` provide.
 *
 * Both cases below point HOME at a throwaway directory, so even a red run writes
 * its fixture into a temp tree rather than into the real one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_KEYS = ['USERPROFILE', 'HOME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME'];

let homeStandIn = '';
let stateDir = '';
let importTimeDir = '';
/** @type {Record<string, string|undefined>} */
let saved = {};

/** @returns {string} */
function mkdtemp(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The home-derived location the middleware used before this seam existed. */
function homeDerivedPath() {
  return path.join(homeStandIn, '.claude', 'artibot', 'runtime', 'checkpoints.json');
}

/** Minimal state with the fields `buildCheckpoint` reads. */
function makeState() {
  return {
    messageParts: [],
    context: {
      routing: { system: 'system2', score: 0.63 },
      intent: { best: 'action:refactor' },
      tasks: { mode: 'agentTeam', id: 'rt-fixture' },
      subagents: { contract: { mode: 'agentTeam' } },
    },
  };
}

beforeEach(() => {
  homeStandIn = mkdtemp('artibot-home-standin-');
  stateDir = mkdtemp('artibot-state-');
  importTimeDir = mkdtemp('artibot-import-time-');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Stand in for the real home BEFORE the modules load, so a red run's write
  // lands here instead of in the developer's `~/.claude/artibot`.
  process.env.USERPROFILE = homeStandIn;
  process.env.HOME = homeStandIn;
  // The override is scoped to a home. These cases pin both, so they must declare
  // the pairing — an override minted for a different home is ignored by design,
  // which is what the last case below exercises.
  process.env.ARTIBOT_STATE_DIR_HOME = homeStandIn;
  // `ARTIBOT_DIR` is a module-level const, so the module graph has to be
  // rebuilt for either env change to be visible.
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    // Assigning `undefined` would stringify to the literal "undefined".
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  saved = {};
  for (const d of [homeStandIn, stateDir, importTimeDir]) {
    try { fsSync.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('checkpoint middleware — user-state isolation', () => {
  it('writes under ARTIBOT_STATE_DIR when it is set, not under the home directory', async () => {
    process.env.ARTIBOT_STATE_DIR = stateDir;
    const { createCheckpointMiddleware } = await import('../../../lib/runtime/middleware/checkpoint.js');

    const state = makeState();
    await createCheckpointMiddleware()(state);

    expect(state.context.checkpoint.persisted).toBe(true);
    expect(state.context.checkpoint.filePath).toBe(
      path.join(stateDir, 'runtime', 'checkpoints.json'),
    );
    expect(fsSync.existsSync(path.join(stateDir, 'runtime', 'checkpoints.json'))).toBe(true);

    // NEGATIVE CONTROL. Without this, the case above would still pass if the
    // middleware wrote BOTH places — and the escape being fixed is a write to
    // the second one.
    expect(fsSync.existsSync(homeDerivedPath())).toBe(false);
  });

  it('resolves the path when the middleware runs, not when the module loaded', async () => {
    // Load the module graph with the env pointing HERE, so the `ARTIBOT_DIR`
    // constant freezes to this value.
    process.env.ARTIBOT_STATE_DIR = importTimeDir;
    const { createCheckpointMiddleware } = await import('../../../lib/runtime/middleware/checkpoint.js');
    const { ARTIBOT_DIR } = await import('../../../lib/core/config.js');
    expect(ARTIBOT_DIR).toBe(importTimeDir);

    // ...then move it, WITHOUT rebuilding the graph. This split is the whole
    // point of the case: the other two set the env before importing, so the
    // constant and the call-time resolver agree there and reverting
    // `getDefaultCheckpointPath` to the constant would still pass them. Here
    // the two disagree, so only a call-time resolve lands in `stateDir`.
    process.env.ARTIBOT_STATE_DIR = stateDir;

    const state = makeState();
    await createCheckpointMiddleware()(state);

    expect(state.context.checkpoint.filePath).toBe(
      path.join(stateDir, 'runtime', 'checkpoints.json'),
    );
    expect(fsSync.existsSync(path.join(importTimeDir, 'runtime', 'checkpoints.json'))).toBe(false);
  });

  it('ignores a state dir minted for a different home', async () => {
    // What a spawned hook sees: it inherits the parent's override through
    // `{ ...process.env }` but is handed its own HOME. The child's home is the
    // more specific instruction and has to win, or the inherited override
    // silently redirects writes the test is about to look for under that home.
    // Measured 2026-08-30 before this rule existed: 4 tests across
    // `tests/hooks/tool-tracker.test.js` and
    // `tests/hooks/project-name-resolution.test.js` failed exactly here.
    process.env.ARTIBOT_STATE_DIR = stateDir;
    process.env.ARTIBOT_STATE_DIR_HOME = importTimeDir; // a DIFFERENT home
    const { createCheckpointMiddleware } = await import('../../../lib/runtime/middleware/checkpoint.js');

    const state = makeState();
    await createCheckpointMiddleware()(state);

    expect(state.context.checkpoint.filePath).toBe(homeDerivedPath());
    expect(fsSync.existsSync(path.join(stateDir, 'runtime', 'checkpoints.json'))).toBe(false);
  });

  it('still defaults to the home directory when ARTIBOT_STATE_DIR is unset', async () => {
    delete process.env.ARTIBOT_STATE_DIR;
    const { createCheckpointMiddleware } = await import('../../../lib/runtime/middleware/checkpoint.js');

    const state = makeState();
    await createCheckpointMiddleware()(state);

    // Production semantics are unchanged: user state stays in the home tree,
    // where it survives a plugin upgrade. This case is what makes the fix a
    // test seam rather than a storage move.
    expect(state.context.checkpoint.filePath).toBe(homeDerivedPath());
    expect(fsSync.existsSync(homeDerivedPath())).toBe(true);
  });
});
