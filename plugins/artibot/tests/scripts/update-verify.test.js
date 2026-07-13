/**
 * Tests for scripts/update-verify.js — the pre/post-condition gates that turn a
 * silent no-op update into a loud, recoverable failure.
 *
 * Covers:
 *   - installLanded (INV-1): forced/drift exemption + pending-update bar + v-prefix
 *   - assertUpdatePrecondition (INV-2): blocks the self-install no-op combo
 *   - collectPostInstallInvariants (INV-3/4/5/6): hooks/mirror/cache/marker
 *   - assertPostInstall: failure subset
 *   - hashFile / renderInvariantTable
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPostInstall,
  assertUpdatePrecondition,
  collectPostInstallInvariants,
  hashFile,
  installLanded,
  renderInvariantTable,
} from '../../scripts/update-verify.js';

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'artibot-update-verify-'));
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

function writeHooks(root, payload) {
  const dir = join(root, 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hooks.json'), payload);
  return root;
}

describe('installLanded (INV-1)', () => {
  it('exempts a forced/drift reinstall (no pending update)', () => {
    expect(installLanded('4.26.0', 'v4.26.0', false)).toBe(true);
    expect(installLanded('4.26.0', 'v4.27.0', false)).toBe(true);
  });

  it('reports NOT landed when a pending update stayed behind', () => {
    expect(installLanded('4.26.0', 'v4.26.1', true)).toBe(false);
  });

  it('reports landed when the installed version reached latest', () => {
    expect(installLanded('4.26.1', 'v4.26.1', true)).toBe(true);
  });

  it('tolerates a v-prefixed latest tag', () => {
    expect(installLanded('4.26.0', 'v4.26.1', true)).toBe(false);
  });
});

describe('assertUpdatePrecondition (INV-2)', () => {
  const home = '/fake/home';

  it('blocks when a pending update has no fresh source and targets the installed copy', () => {
    const r = assertUpdatePrecondition({
      updateAvailable: true,
      pulled: false,
      sourcePluginDir: null,
      installTargetDir: '/fake/home/.claude/artibot',
      home,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-fresh-source');
  });

  it('allows when fresh source was pulled', () => {
    const r = assertUpdatePrecondition({
      updateAvailable: true,
      pulled: true,
      sourcePluginDir: '/repo/plugins/artibot',
      installTargetDir: '/repo/plugins/artibot',
      home,
    });
    expect(r.ok).toBe(true);
  });

  it('exempts a forced/drift reinstall (no update pending)', () => {
    const r = assertUpdatePrecondition({
      updateAvailable: false,
      pulled: false,
      sourcePluginDir: null,
      installTargetDir: '/fake/home/.claude/artibot',
      home,
    });
    expect(r.ok).toBe(true);
  });

  it('allows a non-self-install target without a pull (tarball etc.)', () => {
    const r = assertUpdatePrecondition({
      updateAvailable: true,
      pulled: false,
      sourcePluginDir: null,
      installTargetDir: '/some/other/checkout/plugins/artibot',
      home,
    });
    expect(r.ok).toBe(true);
  });
});

describe('collectPostInstallInvariants (INV-3/4/5/6)', () => {
  function setup({ installedVersion = '4.26.1', updateAvailable = true } = {}) {
    const home = join(tmpRoot, 'home');
    const installedRoot = join(home, '.claude', 'artibot');
    mkdirSync(installedRoot, { recursive: true });
    writeFileSync(join(installedRoot, 'artibot.config.json'), JSON.stringify({ version: installedVersion }));
    writeHooks(installedRoot, '{"v":1}');
    return { home, installedRoot, installedVersion, updateAvailable };
  }

  it('all PASS on a clean, consistent install', () => {
    const { home, installedRoot } = setup();
    const sourceRoot = writeHooks(join(tmpRoot, 'src'), '{"v":1}'); // matches installed
    const inv = collectPostInstallInvariants({
      home, installedRoot, sourcePluginRoot: sourceRoot,
      installedVersion: '4.26.1', latestVersion: 'v4.26.1', updateAvailable: true,
    });
    expect(assertPostInstall(inv).ok).toBe(true);
  });

  it('INV-1 fails when the installed version stayed behind', () => {
    const { home, installedRoot } = setup({ installedVersion: '4.26.0' });
    const inv = collectPostInstallInvariants({
      home, installedRoot, sourcePluginRoot: null,
      installedVersion: '4.26.0', latestVersion: 'v4.26.1', updateAvailable: true,
    });
    const res = assertPostInstall(inv);
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.id)).toContain('INV-1');
  });

  it('INV-3 fails when source and installed hooks.json diverge', () => {
    const { home, installedRoot } = setup();
    const sourceRoot = writeHooks(join(tmpRoot, 'src'), '{"v":2}'); // differs
    const inv = collectPostInstallInvariants({
      home, installedRoot, sourcePluginRoot: sourceRoot,
      installedVersion: '4.26.1', latestVersion: 'v4.26.1', updateAvailable: true,
    });
    const res = assertPostInstall(inv);
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.id)).toContain('INV-3');
  });

  it('INV-4 fails when a non-git marketplace mirror diverges from installed', () => {
    const { home, installedRoot } = setup();
    const mirrorRoot = join(home, '.claude', 'plugins', 'marketplaces', 'artibot', 'plugins', 'artibot');
    writeHooks(mirrorRoot, '{"v":2}'); // differs from installed {"v":1}
    const inv = collectPostInstallInvariants({
      home, installedRoot, sourcePluginRoot: null,
      installedVersion: '4.26.1', latestVersion: 'v4.26.1', updateAvailable: true,
    });
    const res = assertPostInstall(inv);
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.id)).toContain('INV-4');
  });

  it('INV-4 is skipped for a git-managed marketplace (mirror intentionally not written)', () => {
    // Regression (2026-07-13 v4.32.0-stuck incident): install.sh/ps1 never
    // write into a git-managed marketplace, so a version gap there is
    // expected — comparing it would be a guaranteed false failure.
    const { home, installedRoot } = setup();
    const marketplaceRoot = join(home, '.claude', 'plugins', 'marketplaces', 'artibot');
    mkdirSync(join(marketplaceRoot, '.git'), { recursive: true });
    writeHooks(join(marketplaceRoot, 'plugins', 'artibot'), '{"v":2}'); // stale clone content
    const inv = collectPostInstallInvariants({
      home, installedRoot, sourcePluginRoot: null,
      installedVersion: '4.26.1', latestVersion: 'v4.26.1', updateAvailable: true,
    });
    expect(inv.map((i) => i.id)).not.toContain('INV-4');
    expect(assertPostInstall(inv).ok).toBe(true);
  });

  it('INV-6 fails when the .last-install-noop marker is present for a pending update', () => {
    const { home, installedRoot } = setup();
    writeFileSync(join(installedRoot, '.last-install-noop'), new Date(0).toISOString());
    const inv = collectPostInstallInvariants({
      home, installedRoot, sourcePluginRoot: null,
      installedVersion: '4.26.1', latestVersion: 'v4.26.1', updateAvailable: true,
    });
    const res = assertPostInstall(inv);
    expect(res.ok).toBe(false);
    expect(res.failures.map((f) => f.id)).toContain('INV-6');
  });

  it('INV-6 is exempt when no update was pending (force/drift)', () => {
    const { home, installedRoot } = setup({ updateAvailable: false });
    writeFileSync(join(installedRoot, '.last-install-noop'), new Date(0).toISOString());
    const inv = collectPostInstallInvariants({
      home, installedRoot, sourcePluginRoot: null,
      installedVersion: '4.26.1', latestVersion: 'v4.26.1', updateAvailable: false,
    });
    expect(assertPostInstall(inv).ok).toBe(true);
  });
});

describe('hashFile', () => {
  it('returns a stable SHA-1 and null for missing files', () => {
    const f = join(tmpRoot, 'a.txt');
    writeFileSync(f, 'hello');
    expect(hashFile(f)).toHaveLength(40);
    expect(hashFile(f)).toBe(hashFile(f));
    expect(hashFile(join(tmpRoot, 'nope'))).toBeNull();
  });
});

describe('renderInvariantTable', () => {
  it('renders a GFM table with PASS/FAIL', () => {
    const t = renderInvariantTable([
      { id: 'INV-1', label: 'version landing', ok: true, detail: 'installed v4.26.1' },
      { id: 'INV-6', label: 'no-op direct detection', ok: false, detail: 'no-op' },
    ]);
    expect(t).toContain('| INV | check | result | detail |');
    expect(t).toContain('| INV-1 | version landing | PASS | installed v4.26.1 |');
    expect(t).toContain('| INV-6 | no-op direct detection | FAIL | no-op |');
  });
});
