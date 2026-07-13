/**
 * Tests for scripts/update-marketplace.js — the marketplace-clone health
 * check + master-branch version source added in v4.36.4.
 *
 * Root incident (2026-07-13): the marketplace clone sat dirty + diverged
 * (pre-v4.36.4 install.sh mirror pollution) while GitHub Releases stopped at
 * v4.30.0 — both version oracles lied and /update reported a stale v4.32.0
 * as "latest". These tests pin the honest behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isNewerVersion } from '../../lib/core/version-checker.js';
import {
  fetchLatestMasterVersion,
  inspectMarketplaceClone,
  MASTER_PLUGIN_JSON_URL,
  renderMarketplaceDiagnosis,
} from '../../scripts/update-marketplace.js';

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'artibot-update-mkt-'));
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a fake marketplace clone under a fake home. */
function makeClone(home, { version = '4.32.0', git = true } = {}) {
  const root = join(home, '.claude', 'plugins', 'marketplaces', 'artibot');
  const manifestDir = join(root, 'plugins', 'artibot', '.claude-plugin');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, 'plugin.json'), JSON.stringify({ name: 'artibot', version }));
  if (git) mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// fetchLatestMasterVersion
// ---------------------------------------------------------------------------

describe('fetchLatestMasterVersion', () => {
  it('reads the version field from master plugin.json', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '4.36.4' }) }),
    );
    await expect(fetchLatestMasterVersion({ fetchImpl })).resolves.toBe('4.36.4');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(MASTER_PLUGIN_JSON_URL);
  });

  it('strips a v prefix from the manifest version', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 'v4.36.4' }) }),
    );
    await expect(fetchLatestMasterVersion({ fetchImpl })).resolves.toBe('4.36.4');
  });

  it('returns null on non-2xx, missing version, and network error', async () => {
    const notOk = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    await expect(fetchLatestMasterVersion({ fetchImpl: notOk })).resolves.toBeNull();

    const noVersion = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    await expect(fetchLatestMasterVersion({ fetchImpl: noVersion })).resolves.toBeNull();

    const boom = vi.fn(() => Promise.reject(new Error('ENOTFOUND')));
    await expect(fetchLatestMasterVersion({ fetchImpl: boom })).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inspectMarketplaceClone
// ---------------------------------------------------------------------------

describe('inspectMarketplaceClone', () => {
  it('reports absent when no marketplace clone exists', () => {
    const state = inspectMarketplaceClone(join(tmpRoot, 'home'));
    expect(state).toEqual({ present: false, root: null, isGit: false, dirty: null, version: null });
  });

  it('reads the clone version and detects a dirty git worktree', () => {
    const home = join(tmpRoot, 'home');
    const root = makeClone(home, { version: '4.32.0' });
    const exec = vi.fn(() => ' M plugins/artibot/package.json\n');
    const state = inspectMarketplaceClone(home, { exec });
    expect(state.present).toBe(true);
    expect(state.root).toBe(root);
    expect(state.isGit).toBe(true);
    expect(state.dirty).toBe(true);
    expect(state.version).toBe('4.32.0');
    expect(exec.mock.calls[0][1]).toEqual(['-C', root, 'status', '--porcelain']);
  });

  it('reports dirty=false for a clean worktree and dirty=null when git fails', () => {
    const home = join(tmpRoot, 'home');
    makeClone(home);
    expect(inspectMarketplaceClone(home, { exec: vi.fn(() => '') }).dirty).toBe(false);
    expect(
      inspectMarketplaceClone(home, { exec: vi.fn(() => { throw new Error('git missing'); }) }).dirty,
    ).toBeNull();
  });

  it('treats a non-git marketplace as isGit=false without running git', () => {
    const home = join(tmpRoot, 'home');
    makeClone(home, { git: false });
    const exec = vi.fn();
    const state = inspectMarketplaceClone(home, { exec });
    expect(state.isGit).toBe(false);
    expect(state.dirty).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// renderMarketplaceDiagnosis
// ---------------------------------------------------------------------------

describe('renderMarketplaceDiagnosis', () => {
  const args = { latestVersion: '4.36.4', isNewerVersion };

  it('is silent for an absent or healthy clone', () => {
    expect(renderMarketplaceDiagnosis({ present: false }, args)).toEqual([]);
    const healthy = { present: true, root: '/x', isGit: true, dirty: false, version: '4.36.4' };
    expect(renderMarketplaceDiagnosis(healthy, args)).toEqual([]);
  });

  it('diagnoses a stale clone with the exact repair commands', () => {
    const stuck = { present: true, root: '/mkt/artibot', isGit: true, dirty: true, version: '4.32.0' };
    const lines = renderMarketplaceDiagnosis(stuck, args).join('\n');
    expect(lines).toContain('v4.32.0 is behind latest v4.36.4');
    expect(lines).toContain('DIRTY');
    expect(lines).toContain('git -C "/mkt/artibot" fetch origin && git -C "/mkt/artibot" reset --hard origin/master');
    expect(lines).toContain('claude plugin marketplace update artibot');
  });

  it('diagnoses a dirty-but-current clone (pollution caught before it strands an update)', () => {
    const dirty = { present: true, root: '/mkt/artibot', isGit: true, dirty: true, version: '4.36.4' };
    const lines = renderMarketplaceDiagnosis(dirty, args).join('\n');
    expect(lines).toContain('DIRTY');
    expect(lines).not.toContain('behind latest');
  });
});
