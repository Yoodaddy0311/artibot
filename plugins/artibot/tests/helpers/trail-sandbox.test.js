/**
 * Unit tests for `tests/helpers/trail-sandbox.js`.
 *
 * The helper is what keeps every recording subsystem's test writes out of the
 * repo's live `runtime/decision-trail.json`, so the whole "trail delta must be
 * zero" gate rests on it. A helper that silently stopped pinning — or that
 * restored the environment wrongly — would leave that gate green while the
 * protection was gone. These tests exercise the real helper, not a replica.
 *
 * How the lifecycle is observed: `useTrailSandbox()` captures the previous
 * value at CALL time (`trail-sandbox.js:32`) and registers `beforeAll`/
 * `afterAll` in whatever scope it is called from. Calling it inside a
 * `describe` therefore scopes its hooks to that suite, and a later sibling
 * suite runs after its `afterAll` — which is where restoration is asserted.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPluginRoot } from '../../lib/core/platform.js';
import { useTrailSandbox } from './trail-sandbox.js';

const TRUE_ORIGINAL = process.env.CLAUDE_PLUGIN_ROOT;

/** The root `getPluginRoot()` falls back to when the variable is absent. */
const REAL_PLUGIN_ROOT = (() => {
  const saved = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  const real = getPluginRoot();
  if (saved !== undefined) process.env.CLAUDE_PLUGIN_ROOT = saved;
  return real;
})();

const SENTINEL = path.join(os.tmpdir(), 'artibot-trail-sandbox-unit-sentinel');

let setCaseRoot = '';
let unsetCaseRoot = '';

afterAll(() => {
  if (TRUE_ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = TRUE_ORIGINAL;
});

// ── Case 1: a previous value exists ─────────────────────────────────────────
describe('useTrailSandbox() when CLAUDE_PLUGIN_ROOT already has a value', () => {
  process.env.CLAUDE_PLUGIN_ROOT = SENTINEL;
  const sandbox = useTrailSandbox('unit-set');

  it('pins the plugin root to a fresh directory under the temp dir', () => {
    setCaseRoot = sandbox.root();
    expect(setCaseRoot).not.toBe('');
    expect(process.env.CLAUDE_PLUGIN_ROOT).toBe(setCaseRoot);
    expect(setCaseRoot.startsWith(os.tmpdir())).toBe(true);
    expect(existsSync(setCaseRoot)).toBe(true);
  });

  it('never resolves to the real plugin directory', () => {
    expect(sandbox.root()).not.toBe(REAL_PLUGIN_ROOT);
    expect(getPluginRoot()).not.toBe(REAL_PLUGIN_ROOT);
    expect(getPluginRoot()).toBe(sandbox.root());
  });

  it('seeds a decision-trail config so the trail resolves inside the sandbox', () => {
    const cfg = JSON.parse(
      readFileSync(path.join(sandbox.root(), 'artibot.config.json'), 'utf-8'),
    );
    expect(cfg.ago.decisionTrail.enabled).toBe(true);
    expect(cfg.ago.decisionTrail.path).toBe('runtime/decision-trail.json');
  });

  it('names the directory after the label it was given', () => {
    expect(path.basename(sandbox.root())).toContain('unit-set');
  });
});

describe('after a sandboxed suite whose variable had a previous value', () => {
  it('restores that exact string', () => {
    expect(process.env.CLAUDE_PLUGIN_ROOT).toBe(SENTINEL);
  });

  it('removes the temp directory it created', () => {
    expect(setCaseRoot).not.toBe('');
    expect(existsSync(setCaseRoot)).toBe(false);
  });
});

// ── Case 2: no previous value (the `undefined` -> "undefined" trap) ──────────
describe('useTrailSandbox() when CLAUDE_PLUGIN_ROOT is unset', () => {
  delete process.env.CLAUDE_PLUGIN_ROOT;
  const sandbox = useTrailSandbox('unit-unset');

  it('pins the plugin root just the same', () => {
    unsetCaseRoot = sandbox.root();
    expect(process.env.CLAUDE_PLUGIN_ROOT).toBe(unsetCaseRoot);
    expect(unsetCaseRoot.startsWith(os.tmpdir())).toBe(true);
    expect(unsetCaseRoot).not.toBe(REAL_PLUGIN_ROOT);
  });

  it('gets its own directory, distinct from another label in the same file', () => {
    expect(setCaseRoot).not.toBe('');
    expect(sandbox.root()).not.toBe(setCaseRoot);
    expect(path.basename(sandbox.root())).toContain('unit-unset');
  });
});

describe('after a sandboxed suite whose variable had no previous value', () => {
  // `process.env` stringifies assignments, so restoring by assigning
  // `undefined` would leave the literal string "undefined" behind and send
  // `getPluginRoot()` to a bogus "<cwd>/undefined" root. Restoration must
  // delete the key instead. These assertions go red if that regresses.
  it('deletes the variable rather than assigning the string "undefined"', () => {
    expect(process.env.CLAUDE_PLUGIN_ROOT).toBeUndefined();
    expect(process.env.CLAUDE_PLUGIN_ROOT).not.toBe('undefined');
    expect(Object.hasOwn(process.env, 'CLAUDE_PLUGIN_ROOT')).toBe(false);
  });

  it('leaves getPluginRoot() back on its real fallback', () => {
    expect(getPluginRoot()).toBe(REAL_PLUGIN_ROOT);
  });

  it('removes the temp directory it created', () => {
    expect(unsetCaseRoot).not.toBe('');
    expect(existsSync(unsetCaseRoot)).toBe(false);
  });
});
