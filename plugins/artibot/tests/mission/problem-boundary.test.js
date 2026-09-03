/**
 * lib/mission/problem-boundary.js — the 5-way classification and the
 * finding-disposition asymmetry.
 *
 * WHAT THESE TESTS CANNOT SEE
 * ---------------------------
 *  - Evidence is checked for PRESENCE, never for truth. A candidate carrying a
 *    fabricated `file:line` classifies as upstream in these tests exactly as it
 *    would in production; nothing here can tell the difference.
 *  - No candidate discovery is exercised, because the module does none. A real
 *    causal edge that nobody put in the candidate list is invisible in both.
 */

import { describe, expect, it } from 'vitest';

import {
  BOUNDARY_CLASSES,
  buildScope,
  CANDIDATE_RELATIONS,
  classifyBoundary,
  classifyFinding,
  FINDING_DISPOSITIONS,
} from '../../lib/mission/problem-boundary.js';

const context = { requestedTarget: ['lib/split'] };

describe('classifyBoundary()', () => {
  it('exposes the five classes of design 09', () => {
    expect(BOUNDARY_CLASSES).toEqual([
      'direct', 'upstream', 'downstream', 'adjacent', 'unrelated',
    ]);
    expect(CANDIDATE_RELATIONS).toEqual(['causes', 'affected-by', 'related']);
  });

  it('direct — the subject is the requested target', () => {
    const result = classifyBoundary({ subject: 'lib/split' }, context);
    expect(result.class).toBe('direct');
    expect(result.matchedTarget).toBe('lib/split');
  });

  it('direct — the subject sits inside the requested target', () => {
    expect(classifyBoundary({ subject: 'lib/split/plan.js' }, context).class).toBe('direct');
  });

  it('direct — a bare word matches a path target by token overlap', () => {
    expect(classifyBoundary({ subject: 'split' }, context).class).toBe('direct');
  });

  it('upstream — an evidenced cause', () => {
    const result = classifyBoundary(
      { subject: 'lib/core/config.js', relation: 'causes', evidence: ['lib/core/config.js:88'] },
      context,
    );
    expect(result.class).toBe('upstream');
  });

  it('downstream — an evidenced regression risk', () => {
    const result = classifyBoundary(
      { subject: 'lib/supervisor/contracts.js', relation: 'affected-by', evidence: 'contracts.js:12' },
      context,
    );
    expect(result.class).toBe('downstream');
  });

  it('adjacent — a causal claim WITHOUT evidence is demoted, never promoted', () => {
    const result = classifyBoundary(
      { subject: 'lib/core/config.js', relation: 'causes' },
      context,
    );
    expect(result.class).toBe('adjacent');
    expect(result.reason).toMatch(/without evidence/);
  });

  it('adjacent — an empty evidence array does not count as evidence', () => {
    expect(classifyBoundary(
      { subject: 'x', relation: 'causes', evidence: ['   '] },
      context,
    ).class).toBe('adjacent');
  });

  it('adjacent — "related" makes no causal claim', () => {
    expect(classifyBoundary({ subject: 'docs/notes.md', relation: 'related' }, context).class)
      .toBe('adjacent');
  });

  it('unrelated — no relation asserted, and unknown relations fail closed', () => {
    expect(classifyBoundary({ subject: 'lib/tui/theme.js' }, context).class).toBe('unrelated');
    expect(classifyBoundary({ subject: 'lib/tui/theme.js', relation: 'vibes' }, context).class)
      .toBe('unrelated');
  });

  it('unrelated — an empty subject cannot match anything', () => {
    expect(classifyBoundary({}, context).class).toBe('unrelated');
  });
});

describe('buildScope()', () => {
  const result = buildScope({
    requestedTarget: ['lib/split'],
    candidates: [
      { subject: 'lib/split/plan.js' },
      { subject: 'lib/core/config.js', relation: 'causes', evidence: ['config.js:1'] },
      { subject: 'lib/supervisor/contracts.js', relation: 'affected-by', evidence: ['c.js:2'] },
      { subject: 'docs/notes.md', relation: 'related' },
      { subject: 'lib/tui/theme.js' },
    ],
  });

  it('projects direct / upstream / downstream into scope', () => {
    expect(result.scope.requested_target).toEqual(['lib/split']);
    expect(result.scope.direct).toEqual(['lib/split/plan.js']);
    expect(result.scope.upstream).toEqual(['lib/core/config.js']);
    expect(result.scope.downstream).toEqual(['lib/supervisor/contracts.js']);
  });

  it('records unrelated as scope.excluded rather than dropping it', () => {
    expect(result.scope.excluded).toEqual(['lib/tui/theme.js']);
  });

  it('keeps ADJACENT out of scope — optional is not scope expansion', () => {
    expect(result.classified.adjacent.map((c) => c.subject)).toEqual(['docs/notes.md']);
    expect(JSON.stringify(result.scope)).not.toContain('docs/notes.md');
  });

  it('survives an empty candidate list with the target intact', () => {
    const empty = buildScope({ requestedTarget: ['split'] });
    expect(empty.scope.requested_target).toEqual(['split']);
    expect(empty.scope.direct).toEqual([]);
  });
});

describe('classifyFinding() — the asymmetry', () => {
  const contract = {
    explicit_requests: [{ text: 'split 을 업그레이드', span: { start: 0, end: 13 } }],
  };
  const evidence = ['lib/split/plan.js:42'];

  it('exposes the three dispositions', () => {
    expect(FINDING_DISPOSITIONS).toEqual(['plan-revision', 'intent-revision', 'rejected']);
  });

  it('WIDENING scope is a plan revision and the worker keeps going', () => {
    const result = classifyFinding({ kind: 'widen-scope', evidence }, contract);
    expect(result.disposition).toBe('plan-revision');
    expect(result.blocksWorker).toBe(false);
  });

  it('NARROWING an explicit request is an intent revision and stops the worker', () => {
    const result = classifyFinding({ kind: 'narrow-explicit', evidence }, contract);
    expect(result.disposition).toBe('intent-revision');
    expect(result.blocksWorker).toBe(true);
    expect(result.reason).toMatch(/1 explicit request/);
  });

  it('REPLACING an explicit request is likewise an intent revision', () => {
    expect(classifyFinding({ kind: 'replace-explicit', evidence }, contract).disposition)
      .toBe('intent-revision');
  });

  it('changing success.functional is an intent revision', () => {
    expect(classifyFinding({ kind: 'change-success', evidence }, contract).disposition)
      .toBe('intent-revision');
  });

  it('a finding with NO evidence is rejected — inconvenience is not a reason', () => {
    const result = classifyFinding({ kind: 'replace-explicit' }, contract);
    expect(result.disposition).toBe('rejected');
    expect(result.reason).toMatch(/no evidence/);
  });

  it('an unknown finding kind is rejected, not guessed', () => {
    expect(classifyFinding({ kind: 'improve-everything', evidence }, contract).disposition)
      .toBe('rejected');
    expect(classifyFinding({ evidence }, contract).disposition).toBe('rejected');
  });

  it('works without a contract (reporting detail is simply omitted)', () => {
    const result = classifyFinding({ kind: 'narrow-explicit', evidence });
    expect(result.disposition).toBe('intent-revision');
    expect(result.reason).not.toMatch(/explicit request\(s\)/);
  });
});
