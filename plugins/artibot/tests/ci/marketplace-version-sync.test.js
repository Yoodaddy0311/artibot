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
  const rootPackageJson = readJson(join(REPO_ROOT, 'package.json'));
  const rootMarketplace = readJson(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
  const publicMarketplace = readJson(join(PLUGIN_ROOT, 'marketplace.json'));

  it('plugin.json and package.json versions agree', () => {
    expect(pluginJson.version).toBe(packageJson.version);
  });

  it('root <repo>/package.json version matches plugin.json', () => {
    expect(rootPackageJson.version).toBe(pluginJson.version);
  });

  it('<repo>/.claude-plugin/marketplace.json artibot entry matches plugin.json', () => {
    const artibotEntry = rootMarketplace.plugins.find((p) => p.name === 'artibot');
    expect(artibotEntry, 'artibot entry missing from root marketplace.json').toBeDefined();
    expect(artibotEntry.version).toBe(pluginJson.version);
  });

  it('public plugins/artibot/marketplace.json#/version matches plugin.json', () => {
    expect(publicMarketplace.version).toBe(pluginJson.version);
  });

  it('public plugins/artibot/marketplace.json#/release.current matches plugin.json', () => {
    expect(publicMarketplace.release?.current).toBe(pluginJson.version);
  });

  it('Node engine requirement is consistent (>=20)', () => {
    expect(packageJson.engines?.node).toMatch(/>=\s*20/);
    expect(pluginJson.compatibility?.node).toMatch(/>=\s*20/);
    expect(rootPackageJson.engines?.node).toMatch(/>=\s*20/);
  });
});

describe('install scripts do not hardcode stale versions', () => {
  const installSh = readText(join(PLUGIN_ROOT, 'scripts', 'install.sh'));
  // Canonical Windows installer lives at the plugin root, not under scripts/
  // (scripts/install.ps1 is now a thin pass-through shim).
  const installPs1 = readText(join(PLUGIN_ROOT, 'install.ps1'));

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

describe('install scripts support --dry-run / --no-color', () => {
  const installSh = readText(join(PLUGIN_ROOT, 'scripts', 'install.sh'));
  // Canonical Windows installer lives at the plugin root (see note above).
  const installPs1 = readText(join(PLUGIN_ROOT, 'install.ps1'));

  it('install.sh parses --dry-run flag', () => {
    expect(installSh).toMatch(/--dry-run\)\s*DRY_RUN=1/);
  });

  it('install.sh parses --no-color flag', () => {
    expect(installSh).toMatch(/--no-color\)\s*NO_COLOR=1/);
  });

  it('install.sh dry-run banner suffix', () => {
    expect(installSh).toMatch(/\[DRY-RUN\]/);
  });

  it('install.ps1 declares -DryRun param', () => {
    expect(installPs1).toMatch(/\[switch\]\$DryRun/);
  });

  it('install.ps1 declares -NoColor param', () => {
    expect(installPs1).toMatch(/\[switch\]\$NoColor/);
  });
});

describe('canonical install.ps1 seeds read-only permissions', () => {
  // The canonical Windows installer must enable Agent Teams and seed a
  // conservative read-only allowlist (Read/Glob/Grep) into settings.json so
  // first-run users aren't prompted for every read. Write/Edit/Bash excluded.
  const installPs1 = readText(join(PLUGIN_ROOT, 'install.ps1'));

  it('seeds Read/Glob/Grep into permissions.allow', () => {
    expect(installPs1).toMatch(/\$SafeAllow\s*=\s*@\(\s*'Read',\s*'Glob',\s*'Grep'\s*\)/);
  });

  it('enables Agent Teams in settings.json', () => {
    expect(installPs1).toMatch(/CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS/);
  });

  it('flat-copies commands/agents and does NOT clone/`plugins load` (prefix-regression guard)', () => {
    // Lockstep with install.sh: flat-copy yields prefix-free `/save`. The
    // git-clone + `/plugins load` path yields namespaced `/artibot:save`, the
    // UX regression we must never reintroduce.
    expect(installPs1).toMatch(/Copy-MdFiles/);
    expect(installPs1).not.toMatch(/git clone/);
    expect(installPs1).not.toMatch(/plugins load/);
  });
});

describe('install.sh uses safe_copy_dir helper', () => {
  const installSh = readText(join(PLUGIN_ROOT, 'scripts', 'install.sh'));

  it('safe_copy_dir helper is defined', () => {
    expect(installSh).toMatch(/safe_copy_dir\(\)\s*\{/);
  });

  it('safe_copy_dir excludes node_modules and .git', () => {
    expect(installSh).toMatch(/--exclude='node_modules'/);
    expect(installSh).toMatch(/--exclude='\.git'/);
  });

  it('install_files uses safe_copy_dir (no executable bare cp -r "${source_dir}/.")', () => {
    // The string survives in the safe_copy_dir helper's docstring (intentionally,
    // explaining why the helper exists). Filter to executable lines only.
    const executable = installSh
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(executable).not.toMatch(/cp -r "\$\{source_dir\}\/\."/);
    expect(installSh).toMatch(/safe_copy_dir "\$\{source_dir\}" "\$\{PLUGIN_DIR\}"/);
  });
});

describe('install.sh curl-pipe fallback fetches plugin.json from GitHub raw', () => {
  const installSh = readText(join(PLUGIN_ROOT, 'scripts', 'install.sh'));

  it('curl-pipe path fetches raw plugin.json with timeout', () => {
    expect(installSh).toMatch(/raw\.githubusercontent\.com\/Yoodaddy0311\/artibot\/master\/plugins\/artibot\/\.claude-plugin\/plugin\.json/);
    expect(installSh).toMatch(/curl -fsSL --max-time 5/);
  });
});

describe('update-git.js auto-detects Windows OneDrive/Desktop clone paths', () => {
  // findSourceRepo (with the OneDrive/Desktop auto-detection list) moved from
  // update.js into update-git.js in B4 (the git machinery extraction). These
  // source-location greps follow the code to its new home.
  const updateGitJs = readText(join(PLUGIN_ROOT, 'scripts', 'update-git.js'));

  it('includes OneDrive/Desktop English path', () => {
    expect(updateGitJs).toContain("path.join(oneDriveBase, 'Desktop'");
  });

  it('includes OneDrive/바탕 화면 Korean-localized Desktop path', () => {
    expect(updateGitJs).toContain("'바탕 화면'");
  });

  it('includes Desktop/AI/artibot subpath', () => {
    expect(updateGitJs).toMatch(/path\.join\(home, 'Desktop', 'AI', 'artibot'\)/);
  });
});

describe('self-control.yml concurrency group is per-task', () => {
  const selfControlYml = readText(join(REPO_ROOT, '.github', 'workflows', 'self-control.yml'));

  it('group includes task or schedule discriminator', () => {
    expect(selfControlYml).toMatch(/group:\s*self-control-.*github\.event\.inputs\.task/);
    expect(selfControlYml).toMatch(/github\.event\.schedule/);
  });
});

describe('ci.yml cache key extends beyond lockfile', () => {
  const ciYml = readText(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'));

  it('cache-dependency-path is multi-line and includes runtime or _reports', () => {
    expect(ciYml).toMatch(/cache-dependency-path:\s*\|/);
    expect(ciYml).toMatch(/plugins\/artibot\/(runtime|_reports)\/\*\*\/\*\.json/);
  });
});

describe('root marketplace.json carries lockstep $comment', () => {
  const rootMarketplace = readJson(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));

  it('top-level version is 1.0.0 (manifest schema version, NOT plugin version)', () => {
    expect(rootMarketplace.version).toBe('1.0.0');
  });

  it('$comment explains the manifest-vs-plugin version distinction', () => {
    expect(rootMarketplace.$comment).toMatch(/manifest/i);
    expect(rootMarketplace.$comment).toMatch(/plugin/i);
  });
});

describe('release-cowork.yml documents qualityMetrics policy', () => {
  const cowork = readText(join(REPO_ROOT, '.github', 'workflows', 'release-cowork.yml'));

  it('explains why no marketplace.json auto-sync runs for cowork', () => {
    expect(cowork).toMatch(/qualityMetrics/);
    expect(cowork).toMatch(/cowork/);
  });
});
