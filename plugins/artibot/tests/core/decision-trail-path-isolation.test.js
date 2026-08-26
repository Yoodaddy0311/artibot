/**
 * Decision trail — path-resolution isolation.
 *
 * Regression guard for the contamination traced on 2026-08-26, where test
 * fixtures accumulated in the repo's live `runtime/decision-trail.json`. Two
 * distinct defects fed it, both rooted in the trail path being re-derived from
 * `process.env.CLAUDE_PLUGIN_ROOT` at each use instead of once per operation:
 *
 *   A. `router.route()` is synchronous and cannot await its trail write, so the
 *      write flushes on a later turn. Resolved at flush time, its destination is
 *      whatever the environment says then — not the root the caller meant.
 *
 *   B. `recordDecision` read the trail, suspended on `await ensureDir(...)`, then
 *      resolved the path a second time for the write. Note the asymmetry: the
 *      argument to `ensureDir` is evaluated *before* the suspension, so only the
 *      write moved. A read from the sandbox followed by a write to the real root
 *      replaced the real trail with fixture data — data loss, not just noise.
 *
 * Both scenarios use throwaway roots only. Nothing here may resolve to the real
 * plugin directory: `assertNotRealRoot` fails the test if it ever does.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as trail from '../../lib/core/decision-trail.js';
import * as router from '../../lib/cognitive/router.js';
import { getPluginRoot } from '../../lib/core/platform.js';

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

  // ── Scenario A — deferred write keeps the root it was given ───────────────
  it('routes a deferred router write to the root captured at call time', async () => {
    const sandbox = await makeRoot('a-sandbox');
    const decoy = await makeRoot('a-decoy');
    try {
      process.env.CLAUDE_PLUGIN_ROOT = sandbox;
      trail._resetDecisionTrailCache();

      router.resetRouter();
      router.route('analyze security vulnerabilities in the auth layer');

      // Stand in for a test teardown that restores the root before the
      // fire-and-forget chain in router.js gets its turn.
      process.env.CLAUDE_PLUGIN_ROOT = decoy;

      await waitForEntries(sandbox, 'cognitive-router');

      expect(readEntries(decoy)).toBeNull();
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
      await fs.rm(decoy, { recursive: true, force: true });
    }
  });

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
      const flip = setTimeout(() => { process.env.CLAUDE_PLUGIN_ROOT = decoy; }, 0);
      const result = await trail.recordDecision({ subsystem: 'probe-b', action: 'y' });
      clearTimeout(flip);

      expect(result).not.toBeNull();

      const sandboxEntries = readEntries(sandbox);
      expect(sandboxEntries.map((e) => e.subsystem)).toEqual(['sandboxSeed', 'probe-b']);

      // The decoy must be untouched — neither appended to nor replaced.
      expect(readEntries(decoy).map((e) => e.subsystem)).toEqual(['decoySeed']);
    } finally {
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

/** Poll the sandbox trail until the subsystem shows up, or fail after 2s. */
async function waitForEntries(root, subsystem) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const entries = readEntries(root);
    if (entries?.some((e) => e.subsystem === subsystem)) return entries;
    if (Date.now() > deadline) {
      throw new Error(`no '${subsystem}' entry landed in ${root} within 2000ms`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}
