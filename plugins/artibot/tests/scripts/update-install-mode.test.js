/**
 * B3 integration test for scripts/update.js — the install-mode gate.
 *
 * Black-box, NETWORK-FREE: a native marketplace layout must short-circuit
 * BEFORE the GitHub fetch / git-pull / install.sh flow, print the
 * `/plugin marketplace update artibot` hint, and exit 0. We drive this by
 * pointing CLAUDE_PLUGIN_ROOT at a fake plugin-cache dir and HOME/USERPROFILE
 * at an isolated tmp home, so no real ~/.claude state or network is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'update.js');

let home;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'artibot-update-native-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runUpdate(args, extraEnv) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...extraEnv,
  };
  try {
    const stdout = execFileSync('node', [UPDATE_SCRIPT, ...args], {
      encoding: 'utf-8',
      env,
      timeout: 30_000,
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '' };
  }
}

describe('update.js install-mode gate (B3)', () => {
  it('native marketplace layout → prints the /plugin hint and exits 0 without network', () => {
    // Fake native cache root with a config so readCurrentVersion resolves cleanly.
    const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.29.0');
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(path.join(cacheRoot, 'artibot.config.json'), JSON.stringify({ version: '4.29.0' }), 'utf-8');

    const { code, stdout } = runUpdate(['--check'], { CLAUDE_PLUGIN_ROOT: cacheRoot });

    expect(code).toBe(0);
    expect(stdout).toContain('Native marketplace install detected');
    expect(stdout).toContain('/plugin marketplace update artibot');
    // Proof it short-circuited before the network fetch:
    expect(stdout).not.toContain('Latest version');
  });
});
