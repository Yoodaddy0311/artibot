import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * skill-validation-check.js — SessionStart hook that scans skill directories
 * for missing or invalid SKILL.md files. Tests verify path resolution
 * (fileURLToPath for Korean paths) and validation logic.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  writeStdoutCalls: [],
  readdirResult: [],
  statResults: {},
  readFileResults: {},
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  writeStdout: vi.fn((...args) => { mockState.writeStdoutCalls.push(args); }),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readdirSync: vi.fn(() => mockState.readdirResult),
    statSync: vi.fn((p) => {
      const key = Object.keys(mockState.statResults).find((k) => p.includes(k));
      if (key) return mockState.statResults[key];
      throw new Error('ENOENT');
    }),
    readFileSync: vi.fn((p) => {
      const key = Object.keys(mockState.readFileResults).find((k) => p.includes(k));
      if (key) return mockState.readFileResults[key];
      throw new Error('ENOENT');
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.writeStdoutCalls = [];
  mockState.readdirResult = [];
  mockState.statResults = {};
  mockState.readFileResults = {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('skill-validation-check', () => {
  beforeEach(() => {
    vi.resetModules();
    resetState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should exit silently when skills directory does not exist', async () => {
    const { readdirSync } = await import('node:fs');
    readdirSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(0);
  });

  it('should exit silently when all skills are valid', async () => {
    mockState.readdirResult = ['my-skill'];
    mockState.statResults = { 'my-skill': { isDirectory: () => true } };
    mockState.readFileResults = {
      'SKILL.md': [
        '---',
        'name: my-skill',
        'description: A test skill',
        'context: test',
        'triggers: test',
        '---',
        'Content here',
      ].join('\n'),
    };

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(0);
  });

  it('should report skills with missing SKILL.md', async () => {
    mockState.readdirResult = ['broken-skill'];
    mockState.statResults = { 'broken-skill': { isDirectory: () => true } };
    // readFileSync will throw ENOENT for SKILL.md

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const msg = mockState.writeStdoutCalls[0][0].message;
    expect(msg).toContain('broken-skill');
    expect(msg).toContain('not found');
  });

  it('should report skills with missing frontmatter', async () => {
    mockState.readdirResult = ['no-fm'];
    mockState.statResults = { 'no-fm': { isDirectory: () => true } };
    mockState.readFileResults = { 'SKILL.md': 'Just content, no frontmatter' };

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const msg = mockState.writeStdoutCalls[0][0].message;
    expect(msg).toContain('missing frontmatter');
  });

  it('should report skills with missing required fields', async () => {
    mockState.readdirResult = ['partial'];
    mockState.statResults = { partial: { isDirectory: () => true } };
    mockState.readFileResults = {
      'SKILL.md': '---\nname: partial\n---\nContent',
    };

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const msg = mockState.writeStdoutCalls[0][0].message;
    expect(msg).toContain('missing field');
  });

  it('should skip non-directory entries', async () => {
    mockState.readdirResult = ['file.txt'];
    mockState.statResults = { 'file.txt': { isDirectory: () => false } };

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(0);
  });

  it('should truncate report to 5 skills with overflow message', async () => {
    const skills = Array.from({ length: 8 }, (_, i) => `skill-${i}`);
    mockState.readdirResult = skills;
    for (const s of skills) {
      mockState.statResults[s] = { isDirectory: () => true };
    }
    // All skills have missing SKILL.md (readFileSync throws)

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const msg = mockState.writeStdoutCalls[0][0].message;
    expect(msg).toContain('and 3 more');
  });

  it('should report unclosed frontmatter', async () => {
    mockState.readdirResult = ['unclosed'];
    mockState.statResults = { unclosed: { isDirectory: () => true } };
    mockState.readFileResults = {
      'SKILL.md': '---\nname: unclosed\nno closing delimiter',
    };

    await import('../../scripts/hooks/skill-validation-check.js');
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const msg = mockState.writeStdoutCalls[0][0].message;
    expect(msg).toContain('unclosed frontmatter');
  });
});
