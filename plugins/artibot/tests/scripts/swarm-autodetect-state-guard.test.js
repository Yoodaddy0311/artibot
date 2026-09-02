/**
 * Firewall — `--auto` must abstain when the state directory is redirected.
 *
 * Auto-apply rewrites the TRACKED `artibot.config.json` (via `swarm-init.js`)
 * and is safe only because it runs once per (repoUrl, machine). "Once" is
 * remembered in a marker under the user's state directory, and the opt-out
 * record lives beside it. `ARTIBOT_STATE_DIR` moves both, while the profile and
 * the config being rewritten still come from the real plugin root — so both
 * guards answer "first run, never opted out" every time.
 *
 * Measured 2026-08-30: the global test setup sets that variable per worker, and
 * three subprocess runs of `session-start.js` (through the SessionStart
 * dispatcher test) reached `swarm-init` during one full-suite run and flipped
 * the shipped defaults to `enabled: true` / `backend: "git"`, plus rewrote
 * `.claude-plugin/swarm-profile.json`. In-process mocking cannot stop that —
 * the hook runs in a child process, where `vi.mock` does not reach.
 *
 * These cases run the real script in a child process for that reason.
 *
 * WHAT THIS DOES NOT COVER:
 *   - The `--apply` path, which is a deliberate operator action and is meant to
 *     write. Only `--auto` abstains.
 *   - Any other writer of the tracked config. This pins one entry point.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'swarm-autodetect.js');
const CONFIG = path.join(PLUGIN_ROOT, 'artibot.config.json');

/**
 * Run the real script, returning merged stdout+stderr.
 *
 * `spawnSync`, not `execFileSync`: the abstain notice goes to stderr (the
 * script's `log()` writes there), and execFileSync returns only stdout on a
 * zero exit — which is the path this takes.
 */
function run(env) {
  const res = spawnSync(process.execPath, [SCRIPT, '--auto'], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 30_000,
    windowsHide: true,
  });
  return String(res.stdout || '') + String(res.stderr || '');
}

describe('swarm-autodetect --auto: redirected state directory', () => {
  it('abstains instead of rewriting the tracked config', () => {
    const before = readFileSync(CONFIG, 'utf-8');

    // A redirected state dir is exactly what the test suite creates.
    const stateDir = path.join(os.tmpdir(), 'artibot-autodetect-guard-probe');
    run({ ARTIBOT_STATE_DIR: stateDir });

    // The assertion that matters: the shipped defaults are untouched.
    expect(readFileSync(CONFIG, 'utf-8')).toBe(before);

    const parsed = JSON.parse(before);
    expect(parsed.swarm.enabled).toBe(false);
    expect(parsed.swarm.backend).toBe('http');
    expect(parsed.swarm.gitRepoUrl).toBeNull();
  });

  it('says why it abstained rather than failing silently', () => {
    // FAIL-CLOSED. Delete the guard and this goes red — without the message the
    // only remaining signal would be a config rewrite nobody is watching for.
    const stateDir = path.join(os.tmpdir(), 'artibot-autodetect-guard-probe-2');
    const out = run({ ARTIBOT_STATE_DIR: stateDir });
    expect(out).toContain('ARTIBOT_STATE_DIR');
  });

  it('the profile that would trigger auto-apply is actually present (precondition)', () => {
    // Without this the cases above could pass because there was nothing to
    // apply, rather than because the guard held.
    const profile = path.join(PLUGIN_ROOT, '.claude-plugin', 'swarm-profile.json');
    const parsed = JSON.parse(readFileSync(profile, 'utf-8'));
    expect(typeof parsed.repoUrl).toBe('string');
    expect(parsed.repoUrl.length).toBeGreaterThan(0);
  });
});
