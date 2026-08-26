/**
 * Decision-trail sandbox for test files.
 *
 * Any subsystem that records a decision resolves its trail path from
 * `CLAUDE_PLUGIN_ROOT` at write time, falling back to the real plugin directory
 * when the variable is unset (`lib/core/platform.js` getPluginRoot). A test file
 * that exercises `router.route()` or `user-profile.recordSignal()` without
 * setting that variable therefore appends to the repo's live
 * `runtime/decision-trail.json` — measured 2026-08-26: one entry per file, per
 * run, under the default `isolate: true` config.
 *
 * Call `useTrailSandbox()` at the top of any describe-less scope in such a file.
 * It pins the root to a throwaway directory for the whole file and restores the
 * previous value afterwards.
 *
 * @module tests/helpers/trail-sandbox
 */

import { afterAll, beforeAll } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _resetDecisionTrailCache } from '../../lib/core/decision-trail.js';

/**
 * Redirect the decision trail into a temp plugin root for this test file.
 *
 * @param {string} [label] - Short tag used in the temp directory name.
 * @returns {{ root: () => string }} Accessor for the sandbox root (valid inside tests).
 */
export function useTrailSandbox(label = 'trail') {
  const original = process.env.CLAUDE_PLUGIN_ROOT;
  let root = '';

  beforeAll(() => {
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), `artibot-${label}-sandbox-`));
    fsSync.writeFileSync(
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
    process.env.CLAUDE_PLUGIN_ROOT = root;
    _resetDecisionTrailCache();
  });

  afterAll(() => {
    // `process.env` stringifies assignments, so restoring an originally-unset
    // variable must delete it rather than assign `undefined` (which would
    // produce the literal path segment "undefined").
    if (original === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = original;
    _resetDecisionTrailCache();
    try {
      fsSync.rmSync(root, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  return { root: () => root };
}
