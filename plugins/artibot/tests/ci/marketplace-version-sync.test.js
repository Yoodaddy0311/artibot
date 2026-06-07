/**
 * Tripwire: marketplace.json version must match plugin.json/package.json.
 *
 * Why: Claude Code marketplace caches by version. Stale marketplace.json
 * routes new installations to old hook code, causing silent UserPromptSubmit
 * failures. This test fails CI before the drift can reach users.
 *
 * Also asserts the install scripts no longer hardcode legacy versions
 * (install.sh was 2.0.0, install.ps1 was 1.3.0) — they must parse
 * plugin.json/package.json at runtime instead.
 *
 * @module tests/ci/marketplace-version-sync
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = .../plugins/artibot/tests/ci
const PLUGIN_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

describe('marketplace.json version sync', () => {
  const pluginJson = readJson(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const packageJson = readJson(join(PLUGIN_ROOT, 'package.json'));
  const marketplace = readJson(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));

  it('plugin.json and package.json versions agree', () => {
    expect(pluginJson.version).toBe(packageJson.version);
  });

  it('marketplace.json artibot plugin version matches plugin.json', () => {
    const artibotEntry = marketplace.plugins.find((p) => p.name === 'artibot');
    expect(artibotEntry, 'artibot entry missing from marketplace.json').toBeDefined();
    expect(artibotEntry.version).toBe(pluginJson.version);
  });

  it('Node engine requirement is consistent (>=20)', () => {
    expect(packageJson.engines?.node).toMatch(/>=\s*20/);
    expect(pluginJson.compatibility?.node).toMatch(/>=\s*20/);
  });
});

describe('install scripts do not hardcode stale versions', () => {
  const installSh = readText(join(PLUGIN_ROOT, 'scripts', 'install.sh'));
  const installPs1 = readText(join(PLUGIN_ROOT, 'scripts', 'install.ps1'));

  it('install.sh does not hardcode ARTIBOT_VERSION literal', () => {
    expect(installSh).not.toMatch(/ARTIBOT_VERSION="[\d.]+"/);
  });

  it('install.ps1 does not hardcode $ARTIBOT_VERSION literal', () => {
    expect(installPs1).not.toMatch(/\$ARTIBOT_VERSION\s*=\s*"[\d.]+"/);
  });

  it('install.sh requires Node >= 20', () => {
    expect(installSh).toMatch(/MIN_NODE_MAJOR=20\b/);
  });

  it('install.ps1 requires Node >= 20', () => {
    expect(installPs1).toMatch(/\$MIN_NODE_MAJOR\s*=\s*20\b/);
  });
});
