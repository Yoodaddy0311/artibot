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
 * `extractFrontmatter` is covered here as of 2026-09-11. It used to be left to
 * "the validators that consume it", which is how it kept a block scalar's body
 * out of the parse for as long as it did: every consumer checked presence, so
 * storing the header `|` as the value passed all of them. A shared parser whose
 * only test is a downstream presence check is untested where it matters.
 *
 * What these tests do NOT cover: whether the roots the helpers name actually
 * contain correct documentation — that is the gates' job, not the module's.
 *
 * @module tests/ci/ci-utils
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  _resetTrackedNameCache,
  assertRootScanFloor,
  assertRootTreeScanFloor,
  assertScanFloors,
  extractFrontmatter,
  gatherRepoRootDocFiles,
  gatherRepoRootTreeDocFiles,
  getPluginsDir,
  getRepoDocRoot,
  isProjectPluginDir,
  listPluginRoots,
  MIN_DOC_FILES,
  MIN_ROOT_DOC_FILES,
  MIN_ROOT_TREE_DOC_FILES,
  ROOT_SCAN_FILES,
  ROOT_SCAN_TREE_FILES,
  ROOT_SCAN_TREES,
} from '../../scripts/ci/ci-utils.js';

/** `<repo>/plugins/artibot/tests/ci` → four levels up is the real repo root. */
const REAL_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Root of a synthetic tree; each test builds the shape it needs underneath. */
let tmpRoot;
/** Restored after every test so one case cannot leak into the next. */
const savedEnv = process.env.CLAUDE_PLUGIN_ROOT;
/** The git-override variables a hook inherits; restored after every test. */
const savedGitEnv = {
  GIT_DIR: process.env.GIT_DIR,
  GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
};

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
  for (const [key, value] of Object.entries(savedGitEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetTrackedNameCache();
});

describe('gitTrackedNames under a hook environment (retro split-9d6dc2 #56)', () => {
  // git runs pre-push with an ABSOLUTE `GIT_DIR` in the environment and, in a
  // linked worktree, no `GIT_WORK_TREE`. Under that pair `git ls-files` treats
  // the *cwd* as the top of the work tree and lists the whole index relative
  // to it — measured 2026-09-05 in the worktree `split-artibot-ci-scope`:
  //   cwd=plugins, env clean            → 1822 entries, heads {_shared, artibot, artibot-cowork}
  //   cwd=plugins, GIT_DIR only         → 1975 entries, heads {.artibot, .github, ARTIBOT.md, …}
  //   cwd=plugins, GIT_DIR + WORK_TREE  → 1822 entries (correct again)
  // The first-segment parser then sees `plugins` and no plugin root, so the
  // structure / doc-links / md-render gates all fail with "contributed no …".
  // This case pins the fix: the resolver must ignore both overrides.
  //
  // It spawns two git processes (rev-parse + ls-files) against the real repo;
  // that is the only way to reproduce a hook environment.
  it('still resolves the three plugin roots with GIT_DIR set and GIT_WORK_TREE absent', () => {
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: REAL_REPO_ROOT,
      encoding: 'utf-8',
    }).trim();
    process.env.GIT_DIR = gitDir;
    delete process.env.GIT_WORK_TREE;
    _resetTrackedNameCache();
    const roots = listPluginRoots().map((p) => path.basename(p));
    expect(roots).toEqual(['_shared', 'artibot', 'artibot-cowork']);
  });
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

describe('ROOT_SCAN_TREES / ROOT_SCAN_TREE_FILES / MIN_ROOT_TREE_DOC_FILES constants', () => {
  it('is a subtree allowlist naming the canon trees, not `.artibot/**`', () => {
    // `.artibot/` also holds untracked locals (HANDOFF.md, SESSION-NOTES.md,
    // split/, missions/, runtime/) and `reports/*` is gitignored except SPLIT.
    // A wildcard here would make local and CI scan different sets.
    expect([...ROOT_SCAN_TREES]).toEqual([
      '.artibot/guides',
      '.artibot/adr',
      '.artibot/archive',
      'reports/SPLIT',
    ]);
    expect([...ROOT_SCAN_TREE_FILES]).toEqual(['.artibot/project.md']);
    expect(Object.isFrozen(ROOT_SCAN_TREES)).toBe(true);
    expect(Object.isFrozen(ROOT_SCAN_TREE_FILES)).toBe(true);
  });

  it('floor is pinned at the measured count (95 on 2026-09-05), not padded', () => {
    // Reproduce: git ls-files -z -- <trees> <files> | tr '\0' '\n' | grep -c '\.md$'
    // Pinned exactly like MIN_ROOT_DOC_FILES: the canon shrinking should go
    // RED until the deletion is deliberate, and growth means raising this.
    expect(MIN_ROOT_TREE_DOC_FILES).toBe(95);
  });
});

describe('gatherRepoRootTreeDocFiles — git-tracked enumeration, fail-closed', () => {
  it('returns a null root and no files outside the dev repo, without touching git', () => {
    makeTree({ marker: false });
    expect(gatherRepoRootTreeDocFiles()).toEqual({ root: null, files: [] });
  });

  it('keeps only .md files inside the allowlisted trees from an injected listing', () => {
    const repo = makeTree({ marker: true });
    const { root, files } = gatherRepoRootTreeDocFiles({
      tracked: [
        '.artibot/guides/v5-design/B.md',
        '.artibot/guides/v5-design/A.md',
        '.artibot/guides/evidence/trace.ndjson', // not markdown
        '.artibot/adr/ADR-006-split-어휘-소유권.md', // Korean path survives
        '.artibot/HANDOFF.md', // tracked-looking but outside the allowlist
        '.artibot/project.md',
        'reports/SPLIT/split-8f83d7.md',
        'reports/other/report.md', // reports/* outside SPLIT
        'README.md',
      ],
    });
    expect(root).toBe(repo);
    expect(files).toEqual(
      [
        '.artibot/adr/ADR-006-split-어휘-소유권.md',
        '.artibot/guides/v5-design/A.md',
        '.artibot/guides/v5-design/B.md',
        '.artibot/project.md',
        'reports/SPLIT/split-8f83d7.md',
      ]
        .map((rel) => path.join(repo, rel))
        .sort(),
    );
  });

  it('does not treat a sibling that merely shares a prefix as inside a tree', () => {
    makeTree({ marker: true });
    const { files } = gatherRepoRootTreeDocFiles({
      tracked: ['.artibot/guides-old/x.md', '.artibot/adrs/y.md', 'reports/SPLITTER/z.md'],
    });
    expect(files).toEqual([]);
  });

  it('throws "cannot enumerate tracked docs" when git cannot answer (no disk-walk fallback)', () => {
    // A marker-bearing tmp dir that is not a work tree. GIT_CEILING_DIRECTORIES
    // stops discovery from climbing into any repo that might contain tmpdir,
    // so the failure is git's own "not a git repository", deterministically.
    const repo = makeTree({ marker: true, rootDocs: ['README.md'] });
    mkdirSync(path.join(repo, '.artibot', 'guides'), { recursive: true });
    writeFileSync(path.join(repo, '.artibot', 'guides', 'on-disk-only.md'), '# x\n', 'utf-8');
    process.env.GIT_CEILING_DIRECTORIES = tmpRoot;
    expect(() => gatherRepoRootTreeDocFiles()).toThrow(/cannot enumerate tracked docs/);
  });

  it('enumerates the real repo through git: meets the floor and includes the Korean ADR paths', () => {
    // The only tree case that spawns git. It is what proves `-z` is in use —
    // without it the five Korean ADR filenames come back C-quoted and would
    // neither match the tree prefix nor exist on disk under that name.
    const { root, files } = gatherRepoRootTreeDocFiles();
    expect(root).toBe(REAL_REPO_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(MIN_ROOT_TREE_DOC_FILES);
    expect(assertRootTreeScanFloor(root, files.length)).toEqual([]);
    const koreanAdrs = files.filter((f) => /[^\x20-\x7E]/.test(path.basename(f)));
    expect(koreanAdrs.length).toBeGreaterThanOrEqual(5);
    for (const f of files) expect(f.startsWith(root + path.sep)).toBe(true);
  });

  it('enumerates the real repo identically under a hook environment (GIT_DIR set, no GIT_WORK_TREE)', () => {
    const clean = gatherRepoRootTreeDocFiles().files;
    process.env.GIT_DIR = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: REAL_REPO_ROOT,
      encoding: 'utf-8',
    }).trim();
    delete process.env.GIT_WORK_TREE;
    expect(gatherRepoRootTreeDocFiles().files).toEqual(clean);
  });
});

describe('assertRootTreeScanFloor — fail-closed denominator', () => {
  it('passes at and above the floor', () => {
    expect(assertRootTreeScanFloor('/fake/repo', MIN_ROOT_TREE_DOC_FILES)).toEqual([]);
    expect(assertRootTreeScanFloor('/fake/repo', MIN_ROOT_TREE_DOC_FILES + 1)).toEqual([]);
  });

  it('fails one below the floor, naming both numbers', () => {
    const failures = assertRootTreeScanFloor('/fake/repo', MIN_ROOT_TREE_DOC_FILES - 1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(String(MIN_ROOT_TREE_DOC_FILES - 1));
    expect(failures[0]).toContain(String(MIN_ROOT_TREE_DOC_FILES));
  });

  it('fails at zero and does not enforce outside the dev repo', () => {
    expect(assertRootTreeScanFloor('/fake/repo', 0)).toHaveLength(1);
    expect(assertRootTreeScanFloor(null, 0)).toEqual([]);
  });

  it('goes RED if one allowlisted tree drops out of the enumeration (self-check of the floor)', () => {
    // Design §3 D2: removing `.artibot/adr` from scope must not pass. Simulated
    // through the injection seam with the real listing minus that tree.
    const { root, files } = gatherRepoRootTreeDocFiles();
    const withoutAdr = files
      .map((abs) => path.relative(root, abs).split(path.sep).join('/'))
      .filter((rel) => !rel.startsWith('.artibot/adr/'));
    expect(withoutAdr.length).toBeLessThan(files.length);
    const narrowed = gatherRepoRootTreeDocFiles({ tracked: withoutAdr });
    expect(assertRootTreeScanFloor(narrowed.root, narrowed.files.length)).toHaveLength(1);
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

describe('extractFrontmatter', () => {
  it('returns null when the file has no frontmatter block', () => {
    expect(extractFrontmatter('# Title\n\nname: not frontmatter\n')).toBeNull();
  });

  it('keeps an inline value verbatim, quotes included', () => {
    const fields = extractFrontmatter('---\nname: demo\ndescription: "quoted text"\n---\n\nbody\n');
    // Consumers compare these strings as written; stripping quotes here would
    // silently change what every validator sees.
    expect(fields).toEqual({ name: 'demo', description: '"quoted text"' });
  });

  it('folds a block scalar body into a single spaced string', () => {
    const fields = extractFrontmatter(
      '---\nname: demo\ndescription: |\n  First line.\n  Second line.\nmodel: opus\n---\n\nbody\n',
    );
    expect(fields.description).toBe('First line. Second line.');
    // Folding must stop at the next column-0 key, not swallow it.
    expect(fields.model).toBe('opus');
  });

  it('folds a block scalar body that contains blank lines', () => {
    const fields = extractFrontmatter(
      '---\ndescription: |\n  First para.\n\n  Second para.\nname: demo\n---\n',
    );
    expect(fields.description).toBe('First para. Second para.');
    expect(fields.name).toBe('demo');
  });

  it('stores an empty block scalar body as a falsy empty string', () => {
    // The whole point of the repair: a key with no body must not read as
    // present. Before 2026-09-11 this was the truthy string '|'.
    const fields = extractFrontmatter('---\nname: demo\ndescription: |\nmodel: opus\n---\n');
    expect(fields.description).toBe('');
    expect(Boolean(fields.description)).toBe(false);
    expect(fields.model).toBe('opus');
  });

  it.each([['|'], ['|-'], ['|+'], ['>'], ['>-'], ['>+'], ['|2'], ['| # note']])(
    'recognises %s as a block scalar header',
    (indicator) => {
      const fields = extractFrontmatter(
        `---\ndescription: ${indicator}\n  Body text.\nname: demo\n---\n`,
      );
      expect(fields.description).toBe('Body text.');
    },
  );

  it('produces the same fields for CRLF input as for LF', () => {
    const lf = extractFrontmatter(
      '---\nname: demo\ndescription: |\n  First line.\n  Second line.\ntokens: "~3K"\n---\n',
    );
    const crlf = extractFrontmatter(
      '---\r\nname: demo\r\ndescription: |\r\n  First line.\r\n  Second line.\r\ntokens: "~3K"\r\n---\r\n',
    );
    expect(crlf).toEqual(lf);
    expect(crlf.description).toBe('First line. Second line.');
    expect(crlf.tokens).toBe('"~3K"');
  });

  it('leaves a bare key with an indented list at its existing behaviour', () => {
    // `allowed:` carries no `|`/`>` indicator, so it is not a block scalar and
    // folding must not claim it. Measured before and after the 2026-09-11
    // repair: the key is absent from the result either way. Pinned so that
    // widening the fold to bare keys cannot happen by accident — that would
    // change what every consumer sees for list-valued keys.
    const fields = extractFrontmatter('---\nname: demo\nallowed:\n  - one\n  - two\n---\n');
    expect(fields.allowed).toBeUndefined();
    expect(fields.name).toBe('demo');
  });

  it('normalizes an empty double-quoted inline value to a falsy empty string', () => {
    // `description: ""` is a key present with no description. Storing the raw
    // two-character string made it truthy, so every presence check in
    // validate-skills/agents/commands reported green (measured 2026-09-11:
    // PASS/PASS/PASS on all three). Only the two EMPTY spellings normalize.
    const fields = extractFrontmatter('---\nname: demo\ndescription: ""\n---\n\nbody\n');
    expect(fields.description).toBe('');
    expect(Boolean(fields.description)).toBe(false);
    expect(fields.name).toBe('demo');
  });

  it('normalizes an empty single-quoted inline value to a falsy empty string', () => {
    const fields = extractFrontmatter("---\nname: demo\ndescription: ''\n---\n\nbody\n");
    expect(fields.description).toBe('');
    expect(Boolean(fields.description)).toBe(false);
  });

  it('keeps a quoted single space verbatim', () => {
    // The normalization is spelling-exact, not a trim: `" "` is a value with
    // content as far as this parser is concerned, and stripping its quotes
    // would change what consumers compare. Widening to "semantically empty"
    // values is deliberately out of scope.
    const fields = extractFrontmatter('---\nname: demo\ndescription: " "\n---\n');
    expect(fields.description).toBe('" "');
    expect(Boolean(fields.description)).toBe(true);
  });

  it('keeps a quoted non-empty value verbatim', () => {
    const fields = extractFrontmatter('---\nname: demo\ndescription: "a"\n---\n');
    expect(fields.description).toBe('"a"');
  });

  it('normalizes empty quoted values in CRLF files too', () => {
    // Without CRLF normalization the value would be `""\r`, which matches
    // neither spelling and would stay truthy on Windows-checkout files only.
    const fields = extractFrontmatter('---\r\nname: demo\r\ndescription: ""\r\nmodel: opus\r\n---\r\n');
    expect(fields.description).toBe('');
    expect(fields.model).toBe('opus');
  });

  it('normalizes empty quotes for every required field, not just description', () => {
    const fields = extractFrontmatter(
      '---\nname: ""\ndescription: \'\'\nmodel: ""\nargument-hint: ""\n---\n',
    );
    expect(fields).toEqual({ name: '', description: '', model: '', 'argument-hint': '' });
  });

  it('reads the live lang-reference description as folded prose', () => {
    const file = path.join(REAL_REPO_ROOT, 'plugins', 'artibot', 'skills', 'lang-reference', 'SKILL.md');
    const fields = extractFrontmatter(readFileSync(file, 'utf-8'));
    expect(fields.description.length).toBeGreaterThan(100);
    expect(fields.description.startsWith('|')).toBe(false);
  });
});
