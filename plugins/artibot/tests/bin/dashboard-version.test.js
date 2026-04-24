/**
 * dashboard-version.test.js — verify artibot-dashboard CLI `--version` output
 * matches the live `package.json` version (no hardcoded drift).
 *
 * Regression guard: v3.3.0 FX1 flagged that the dashboard was printing a
 * stale "3.2.0" even after package.json bumped to 3.4.0. This suite locks
 * the contract: `--version` and `-v` must print the current package.json
 * version exactly, and the help header must embed the same string.
 */

import { describe, expect, it } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(PLUGIN_ROOT, 'bin', 'artibot-dashboard.mjs');
const PKG_PATH = path.join(PLUGIN_ROOT, 'package.json');

function readPkgVersion() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  return pkg.version;
}

async function runCli(...args) {
  const { stdout, stderr } = await execFile(process.execPath, [CLI_PATH, ...args], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    timeout: 15_000,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

describe('artibot-dashboard --version', () => {
  it('prints the current package.json version with --version', async () => {
    const expected = readPkgVersion();
    const { stdout } = await runCli('--version');
    expect(stdout).toBe(expected);
  });

  it('prints the current package.json version with -v', async () => {
    const expected = readPkgVersion();
    const { stdout } = await runCli('-v');
    expect(stdout).toBe(expected);
  });

  it('emits a valid semver-shaped version (major.minor.patch)', async () => {
    const { stdout } = await runCli('--version');
    expect(stdout).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  });

  it('embeds the same version in --help output', async () => {
    const expected = readPkgVersion();
    const { stdout } = await runCli('--help');
    expect(stdout).toContain(`artibot-dashboard ${expected}`);
  });

  it('does not contain stale hardcoded "3.2.0" in CLI source', () => {
    const src = readFileSync(CLI_PATH, 'utf-8');
    // Source must not hardcode a specific semver literal for the version
    // constant. We allow the string inside comments/paths but not as the
    // value of the VERSION identifier.
    expect(src).not.toMatch(/const\s+VERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/);
  });
});
