import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockReadJsonFile = vi.fn();
const mockWriteJsonFile = vi.fn();
const mockEnsureDir = vi.fn();

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: (...args) => mockReadJsonFile(...args),
  writeJsonFile: (...args) => mockWriteJsonFile(...args),
  ensureDir: (...args) => mockEnsureDir(...args),
}));

vi.mock('../../lib/core/config.js', () => ({
  ARTIBOT_DIR: '/fake/.claude/artibot',
}));

vi.mock('../../lib/core/platform.js', () => ({
  getPluginRoot: vi.fn(() => '/fake/plugin'),
}));

// fs mock
const mockFsAccess = vi.fn();
const mockFsReadFile = vi.fn();
const mockFsWriteFile = vi.fn();
const mockFsUnlink = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    access: (...args) => mockFsAccess(...args),
    readFile: (...args) => mockFsReadFile(...args),
    writeFile: (...args) => mockFsWriteFile(...args),
    unlink: (...args) => mockFsUnlink(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  clearInjections,
  getInjectedRules,
  injectRules,
} from '../../lib/learning/skill-injector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(type, content, confidence = 0.9) {
  return { type, content, confidence, source: 'conversation', lang: 'en', extractedAt: new Date().toISOString(), rawMatch: content };
}

/**
 * Find the writeJsonFile call that wrote to a references/auto-learned-rules.json path.
 * Returns the written data, or undefined if not found.
 */
function findAutoLearnedWrite() {
  for (const call of mockWriteJsonFile.mock.calls) {
    if (typeof call[0] === 'string' && call[0].includes('auto-learned-rules.json')) {
      return call[1];
    }
  }
  return undefined;
}

/**
 * Find the writeJsonFile call that wrote the injection log.
 * Returns the written data, or undefined if not found.
 */
function findInjectionLogWrite() {
  for (const call of mockWriteJsonFile.mock.calls) {
    if (typeof call[0] === 'string' && call[0].includes('skill-injection-log.json')) {
      return call[1];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// injectRules()
// ---------------------------------------------------------------------------

describe('injectRules()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDir.mockResolvedValue(undefined);
    mockReadJsonFile.mockResolvedValue([]); // empty injection log + empty auto-learned rules
    mockWriteJsonFile.mockResolvedValue(undefined);
    mockFsAccess.mockResolvedValue(undefined); // skill exists
    mockFsReadFile.mockResolvedValue('# Coding Standards\n\nSome content.');
    mockFsWriteFile.mockResolvedValue(undefined);
  });

  it('returns zero injected when rules array is empty', async () => {
    const result = await injectRules([], 'coding-standards');
    expect(result).toMatchObject({ injected: 0, skipped: 0, injectedContents: [] });
  });

  it('returns zero injected when rules is null', async () => {
    const result = await injectRules(null, 'coding-standards');
    expect(result).toMatchObject({ injected: 0, skipped: 0 });
  });

  it('returns skipped=N when skill does not exist', async () => {
    mockFsAccess.mockRejectedValue(new Error('ENOENT'));
    const rules = [makeRule('preference', 'Always use TypeScript')];
    const result = await injectRules(rules, 'nonexistent-skill');
    expect(result.injected).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('injects a single new rule into references/auto-learned-rules.json', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];
    const result = await injectRules(rules, 'coding-standards');

    expect(result.injected).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.injectedContents).toContain('Always use TypeScript');

    const written = findAutoLearnedWrite();
    expect(written).toBeDefined();
    expect(written).toHaveLength(1);
    expect(written[0].content).toBe('Always use TypeScript');
  });

  it('writes to references/ directory (auto-commit allowlist)', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];
    await injectRules(rules, 'coding-standards');

    const writeCall = mockWriteJsonFile.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('references'),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall[0]).toContain('references');
    expect(writeCall[0]).toContain('auto-learned-rules.json');
  });

  it('does NOT modify SKILL.md directly', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];
    await injectRules(rules, 'coding-standards');

    // fs.writeFile should NOT be called (SKILL.md is not touched)
    expect(mockFsWriteFile).not.toHaveBeenCalled();
  });

  it('skips rules already in injection log (deduplication)', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];

    // First injection - should succeed
    const first = await injectRules(rules, 'coding-standards');
    expect(first.injected).toBe(1);

    // Second injection: now the log contains the hash
    const savedLog = findInjectionLogWrite() ?? [];
    mockReadJsonFile.mockResolvedValue(savedLog);

    const second = await injectRules(rules, 'coding-standards');
    expect(second.injected).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('injects multiple rules in a single call', async () => {
    const rules = [
      makeRule('preference', 'Always use TypeScript'),
      makeRule('prohibition', 'Never use var'),
      makeRule('decision', 'Use vitest for testing'),
    ];
    const result = await injectRules(rules, 'coding-standards');
    expect(result.injected).toBe(3);
    expect(result.injectedContents).toHaveLength(3);
  });

  it('persists the injection log after writing', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];
    await injectRules(rules, 'coding-standards');

    const logArg = findInjectionLogWrite();
    expect(logArg).toBeDefined();
    expect(Array.isArray(logArg)).toBe(true);
    expect(logArg.length).toBe(1);
    expect(logArg[0].skillName).toBe('coding-standards');
  });

  it('includes formatted rule line in JSON entry', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];
    await injectRules(rules, 'coding-standards');

    const written = findAutoLearnedWrite();
    expect(written[0].formatted).toBe('- [preference] Always use TypeScript');
  });

  it('formats prohibition rules with [prohibition] label', async () => {
    const rules = [makeRule('prohibition', 'Never use var')];
    await injectRules(rules, 'coding-standards');

    const written = findAutoLearnedWrite();
    expect(written[0].formatted).toContain('[prohibition] Never use var');
  });

  it('formats decision rules with [decision] label', async () => {
    const rules = [makeRule('decision', 'Use Bun runtime')];
    await injectRules(rules, 'coding-standards');

    const written = findAutoLearnedWrite();
    expect(written[0].formatted).toContain('[decision] Use Bun runtime');
  });

  it('formats tool-preference rules with [tool] label', async () => {
    const rules = [makeRule('tool-preference', 'pnpm instead of npm')];
    await injectRules(rules, 'coding-standards');

    const written = findAutoLearnedWrite();
    expect(written[0].formatted).toContain('[tool] pnpm instead of npm');
  });

  it('returns skillName in result', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];
    const result = await injectRules(rules, 'testing-standards');
    expect(result.skillName).toBe('testing-standards');
  });

  it('does NOT write when all rules are duplicates', async () => {
    const rules = [makeRule('preference', 'Always use TypeScript')];
    await injectRules(rules, 'coding-standards'); // first pass

    const savedLog = findInjectionLogWrite() ?? [];
    mockReadJsonFile.mockResolvedValue(savedLog);
    mockWriteJsonFile.mockClear();

    const second = await injectRules(rules, 'coding-standards');
    expect(second.injected).toBe(0);
    // No writes should occur
    expect(findAutoLearnedWrite()).toBeUndefined();
  });

  it('handles log with many entries without throwing', async () => {
    const bigLog = Array.from({ length: 1900 }, (_, i) => ({
      skillName: 'coding-standards',
      ruleHash: i.toString(16).padStart(8, '0'),
      type: 'preference',
      content: `Rule ${i}`,
      injectedAt: new Date().toISOString(),
    }));
    mockReadJsonFile.mockResolvedValue(bigLog);

    const rules = [makeRule('preference', 'Brand new rule')];
    const result = await injectRules(rules, 'coding-standards');
    expect(result.injected).toBe(1);
  });

  it('merges with existing auto-learned rules', async () => {
    const existingRules = [
      { type: 'preference', content: 'Old rule', formatted: '- [preference] Old rule', injectedAt: '2026-01-01' },
    ];
    // readJsonFile returns existing rules for auto-learned-rules.json
    mockReadJsonFile.mockImplementation((filePath) => {
      if (typeof filePath === 'string' && filePath.includes('auto-learned-rules.json')) {
        return Promise.resolve(existingRules);
      }
      return Promise.resolve([]); // empty injection log
    });

    const rules = [makeRule('preference', 'New rule')];
    await injectRules(rules, 'coding-standards');

    const written = findAutoLearnedWrite();
    expect(written).toHaveLength(2);
    expect(written[0].content).toBe('Old rule');
    expect(written[1].content).toBe('New rule');
  });
});

// ---------------------------------------------------------------------------
// getInjectedRules()
// ---------------------------------------------------------------------------

describe('getInjectedRules()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDir.mockResolvedValue(undefined);
    mockWriteJsonFile.mockResolvedValue(undefined);
  });

  it('returns all log entries when no skillName filter', async () => {
    const log = [
      { skillName: 'coding-standards', ruleHash: 'aaa', type: 'preference', content: 'A', injectedAt: '' },
      { skillName: 'testing-standards', ruleHash: 'bbb', type: 'decision', content: 'B', injectedAt: '' },
    ];
    mockReadJsonFile.mockResolvedValue(log);

    const result = await getInjectedRules();
    expect(result).toHaveLength(2);
  });

  it('filters by skillName', async () => {
    const log = [
      { skillName: 'coding-standards', ruleHash: 'aaa', type: 'preference', content: 'A', injectedAt: '' },
      { skillName: 'testing-standards', ruleHash: 'bbb', type: 'decision', content: 'B', injectedAt: '' },
    ];
    mockReadJsonFile.mockResolvedValue(log);

    const result = await getInjectedRules('coding-standards');
    expect(result).toHaveLength(1);
    expect(result[0].skillName).toBe('coding-standards');
  });

  it('returns empty array when log is empty', async () => {
    mockReadJsonFile.mockResolvedValue([]);
    const result = await getInjectedRules('coding-standards');
    expect(result).toEqual([]);
  });

  it('returns empty array when skill not found in log', async () => {
    mockReadJsonFile.mockResolvedValue([
      { skillName: 'other-skill', ruleHash: 'ccc', type: 'preference', content: 'C', injectedAt: '' },
    ]);
    const result = await getInjectedRules('coding-standards');
    expect(result).toEqual([]);
  });

  it('handles null log (corrupted file)', async () => {
    mockReadJsonFile.mockResolvedValue(null);
    const result = await getInjectedRules();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clearInjections()
// ---------------------------------------------------------------------------

describe('clearInjections()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDir.mockResolvedValue(undefined);
    mockWriteJsonFile.mockResolvedValue(undefined);
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue('# Skill\n\n## Project-Specific Rules\n\n- [preference] Old rule\n');
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsUnlink.mockResolvedValue(undefined);
  });

  it('removes log entries for the given skill', async () => {
    const log = [
      { skillName: 'coding-standards', ruleHash: 'aaa', type: 'preference', content: 'A', injectedAt: '' },
      { skillName: 'other-skill', ruleHash: 'bbb', type: 'decision', content: 'B', injectedAt: '' },
    ];
    mockReadJsonFile.mockResolvedValue(log);

    await clearInjections('coding-standards');

    const writtenLog = mockWriteJsonFile.mock.calls[0][1];
    expect(writtenLog).toHaveLength(1);
    expect(writtenLog[0].skillName).toBe('other-skill');
  });

  it('returns cleared count', async () => {
    const log = [
      { skillName: 'coding-standards', ruleHash: 'aaa', type: 'preference', content: 'A', injectedAt: '' },
      { skillName: 'coding-standards', ruleHash: 'bbb', type: 'prohibition', content: 'B', injectedAt: '' },
    ];
    mockReadJsonFile.mockResolvedValue(log);

    const result = await clearInjections('coding-standards');
    expect(result.cleared).toBe(2);
  });

  it('deletes auto-learned-rules.json file', async () => {
    mockReadJsonFile.mockResolvedValue([
      { skillName: 'coding-standards', ruleHash: 'aaa', type: 'preference', content: 'A', injectedAt: '' },
    ]);

    await clearInjections('coding-standards');

    expect(mockFsUnlink).toHaveBeenCalledTimes(1);
    const unlinkPath = mockFsUnlink.mock.calls[0][0];
    expect(unlinkPath).toContain('auto-learned-rules.json');
    expect(unlinkPath).toContain('references');
  });

  it('handles missing auto-learned-rules.json gracefully', async () => {
    mockReadJsonFile.mockResolvedValue([]);
    mockFsUnlink.mockRejectedValue(new Error('ENOENT'));

    const result = await clearInjections('coding-standards');
    expect(result.cleared).toBe(0);
  });

  it('strips legacy project-rules section from SKILL.md', async () => {
    const log = [{ skillName: 'coding-standards', ruleHash: 'aaa', type: 'preference', content: 'A', injectedAt: '' }];
    mockReadJsonFile.mockResolvedValue(log);

    await clearInjections('coding-standards');

    const writtenSkill = mockFsWriteFile.mock.calls[0][1];
    expect(writtenSkill).not.toContain('## Project-Specific Rules');
    expect(writtenSkill).not.toContain('Old rule');
  });

  it('returns cleared=0 when no entries for that skill', async () => {
    mockReadJsonFile.mockResolvedValue([
      { skillName: 'other-skill', ruleHash: 'ccc', type: 'preference', content: 'C', injectedAt: '' },
    ]);

    const result = await clearInjections('coding-standards');
    expect(result.cleared).toBe(0);
  });

  it('handles non-existent skill (no SKILL.md) gracefully', async () => {
    mockReadJsonFile.mockResolvedValue([]);
    mockFsAccess.mockRejectedValue(new Error('ENOENT'));

    const result = await clearInjections('nonexistent-skill');
    expect(result.cleared).toBe(0);
  });

  it('handles skill without project-rules section gracefully', async () => {
    mockReadJsonFile.mockResolvedValue([
      { skillName: 'coding-standards', ruleHash: 'aaa', type: 'preference', content: 'A', injectedAt: '' },
    ]);
    mockFsReadFile.mockResolvedValue('# Coding Standards\n\nNo project rules here.');

    const result = await clearInjections('coding-standards');
    expect(result.cleared).toBe(1);
  });
});
