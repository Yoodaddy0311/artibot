/**
 * Tests for lib/core/citation-formatter.js
 *
 * Covers:
 *   - extractDomain: protocol/www stripping, invalid URL → null
 *   - stripLenticularBrackets: 【】 removal, OpenAI search markers
 *   - dedupeSources: order preservation, trailing slash + fragment normalization
 *   - renderCitation: all 5 modes
 *   - formatCitations: marker replacement + footer + edge cases
 */

import { describe, expect, it } from 'vitest';
import {
  CITATION_MODES,
  dedupeSources,
  extractDomain,
  formatCitations,
  renderCitation,
  stripLenticularBrackets,
} from '../../lib/core/citation-formatter.js';

describe('extractDomain', () => {
  it('strips protocol and www prefix', () => {
    expect(extractDomain('https://www.react.dev/reference/react')).toBe('react.dev');
  });

  it('returns lowercase host', () => {
    expect(extractDomain('https://React.DEV/path')).toBe('react.dev');
  });

  it('keeps non-www subdomains', () => {
    expect(extractDomain('https://docs.djangoproject.com/en/6.0/')).toBe('docs.djangoproject.com');
  });

  it('returns null for non-URL input', () => {
    expect(extractDomain('not a url')).toBeNull();
    expect(extractDomain('')).toBeNull();
    expect(extractDomain(undefined)).toBeNull();
    expect(extractDomain(42)).toBeNull();
  });

  it('returns null for malformed URL', () => {
    expect(extractDomain('http://')).toBeNull();
  });
});

describe('stripLenticularBrackets', () => {
  it('removes empty brackets entirely', () => {
    expect(stripLenticularBrackets('hello 【】 world')).toBe('hello  world');
  });

  it('converts numeric brackets to plain bracket form', () => {
    expect(stripLenticularBrackets('cite this 【1】 here')).toBe('cite this [1] here');
  });

  it('converts domain brackets', () => {
    expect(stripLenticularBrackets('see 【react.dev】')).toBe('see [react.dev]');
  });

  it('drops OpenAI-search internal source markers', () => {
    expect(stripLenticularBrackets('see 【1†source】 for details')).toBe('see [1] for details');
  });

  it('handles multiple brackets in one string', () => {
    expect(stripLenticularBrackets('a 【1】 b 【2】 c')).toBe('a [1] b [2] c');
  });

  it('returns empty string for non-string input', () => {
    expect(stripLenticularBrackets(undefined)).toBe('');
    expect(stripLenticularBrackets(null)).toBe('');
    expect(stripLenticularBrackets('')).toBe('');
  });

  it('preserves text without lenticular brackets', () => {
    expect(stripLenticularBrackets('plain text')).toBe('plain text');
  });
});

describe('dedupeSources', () => {
  it('preserves first-seen order', () => {
    const out = dedupeSources(['https://a.com/', 'https://b.com/', 'https://a.com/']);
    expect(out).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('treats trailing slash as duplicate', () => {
    const out = dedupeSources(['https://react.dev/foo', 'https://react.dev/foo/']);
    expect(out).toHaveLength(1);
  });

  it('treats fragment-only differences as duplicate', () => {
    const out = dedupeSources(['https://x.com/p', 'https://x.com/p#section']);
    expect(out).toHaveLength(1);
  });

  it('filters non-string entries', () => {
    const out = dedupeSources(['https://a.com/', null, undefined, 42, '']);
    expect(out).toEqual(['https://a.com/']);
  });

  it('returns frozen empty array for non-array input', () => {
    const out = dedupeSources('not array');
    expect(out).toEqual([]);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('falls back to lowercase compare for non-URL strings', () => {
    const out = dedupeSources(['Ref-A', 'ref-a', 'REF-B']);
    expect(out).toEqual(['Ref-A', 'REF-B']);
  });
});

describe('renderCitation', () => {
  const url = 'https://react.dev/reference/react/useActionState';

  it('renders NUMBER mode', () => {
    expect(renderCitation({ url, index: 3, mode: CITATION_MODES.NUMBER })).toBe('[3]');
  });

  it('renders DOMAIN mode', () => {
    expect(renderCitation({ url, index: 1, mode: CITATION_MODES.DOMAIN })).toBe('[react.dev]');
  });

  it('renders DOMAIN_ID mode', () => {
    expect(renderCitation({ url, index: 2, mode: CITATION_MODES.DOMAIN_ID })).toBe('[react.dev:2]');
  });

  it('renders NUMBER_HYPERLINK mode as markdown hyperlink', () => {
    expect(renderCitation({ url, index: 1, mode: CITATION_MODES.NUMBER_HYPERLINK })).toBe(`[1](${url})`);
  });

  it('renders DOMAIN_HYPERLINK mode as markdown hyperlink', () => {
    expect(renderCitation({ url, index: 1, mode: CITATION_MODES.DOMAIN_HYPERLINK })).toBe(`[react.dev](${url})`);
  });

  it('falls back to plain bracket when URL is invalid in link modes', () => {
    expect(renderCitation({ url: 'not-a-url', index: 1, mode: CITATION_MODES.NUMBER_HYPERLINK })).toBe('[1]');
    expect(renderCitation({ url: 'not-a-url', index: 1, mode: CITATION_MODES.DOMAIN_HYPERLINK })).toBe('[source]');
  });

  it('defaults to NUMBER mode when mode is missing', () => {
    expect(renderCitation({ url, index: 1 })).toBe('[1]');
  });

  it('coerces invalid index to 1', () => {
    expect(renderCitation({ url, index: 0, mode: CITATION_MODES.NUMBER })).toBe('[1]');
    expect(renderCitation({ url, index: -3, mode: CITATION_MODES.NUMBER })).toBe('[1]');
    expect(renderCitation({ url, index: 'x', mode: CITATION_MODES.NUMBER })).toBe('[1]');
  });

  it('falls back to NUMBER format for unknown mode', () => {
    expect(renderCitation({ url, index: 5, mode: 'BOGUS' })).toBe('[5]');
  });
});

describe('formatCitations', () => {
  const sources = ['https://react.dev/x', 'https://nextjs.org/y'];

  it('replaces [N] markers with DOMAIN mode', () => {
    const out = formatCitations('See [1] and [2].', { sources, mode: CITATION_MODES.DOMAIN });
    expect(out).toBe('See [react.dev] and [nextjs.org].');
  });

  it('strips lenticular brackets and re-replaces', () => {
    const out = formatCitations('Per 【1】 here.', { sources, mode: CITATION_MODES.DOMAIN_ID });
    expect(out).toBe('Per [react.dev:1] here.');
  });

  it('leaves out-of-range markers untouched', () => {
    const out = formatCitations('Has [1] and [9].', { sources, mode: CITATION_MODES.NUMBER });
    expect(out).toBe('Has [1] and [9].');
  });

  it('appends Sources footer when requested', () => {
    const out = formatCitations('Body [1].', { sources, mode: CITATION_MODES.NUMBER, appendFooter: true });
    expect(out).toContain('Sources:');
    expect(out).toContain('1. https://react.dev/x');
    expect(out).toContain('2. https://nextjs.org/y');
  });

  it('does not append footer when sources is empty', () => {
    const out = formatCitations('No cites here.', { sources: [], appendFooter: true });
    expect(out).toBe('No cites here.');
  });

  it('returns empty string for non-string input', () => {
    expect(formatCitations(undefined)).toBe('');
    expect(formatCitations(null)).toBe('');
    expect(formatCitations('')).toBe('');
  });

  it('dedupes sources before indexing', () => {
    const dupSources = ['https://react.dev/x', 'https://react.dev/x/', 'https://nextjs.org/y'];
    const out = formatCitations('See [2].', { sources: dupSources, mode: CITATION_MODES.DOMAIN });
    expect(out).toBe('See [nextjs.org].');
  });

  it('handles NUMBER_HYPERLINK mode with hyperlink output', () => {
    const out = formatCitations('Per [1].', { sources, mode: CITATION_MODES.NUMBER_HYPERLINK });
    expect(out).toBe('Per [1](https://react.dev/x).');
  });
});
