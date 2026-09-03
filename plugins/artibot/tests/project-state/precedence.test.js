import { describe, expect, it } from 'vitest';
import {
  comparePrecedence,
  conflictAction,
  hasVerification,
  PRECEDENCE_ORDER,
  precedenceRank,
  resolveConflict,
} from '../../lib/project-state/precedence.js';

const verified = (source, value) => ({ source, value, verifiedBy: `measured ${source}` });

describe('the 8 tiers', () => {
  it('matches v1.1 §02 order exactly', () => {
    expect([...PRECEDENCE_ORDER]).toEqual([
      'verified-repo-state',
      'state-yaml',
      'intent-md',
      'plan-md',
      'adr',
      'historical-outcome',
      'memory',
      'old-runtime-logs',
    ]);
  });

  it('ranks from 1 to 8', () => {
    expect(PRECEDENCE_ORDER.map(precedenceRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('returns null for an id outside the table', () => {
    expect(precedenceRank('git-log')).toBeNull();
  });

  it('refuses to compare an unknown id rather than ranking it last', () => {
    expect(() => comparePrecedence('memory', 'git-log')).toThrow(/unknown source/);
  });
});

describe('verifiedBy is required — fail-closed', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
    ['empty array', []],
    ['array with a blank entry', ['ok', '']],
    ['a number', 1],
  ])('rejects %s', (_label, value) => {
    expect(hasVerification(value)).toBe(false);
  });

  it('accepts a non-empty string and a non-empty string array', () => {
    expect(hasVerification('git status --porcelain')).toBe(true);
    expect(hasVerification(['a.js:1', 'b.js:2'])).toBe(true);
  });

  it('skips an unverified tier-1 claim instead of demoting it', () => {
    const out = resolveConflict([
      { source: 'verified-repo-state', value: 'file exists' },
      verified('state-yaml', 'executing'),
    ]);
    expect(out.winner.source).toBe('state-yaml');
    expect(out.skipped).toEqual([{ source: 'verified-repo-state', reason: 'unverified' }]);
    expect(out.warnings.map((w) => w.code)).toContain('unverified-source-skipped');
  });

  it('resolves nothing when no candidate carries evidence', () => {
    const out = resolveConflict([{ source: 'memory', value: 'x' }, { source: 'adr', value: 'y' }]);
    expect(out.resolved).toBe(false);
    expect(out.winner).toBeNull();
    expect(out.warnings.map((w) => w.code)).toContain('no-verified-candidate');
  });

  it('skips an unknown source rather than ranking it last', () => {
    const out = resolveConflict([
      { source: 'slack-thread', value: 'x', verifiedBy: 'read it' },
      verified('memory', 'y'),
    ]);
    expect(out.winner.source).toBe('memory');
    expect(out.skipped).toEqual([{ source: 'slack-thread', reason: 'unknown-source' }]);
  });
});

describe('resolution', () => {
  it('the highest verified tier wins regardless of input order', () => {
    const out = resolveConflict([
      verified('old-runtime-logs', 'stale'),
      verified('verified-repo-state', 'live'),
      verified('plan-md', 'planned'),
    ]);
    expect(out.winner.source).toBe('verified-repo-state');
    expect(out.rank).toBe(1);
    expect(out.losers.map((c) => c.source)).toEqual(['plan-md', 'old-runtime-logs']);
  });

  it('does not warn when tier 1 wins', () => {
    const out = resolveConflict([verified('verified-repo-state', 'live')]);
    expect(out.warnings).toEqual([]);
  });

  it('warns when a lower tier wins, naming the empty upper slot', () => {
    const out = resolveConflict([verified('plan-md', 'planned')]);
    expect(out.resolved).toBe(true);
    expect(out.rank).toBe(4);
    const warning = out.warnings.find((w) => w.code === 'lower-source-won');
    expect(warning.message).toMatch(/tiers 1-3 were absent or unverified/);
  });

  it('keeps the first of two entries for one source and warns', () => {
    const out = resolveConflict([
      { source: 'memory', value: 'first', verifiedBy: 'a' },
      { source: 'memory', value: 'second', verifiedBy: 'b' },
    ]);
    expect(out.winner.value).toBe('first');
    expect(out.warnings.map((w) => w.code)).toContain('duplicate-source');
  });

  it('rejects a non-array argument', () => {
    expect(() => resolveConflict(null)).toThrow(/must be an array/);
  });
});

describe('conflictAction — the two directions design §3.1 rules on', () => {
  it('a verified repo beating the intent is a completion judgement, not an intent edit', () => {
    const out = conflictAction('verified-repo-state', 'intent-md');
    expect(out.action).toBe('record-completion');
    expect(out.rationale).toMatch(/do not edit intent\.md/);
  });

  it('the intent beating the plan revises the plan', () => {
    expect(conflictAction('intent-md', 'plan-md').action).toBe('revise-plan');
  });

  it('returns null for a pair the design does not rule on, rather than guessing', () => {
    expect(conflictAction('adr', 'memory')).toBeNull();
    expect(conflictAction('intent-md', 'verified-repo-state')).toBeNull();
  });
});
