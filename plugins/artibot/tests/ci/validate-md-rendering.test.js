/**
 * Tests for the markdown-rendering linter (scripts/ci/validate-md-rendering.js).
 *
 * Exercises the pure rule functions with in-memory fixtures — no live
 * filesystem dependency for pass/fail assertions, so detection logic is
 * verified deterministically. Catches mechanical rendering bugs that look
 * fine in a diff but render wrong on GitHub / in the plugin UI:
 *   - inner backticks inside an inline code span
 *   - GFM table rows whose column count differs from the header
 *
 * Ported from claude-howto/scripts/check_markdown_rendering.py.
 *
 * @module tests/ci/validate-md-rendering
 */

import { describe, expect, it } from 'vitest';
import {
  gatherRepoRootTreeDocFiles,
  MIN_ROOT_TREE_DOC_FILES,
} from '../../scripts/ci/ci-utils.js';
import {
  applyRatchet,
  KNOWN_RENDER_VIOLATIONS,
  maskFencedBlocks,
  ruleBacktickInInlineCode,
  RULES,
  ruleTablePipeMismatch,
  scanAllPlugins,
  scanRepoRoot,
  scanRepoRootTrees,
} from '../../scripts/ci/validate-md-rendering.js';

const REL = 'README.md';

// ----- maskFencedBlocks -----------------------------------------------------

describe('maskFencedBlocks', () => {
  it('blanks lines inside a triple-backtick fence while preserving line count', () => {
    const content = 'before\n```\ninside `a`b`\n```\nafter';
    const masked = maskFencedBlocks(content);
    const lines = masked.split('\n');
    expect(lines).toHaveLength(5); // line numbers survive
    expect(lines[0]).toBe('before');
    expect(lines[2]).toBe(''); // fenced content blanked
    expect(lines[4]).toBe('after');
  });

  it('recognises fences nested inside a blockquote', () => {
    const content = '> note\n>\n> ```json\n> { "k": "`inner`" }\n> ```\n';
    const masked = maskFencedBlocks(content);
    const lines = masked.split('\n');
    // the JSON line with the inner backtick must be blanked
    expect(lines[3]).toBe('');
  });

  it('leaves non-fenced content untouched', () => {
    const content = 'plain `code` text\nmore prose';
    expect(maskFencedBlocks(content)).toBe(content);
  });
});

// ----- ruleBacktickInInlineCode --------------------------------------------

describe('ruleBacktickInInlineCode', () => {
  it('flags a single-backtick span containing an inner backtick', () => {
    const content = 'Use `!`command`` for shell substitution.\n';
    const errors = ruleBacktickInInlineCode(content, REL);
    expect(errors.some((e) => e.includes('backtick-in-inline-code'))).toBe(true);
  });

  it('passes the double-backtick + space-padding idiom', () => {
    const content = 'Use `` `!command` `` for shell substitution.\n';
    expect(ruleBacktickInInlineCode(content, REL)).toEqual([]);
  });

  it('ignores backticks inside a fenced code block', () => {
    const content = 'Before\n\n```\nfoo `!`command`` bar\n```\n\nAfter\n';
    expect(ruleBacktickInInlineCode(content, REL)).toEqual([]);
  });

  it('ignores backticks inside a blockquote fence', () => {
    const content =
      '> note\n>\n> ```json\n> { "key": "value with `inner` backtick" }\n> ```\n';
    expect(ruleBacktickInInlineCode(content, REL)).toEqual([]);
  });

  it('reports the offending line number', () => {
    const content = 'line 1\nline 2 with `a`b` content\nline 3\n';
    const errors = ruleBacktickInInlineCode(content, REL);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('README.md:2:');
  });

  it('passes clean prose with well-formed single-backtick spans', () => {
    const content = 'Run `npm test` and `npm run lint` before commit.\n';
    expect(ruleBacktickInInlineCode(content, REL)).toEqual([]);
  });
});

// ----- ruleTablePipeMismatch -----------------------------------------------

describe('ruleTablePipeMismatch', () => {
  it('flags a data row with more columns than the header', () => {
    const content = '| col1 | col2 |\n|------|------|\n| a | b | c |\n';
    const errors = ruleTablePipeMismatch(content, REL);
    expect(errors.some((e) => e.includes('table-pipe-column-mismatch'))).toBe(true);
  });

  it('passes a row with an escaped pipe (\\| is not a column separator)', () => {
    const content = '| col1 | col2 |\n|------|------|\n| [color\\|default] | b |\n';
    expect(ruleTablePipeMismatch(content, REL)).toEqual([]);
  });

  it('passes a well-formed table', () => {
    const content = '| col1 | col2 |\n|------|------|\n| a | b |\n| c | d |\n';
    expect(ruleTablePipeMismatch(content, REL)).toEqual([]);
  });

  it('ignores a bare pipe in prose outside any table', () => {
    const content = 'This is | a sentence with a pipe in prose.\n';
    expect(ruleTablePipeMismatch(content, REL)).toEqual([]);
  });

  it('ignores tables inside a fenced code block', () => {
    const content =
      'Example:\n\n```\n| col1 | col2 |\n|------|------|\n| a | b | c |\n```\n';
    expect(ruleTablePipeMismatch(content, REL)).toEqual([]);
  });

  it('reports the offending data-row line number', () => {
    const content = '| h1 | h2 |\n|----|----|\n| ok | ok |\n| a | b | c |\n';
    const errors = ruleTablePipeMismatch(content, REL);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('README.md:4:');
  });
});

// ----- RULES registry -------------------------------------------------------

describe('RULES', () => {
  it('exposes exactly the two named rules in append-order', () => {
    expect(RULES.map((r) => r.name)).toEqual([
      'backtick-in-inline-code',
      'table-pipe-column-mismatch',
    ]);
  });

  it('each rule entry pairs a name with a callable fn', () => {
    for (const rule of RULES) {
      expect(typeof rule.name).toBe('string');
      expect(typeof rule.fn).toBe('function');
    }
  });

  it('rule fns accept (content, relPath) and return an array', () => {
    for (const rule of RULES) {
      const out = rule.fn('# clean\n', REL);
      expect(Array.isArray(out)).toBe(true);
    }
  });
});

// ----- scanRepoRootTrees (repo-root canon trees, added 2026-09-05) ----------
//
// These cases run against the live repo: the tree scan is anchored to
// `git ls-files`, and a fixture that cannot `git init` cannot stand in for it.
// Each `scanRepoRootTrees()` call spawns one git process.

describe('scanRepoRootTrees', () => {
  it('reads the same files the shared enumerator returns (lockstep denominator)', () => {
    // If this scanner ever grew its own listing, one side could quietly
    // shrink while the other stayed green. Both must consume ci-utils.
    const { root, count } = scanRepoRootTrees();
    const { files } = gatherRepoRootTreeDocFiles();
    expect(root).not.toBeNull();
    expect(count).toBe(files.length);
    expect(count).toBeGreaterThanOrEqual(MIN_ROOT_TREE_DOC_FILES);
  });

  it('keys findings under `<root>/<tree path>` so they cannot collide with plugin or root-file keys', () => {
    const ragged = '| a | b |\n|---|---|\n| 1 |\n';
    const hits = RULES.flatMap((r) => r.fn(ragged, '<root>/.artibot/guides/x.md'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^<root>\/\.artibot\/guides\/x\.md:3: table-pipe-column-mismatch/);
    // The three scans partition the key space: plugin keys never start with
    // `<root>/`, root-file keys never descend into a tree.
    expect(scanAllPlugins().findings.every((f) => !f.key.startsWith('<root>/'))).toBe(true);
    for (const f of scanRepoRoot().findings) {
      expect(f.key).not.toMatch(/^<root>\/(\.artibot|reports)\//);
    }
    for (const f of scanRepoRootTrees().findings) {
      expect(f.key).toMatch(/^<root>\/(\.artibot|reports\/SPLIT)\//);
    }
  });

  it('the canon enters the gate clean and is never baselined (design DC-1: fix, do not ratchet)', () => {
    // 15 real violations were fixed before this scope opened (12 ragged rows
    // in ARTIBOT-5.0-DESIGN.md 부록 0-2, 3 unclosed code spans). A `<root>/`
    // key in KNOWN_RENDER_VIOLATIONS would mean the canon was baselined
    // instead — and a baseline on a file still being edited goes stale on the
    // next edit. Evaluated against an EMPTY baseline so the two cowork entries
    // do not read as stale here; the live ratchet is the gate's own job.
    for (const key of Object.keys(KNOWN_RENDER_VIOLATIONS)) {
      expect(key.startsWith('<root>/')).toBe(false);
    }
    const { findings } = scanRepoRootTrees();
    const { unexpected } = applyRatchet(findings, {});
    expect(unexpected).toEqual([]);
  });
});
