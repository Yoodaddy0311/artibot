/**
 * Decision trail — path-resolution isolation.
 *
 * Regression guard for the contamination traced on 2026-08-26, where test
 * fixtures accumulated in the repo's live `runtime/decision-trail.json`. Two
 * distinct defects fed it, both rooted in the trail path being re-derived from
 * `process.env.CLAUDE_PLUGIN_ROOT` at each use instead of once per operation:
 *
 *   A. `router.route()` was synchronous and could not await its trail write, so
 *      the write flushed on a later turn at whatever root the environment named
 *      then. RETIRED 2026-09-05 (D9): the router no longer writes the trail at
 *      all — `tests/core/decision-trail.test.js` "integration touchpoints"
 *      asserts that — so there is no deferred write left to pin.
 *
 *   B. `recordDecision` read the trail, suspended on `await ensureDir(...)`, then
 *      resolved the path a second time for the write. Note the asymmetry: the
 *      argument to `ensureDir` is evaluated *before* the suspension, so only the
 *      write moved. A read from the sandbox followed by a write to the real root
 *      replaced the real trail with fixture data — data loss, not just noise.
 *      Still live on the opt-in path (`enabled: true`), so still guarded.
 *
 * Every scenario uses throwaway roots only. Nothing here may resolve to the real
 * plugin directory: `assertNotRealRoot` fails the test if it ever does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as trail from '../../lib/core/decision-trail.js';
import { getPluginRoot } from '../../lib/core/platform.js';

/**
 * Scenario B needs the root to move *while `recordDecision` is suspended*, and
 * a `setTimeout(..., 0)` cannot promise that. It only wins the race because
 * `ensureDir` happens to await a threadpool round-trip — a property of another
 * module, not part of any contract. Measured 2026-08-26: give `ensureDir` a
 * synchronous fast path (`if (existsSync(dir)) return;`) and a re-resolving
 * `recordDecision` — the exact defect this file guards — passes scenario B 8
 * times out of 8. No assertion changed; the flip just stopped landing in the
 * window.
 *
 * So the flip hangs off `ensureDir` itself, the one call whose invocation sits
 * inside the suspension by construction, and scenario B asserts it fired.
 *
 * `vi.mock` is hoisted file-wide, so the hook is nullable and stays null for
 * scenario C, where `ensureDir` passes straight through to the real one.
 * `vi.hoisted` is what lets the factory reach the holder: the factory is lifted
 * above ordinary top-level declarations and cannot see them.
 */
const fileHook = vi.hoisted(() => ({ onEnsureDir: null }));

vi.mock('../../lib/core/file.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureDir: async (dirPath) => {
      fileHook.onEnsureDir?.();
      return actual.ensureDir(dirPath);
    },
  };
});

const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const REAL_PLUGIN_ROOT = (() => {
  const saved = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  const real = getPluginRoot();
  if (saved !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saved;
  return real;
})();

function restorePluginRoot() {
  if (ORIGINAL_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
}

/** Guard: no sandbox in this file may ever point at the real plugin directory. */
function assertNotRealRoot(root) {
  expect(root).not.toBe(REAL_PLUGIN_ROOT);
  expect(root.startsWith(os.tmpdir())).toBe(true);
}

async function makeRoot(tag) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `artibot-trailiso-${tag}-`));
  assertNotRealRoot(root);
  await fs.writeFile(
    path.join(root, 'artibot.config.json'),
    JSON.stringify({
      ago: {
        decisionTrail: {
          enabled: true,
          path: 'runtime/decision-trail.json',
          retentionDays: 30,
          redactSensitive: true,
        },
      },
    }),
    'utf-8',
  );
  return root;
}

function trailFile(root) {
  return path.join(root, 'runtime', 'decision-trail.json');
}

function readEntries(root) {
  const file = trailFile(root);
  if (!fsSync.existsSync(file)) return null;
  return JSON.parse(fsSync.readFileSync(file, 'utf-8')).entries;
}

function seedTrail(root, subsystem) {
  fsSync.mkdirSync(path.dirname(trailFile(root)), { recursive: true });
  fsSync.writeFileSync(
    trailFile(root),
    JSON.stringify({ entries: [{ id: `${subsystem}-seed`, subsystem, action: 'seed' }], metadata: {} }),
    'utf-8',
  );
}

describe('decision-trail path isolation', () => {
  afterEach(() => {
    restorePluginRoot();
    trail._resetDecisionTrailCache();
  });

  // ── Scenario A retired with D9 (see the header) ───────────────────────────

  // ── Scenario B — one operation, one destination ───────────────────────────
  it('writes back to the same file it read, when the root moves mid-operation', async () => {
    const sandbox = await makeRoot('b-sandbox');
    const decoy = await makeRoot('b-decoy');
    seedTrail(sandbox, 'sandboxSeed');
    seedTrail(decoy, 'decoySeed');
    try {
      process.env.CLAUDE_PLUGIN_ROOT = sandbox;
      trail._resetDecisionTrailCache();

      // Flip the root while recordDecision is suspended on `await ensureDir`.
      // That suspension now sits above the read — the read-modify-write below it
      // has to stay unbroken, or concurrent writes lose each other's entries
      // (see decision-trail.js) — so the flip lands after the path is resolved
      // and before either half uses it. A write that re-resolved the path would
      // still land in the decoy and fail the assertion below.
      let ensureDirCalls = 0;
      fileHook.onEnsureDir = () => {
        ensureDirCalls += 1;
        process.env.CLAUDE_PLUGIN_ROOT = decoy;
      };

      const result = await trail.recordDecision({ subsystem: 'probe-b', action: 'y' });

      // Without these two, the scenario name is an unbacked claim: the three
      // assertions below also hold when the root never moved at all.
      expect(ensureDirCalls).toBe(1);
      expect(process.env.CLAUDE_PLUGIN_ROOT).toBe(decoy);

      expect(result).not.toBeNull();

      const sandboxEntries = readEntries(sandbox);
      expect(sandboxEntries.map((e) => e.subsystem)).toEqual(['sandboxSeed', 'probe-b']);

      // The decoy must be untouched — neither appended to nor replaced.
      expect(readEntries(decoy).map((e) => e.subsystem)).toEqual(['decoySeed']);
    } finally {
      // The mock is file-wide; leaving the hook set would flip the root under
      // whichever scenario runs next.
      fileHook.onEnsureDir = null;
      await fs.rm(sandbox, { recursive: true, force: true });
      await fs.rm(decoy, { recursive: true, force: true });
    }
  });

  // ── Explicit root beats the environment ───────────────────────────────────
  it('honours an explicit pluginRoot over the current environment', async () => {
    const pinned = await makeRoot('c-pinned');
    const decoy = await makeRoot('c-decoy');
    try {
      process.env.CLAUDE_PLUGIN_ROOT = decoy;
      trail._resetDecisionTrailCache();

      const result = await trail.recordDecision(
        { subsystem: 'probe-c', action: 'pinned' },
        { pluginRoot: pinned },
      );

      expect(result).not.toBeNull();
      expect(readEntries(pinned).map((e) => e.subsystem)).toEqual(['probe-c']);
      expect(readEntries(decoy)).toBeNull();
    } finally {
      await fs.rm(pinned, { recursive: true, force: true });
      await fs.rm(decoy, { recursive: true, force: true });
    }
  });
});
