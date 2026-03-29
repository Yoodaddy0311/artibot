import { describe, expect, it, beforeEach } from 'vitest';
import {
  AstSearch,
  parseAstGrepOutput,
  escapeRegex,
  patternToRegex,
  extractMetaVarNames,
} from '../../lib/tools/ast-search.js';

// ---------------------------------------------------------------------------
describe('parseAstGrepOutput()', () => {
  it('returns empty array for empty string', () => {
    expect(parseAstGrepOutput('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseAstGrepOutput('   ')).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseAstGrepOutput('{"key":"value"}')).toEqual([]);
  });

  it('parses a valid ast-grep JSON array', () => {
    const input = JSON.stringify([
      {
        file: 'src/index.js',
        range: { start: { line: 10, column: 4 } },
        text: 'console.log("hello")',
        metaVariables: { $MSG: '"hello"' },
      },
    ]);

    const result = parseAstGrepOutput(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      file: 'src/index.js',
      line: 10,
      column: 4,
      matchedCode: 'console.log("hello")',
      metaVariables: { $MSG: '"hello"' },
    });
  });

  it('handles missing fields gracefully', () => {
    const input = JSON.stringify([{}]);
    const result = parseAstGrepOutput(input);
    expect(result[0]).toEqual({
      file: '',
      line: 0,
      column: 0,
      matchedCode: '',
      metaVariables: {},
    });
  });
});

// ---------------------------------------------------------------------------
describe('escapeRegex()', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });

  it('escapes brackets and parens', () => {
    expect(escapeRegex('[a](b)')).toBe('\\[a\\]\\(b\\)');
  });

  it('returns plain strings unchanged', () => {
    expect(escapeRegex('hello')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
describe('patternToRegex()', () => {
  it('converts meta-variables to capture groups', () => {
    const regex = patternToRegex('console.log($MSG)');
    expect(regex.source).toContain('(.+?)');
    expect(regex.source).toContain('console\\.log\\(');
  });

  it('matches a simple pattern', () => {
    const regex = patternToRegex('console.log($MSG)');
    // Global regex — use exec() to get capture groups
    const match = regex.exec('console.log("hello")');
    expect(match).not.toBeNull();
    expect(match[1]).toBe('"hello"');
  });

  it('handles patterns without meta-variables', () => {
    const regex = patternToRegex('return true');
    expect('return true'.match(regex)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('extractMetaVarNames()', () => {
  it('extracts single meta-variable', () => {
    expect(extractMetaVarNames('console.log($MSG)')).toEqual(['$MSG']);
  });

  it('extracts multiple meta-variables', () => {
    expect(extractMetaVarNames('$OBJ.$METHOD($ARG)')).toEqual([
      '$OBJ',
      '$METHOD',
      '$ARG',
    ]);
  });

  it('returns empty array when no meta-variables', () => {
    expect(extractMetaVarNames('return true')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('AstSearch', () => {
  let astSearch;

  beforeEach(() => {
    astSearch = new AstSearch({ binaryPath: 'nonexistent-sg-binary' });
  });

  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('creates instance with default binary path', () => {
      const s = new AstSearch();
      expect(s).toBeInstanceOf(AstSearch);
    });

    it('accepts custom binary path', () => {
      const s = new AstSearch({ binaryPath: '/usr/local/bin/sg' });
      expect(s).toBeInstanceOf(AstSearch);
    });
  });

  // ---------------------------------------------------------------------------
  describe('isAvailable()', () => {
    it('returns false when binary is not found', async () => {
      const result = await astSearch.isAvailable();
      expect(result).toBe(false);
    });

    it('caches the availability result', async () => {
      await astSearch.isAvailable();
      const second = await astSearch.isAvailable();
      expect(second).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getSupportedLanguages()', () => {
    it('returns a non-empty array', () => {
      const langs = astSearch.getSupportedLanguages();
      expect(Array.isArray(langs)).toBe(true);
      expect(langs.length).toBeGreaterThan(0);
    });

    it('includes common languages', () => {
      const langs = astSearch.getSupportedLanguages();
      expect(langs).toContain('javascript');
      expect(langs).toContain('typescript');
      expect(langs).toContain('python');
    });
  });

  // ---------------------------------------------------------------------------
  describe('search()', () => {
    it('throws on empty pattern', async () => {
      await expect(astSearch.search('', '/tmp')).rejects.toThrow(
        'Pattern must be a non-empty string',
      );
    });

    it('throws on empty target path', async () => {
      await expect(astSearch.search('console.log($MSG)', '')).rejects.toThrow(
        'Target path must be a non-empty string',
      );
    });

    it('falls back to regex when ast-grep unavailable', async () => {
      // Create a temp file for searching
      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const dir = join(tmpdir(), `ast-search-test-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'test.js'), 'console.log("hello world");\n');

      try {
        const { results, fallback } = await astSearch.search(
          'console.log($MSG)',
          dir,
        );

        expect(fallback).toBe(true);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].matchedCode).toContain('console.log');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fallback search works on a single file', async () => {
      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const dir = join(tmpdir(), `ast-search-file-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, 'single.js');
      writeFileSync(filePath, 'const x = 42;\nconsole.log(x);\n');

      try {
        const { results, fallback } = await astSearch.search(
          'console.log($MSG)',
          filePath,
        );

        expect(fallback).toBe(true);
        expect(results.length).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('replace()', () => {
    it('throws on empty pattern', async () => {
      await expect(
        astSearch.replace('', 'replacement', '/tmp'),
      ).rejects.toThrow('Pattern must be a non-empty string');
    });

    it('throws when replacement is not a string', async () => {
      await expect(
        astSearch.replace('pattern', null, '/tmp'),
      ).rejects.toThrow('Replacement must be a string');
    });

    it('throws on empty target path', async () => {
      await expect(
        astSearch.replace('pattern', 'replacement', ''),
      ).rejects.toThrow('Target path must be a non-empty string');
    });

    it('throws when ast-grep is not available', async () => {
      await expect(
        astSearch.replace('console.log($MSG)', 'logger.info($MSG)', '/tmp'),
      ).rejects.toThrow('ast-grep is required for structural replace');
    });
  });
});
