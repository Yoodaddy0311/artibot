import { afterEach, describe, expect, it } from 'vitest';
import {
  _buildKeywordIndex,
  _getKeywordIndex,
  _resetSkillCaches,
  createSkillsMiddleware,
} from '../../../lib/runtime/middleware/skills.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeIndex(entries) {
  return entries.map((e) => ({
    name: e.name ?? e.dirName,
    dirName: e.dirName,
    triggers: e.triggers ?? [],
    path: `/fake/skills/${e.dirName}/SKILL.md`,
  }));
}

function makeState(overrides = {}) {
  return {
    context: {
      intent: {
        best: 'action:implement',
        commands: ['/implement'],
        agents: ['frontend-developer'],
        intents: ['action:implement'],
        ambiguous: false,
      },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildKeywordIndex unit tests
// ---------------------------------------------------------------------------

describe('buildKeywordIndex', () => {
  it('indexes name, dirName, and triggers as lowercase keys', () => {
    const index = makeFakeIndex([
      { dirName: 'tdd-workflow', name: 'TDD Workflow', triggers: ['test', 'tdd'] },
    ]);
    const kwIndex = _buildKeywordIndex(index);

    expect(kwIndex.get('tdd workflow')).toBeDefined();
    expect(kwIndex.get('tdd workflow').has('tdd-workflow')).toBe(true);
    expect(kwIndex.get('tdd-workflow')).toBeDefined();
    expect(kwIndex.get('test')).toBeDefined();
    expect(kwIndex.get('tdd')).toBeDefined();
  });

  it('maps multiple skills to the same trigger keyword', () => {
    const index = makeFakeIndex([
      { dirName: 'skill-a', name: 'Skill A', triggers: ['deploy'] },
      { dirName: 'skill-b', name: 'Skill B', triggers: ['deploy', 'ci'] },
    ]);
    const kwIndex = _buildKeywordIndex(index);

    const deploySkills = kwIndex.get('deploy');
    expect(deploySkills.size).toBe(2);
    expect(deploySkills.has('skill-a')).toBe(true);
    expect(deploySkills.has('skill-b')).toBe(true);
  });

  it('returns empty Map for empty index', () => {
    const kwIndex = _buildKeywordIndex([]);
    expect(kwIndex.size).toBe(0);
  });

  it('handles entries with no triggers', () => {
    const index = makeFakeIndex([
      { dirName: 'no-triggers', name: 'No Triggers', triggers: [] },
    ]);
    const kwIndex = _buildKeywordIndex(index);

    // name and dirName should still be indexed
    expect(kwIndex.get('no triggers')).toBeDefined();
    expect(kwIndex.get('no-triggers')).toBeDefined();
    // Only 2 keys (name + dirName), no trigger keys
    expect(kwIndex.size).toBe(2);
  });

  it('deduplicates when name equals dirName', () => {
    const index = makeFakeIndex([
      { dirName: 'coding-standards', name: 'coding-standards', triggers: ['lint'] },
    ]);
    const kwIndex = _buildKeywordIndex(index);

    // 'coding-standards' appears as both name and dirName but produces one Set
    const entry = kwIndex.get('coding-standards');
    expect(entry.size).toBe(1);
    expect(entry.has('coding-standards')).toBe(true);
  });

  it('preserves original dirName casing in Set values', () => {
    const index = makeFakeIndex([
      { dirName: 'TDD-Workflow', name: 'tdd workflow', triggers: ['test'] },
    ]);
    const kwIndex = _buildKeywordIndex(index);

    // Keys are lowercased
    expect(kwIndex.has('tdd-workflow')).toBe(true);
    // Values preserve original casing
    expect(kwIndex.get('tdd-workflow').has('TDD-Workflow')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Keyword index caching and lifecycle
// ---------------------------------------------------------------------------

describe('keyword index lifecycle', () => {
  afterEach(() => {
    _resetSkillCaches();
  });

  it('_getKeywordIndex returns null before any matching', () => {
    expect(_getKeywordIndex()).toBeNull();
  });

  it('_resetSkillCaches clears keyword index', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 5 },
    });
    const state = makeState();
    await mw(state);

    // After lazy loading, keyword index should exist (if index loaded)
    // Reset should clear it
    _resetSkillCaches();
    expect(_getKeywordIndex()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchSkills via middleware — behavioral compatibility
// ---------------------------------------------------------------------------

describe('keyword-indexed matchSkills compatibility', () => {
  afterEach(() => {
    _resetSkillCaches();
  });

  it('existing lazy-loading tests still pass (smoke test)', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 5 },
    });
    const state = makeState({
      context: {
        intent: {
          best: 'action:implement',
          commands: ['/implement'],
          agents: [],
          intents: ['action:implement'],
        },
      },
    });
    const result = await mw(state);

    expect(result.context.skills.source).toBe('lazy-loaded');
    expect(result.context.skills.indexSize).toBeGreaterThan(0);
  });

  it('maxConcurrent limit is respected with keyword index', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 1 },
    });
    const state = makeState({
      context: {
        intent: {
          best: 'action:implement',
          commands: ['/implement'],
          agents: [],
          intents: ['action:implement'],
        },
      },
    });
    const result = await mw(state);

    expect(result.context.skills.loaded.length).toBeLessThanOrEqual(1);
  });

  it('keyword index is built only once across multiple calls', async () => {
    const mw = createSkillsMiddleware({
      lazyLoading: { enabled: true, maxConcurrent: 5 },
    });

    await mw(makeState());
    const index1 = _getKeywordIndex();
    expect(index1).not.toBeNull();

    await mw(makeState());
    const index2 = _getKeywordIndex();

    // Same reference — index was reused, not rebuilt
    expect(index2).toBe(index1);
  });

  it('non-lazy mode does not build keyword index', async () => {
    const mw = createSkillsMiddleware();
    await mw(makeState());

    expect(_getKeywordIndex()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('keyword index edge cases', () => {
  it('handles index entries with mixed-case triggers', () => {
    const index = makeFakeIndex([
      { dirName: 'auth-flow', name: 'Auth Flow', triggers: ['OAuth', 'JWT', 'authentication'] },
    ]);
    const kwIndex = _buildKeywordIndex(index);

    expect(kwIndex.get('oauth').has('auth-flow')).toBe(true);
    expect(kwIndex.get('jwt').has('auth-flow')).toBe(true);
    expect(kwIndex.get('authentication').has('auth-flow')).toBe(true);
  });

  it('handles large index without errors', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      dirName: `skill-${i}`,
      name: `Skill ${i}`,
      triggers: [`trigger-${i}`, `kw-${i % 10}`],
    }));
    const index = makeFakeIndex(entries);
    const kwIndex = _buildKeywordIndex(index);

    // 200 names + 200 dirNames + triggers (200 unique + 10 shared) = ~410 keys
    expect(kwIndex.size).toBeGreaterThan(200);
    // Shared trigger should map to multiple skills
    expect(kwIndex.get('kw-0').size).toBe(20); // 200 / 10
  });

  it('handles entries with duplicate triggers gracefully', () => {
    const index = makeFakeIndex([
      { dirName: 'skill-x', name: 'Skill X', triggers: ['test', 'test', 'test'] },
    ]);
    const kwIndex = _buildKeywordIndex(index);

    // 'test' key should exist with one skill
    expect(kwIndex.get('test').size).toBe(1);
  });
});
