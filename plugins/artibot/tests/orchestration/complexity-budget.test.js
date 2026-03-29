import { describe, expect, it, beforeEach } from 'vitest';
import {
  ComplexityBudget,
  countLines,
  countSubtasks,
  extractFileReferences,
  extractHeadings,
  extractNumberedGroups,
  groupFilesByDirectory,
  Level,
  DEFAULT_THRESHOLDS,
} from '../../lib/orchestration/complexity-budget.js';

// ---------------------------------------------------------------------------
describe('countLines()', () => {
  it('returns 0 for empty string', () => {
    expect(countLines('')).toBe(0);
  });

  it('counts non-empty lines', () => {
    expect(countLines('line1\nline2\nline3')).toBe(3);
  });

  it('skips blank lines', () => {
    expect(countLines('line1\n\n\nline2\n  \nline3')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('countSubtasks()', () => {
  it('returns 0 for text without list items', () => {
    expect(countSubtasks('Just a paragraph.')).toBe(0);
  });

  it('counts checkbox items', () => {
    const text = '- [ ] Task A\n- [x] Task B\n- [ ] Task C';
    expect(countSubtasks(text)).toBe(3);
  });

  it('counts numbered list items', () => {
    const text = '1. First\n2. Second\n3) Third';
    expect(countSubtasks(text)).toBe(3);
  });

  it('counts bullet items', () => {
    const text = '- Item A\n* Item B\n- Item C';
    expect(countSubtasks(text)).toBe(3);
  });

  it('does not double-count checkboxes as bullets', () => {
    const text = '- [ ] checkbox\n- bullet';
    expect(countSubtasks(text)).toBe(2);
  });

  it('handles mixed list types', () => {
    const text = '- [ ] Check\n1. Numbered\n- Bullet\n* Star';
    expect(countSubtasks(text)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('extractFileReferences()', () => {
  it('returns empty array for no file refs', () => {
    expect(extractFileReferences('just text')).toEqual([]);
  });

  it('extracts file paths with extensions', () => {
    const text = 'Edit `src/index.js` and `lib/utils.ts`';
    const files = extractFileReferences(text);
    expect(files).toContain('src/index.js');
    expect(files).toContain('lib/utils.ts');
  });

  it('deduplicates file paths', () => {
    const text = 'src/index.js and again src/index.js';
    expect(extractFileReferences(text)).toHaveLength(1);
  });

  it('ignores common non-file patterns', () => {
    const text = 'e.g. this is not a file';
    expect(extractFileReferences(text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('extractHeadings()', () => {
  it('returns empty array for no headings', () => {
    expect(extractHeadings('no headings here')).toEqual([]);
  });

  it('extracts ## and ### headings', () => {
    const text = '## Phase 1\nSome text\n### Step A\nMore text\n## Phase 2';
    const headings = extractHeadings(text);
    expect(headings).toHaveLength(3);
    expect(headings[0].title).toBe('Phase 1');
    expect(headings[1].title).toBe('Step A');
    expect(headings[2].title).toBe('Phase 2');
  });

  it('ignores # level 1 headings', () => {
    const text = '# Title\n## Subtitle';
    const headings = extractHeadings(text);
    expect(headings).toHaveLength(1);
    expect(headings[0].title).toBe('Subtitle');
  });

  it('includes lineIndex', () => {
    const text = 'line0\n## Heading\nline2';
    const headings = extractHeadings(text);
    expect(headings[0].lineIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('extractNumberedGroups()', () => {
  it('returns empty array for no numbered items', () => {
    expect(extractNumberedGroups('plain text')).toEqual([]);
  });

  it('extracts numbered items with dot notation', () => {
    const text = '1. First task\n2. Second task';
    const groups = extractNumberedGroups(text);
    expect(groups).toHaveLength(2);
    expect(groups[0].title).toBe('First task');
  });

  it('extracts numbered items with paren notation', () => {
    const text = '1) Alpha\n2) Beta';
    const groups = extractNumberedGroups(text);
    expect(groups).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
describe('groupFilesByDirectory()', () => {
  it('returns empty array for no files', () => {
    expect(groupFilesByDirectory([])).toEqual([]);
  });

  it('groups files by directory', () => {
    const files = ['src/a.js', 'src/b.js', 'lib/c.js'];
    const groups = groupFilesByDirectory(files);
    expect(groups).toHaveLength(2);

    const srcGroup = groups.find((g) => g.directory === 'src');
    expect(srcGroup.files).toEqual(['src/a.js', 'src/b.js']);
  });

  it('puts root-level files in . directory', () => {
    const groups = groupFilesByDirectory(['index.js']);
    expect(groups[0].directory).toBe('.');
  });
});

// ---------------------------------------------------------------------------
describe('Level', () => {
  it('has LOW, MEDIUM, HIGH values', () => {
    expect(Level.LOW).toBe('LOW');
    expect(Level.MEDIUM).toBe('MEDIUM');
    expect(Level.HIGH).toBe('HIGH');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(Level)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('DEFAULT_THRESHOLDS', () => {
  it('has expected default values', () => {
    expect(DEFAULT_THRESHOLDS.lines).toBe(150);
    expect(DEFAULT_THRESHOLDS.subtasks).toBe(5);
    expect(DEFAULT_THRESHOLDS.files).toBe(7);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ComplexityBudget', () => {
  let budget;

  beforeEach(() => {
    budget = new ComplexityBudget();
  });

  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('uses default thresholds', () => {
      const score = budget.estimateComplexity('a line');
      expect(score).toBeDefined();
    });

    it('accepts custom thresholds', () => {
      const custom = new ComplexityBudget({ lines: 10, subtasks: 2, files: 3 });
      const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
      const score = custom.estimateComplexity(text);
      expect(score.level).toBe('HIGH');
    });
  });

  // ---------------------------------------------------------------------------
  describe('estimateComplexity()', () => {
    it('throws on non-string input', () => {
      expect(() => budget.estimateComplexity(42)).toThrow(
        'Task description must be a string',
      );
    });

    it('returns LOW for simple tasks', () => {
      const score = budget.estimateComplexity('Fix the typo in README.md');
      expect(score.level).toBe('LOW');
      expect(score.lines).toBe(1);
    });

    it('returns HIGH for many lines', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Step ${i}`);
      const score = budget.estimateComplexity(lines.join('\n'));
      expect(score.level).toBe('HIGH');
      expect(score.lines).toBe(200);
    });

    it('returns HIGH for many subtasks', () => {
      const items = Array.from({ length: 8 }, (_, i) => `- [ ] Task ${i}`);
      const score = budget.estimateComplexity(items.join('\n'));
      expect(score.level).toBe('HIGH');
      expect(score.subtasks).toBe(8);
    });

    it('returns HIGH for many file references', () => {
      const files = Array.from(
        { length: 10 },
        (_, i) => `Edit src/file${i}.js`,
      );
      const score = budget.estimateComplexity(files.join('\n'));
      expect(score.level).toBe('HIGH');
    });

    it('returns MEDIUM at 60-100% threshold', () => {
      const custom = new ComplexityBudget({ lines: 10, subtasks: 100, files: 100 });
      const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
      const score = custom.estimateComplexity(lines.join('\n'));
      expect(score.level).toBe('MEDIUM');
    });

    it('returns frozen score object', () => {
      const score = budget.estimateComplexity('test');
      expect(Object.isFrozen(score)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('shouldSplit()', () => {
    it('returns false for simple tasks', () => {
      const result = budget.shouldSplit('Fix a bug');
      expect(result.shouldSplit).toBe(false);
      expect(result.reasons).toEqual([]);
    });

    it('returns true with line count reason', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Step ${i}`);
      const result = budget.shouldSplit(lines.join('\n'));
      expect(result.shouldSplit).toBe(true);
      expect(result.reasons.some((r) => r.includes('Line count'))).toBe(true);
    });

    it('returns true with subtask count reason', () => {
      const items = Array.from({ length: 8 }, (_, i) => `- [ ] Task ${i}`);
      const result = budget.shouldSplit(items.join('\n'));
      expect(result.shouldSplit).toBe(true);
      expect(result.reasons.some((r) => r.includes('Subtask count'))).toBe(true);
    });

    it('returns true with file count reason', () => {
      const files = Array.from(
        { length: 10 },
        (_, i) => `Edit src/file${i}.js`,
      );
      const result = budget.shouldSplit(files.join('\n'));
      expect(result.shouldSplit).toBe(true);
      expect(result.reasons.some((r) => r.includes('File count'))).toBe(true);
    });

    it('returns frozen result', () => {
      const result = budget.shouldSplit('test');
      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('suggestSplits()', () => {
    it('throws on non-string input', () => {
      expect(() => budget.suggestSplits(null)).toThrow(
        'Task description must be a string',
      );
    });

    it('returns headings as split points', () => {
      const text = '## Phase 1\nDo A\n## Phase 2\nDo B';
      const splits = budget.suggestSplits(text);
      expect(splits.headings).toHaveLength(2);
    });

    it('returns numbered groups as split points', () => {
      const text = '1. First\n2. Second\n3. Third';
      const splits = budget.suggestSplits(text);
      expect(splits.numberedGroups).toHaveLength(3);
    });

    it('returns file groups as split points', () => {
      const text = 'Edit `src/a.js` and `src/b.js` and `lib/c.js`';
      const splits = budget.suggestSplits(text);
      expect(splits.fileGroups.length).toBeGreaterThan(0);
    });

    it('returns frozen result', () => {
      const splits = budget.suggestSplits('test');
      expect(Object.isFrozen(splits)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getScore()', () => {
    it('is an alias for estimateComplexity', () => {
      const text = 'Fix bug in src/index.js';
      const score = budget.getScore(text);
      const complexity = budget.estimateComplexity(text);
      expect(score).toEqual(complexity);
    });
  });
});
