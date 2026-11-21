/**
 * release-check.js must fail CLOSED when a lockstep file has no version.
 *
 * -- What broke (review L15, 2026-11-21) ----------------------------------------
 * `versions` collected `readJson(file).version || null` (and `?? null` for the
 * marketplace key paths), then compared `new Set(versions.map(v => v.version)
 * .filter(Boolean))`. A file whose version key was missing became `null`, the
 * filter dropped it, and the remaining files agreed with each other — exit 0.
 * When the missing key was package.json's, `canonicalVersion` was null and the
 * CHANGELOG check was skipped without a word.
 *
 * -- How this is tested --------------------------------------------------------
 * The script resolves PLUGIN_ROOT from its own location and runs at import, so
 * each case copies it into a fresh temp tree (`<tmp>/plugins/artibot/scripts/`)
 * next to a complete fixture lockstep set, breaks ONE thing, and runs it with
 * `--no-sync-check`. Nothing in the shared working tree is touched.
 *
 * -- What this cannot see -------------------------------------------------------
 *  - The real repo's lockstep set; `release-check-smoke.test.js` runs that.
 *  - Whether the fixture set stays complete if release-check.js gains a new
 *    lockstep source: the baseline case below goes RED ("Missing version file")
 *    in that case, which is the intended signal to extend `writeLockstep`.
 *
 * @module tests/ci/release-check-missing-version
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'release-check.js');
const V = '9.9.9';
const BASE = mkdtempSync(path.join(os.tmpdir(), 'release-check-'));

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const text = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
};

/**
 * Build a complete, consistent lockstep tree and apply `mutate` to the
 * documents before they are written.
 *
 * @param {string} id - Case id (directory name).
 * @param {(docs: Record<string, any>) => void} [mutate]
 * @returns {{ status: number|null, out: string }}
 */
function run(id, mutate = () => {}) {
  const repo = path.join(BASE, id);
  const plugin = path.join(repo, 'plugins', 'artibot');
  const docs = {
    pkg: { name: 'artibot', version: V },
    config: { version: V },
    manifest: { name: 'artibot', version: V },
    mcp: { name: 'artibot', version: V },
    repoPkg: { name: 'artibot-repo', version: V },
    rootMarket: { plugins: [{ name: 'artibot', version: V }] },
    pubMarket: { version: V, release: { current: V } },
    agents: `Current plugin version: **${V}**\n`,
    readme: `![v](https://img.shields.io/badge/version-${V}-blue)\n`,
    changelog: `# Changelog\n\n## [${V}] - 2026-11-21\n`,
  };
  mutate(docs);
  json(path.join(plugin, 'package.json'), docs.pkg);
  json(path.join(plugin, 'artibot.config.json'), docs.config);
  json(path.join(plugin, '.claude-plugin', 'plugin.json'), docs.manifest);
  json(path.join(plugin, '.well-known', 'mcp-server.json'), docs.mcp);
  json(path.join(repo, 'package.json'), docs.repoPkg);
  json(path.join(repo, '.claude-plugin', 'marketplace.json'), docs.rootMarket);
  json(path.join(plugin, 'marketplace.json'), docs.pubMarket);
  text(path.join(plugin, 'AGENTS.md'), docs.agents);
  text(path.join(repo, 'README.md'), docs.readme);
  text(path.join(plugin, 'README.md'), docs.readme);
  text(path.join(plugin, 'CHANGELOG.md'), docs.changelog);
  mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  copyFileSync(SCRIPT, path.join(plugin, 'scripts', 'release-check.js'));
  const r = spawnSync(process.execPath, [path.join(plugin, 'scripts', 'release-check.js'), '--no-sync-check'], {
    encoding: 'utf8',
    cwd: plugin,
  });
  // ANSI colour codes would otherwise split the words the assertions look for.
  // eslint-disable-next-line no-control-regex -- stripping the script's own colour escapes
  return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
}

describe('release-check.js: a lockstep file without a version is an error', () => {
  it('passes a complete, consistent fixture set (control: the harness is not RED by itself)', () => {
    const r = run('baseline');
    expect(r.out).toContain('All checks passed');
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ['artibot.config.json', (d) => { delete d.config.version; }],
    ['.claude-plugin/plugin.json', (d) => { delete d.manifest.version; }],
    ['.well-known/mcp-server.json', (d) => { delete d.mcp.version; }],
    ['<repo>/package.json', (d) => { d.repoPkg.version = ''; }],
    ['<repo>/.claude-plugin/marketplace.json#/plugins[artibot].version', (d) => { delete d.rootMarket.plugins[0].version; }],
    ['marketplace.json#/version', (d) => { delete d.pubMarket.version; }],
    ['marketplace.json#/release.current', (d) => { delete d.pubMarket.release; }],
  ])('%s with no version fails (was: filtered out, exit 0)', (label, mutate) => {
    const r = run(`no-version-${label.replace(/[^a-z0-9]+/gi, '-')}`, mutate);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`No version found in ${label}`);
  });

  it('package.json with no version fails and says the CHANGELOG check could not run', () => {
    const r = run('no-version-package-json', (d) => { delete d.pkg.version; });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('No version found in package.json');
    expect(r.out).toContain('CHANGELOG.md check skipped');
  });

  it('a non-string version (number) is not accepted as a version', () => {
    const r = run('numeric-version', (d) => { d.config.version = 999; });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('No version found in artibot.config.json');
  });

  it('still reports a real mismatch (control: the existing check is intact)', () => {
    const r = run('mismatch', (d) => { d.mcp.version = '9.9.8'; });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('Version mismatch across files');
  });

  it('still reports a missing CHANGELOG entry (control)', () => {
    const r = run('no-changelog-entry', (d) => { d.changelog = '# Changelog\n\n## [9.9.8]\n'; });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`CHANGELOG.md missing entry for version ${V}`);
  });
});
