import { describe, expect, it } from 'vitest';
import { EFFORT_POLICY, getEffortForCommand } from '../../lib/cognitive/router.js';

const VALID_LEVELS = new Set(['max', 'xhigh', 'high', 'medium', 'low']);

describe('EFFORT_POLICY constant', () => {
  it('is a frozen object', () => {
    expect(Object.isFrozen(EFFORT_POLICY)).toBe(true);
  });

  it('classifies deepest multi-agent orchestration commands as max', () => {
    const maxKeys = ['orchestrate', 'swarm', 'autopilot'];
    for (const key of maxKeys) {
      expect(EFFORT_POLICY[key]).toBe('max');
    }
  });

  it('classifies agentic-coding / multi-file commands as xhigh', () => {
    const xhighKeys = [
      'implement', 'team', 'tdd', 'build-fix', 'cleanup',
      'refactor-clean', 'spawn',
    ];
    for (const key of xhighKeys) {
      expect(EFFORT_POLICY[key]).toBe('xhigh');
    }
  });

  it('classifies focused-reasoning / review / design commands as high', () => {
    const highKeys = [
      'code-review', 'adversarial-review', 'review',
      'plan', 'troubleshoot', 'analyze', 'design',
      'estimate', 'spec', 'verify', 'improve', 'repo',
    ];
    for (const key of highKeys) {
      expect(EFFORT_POLICY[key]).toBe('high');
    }
  });

  it('classifies balanced content / domain commands as medium', () => {
    const mediumKeys = [
      'daily', 'load', 'index', 'explain', 'document',
      'checkpoint', 'learn', 'git', 'playbook', 'build', 'ship',
      'test', 'visual-check',
      'ad', 'analytics', 'content', 'crm', 'cro', 'email',
      'excel', 'marketing', 'mkt', 'ppt', 'seo', 'social',
    ];
    for (const key of mediumKeys) {
      expect(EFFORT_POLICY[key]).toBe('medium');
    }
  });

  it('classifies cost-saving / lookup / config commands as low', () => {
    const lowKeys = [
      'permissions', 'update', 'quickstart',
      'sc', 'sdk', 'setup', 'task', 'assemble', 'codex',
    ];
    for (const key of lowKeys) {
      expect(EFFORT_POLICY[key]).toBe('low');
    }
  });

  it('covers every slash command with a classification (56 total)', () => {
    expect(Object.keys(EFFORT_POLICY)).toHaveLength(56);
  });

  it('uses only the five valid effort levels for every value', () => {
    for (const [key, value] of Object.entries(EFFORT_POLICY)) {
      expect(VALID_LEVELS.has(value), `key=${key} value=${value}`).toBe(true);
    }
  });
});

describe('getEffortForCommand()', () => {
  it('returns xhigh for implement', () => {
    expect(getEffortForCommand('implement')).toBe('xhigh');
  });

  it('normalizes a leading slash (/implement -> xhigh)', () => {
    expect(getEffortForCommand('/implement')).toBe('xhigh');
  });

  it('returns high for code-review', () => {
    expect(getEffortForCommand('code-review')).toBe('high');
  });

  it('returns medium for daily', () => {
    expect(getEffortForCommand('daily')).toBe('medium');
  });

  it('returns low for quickstart', () => {
    expect(getEffortForCommand('quickstart')).toBe('low');
  });

  it('falls back to medium for unknown commands', () => {
    expect(getEffortForCommand('unknown-command')).toBe('medium');
  });

  it('falls back to medium for empty string', () => {
    expect(getEffortForCommand('')).toBe('medium');
  });

  it('falls back to medium for null (defensive)', () => {
    expect(getEffortForCommand(null)).toBe('medium');
  });

  it('falls back to medium for undefined (defensive)', () => {
    expect(getEffortForCommand(undefined)).toBe('medium');
  });

  it('trims whitespace around input (" implement " -> xhigh)', () => {
    expect(getEffortForCommand(' implement ')).toBe('xhigh');
  });

  it('is case-sensitive — capitalized input falls back to medium', () => {
    expect(getEffortForCommand('Implement')).toBe('medium');
  });

  it('does not throw on non-string inputs and returns medium', () => {
    expect(() => getEffortForCommand(42)).not.toThrow();
    expect(getEffortForCommand(42)).toBe('medium');
    expect(() => getEffortForCommand({})).not.toThrow();
    expect(getEffortForCommand({})).toBe('medium');
  });
});
