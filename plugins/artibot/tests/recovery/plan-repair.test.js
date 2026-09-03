/**
 * `lib/recovery/plan-repair` — review findings -> plan tasks.
 *
 * The severity filter is asserted against `review-output.schema.json` rather
 * than retyped: the module only auto-writes tasks for the severities the
 * schema makes `suggestion` mandatory for, and that is the property under test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ACTIONABLE_SEVERITIES, repairPlan } from '../../lib/recovery/plan-repair.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEW_SCHEMA = path.join(PLUGIN_ROOT, 'schemas', 'review-output.schema.json');

const basePlan = () => ({
  schema_version: 1,
  mission_id: 'M-20260902-001',
  revision: 4,
  tasks: [
    { id: 'T-01', mission_id: 'M-20260902-001', status: 'done', title: 'existing work' },
  ],
});

const critical = {
  severity: 'critical',
  file: 'lib/core/io.js',
  line: 42,
  description: 'path join drops the drive letter on Windows',
  suggestion: 'use path.resolve',
};

const high = {
  severity: 'high',
  file: 'lib/core/config.js',
  line: 7,
  description: 'config read is not fail-closed',
  suggestion: 'throw on a missing key',
};

describe('severity filter comes from the review schema', () => {
  it('ACTIONABLE_SEVERITIES is exactly the set that requires a suggestion', () => {
    const schema = JSON.parse(readFileSync(REVIEW_SCHEMA, 'utf8'));
    const rule = schema.definitions.finding.allOf.find(
      (entry) => entry.then?.required?.includes('suggestion'),
    );
    expect(rule).toBeDefined();
    expect([...ACTIONABLE_SEVERITIES].sort())
      .toEqual([...rule.if.properties.severity.enum].sort());
  });

  it('critical and high become tasks', () => {
    const { plan, changed } = repairPlan({ plan: basePlan(), findings: [critical, high] });
    expect(plan.tasks).toHaveLength(3);
    expect(changed.filter((entry) => entry.type === 'task-added')).toHaveLength(2);
  });

  it('medium, low and info do not', () => {
    const findings = ['medium', 'low', 'info'].map((severity) => ({
      severity,
      file: 'a.js',
      line: 1,
      description: `a ${severity} note`,
    }));
    const { plan, changed } = repairPlan({ plan: basePlan(), findings });
    expect(plan.tasks).toHaveLength(1);
    expect(changed).toEqual([]);
  });

  it('a critical finding with no description is skipped, not invented', () => {
    const findings = [{ severity: 'critical', file: 'a.js', line: 1 }];
    expect(repairPlan({ plan: basePlan(), findings }).changed).toEqual([]);
  });
});

describe('what a repair task carries', () => {
  it('records the finding verbatim and queues the task', () => {
    const { plan } = repairPlan({ plan: basePlan(), findings: [critical] });
    const added = plan.tasks.at(-1);
    expect(added.status).toBe('queued');
    expect(added.origin).toBe('plan-repair');
    expect(added.mission_id).toBe('M-20260902-001');
    expect(added.finding).toEqual({
      severity: 'critical',
      file: 'lib/core/io.js',
      line: 42,
      description: 'path join drops the drive letter on Windows',
      suggestion: 'use path.resolve',
    });
  });

  it('names the location in the title', () => {
    const { plan } = repairPlan({ plan: basePlan(), findings: [critical] });
    expect(plan.tasks.at(-1).title).toContain('lib/core/io.js:42');
  });

  it('falls back to a stated placeholder when the finding has no file', () => {
    const findings = [{ severity: 'high', description: 'no location', suggestion: 'fix' }];
    const { plan } = repairPlan({ plan: basePlan(), findings });
    expect(plan.tasks.at(-1).title).toContain('unspecified location');
    expect(plan.tasks.at(-1).finding.file).toBeNull();
    expect(plan.tasks.at(-1).finding.line).toBeNull();
  });

  it('omits mission_id when the plan carries none', () => {
    const plan = { revision: 1, tasks: [] };
    const result = repairPlan({ plan, findings: [critical] });
    expect(result.plan.tasks[0]).not.toHaveProperty('mission_id');
  });

  it('records a null suggestion rather than fabricating one', () => {
    const findings = [{ severity: 'high', file: 'a.js', line: 2, description: 'no suggestion' }];
    const { plan } = repairPlan({ plan: basePlan(), findings });
    expect(plan.tasks.at(-1).finding.suggestion).toBeNull();
  });
});

describe('ids are content-derived, so repair is idempotent', () => {
  it('the same finding produces the same id across calls', () => {
    const a = repairPlan({ plan: basePlan(), findings: [critical] });
    const b = repairPlan({ plan: basePlan(), findings: [critical] });
    expect(a.plan.tasks.at(-1).id).toBe(b.plan.tasks.at(-1).id);
    expect(a.plan.tasks.at(-1).id).toMatch(/^T-REPAIR-[0-9a-f]{8}$/);
  });

  it('a second pass over an already-repaired plan changes nothing', () => {
    const first = repairPlan({ plan: basePlan(), findings: [critical, high] });
    const second = repairPlan({ plan: first.plan, findings: [critical, high] });
    expect(second.changed).toEqual([]);
    expect(second.plan.tasks).toHaveLength(3);
    expect(second.plan.revision).toBe(first.plan.revision);
  });

  it('duplicate findings inside one call add one task', () => {
    const { plan, changed } = repairPlan({ plan: basePlan(), findings: [critical, critical] });
    expect(plan.tasks).toHaveLength(2);
    expect(changed.filter((entry) => entry.type === 'task-added')).toHaveLength(1);
  });

  it('a different finding still lands on the already-repaired plan', () => {
    const first = repairPlan({ plan: basePlan(), findings: [critical] });
    const second = repairPlan({ plan: first.plan, findings: [critical, high] });
    expect(second.plan.tasks).toHaveLength(3);
    expect(second.plan.revision).toBe(6);
  });

  it('a changed line number is a different finding', () => {
    const moved = { ...critical, line: 43 };
    const { plan } = repairPlan({ plan: basePlan(), findings: [critical, moved] });
    expect(plan.tasks).toHaveLength(3);
  });
});

describe('revision bookkeeping', () => {
  it('bumps once per call that changed something, and reports the bump', () => {
    const { plan, changed } = repairPlan({ plan: basePlan(), findings: [critical, high] });
    expect(plan.revision).toBe(5);
    expect(changed.at(-1)).toEqual({ type: 'revision-bumped', from: 4, to: 5 });
  });

  it('does not bump when nothing changed', () => {
    const { plan, changed } = repairPlan({ plan: basePlan(), findings: [] });
    expect(plan.revision).toBe(4);
    expect(changed).toEqual([]);
  });

  it('initialises a missing revision to 1', () => {
    const plan = { mission_id: 'M-20260902-001', tasks: [] };
    expect(repairPlan({ plan, findings: [critical] }).plan.revision).toBe(1);
  });
});

describe('existing tasks are never touched', () => {
  it('keeps them in place and unmodified', () => {
    const plan = basePlan();
    plan.tasks.push({ id: 'T-02', status: 'executing', title: 'in flight' });
    const result = repairPlan({ plan, findings: [critical] });
    expect(result.plan.tasks.slice(0, 2)).toEqual(plan.tasks);
    expect(result.changed.every((entry) => entry.type !== 'task-removed')).toBe(true);
  });

  it('appends rather than reorders', () => {
    const { plan } = repairPlan({ plan: basePlan(), findings: [critical] });
    expect(plan.tasks[0].id).toBe('T-01');
    expect(plan.tasks[1].id).toMatch(/^T-REPAIR-/);
  });
});

describe('purity', () => {
  it('does not mutate the input plan', () => {
    const plan = basePlan();
    const snapshot = JSON.stringify(plan);
    repairPlan({ plan, findings: [critical, high] });
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it('returns a plan that is not the same object', () => {
    const plan = basePlan();
    expect(repairPlan({ plan, findings: [] }).plan).not.toBe(plan);
  });

  it('does not mutate the findings', () => {
    const findings = [{ ...critical }];
    const snapshot = JSON.stringify(findings);
    repairPlan({ plan: basePlan(), findings });
    expect(JSON.stringify(findings)).toBe(snapshot);
  });

  it('is deterministic', () => {
    const a = repairPlan({ plan: basePlan(), findings: [critical, high] });
    const b = repairPlan({ plan: basePlan(), findings: [critical, high] });
    expect(a).toEqual(b);
  });
});

describe('fails closed on an unknown plan shape', () => {
  it.each([
    ['a missing plan', undefined],
    ['null', null],
    ['a string', 'plan.md'],
    ['an array', []],
  ])('throws on %s', (_label, plan) => {
    expect(() => repairPlan({ plan, findings: [critical] })).toThrow(TypeError);
  });

  it('throws when tasks is not an array', () => {
    expect(() => repairPlan({ plan: { tasks: {} } })).toThrow(/plan\.tasks/);
    expect(() => repairPlan({ plan: { revision: 1 } })).toThrow(/plan\.tasks/);
  });

  it('throws on a missing argument rather than returning an empty plan', () => {
    expect(() => repairPlan()).toThrow(TypeError);
  });

  it('tolerates malformed findings without throwing', () => {
    for (const findings of [undefined, null, 'nope', [null, 42, {}, { severity: 'critical' }]]) {
      expect(repairPlan({ plan: basePlan(), findings }).changed).toEqual([]);
    }
  });

  it('ignores malformed entries already in tasks when deduping', () => {
    const plan = basePlan();
    plan.tasks.push(null, 42, { noId: true });
    expect(() => repairPlan({ plan, findings: [critical] })).not.toThrow();
  });
});
