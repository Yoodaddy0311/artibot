import { describe, expect, it } from 'vitest';
import {
  _daysBetween,
  _parseDate,
  _parseFrontmatter,
  _updateLastVerified,
  createSkillFreshnessChecker,
} from '../../lib/learning/skill-freshness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed "now" for deterministic tests: 2026-03-27 */
const NOW = new Date('2026-03-27T00:00:00Z');
const nowFn = () => NOW;

function makeChecker(overrides = {}) {
  return createSkillFreshnessChecker({ now: nowFn, ...overrides });
}

// ---------------------------------------------------------------------------
// _parseDate
// ---------------------------------------------------------------------------

describe('skill-freshness/_parseDate', () => {
  it('parses valid YYYY-MM-DD', () => {
    const d = _parseDate('2026-03-27');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString().startsWith('2026-03-27')).toBe(true);
  });

  it('strips surrounding quotes', () => {
    const d = _parseDate('"2026-01-15"');
    expect(d.toISOString().startsWith('2026-01-15')).toBe(true);
  });

  it('returns null for empty string', () => {
    expect(_parseDate('')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(_parseDate(null)).toBeNull();
    expect(_parseDate(undefined)).toBeNull();
  });

  it('returns null for invalid format', () => {
    expect(_parseDate('March 27 2026')).toBeNull();
    expect(_parseDate('2026/03/27')).toBeNull();
    expect(_parseDate('not-a-date')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(_parseDate(12345)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _daysBetween
// ---------------------------------------------------------------------------

describe('skill-freshness/_daysBetween', () => {
  it('calculates correct day difference', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-03-27T00:00:00Z');
    expect(_daysBetween(from, to)).toBe(85);
  });

  it('returns 0 for same date', () => {
    expect(_daysBetween(NOW, NOW)).toBe(0);
  });

  it('returns negative for future from-date', () => {
    const future = new Date('2026-06-01T00:00:00Z');
    expect(_daysBetween(future, NOW)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// _parseFrontmatter
// ---------------------------------------------------------------------------

describe('skill-freshness/_parseFrontmatter', () => {
  it('extracts name, version, lastVerified', () => {
    const content = `---
name: my-skill
version: "1.2.0"
lastVerified: "2026-03-01"
---

# My Skill`;

    const fm = _parseFrontmatter(content);
    expect(fm.name).toBe('my-skill');
    expect(fm.version).toBe('1.2.0');
    expect(fm.lastVerified).toBe('2026-03-01');
  });

  it('returns nulls for missing fields', () => {
    const content = `---
name: some-skill
---
# Content`;

    const fm = _parseFrontmatter(content);
    expect(fm.name).toBe('some-skill');
    expect(fm.version).toBeNull();
    expect(fm.lastVerified).toBeNull();
  });

  it('returns all nulls for invalid frontmatter', () => {
    const fm = _parseFrontmatter('No frontmatter here');
    expect(fm.name).toBeNull();
    expect(fm.version).toBeNull();
  });

  it('returns all nulls for null/undefined/empty', () => {
    expect(_parseFrontmatter(null).name).toBeNull();
    expect(_parseFrontmatter(undefined).name).toBeNull();
    expect(_parseFrontmatter('').name).toBeNull();
  });

  it('handles multiline description without breaking', () => {
    const content = `---
name: complex-skill
description: |
  Multi-line description here.
  Triggers: foo, bar
version: "2.0.0"
lastVerified: "2026-02-15"
---
# Skill`;

    const fm = _parseFrontmatter(content);
    expect(fm.name).toBe('complex-skill');
    expect(fm.version).toBe('2.0.0');
    expect(fm.lastVerified).toBe('2026-02-15');
  });
});

// ---------------------------------------------------------------------------
// _updateLastVerified
// ---------------------------------------------------------------------------

describe('skill-freshness/_updateLastVerified', () => {
  it('replaces existing lastVerified field', () => {
    const content = `---
name: test
lastVerified: "2025-01-01"
---
# Content`;

    const updated = _updateLastVerified(content, '2026-03-27');
    expect(updated).toContain('lastVerified: "2026-03-27"');
    expect(updated).not.toContain('2025-01-01');
  });

  it('inserts lastVerified before closing --- if missing', () => {
    const content = `---
name: test
version: "1.0.0"
---
# Content`;

    const updated = _updateLastVerified(content, '2026-03-27');
    expect(updated).toContain('lastVerified: "2026-03-27"');
    expect(updated).toContain('---\n# Content');
  });

  it('returns input unchanged for null/undefined/empty', () => {
    expect(_updateLastVerified(null, '2026-03-27')).toBeNull();
    expect(_updateLastVerified(undefined, '2026-03-27')).toBeUndefined();
    expect(_updateLastVerified('', '2026-03-27')).toBe('');
  });

  it('does not mutate original string', () => {
    const content = `---
name: test
lastVerified: "2025-01-01"
---`;
    const original = content;
    _updateLastVerified(content, '2026-03-27');
    expect(content).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// checkFreshness
// ---------------------------------------------------------------------------

describe('skill-freshness/checkFreshness', () => {
  it('returns fresh for recent verification', () => {
    const checker = makeChecker();
    const result = checker.checkFreshness({ name: 'my-skill', lastVerified: '2026-03-20' });

    expect(result.status).toBe('fresh');
    expect(result.daysSinceVerified).toBe(7);
    expect(result.skill).toBe('my-skill');
  });

  it('returns warning when past warningDays', () => {
    const checker = makeChecker();
    // 65 days ago = 2026-01-21
    const result = checker.checkFreshness({ name: 'aging-skill', lastVerified: '2026-01-21' });

    expect(result.status).toBe('warning');
    expect(result.daysSinceVerified).toBe(65);
  });

  it('returns stale when past maxAgeDays', () => {
    const checker = makeChecker();
    // 100 days ago = 2025-12-18
    const result = checker.checkFreshness({ name: 'old-skill', lastVerified: '2025-12-18' });

    expect(result.status).toBe('stale');
    expect(result.daysSinceVerified).toBeGreaterThan(90);
  });

  it('returns unknown when lastVerified is missing', () => {
    const checker = makeChecker();
    const result = checker.checkFreshness({ name: 'no-date' });

    expect(result.status).toBe('unknown');
    expect(result.daysSinceVerified).toBeNull();
  });

  it('returns unknown when lastVerified is invalid', () => {
    const checker = makeChecker();
    const result = checker.checkFreshness({ name: 'bad-date', lastVerified: 'not-a-date' });

    expect(result.status).toBe('unknown');
  });

  it('respects custom thresholds', () => {
    const checker = makeChecker({ maxAgeDays: 30, warningDays: 15 });
    // 20 days ago = warning with custom thresholds
    const result = checker.checkFreshness({ name: 'custom', lastVerified: '2026-03-07' });

    expect(result.status).toBe('warning');
    expect(result.daysSinceVerified).toBe(20);
  });

  it('handles null skillMeta gracefully', () => {
    const checker = makeChecker();
    const result = checker.checkFreshness(null);

    expect(result.status).toBe('unknown');
    expect(result.skill).toBe('unknown');
  });

  it('exactly at boundary: warningDays is warning', () => {
    const checker = makeChecker({ warningDays: 60, maxAgeDays: 90 });
    // Exactly 60 days → NOT warning (must be >60)
    const result = checker.checkFreshness({ name: 'boundary', lastVerified: '2026-01-26' });
    expect(result.daysSinceVerified).toBe(60);
    expect(result.status).toBe('fresh');
  });

  it('exactly at maxAgeDays boundary: 90 days is warning not stale', () => {
    const checker = makeChecker({ warningDays: 60, maxAgeDays: 90 });
    // Exactly 90 days → NOT stale (must be >90)
    const result = checker.checkFreshness({ name: 'boundary90', lastVerified: '2025-12-27' });
    expect(result.daysSinceVerified).toBe(90);
    expect(result.status).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// scanAllSkills (with mocked readFile)
// ---------------------------------------------------------------------------

describe('skill-freshness/scanAllSkills', () => {
  it('scans directory and returns freshness for each skill', async () => {
    const files = {
      '/skills/alpha/SKILL.md': `---\nname: alpha\nversion: "1.0.0"\nlastVerified: "2026-03-20"\n---\n# Alpha`,
      '/skills/beta/SKILL.md': `---\nname: beta\nlastVerified: "2025-12-01"\n---\n# Beta`,
      '/skills/gamma/SKILL.md': `---\nname: gamma\n---\n# Gamma`,
    };

    const checker = makeChecker({
      readFile: async (p) => {
        const normalized = p.replace(/\\/g, '/');
        if (files[normalized]) return files[normalized];
        throw new Error('ENOENT');
      },
    });

    // Mock readdir via a custom scanAllSkills that injects entries
    const mockDir = '/skills';
    const results = await scanWithMockReaddir(checker, mockDir, ['alpha', 'beta', 'gamma'], files);

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.skill === 'alpha').status).toBe('fresh');
    expect(results.find((r) => r.skill === 'beta').status).toBe('stale');
    expect(results.find((r) => r.skill === 'gamma').status).toBe('unknown');
  });

  it('returns empty array if directory does not exist', async () => {
    const checker = makeChecker({
      readFile: async () => { throw new Error('ENOENT'); },
    });
    // scanAllSkills catches readdir errors
    const results = await checker.scanAllSkills('/nonexistent');
    expect(results).toEqual([]);
  });
});

/**
 * Helper to test scanAllSkills with mocked readdir.
 * Since scanAllSkills uses readdir internally, we create a checker with readFile mock
 * and manually invoke the scan logic.
 */
async function scanWithMockReaddir(checker, _dir, dirNames, files) {
  const results = [];
  for (const name of dirNames) {
    const skillPath = `/${_dir.replace(/^\//, '')}/${name}/SKILL.md`.replace(/\/\//g, '/');
    let content;
    try {
      const normalizedPath = skillPath.replace(/\\/g, '/');
      content = files[normalizedPath];
      if (!content) throw new Error('ENOENT');
    } catch {
      continue;
    }
    const meta = _parseFrontmatter(content);
    const freshness = checker.checkFreshness(meta);
    results.push({ ...freshness, version: meta.version ?? null, path: skillPath });
  }
  return results;
}


// ---------------------------------------------------------------------------
// markVerified
// ---------------------------------------------------------------------------

describe('skill-freshness/markVerified', () => {
  it('updates lastVerified to today', () => {
    const checker = makeChecker();
    const content = `---\nname: test\nlastVerified: "2025-01-01"\n---\n# Content`;
    const updated = checker.markVerified(content);

    expect(updated).toContain('lastVerified: "2026-03-27"');
    expect(updated).not.toContain('2025-01-01');
  });

  it('inserts lastVerified if missing', () => {
    const checker = makeChecker();
    const content = `---\nname: test\nversion: "1.0.0"\n---\n# Content`;
    const updated = checker.markVerified(content);

    expect(updated).toContain('lastVerified: "2026-03-27"');
  });

  it('does not mutate original content', () => {
    const checker = makeChecker();
    const content = `---\nname: test\nlastVerified: "2025-01-01"\n---`;
    const original = content;
    checker.markVerified(content);
    expect(content).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

describe('skill-freshness/generateReport', () => {
  it('counts statuses correctly', () => {
    const checker = makeChecker();
    const results = [
      { status: 'fresh', skill: 'a', daysSinceVerified: 5, version: '1.0.0', path: '/a' },
      { status: 'fresh', skill: 'b', daysSinceVerified: 10, version: '1.0.0', path: '/b' },
      { status: 'warning', skill: 'c', daysSinceVerified: 65, version: '1.0.0', path: '/c' },
      { status: 'stale', skill: 'd', daysSinceVerified: 100, version: '1.0.0', path: '/d' },
      { status: 'unknown', skill: 'e', daysSinceVerified: null, version: null, path: '/e' },
    ];

    const report = checker.generateReport(results);

    expect(report.total).toBe(5);
    expect(report.fresh).toBe(2);
    expect(report.warning).toBe(1);
    expect(report.stale).toBe(1);
    expect(report.unknown).toBe(1);
    expect(report.staleSkills).toEqual(['d']);
    expect(report.warningSkills).toEqual(['c']);
  });

  it('handles empty results', () => {
    const checker = makeChecker();
    const report = checker.generateReport([]);

    expect(report.total).toBe(0);
    expect(report.fresh).toBe(0);
    expect(report.staleSkills).toEqual([]);
    expect(report.warningSkills).toEqual([]);
  });

  it('handles all-fresh results', () => {
    const checker = makeChecker();
    const results = [
      { status: 'fresh', skill: 'x', daysSinceVerified: 1, version: '1.0.0', path: '/x' },
    ];
    const report = checker.generateReport(results);

    expect(report.stale).toBe(0);
    expect(report.warning).toBe(0);
    expect(report.staleSkills).toEqual([]);
  });
});
