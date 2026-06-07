/**
 * Smoke test: release-check.js
 *
 * Verifies the script exits 0 against the current repo state, and that the
 * lockstep set extension (root package.json + both marketplace.json files,
 * added 2026-06-08 to prevent the 4.13.1 vs 4.19.6 marketplace-cache incident)
 * is wired into the script source — a regression tripwire so future refactors
 * cannot silently drop the new lockstep entries.
 *
 * @module tests/ci/release-check-smoke
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'release-check.js');

describe('release-check.js smoke', () => {
  it('exits 0 when current versions are in lockstep', () => {
    const result = spawnSync('node', [SCRIPT, '--no-sync-check'], {
      encoding: 'utf8',
      cwd: PLUGIN_ROOT,
    });
    expect(
      result.status,
      `release-check.js failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
  });

  describe('lockstep source tripwire (regression guard)', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    it('includes <repo>/package.json in the lockstep set', () => {
      expect(source).toContain("'<repo>/package.json'");
    });

    it('includes <repo>/.claude-plugin/marketplace.json artibot entry check', () => {
      expect(source).toContain("'<repo>/.claude-plugin/marketplace.json#/plugins[artibot].version'");
    });

    it('includes plugins/artibot/marketplace.json #/version and #/release.current', () => {
      expect(source).toContain("'marketplace.json#/version'");
      expect(source).toContain("'marketplace.json#/release.current'");
    });
  });
});
