/**
 * Tests for lib/autopilot/template-loader.js (v4.10.0 Track G).
 * Verifies each of the 3 packaged contract templates loads and parses
 * cleanly, and that loadTemplate honours validation + caching.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTemplateCache,
  getTemplatesDir,
  listTemplates,
  loadTemplate,
} from '../../lib/autopilot/template-loader.js';
import { validateGoalContract } from '../../lib/autopilot/goal-schema.js';

beforeEach(() => {
  clearTemplateCache();
});

describe('getTemplatesDir', () => {
  it('resolves to an absolute path ending with contract-templates', () => {
    const dir = getTemplatesDir();
    expect(dir.length).toBeGreaterThan(0);
    expect(dir.endsWith('contract-templates')).toBe(true);
  });
});

describe('listTemplates', () => {
  it('lists the 3 packaged templates sorted alphabetically', () => {
    const names = listTemplates();
    expect(names).toEqual(['bugfix', 'feature', 'refactor']);
  });
});

describe('loadTemplate — validation', () => {
  it('throws TypeError on invalid name (path traversal attempt)', () => {
    expect(() => loadTemplate('../etc/passwd')).toThrow(TypeError);
    expect(() => loadTemplate('')).toThrow(TypeError);
    expect(() => loadTemplate(null)).toThrow(TypeError);
  });

  it('throws Error on missing template file', () => {
    expect(() => loadTemplate('does-not-exist')).toThrow(/template not found/);
  });
});

describe('loadTemplate — bugfix', () => {
  it('loads the bugfix template with expected goal-contract fields', () => {
    const t = loadTemplate('bugfix');
    expect(t.name).toBe('bugfix');
    expect(typeof t.objective).toBe('string');
    expect(typeof t.stoppingCondition).toBe('string');
    expect(Array.isArray(t.forbiddenChanges)).toBe(true);
    expect(typeof t.maxIterations).toBe('number');
  });

  it('produces a valid Goal Contract after validation', () => {
    const t = loadTemplate('bugfix');
    const r = validateGoalContract(t);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('loadTemplate — refactor', () => {
  it('loads the refactor template and has a higher iteration ceiling', () => {
    const t = loadTemplate('refactor');
    expect(t.name).toBe('refactor');
    expect(t.maxIterations).toBeGreaterThanOrEqual(5);
  });

  it('produces a valid Goal Contract', () => {
    const t = loadTemplate('refactor');
    const r = validateGoalContract(t);
    expect(r.valid).toBe(true);
  });
});

describe('loadTemplate — feature', () => {
  it('loads the feature template with a CI validation command', () => {
    const t = loadTemplate('feature');
    expect(t.name).toBe('feature');
    expect(t.validationCommand).toMatch(/ci|test|build/);
  });

  it('produces a valid Goal Contract', () => {
    const t = loadTemplate('feature');
    const r = validateGoalContract(t);
    expect(r.valid).toBe(true);
  });
});

describe('loadTemplate — caching', () => {
  it('returns the same object reference on repeated calls', () => {
    const a = loadTemplate('bugfix');
    const b = loadTemplate('bugfix');
    expect(a).toBe(b);
  });

  it('returns a fresh reference after clearTemplateCache()', () => {
    const a = loadTemplate('bugfix');
    clearTemplateCache();
    const b = loadTemplate('bugfix');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
