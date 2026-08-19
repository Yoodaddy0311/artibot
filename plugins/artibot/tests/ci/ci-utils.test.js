/**
 * Tests for the CI scanners' shared helpers (scripts/ci/ci-utils.js).
 *
 * Why this file exists: `ci-utils.js` became the single source of truth for
 * "which roots do the documentation gates scan, and how do we know we are in
 * the dev repo" when the repo-root helpers moved here (2026-08-19) so that
 * `validate-doc-links.js` and `validate-md-rendering.js` could not drift apart
 * on the dev-repo GUARD. A safety check with two copies is how one gets fixed
 * and the other does not — but a shared check with no unit test is the same
 * hazard wearing a different hat.
 *
 * Deliberate overlap with `tests/firewall/cowork-doc-gates.test.js`: that file
 * pins the GATES (does the scanner still reach the root, does a planted
 * violation still go red). This one pins the MODULE CONTRACT (what each helper
 * returns for a given input, including inputs the live repo never produces).
 * The firewall pins would all still pass if `getRepoDocRoot` accepted any
 * directory whatsoever, because the live repo happens to be a dev repo.
 *
 * Every filesystem case runs against a temp directory driven through
 * `CLAUDE_PLUGIN_ROOT`, which `lib/core/platform.js#getPluginRoot` honours.
 * Nothing here reads or writes the real tree.
 *
 * What these tests do NOT cover: `extractFrontmatter` (exercised by the
 * validators that consume it), and whether the roots the helpers name actually
 * contain correct documentation — that is the gates' job, not the module's.
 *
 * @module tests/ci/ci-utils
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertRootScanFloor,
  assertScanFloors,
  gatherRepoRootDocFiles,
  getPluginsDir,
  getRepoDocRoot,
  isProjectPluginDir,
  listPluginRoots,
  MIN_DOC_FILES,
  MIN_ROOT_DOC_FILES,
  ROOT_SCAN_FILES,
} from '../../scripts/ci/ci-utils.js';

/** Root of a synthetic tree; each test builds the shape it needs underneath. */
let tmpRoot;
/** Restored after every test so one case cannot leak into the next. */
const savedEnv = process.env.CLAUDE_PLUGIN_ROOT;

/**
 * Build a synthetic `<repo>/plugins/artibot` tree and point the resolver at it.
 *
 * @param {{ marker?: boolean, rootDocs?: string[], plugins?: string[] }} opts
 * @returns {string} The synthetic repo root.
 */
function makeTree({ marker = true, rootDocs = [], plugins = ['artibot'] } = {}) {
  const repo = mkdtempSync(path.join(tmpRoot, 'repo-'));
  for (const name of plugins) mkdirSync(path.join(repo, 'plugins', name), { recursive: true });
  if (marker) {
    mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(repo, '.claude-plugin', 'marketplace.json'), '{}', 'utf-8');
  }
  for (const doc of rootDocs) writeFileSync(path.join(repo, doc), '# x\n', 'utf-8');
  process.env.CLAUDE_PLUGIN_ROOT = path.join(repo, 'plugins', 'artibot');
  return repo;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'artibot-ci-utils-'));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = savedEnv;
});

describe('ROOT_SCAN_FILES / MIN_ROOT_DOC_FILES constants', () => {
  it('names the authored root docs and excludes frozen or personal ones', () => {
    expect(ROOT_SCAN_FILES).toEqual([
      'README.md',
      'CONTRIBUTING.md',
      'INSTALL.md',
      'CLAUDE.md',
      'AGENTS.md',
    ]);
  });

  it('excludes CHANGELOG / RELEASE_NOTES / WORK-REPORT / CLAUDE.local by omission', () => {
    // Stated as an assertion rather than a comment: these were excluded on
    // purpose (append-only history, frozen dated artifacts, gitignored personal
    // config). Adding one silently would rewrite that decision.
    for (const excluded of [
      'CHANGELOG.md',
      'RELEASE_NOTES_4.7_KO.md',
      'WORK-REPORT-2026-03-30.md',
      'CLAUDE.local.md',
    ]) {
      expect(ROOT_SCAN_FILES).not.toContain(excluded);
    }
  });

  it('floor is pinned at the measured count, not padded with slack', () => {
    // 4 of the 5 listed files exist (AGENTS.md has never existed at the repo
    // root), and repo history shows zero deletions of any of them. A floor
    // below the real count would let a deletion pass silently.
    expect(MIN_ROOT_DOC_FILES).toBe(4);
    expect(MIN_ROOT_DOC_FILES).toBeLessThanOrEqual(ROOT_SCAN_FILES.length);
  });
});

describe('getRepoDocRoot — dev-repo marker guard', () => {
  it('returns the repo root when the marketplace marker is present', () => {
    const repo = makeTree({ marker: true });
    expect(getRepoDocRoot()).toBe(repo);
  });

  it('returns null when the marker is absent (installed tree)', () => {
    // In an installed tree getPluginsDir()'s parent is ~/.claude. Without this
    // guard the gates would walk the user's personal ~/.claude/CLAUDE.md and
    // report their problems as Artibot CI failures.
    makeTree({ marker: false });
    expect(getRepoDocRoot()).toBeNull();
  });

  it('requires the marker FILE, not merely the .claude-plugin directory', () => {
    const repo = makeTree({ marker: false });
    mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true });
    expect(getRepoDocRoot()).toBeNull();
  });

  it('resolves the root as the parent of the plugins dir, not of the plugin', () => {
    const repo = makeTree({ marker: true });
    expect(getPluginsDir()).toBe(path.join(repo, 'plugins'));
    expect(getRepoDocRoot()).toBe(path.resolve(getPluginsDir(), '..'));
  });
});

describe('gatherRepoRootDocFiles — existence filter', () => {
  it('returns only the listed docs that actually exist, in ROOT_SCAN_FILES order', () => {
    const repo = makeTree({ marker: true, rootDocs: ['README.md', 'INSTALL.md'] });
    const { root, files } = gatherRepoRootDocFiles();
    expect(root).toBe(repo);
    expect(files).toEqual([path.join(repo, 'README.md'), path.join(repo, 'INSTALL.md')]);
  });

  it('ignores root .md files that are not in ROOT_SCAN_FILES', () => {
    const repo = makeTree({ marker: true, rootDocs: ['README.md'] });
    writeFileSync(path.join(repo, 'CHANGELOG.md'), '# frozen\n', 'utf-8');
    writeFileSync(path.join(repo, 'RELEASE_NOTES_9.9_KO.md'), '# frozen\n', 'utf-8');
    expect(gatherRepoRootDocFiles().files).toEqual([path.join(repo, 'README.md')]);
  });

  it('returns an empty list and a null root outside the dev repo', () => {
    makeTree({ marker: false, rootDocs: ['README.md', 'CONTRIBUTING.md'] });
    expect(gatherRepoRootDocFiles()).toEqual({ root: null, files: [] });
  });

  it('returns an empty list when the marker exists but no listed doc does', () => {
    // Distinct from the case above: the root IS in scope, so the floor must
    // fire. Silently returning nothing here is what the floor exists to catch.
    const repo = makeTree({ marker: true, rootDocs: [] });
    const { root, files } = gatherRepoRootDocFiles();
    expect(root).toBe(repo);
    expect(files).toEqual([]);
    expect(assertRootScanFloor(root, files.length)).toHaveLength(1);
  });
});

describe('assertRootScanFloor — fail-closed denominator', () => {
  it('passes at the floor exactly', () => {
    expect(assertRootScanFloor('/fake/repo', MIN_ROOT_DOC_FILES)).toEqual([]);
  });

  it('passes above the floor', () => {
    expect(assertRootScanFloor('/fake/repo', MIN_ROOT_DOC_FILES + 1)).toEqual([]);
  });

  it('fails one below the floor, naming both numbers', () => {
    const failures = assertRootScanFloor('/fake/repo', MIN_ROOT_DOC_FILES - 1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(String(MIN_ROOT_DOC_FILES - 1));
    expect(failures[0]).toContain(String(MIN_ROOT_DOC_FILES));
  });

  it('fails at zero — "0 scanned" must never read as "0 problems"', () => {
    expect(assertRootScanFloor('/fake/repo', 0)).toHaveLength(1);
  });

  it('does not enforce a floor when the root is out of scope (null)', () => {
    expect(assertRootScanFloor(null, 0)).toEqual([]);
  });
});

describe('assertScanFloors — plugin roots stay separate from the repo root', () => {
  it('rejects a <root> key, which is why the root floor is a separate function', () => {
    // MIN_DOC_FILES is keyed by PLUGIN root and is shared with
    // validate-md-rendering.js. Folding the repo root into it would make every
    // plugin-only scanner fail on an unknown key — the reason
    // assertRootScanFloor exists at all.
    const failures = assertScanFloors({ ...passingCounts(), '<root>': 4 });
    expect(failures.join(' ')).toMatch(/<root>.*no entry in MIN_DOC_FILES/);
  });

  it('passes for a counts map holding exactly the known roots', () => {
    expect(assertScanFloors(passingCounts())).toEqual([]);
  });

  /** A counts map at the floor for every known root. */
  function passingCounts() {
    return Object.fromEntries(Object.entries(MIN_DOC_FILES).map(([k, v]) => [k, v]));
  }
});

describe('isProjectPluginDir / listPluginRoots', () => {
  it('accepts our plugins and _shared, rejects third-party siblings', () => {
    for (const name of ['artibot', 'artibot-cowork', 'artibot-anything', '_shared']) {
      expect(isProjectPluginDir(name), name).toBe(true);
    }
    // In an installed tree the siblings include other marketplaces' plugins;
    // scanning those would turn THEIR problems into OUR CI failures.
    for (const name of ['superclaude', 'some-vendor', 'artiboot', 'shared']) {
      expect(isProjectPluginDir(name), name).toBe(false);
    }
  });

  it('enumerates only project plugin dirs from disk, sorted', () => {
    makeTree({ marker: true, plugins: ['artibot', 'artibot-cowork', '_shared', 'vendor-plugin'] });
    const names = listPluginRoots().map((p) => path.basename(p));
    expect(names).toEqual(['_shared', 'artibot', 'artibot-cowork']);
  });

  it('returns an empty array when the plugins dir does not exist', () => {
    const repo = mkdtempSync(path.join(tmpRoot, 'empty-'));
    process.env.CLAUDE_PLUGIN_ROOT = path.join(repo, 'plugins', 'artibot');
    expect(listPluginRoots()).toEqual([]);
  });
});
