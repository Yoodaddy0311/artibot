/**
 * Tests for lib/learning/risk-classifier.
 *
 * Pure unit tests — no I/O, no mocks needed.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyDiff,
  isWithinRiskCeiling,
  scoreFile,
} from '../../lib/learning/risk-classifier.js';

// ---------------------------------------------------------------------------
// scoreFile
// ---------------------------------------------------------------------------

describe('scoreFile — critical level', () => {
  it('classifies package.json modification as critical', () => {
    const r = scoreFile({ path: 'package.json', status: 'M', additions: 1, deletions: 1 });
    expect(r.level).toBe('critical');
    expect(r.score).toBe(1.0);
  });

  it('classifies artibot.config.json as critical', () => {
    expect(scoreFile({ path: 'artibot.config.json' }).level).toBe('critical');
  });

  it('classifies .claude-plugin/plugin.json as critical', () => {
    expect(scoreFile({ path: '.claude-plugin/plugin.json' }).level).toBe('critical');
  });

  it('classifies hooks.json as critical', () => {
    expect(scoreFile({ path: 'hooks.json' }).level).toBe('critical');
  });

  it('classifies migration paths as critical', () => {
    expect(scoreFile({ path: 'db/migrations/001_init.sql' }).level).toBe('critical');
    expect(scoreFile({ path: 'src/migration/something.js' }).level).toBe('critical');
  });

  it('classifies schema files as critical', () => {
    expect(scoreFile({ path: 'prisma/schema.prisma' }).level).toBe('critical');
    expect(scoreFile({ path: 'db/schema.sql' }).level).toBe('critical');
  });
});

describe('scoreFile — high level', () => {
  it('classifies new lib file as high', () => {
    const r = scoreFile({ path: 'lib/core/new-feature.js', status: 'A', additions: 50 });
    expect(r.level).toBe('high');
  });

  it('classifies deleted lib file as high', () => {
    const r = scoreFile({ path: 'lib/learning/old.js', status: 'D', deletions: 100 });
    expect(r.level).toBe('high');
  });

  it('classifies agents/*.md as high', () => {
    expect(scoreFile({ path: 'agents/orchestrator.md', status: 'M' }).level).toBe('high');
  });

  it('classifies commands/*.md as high', () => {
    expect(scoreFile({ path: 'commands/team.md', status: 'M' }).level).toBe('high');
  });
});

describe('scoreFile — low level', () => {
  it('classifies README.md as low', () => {
    expect(scoreFile({ path: 'README.md', status: 'M' }).level).toBe('low');
  });

  it('classifies docs changes as low', () => {
    expect(scoreFile({ path: 'docs/ARCHITECTURE.md' }).level).toBe('low');
  });

  it('classifies format-only hunks as low', () => {
    const file = {
      path: 'lib/core/some.js',
      status: 'M',
      additions: 2,
      deletions: 2,
      hunks: [
        { lines: ['+  ', '-  ', '+;', '-;'] },
      ],
    };
    expect(scoreFile(file).level).toBe('low');
  });
});

describe('scoreFile — medium level', () => {
  it('classifies internal lib edits as medium', () => {
    const r = scoreFile({ path: 'lib/core/config.js', status: 'M', additions: 5, deletions: 3 });
    expect(r.level).toBe('medium');
  });

  it('classifies test edits as medium', () => {
    expect(scoreFile({ path: 'tests/core/config.test.js', status: 'M', additions: 10 }).level)
      .toBe('medium');
  });

  it('classifies hooks edits as medium', () => {
    expect(scoreFile({ path: 'hooks/pre-commit.js', status: 'M' }).level).toBe('medium');
  });

  it('defaults to medium for unknown patterns (safety rail)', () => {
    const r = scoreFile({ path: 'some/random/path.js', status: 'M' });
    expect(r.level).toBe('medium');
  });

  it('returns medium for invalid descriptors', () => {
    expect(scoreFile(null).level).toBe('medium');
    expect(scoreFile({ path: 123 }).level).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// classifyDiff
// ---------------------------------------------------------------------------

describe('classifyDiff', () => {
  it('returns low when no files', () => {
    const r = classifyDiff({ files: [] });
    expect(r.level).toBe('low');
    expect(r.reasons).toEqual(['no file changes']);
  });

  it('picks the highest severity across multiple files', () => {
    const r = classifyDiff({
      files: [
        { path: 'README.md', status: 'M' },
        { path: 'lib/core/config.js', status: 'M', additions: 1 },
        { path: 'package.json', status: 'M' },
      ],
    });
    expect(r.level).toBe('critical');
  });

  it('stays at low when all changes are low', () => {
    const r = classifyDiff({
      files: [
        { path: 'README.md', status: 'M' },
        { path: 'docs/guide.md', status: 'A' },
      ],
    });
    expect(r.level).toBe('low');
  });

  it('escalates to high when any file is high', () => {
    const r = classifyDiff({
      files: [
        { path: 'README.md', status: 'M' },
        { path: 'lib/new-thing.js', status: 'A' },
      ],
    });
    expect(r.level).toBe('high');
  });

  it('reports reasons per file', () => {
    const r = classifyDiff({
      files: [
        { path: 'README.md', status: 'M' },
        { path: 'lib/core/a.js', status: 'M', additions: 3, deletions: 0 },
      ],
    });
    expect(r.reasons).toHaveLength(2);
    expect(r.reasons[0]).toContain('README.md');
    expect(r.reasons[1]).toContain('lib/core/a.js');
  });

  it('normalizes Windows paths', () => {
    const r = classifyDiff({
      files: [{ path: 'lib\\core\\a.js', status: 'M', additions: 1 }],
    });
    expect(r.level).toBe('medium');
    expect(r.reasons[0]).toContain('lib/core/a.js');
  });
});

// ---------------------------------------------------------------------------
// isWithinRiskCeiling
// ---------------------------------------------------------------------------

describe('isWithinRiskCeiling', () => {
  it('low fits within low ceiling', () => {
    expect(isWithinRiskCeiling('low', 'low')).toBe(true);
  });

  it('medium does not fit within low ceiling', () => {
    expect(isWithinRiskCeiling('medium', 'low')).toBe(false);
  });

  it('low fits within medium ceiling', () => {
    expect(isWithinRiskCeiling('low', 'medium')).toBe(true);
  });

  it('critical never fits below critical ceiling', () => {
    expect(isWithinRiskCeiling('critical', 'high')).toBe(false);
    expect(isWithinRiskCeiling('critical', 'critical')).toBe(true);
  });

  it('returns false for unknown levels', () => {
    expect(isWithinRiskCeiling('unknown', 'low')).toBe(false);
    expect(isWithinRiskCeiling('low', 'unknown')).toBe(false);
  });
});
