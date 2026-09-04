/**
 * Unit tests for the documentation internal-link / anchor validator.
 *
 * Validates pure functions ported from claude-howto's check_cross_references.py:
 *   - maskCodeFences: blanks out fenced + inline code so example links aren't scanned
 *   - extractMdLinks: pulls relative `[..](path.md)` links
 *   - extractAnchorRefs: pulls in-page `[..](#anchor)` references
 *   - headingToAnchor: GitHub-style heading → anchor slug
 *   - extractHeadings: pulls `# heading` text from raw (unmasked) content
 *   - hasUnbalancedFences: odd number of line-start ``` fences
 *   - findBrokenLinks: composes the above against a file on disk
 *
 * @module tests/ci/validate-doc-links
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIN_ROOT_TREE_DOC_FILES } from '../../scripts/ci/ci-utils.js';
import {
  extractAnchorRefs,
  extractHeadings,
  extractMdLinks,
  findBrokenLinks,
  gatherRepoRootTreeDocFiles,
  hasUnbalancedFences,
  headingToAnchor,
  maskCodeFences,
} from '../../scripts/ci/validate-doc-links.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = .../plugins/artibot/tests/ci
const PLUGIN_ROOT = join(__dirname, '..', '..');

describe('maskCodeFences', () => {
  it('blanks out fenced code blocks but preserves line count', () => {
    const input = ['before', '```js', 'const x = "[a](fake.md)";', '```', 'after'].join('\n');
    const masked = maskCodeFences(input);
    expect(masked).not.toContain('fake.md');
    // Surrounding prose survives
    expect(masked).toContain('before');
    expect(masked).toContain('after');
  });

  it('blanks out inline code spans', () => {
    const input = 'see `[x](inline.md)` here';
    const masked = maskCodeFences(input);
    expect(masked).not.toContain('inline.md');
    expect(masked).toContain('see');
    expect(masked).toContain('here');
  });

  it('leaves real links outside code untouched', () => {
    const input = 'real [link](real.md) text';
    const masked = maskCodeFences(input);
    expect(masked).toContain('real.md');
  });

  it('handles tilde-fenced blocks', () => {
    const input = ['~~~', '[x](tilde.md)', '~~~'].join('\n');
    const masked = maskCodeFences(input);
    expect(masked).not.toContain('tilde.md');
  });
});

describe('extractMdLinks', () => {
  it('extracts relative .md link targets', () => {
    const input = 'see [Architecture](docs/ARCHITECTURE.md) and [Other](../other.md)';
    expect(extractMdLinks(input)).toEqual(['docs/ARCHITECTURE.md', '../other.md']);
  });

  it('ignores external http(s) links', () => {
    const input = '[site](https://example.com/page.md)';
    expect(extractMdLinks(input)).toEqual([]);
  });

  it('strips trailing anchors from md link targets', () => {
    const input = '[x](docs/file.md#section)';
    expect(extractMdLinks(input)).toEqual(['docs/file.md']);
  });

  it('ignores image links and non-md targets', () => {
    const input = '![img](pic.png) and [code](script.js)';
    expect(extractMdLinks(input)).toEqual([]);
  });

  it('returns empty array when no links present', () => {
    expect(extractMdLinks('plain text')).toEqual([]);
  });
});

describe('extractAnchorRefs', () => {
  it('extracts in-page anchor references', () => {
    const input = 'jump to [Quality Gates](#quality-gates)';
    expect(extractAnchorRefs(input)).toEqual(['quality-gates']);
  });

  it('does not treat cross-file anchors as in-page', () => {
    const input = '[x](other.md#section)';
    expect(extractAnchorRefs(input)).toEqual([]);
  });

  it('returns empty array when no anchors present', () => {
    expect(extractAnchorRefs('[x](file.md)')).toEqual([]);
  });
});

describe('headingToAnchor', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(headingToAnchor('Quality Gates')).toBe('quality-gates');
  });

  it('strips punctuation', () => {
    expect(headingToAnchor('DEV Protocol (Mandatory)')).toBe('dev-protocol-mandatory');
  });

  it('removes leading hash markers passed in', () => {
    // extractHeadings strips the leading '#'; this just normalizes text
    expect(headingToAnchor('5-Layer Architecture')).toBe('5-layer-architecture');
  });

  it('strips trailing hyphens', () => {
    expect(headingToAnchor('Section: ')).toBe('section');
  });

  it('collapses an emoji-prefixed heading reasonably', () => {
    // GitHub drops the emoji; the leading hyphen it would leave is acceptable to keep,
    // but for our near-approximation we only assert the slug body is present.
    expect(headingToAnchor('Detection Engine')).toBe('detection-engine');
  });
});

describe('extractHeadings', () => {
  it('extracts ATX headings of all levels', () => {
    const input = ['# H1', 'text', '### H3 Deep', '###### H6'].join('\n');
    expect(extractHeadings(input)).toEqual(['H1', 'H3 Deep', 'H6']);
  });

  it('ignores non-heading hash usage mid-line', () => {
    const input = 'this is # not a heading';
    expect(extractHeadings(input)).toEqual([]);
  });
});

describe('hasUnbalancedFences', () => {
  it('returns false for balanced fences', () => {
    const input = ['```', 'code', '```'].join('\n');
    expect(hasUnbalancedFences(input)).toBe(false);
  });

  it('returns true for an odd number of fences', () => {
    const input = ['```', 'code'].join('\n');
    expect(hasUnbalancedFences(input)).toBe(true);
  });

  it('returns false when there are no fences', () => {
    expect(hasUnbalancedFences('plain text')).toBe(false);
  });

  it('only counts line-start fences', () => {
    // An inline ``` mid-line should not be counted as a fence opener.
    const input = ['text ``` mid', '```', 'code', '```'].join('\n');
    expect(hasUnbalancedFences(input)).toBe(false);
  });
});

describe('findBrokenLinks (integration on disk)', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'doclinks-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports a broken relative .md link', () => {
    const file = join(tmp, 'index.md');
    writeFileSync(file, 'see [Missing](missing.md)', 'utf8');
    const broken = findBrokenLinks('see [Missing](missing.md)', file, tmp);
    expect(broken.some((b) => b.type === 'link' && b.target === 'missing.md')).toBe(true);
  });

  it('passes a valid relative .md link', () => {
    const target = join(tmp, 'exists.md');
    writeFileSync(target, '# Exists', 'utf8');
    const file = join(tmp, 'index.md');
    const content = 'see [Exists](exists.md)';
    writeFileSync(file, content, 'utf8');
    const broken = findBrokenLinks(content, file, tmp);
    expect(broken.filter((b) => b.type === 'link')).toEqual([]);
  });

  it('reports a broken in-page anchor', () => {
    const file = join(tmp, 'page.md');
    const content = ['# Real Heading', 'jump [bad](#nonexistent)'].join('\n');
    writeFileSync(file, content, 'utf8');
    const broken = findBrokenLinks(content, file, tmp);
    expect(broken.some((b) => b.type === 'anchor' && b.target === 'nonexistent')).toBe(true);
  });

  it('passes a valid in-page anchor matching a heading', () => {
    const file = join(tmp, 'page.md');
    const content = ['# Quality Gates', 'jump [ok](#quality-gates)'].join('\n');
    writeFileSync(file, content, 'utf8');
    const broken = findBrokenLinks(content, file, tmp);
    expect(broken.filter((b) => b.type === 'anchor')).toEqual([]);
  });

  it('does not flag links inside code fences', () => {
    const file = join(tmp, 'page.md');
    const content = ['```md', '[fake](does-not-exist.md)', '```'].join('\n');
    writeFileSync(file, content, 'utf8');
    const broken = findBrokenLinks(content, file, tmp);
    expect(broken.filter((b) => b.type === 'link')).toEqual([]);
  });

  it('reports unbalanced code fences as a warning entry', () => {
    const file = join(tmp, 'page.md');
    const content = ['```', 'unclosed code'].join('\n');
    writeFileSync(file, content, 'utf8');
    const broken = findBrokenLinks(content, file, tmp);
    expect(broken.some((b) => b.type === 'fence')).toBe(true);
  });

  it('resolves nested relative paths correctly', () => {
    mkdirSync(join(tmp, 'docs'), { recursive: true });
    writeFileSync(join(tmp, 'docs', 'deep.md'), '# Deep', 'utf8');
    const file = join(tmp, 'docs', 'index.md');
    const content = 'see [Deep](deep.md) and [Up](../top.md)';
    writeFileSync(file, content, 'utf8');
    const broken = findBrokenLinks(content, file, tmp);
    // deep.md exists, ../top.md does not
    expect(broken.some((b) => b.type === 'link' && b.target === 'deep.md')).toBe(false);
    expect(broken.some((b) => b.type === 'link' && b.target === '../top.md')).toBe(true);
  });
});

describe('module sanity', () => {
  it('plugin root resolves to the artibot plugin dir', () => {
    expect(PLUGIN_ROOT).toMatch(/artibot$/);
  });
});

// ----- repo-root canon trees (added to the scan set 2026-09-05) -------------
//
// `main()` is not exported, so what is pinned here is the two halves it
// composes: the tree enumeration is in scope (denominator, via ci-utils), and a
// tree file's links are judged under repo-root containment — which is what lets
// `.artibot/guides/x.md → ../../plugins/artibot/...` be checked at all.

describe('repo-root tree docs are judged under root containment', () => {
  /** `<repo>/plugins/artibot` → two levels up is the repo root. */
  const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');

  it('enumerates the canon trees through the shared, git-anchored helper', () => {
    // One git spawn. Proves the re-export is wired, and that the count this
    // gate would add to its tally clears the floor it would assert.
    const { root, files } = gatherRepoRootTreeDocFiles();
    expect(root).toBe(REPO_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(MIN_ROOT_TREE_DOC_FILES);
    expect(files.some((f) => f.includes(join('.artibot', 'adr')))).toBe(true);
  });

  it('reports a dead link from a guides file (the ADR-rot case 후속 1 named)', () => {
    const victim = join(REPO_ROOT, '.artibot', 'guides', 'v5-design', 'x.md');
    const broken = findBrokenLinks('[adr](../../adr/ADR-999-does-not-exist.md)\n', victim, REPO_ROOT);
    expect(broken.map((b) => b.type)).toEqual(['link']);
  });

  it('judges a cross-link from a guides file into a plugin (not skipped as out-of-scope)', () => {
    const victim = join(REPO_ROOT, '.artibot', 'guides', 'v5-design', 'x.md');
    const ok = findBrokenLinks('[readme](../../../plugins/artibot/README.md)\n', victim, REPO_ROOT);
    expect(ok).toEqual([]);
    const dead = findBrokenLinks('[readme](../../../plugins/artibot/NOPE.md)\n', victim, REPO_ROOT);
    expect(dead.map((b) => b.type)).toEqual(['link']);
  });

  it('would have excused the same dead cross-link under plugins/ containment (why root containment matters)', () => {
    const victim = join(REPO_ROOT, '.artibot', 'guides', 'v5-design', 'x.md');
    const dead = findBrokenLinks(
      '[readme](../../../plugins/artibot/NOPE.md)\n',
      victim,
      join(REPO_ROOT, 'plugins', 'artibot'),
    );
    // Resolves inside plugins/artibot, so it IS judged even there — but the
    // guides file itself would never have been scanned. The point of this case
    // is the file-to-root pairing: a target that resolves under `.artibot/`
    // is out of scope for a plugins/ containment and silently skipped.
    expect(dead.map((b) => b.type)).toEqual(['link']);
    const skipped = findBrokenLinks(
      '[adr](../../adr/ADR-999-does-not-exist.md)\n',
      victim,
      join(REPO_ROOT, 'plugins'),
    );
    expect(skipped).toEqual([]);
  });
});
