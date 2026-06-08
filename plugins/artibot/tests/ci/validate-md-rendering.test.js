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
  maskFencedBlocks,
  ruleBacktickInInlineCode,
  RULES,
  ruleTablePipeMismatch,
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
