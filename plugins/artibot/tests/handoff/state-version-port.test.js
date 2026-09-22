/**
 * `createStateVersionPort` — the read-only port `/save` hands to
 * `collectHandoffData` so the HANDOFF frontmatter can carry a real
 * `derived-from: state@<n>` instead of the permanent `state@unmeasured`.
 *
 * ── What this file pins ───────────────────────────────────────────────────
 *  1. A store resolved under the git common dir with a recorded version
 *     yields that integer.
 *  2. `state_version: 0` yields `null`, NOT `0`. Zero is the empty-snapshot
 *     sentinel (`lib/project-state/journal.js#emptySnapshot`), so a brand-new
 *     or never-written store is indistinguishable from "nothing recorded".
 *     Reporting `state@0` would claim provenance the store does not have.
 *  3. The `project-root-fallback` location yields `null` unconditionally —
 *     even when a snapshot sits there with a version. That directory is
 *     per-worktree and therefore divergent by construction
 *     (`lib/project-state/store-location.js` decision F3), so a number read
 *     from it is not the project's state version.
 *  4. Every failure is soft: a throwing git port, an unreadable store, a bad
 *     `projectRoot` — all `null`, never a throw. The handoff must still be
 *     written when provenance cannot be measured.
 *  5. The call is READ-ONLY. The store directory hashes identically before
 *     and after, and no `.artibot/state.yaml` projection appears.
 *
 * ── What this file does NOT pin ───────────────────────────────────────────
 *  - That `/save` actually calls it. `/save` is prose (`commands/save.md`),
 *    executed by the model; there is no code call site to assert on. The
 *    prose naming the port is pinned by the save.md gates, and the live
 *    end-to-end check (run `/save`, read `derived-from`) is a human step.
 *  - Timeout behaviour. The port is synchronous filesystem reads; the
 *    builder's JSDoc already states bounding is the caller's job.
 *
 * @module tests/handoff/state-version-port
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectHandoffData, renderHandoffMarkdown } from '../../lib/handoff/handoff-builder.js';
import { createStateVersionPort } from '../../lib/handoff/state-version-port.js';
import { emptySnapshot } from '../../lib/project-state/journal.js';
import { SNAPSHOT_FILE } from '../../lib/project-state/state-manager.js';

/** Temp roots created by the tests, torn down in afterEach. */
const roots = [];

/**
 * Make a throwaway project root.
 *
 * @returns {string} Absolute path to a fresh empty directory.
 */
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'artibot-svport-'));
  roots.push(root);
  return root;
}

/**
 * Write a snapshot carrying `stateVersion` into `dir`.
 *
 * The snapshot alone is enough: with no journal beside it the store's
 * loader keeps the on-disk snapshot whenever its version is at least the
 * journal's (zero), so this is the cheapest honest fixture.
 *
 * @param {string} dir - Store directory.
 * @param {number} stateVersion - Version to record.
 * @returns {void}
 */
function seedStore(dir, stateVersion) {
  mkdirSync(dir, { recursive: true });
  const snapshot = { ...emptySnapshot('fixture'), state_version: stateVersion, updated_at: '2026-09-21T00:00:00.000Z' };
  writeFileSync(path.join(dir, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/**
 * Hash a directory tree's relative paths and bytes.
 *
 * @param {string} dir - Directory to hash; a missing directory hashes empty.
 * @returns {string} Hex digest.
 */
function hashDir(dir) {
  const h = createHash('sha256');
  /**
   * @param {string} abs - Absolute directory.
   * @param {string} rel - Path relative to the hash root.
   * @returns {void}
   */
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), next);
      else h.update(next).update(readFileSync(path.join(abs, entry.name)));
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return h.digest('hex');
}

/** A git port that reports a main checkout, so the store lands under `.git/artibot`. */
const COMMON_DIR = () => '.git';

/** A git port that resolves nothing, forcing the per-worktree fallback. */
const NO_COMMON_DIR = () => null;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('createStateVersionPort — value domain', () => {
  it('returns the recorded version when the store sits under the git common dir', () => {
    const root = makeRoot();
    seedStore(path.join(root, '.git', 'artibot'), 30);
    expect(createStateVersionPort({ projectRoot: root, resolveGitCommonDir: COMMON_DIR })()).toBe(30);
  });

  it('returns null for state_version 0 — the empty-snapshot sentinel, not a provenance', () => {
    const root = makeRoot();
    seedStore(path.join(root, '.git', 'artibot'), 0);
    expect(createStateVersionPort({ projectRoot: root, resolveGitCommonDir: COMMON_DIR })()).toBeNull();
  });

  it('returns null when no store file exists at all', () => {
    const root = makeRoot();
    expect(createStateVersionPort({ projectRoot: root, resolveGitCommonDir: COMMON_DIR })()).toBeNull();
  });

  it('returns null from the project-root-fallback location even when a version is recorded there', () => {
    const root = makeRoot();
    seedStore(path.join(root, '.artibot', 'runtime'), 7);
    expect(createStateVersionPort({ projectRoot: root, resolveGitCommonDir: NO_COMMON_DIR })()).toBeNull();
  });
});

describe('createStateVersionPort — soft failure', () => {
  it('returns null when the git port throws', () => {
    const root = makeRoot();
    seedStore(path.join(root, '.git', 'artibot'), 12);
    const port = createStateVersionPort({
      projectRoot: root,
      resolveGitCommonDir: () => { throw new Error('git missing'); },
    });
    expect(port()).toBeNull();
  });

  it('returns null instead of throwing on a missing projectRoot', () => {
    expect(createStateVersionPort()).toBeTypeOf('function');
    expect(createStateVersionPort()()).toBeNull();
    expect(createStateVersionPort({ projectRoot: '' })()).toBeNull();
  });

  it('returns null when the snapshot is unparseable', () => {
    const root = makeRoot();
    const dir = path.join(root, '.git', 'artibot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, SNAPSHOT_FILE), '{ not json', 'utf8');
    expect(createStateVersionPort({ projectRoot: root, resolveGitCommonDir: COMMON_DIR })()).toBeNull();
  });
});

describe('createStateVersionPort — read-only', () => {
  it('leaves the store directory byte-identical and writes no projection', () => {
    const root = makeRoot();
    const dir = path.join(root, '.git', 'artibot');
    seedStore(dir, 30);
    const before = hashDir(dir);

    const port = createStateVersionPort({ projectRoot: root, resolveGitCommonDir: COMMON_DIR });
    expect(port()).toBe(30);
    expect(port()).toBe(30);

    expect(hashDir(dir)).toBe(before);
    expect(existsSync(path.join(root, '.artibot', 'state.yaml'))).toBe(false);
  });

  it('creates nothing when the store is absent', () => {
    const root = makeRoot();
    const before = hashDir(root);
    expect(createStateVersionPort({ projectRoot: root, resolveGitCommonDir: COMMON_DIR })()).toBeNull();
    expect(hashDir(root)).toBe(before);
  });
});

describe('createStateVersionPort — accepted by collectHandoffData', () => {
  /** A git runner that answers every probe with an empty string. */
  const GIT = () => '';

  it('stamps derived-from: state@<n> when the port measures a version', async () => {
    const root = makeRoot();
    seedStore(path.join(root, '.git', 'artibot'), 30);
    const data = await collectHandoffData({
      pluginRoot: root,
      projectRoot: root,
      gitRunner: GIT,
      readStateVersion: createStateVersionPort({ projectRoot: root, resolveGitCommonDir: COMMON_DIR }),
    });
    expect(data.meta.stateVersion).toBe(30);
    expect(renderHandoffMarkdown(data)).toContain('derived-from: state@30');
  });

  it('degrades to state@unmeasured from the fallback location', async () => {
    const root = makeRoot();
    seedStore(path.join(root, '.artibot', 'runtime'), 7);
    const data = await collectHandoffData({
      pluginRoot: root,
      projectRoot: root,
      gitRunner: GIT,
      readStateVersion: createStateVersionPort({ projectRoot: root, resolveGitCommonDir: NO_COMMON_DIR }),
    });
    expect(data.meta.stateVersion).toBeNull();
    expect(renderHandoffMarkdown(data)).toContain('derived-from: state@unmeasured');
  });
});
