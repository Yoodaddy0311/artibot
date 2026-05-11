/**
 * Tests for lib/autopilot/prd-parser.js (v4.6.0 Phase 1).
 * Covers Goal Contract extraction, backward compat (legacy PRDs),
 * malformed JSON, and schema-failure paths.
 */

import { describe, expect, it } from 'vitest';
import { parseGoalContract } from '../../lib/autopilot/prd-parser.js';

const VALID_CONTRACT_BLOCK = `## 2.5 Goal Contract

Machine-readable stopping condition.

\`\`\`json
{
  "objective": "migrate API to v2",
  "stoppingCondition": "all endpoints return 200 under v2 schema",
  "validationCommand": "npm run ci",
  "forbiddenChanges": ["docs/PRD/**"],
  "maxIterations": 3
}
\`\`\`

`;

const LEGACY_PRD = `# PRD: legacy task

## 1. 배경

기존 PRD 형식 — Goal Contract 없음.

## 2. 목표

| ID | 목표 |
|----|------|
| G1 | do something |

## 3. 범위

본 작업 디렉토리 내부만.
`;

describe('parseGoalContract — backward compatibility', () => {
  it('returns found=false for a legacy PRD with no Goal Contract section', () => {
    const r = parseGoalContract(LEGACY_PRD);
    expect(r.found).toBe(false);
    expect(r.contract).toBeNull();
    expect(r.errors).toEqual([]);
  });

  it('returns found=false for empty string input', () => {
    const r = parseGoalContract('');
    expect(r.found).toBe(false);
  });

  it('returns found=false for non-string input', () => {
    const r1 = parseGoalContract(null);
    const r2 = parseGoalContract(42);
    const r3 = parseGoalContract(undefined);
    expect(r1.found).toBe(false);
    expect(r2.found).toBe(false);
    expect(r3.found).toBe(false);
  });
});

describe('parseGoalContract — happy path', () => {
  it('extracts and validates a well-formed Goal Contract block', () => {
    const r = parseGoalContract(VALID_CONTRACT_BLOCK);
    expect(r.found).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.contract).toEqual({
      objective: 'migrate API to v2',
      stoppingCondition: 'all endpoints return 200 under v2 schema',
      validationCommand: 'npm run ci',
      forbiddenChanges: ['docs/PRD/**'],
      maxIterations: 3,
    });
  });

  it('tolerates a section heading without a numeric prefix', () => {
    const md = `## Goal Contract

\`\`\`json
{ "objective": "X", "stoppingCondition": "Y" }
\`\`\`
`;
    const r = parseGoalContract(md);
    expect(r.found).toBe(true);
    expect(r.contract.objective).toBe('X');
  });

  it('tolerates a deeper section numbering (e.g. 3.1.2)', () => {
    const md = `### 3.1.2 Goal Contract

\`\`\`json
{ "objective": "X", "stoppingCondition": "Y" }
\`\`\`
`;
    const r = parseGoalContract(md);
    expect(r.found).toBe(true);
  });
});

describe('parseGoalContract — malformed input', () => {
  it('reports malformed JSON without crashing', () => {
    const md = `## 2.5 Goal Contract

\`\`\`json
{ "objective": "X", "stoppingCondition": MISSING_QUOTES }
\`\`\`
`;
    const r = parseGoalContract(md);
    expect(r.found).toBe(true);
    expect(r.contract).toBeNull();
    expect(r.errors[0]).toMatch(/JSON parse error/);
  });

  it('reports empty JSON block', () => {
    const md = `## 2.5 Goal Contract

\`\`\`json

\`\`\`
`;
    const r = parseGoalContract(md);
    expect(r.found).toBe(true);
    expect(r.contract).toBeNull();
    expect(r.errors[0]).toMatch(/empty/);
  });

  it('reports schema-validation failures (e.g. missing required field)', () => {
    const md = `## 2.5 Goal Contract

\`\`\`json
{ "objective": "X" }
\`\`\`
`;
    const r = parseGoalContract(md);
    expect(r.found).toBe(true);
    expect(r.contract).toBeNull();
    expect(r.errors.some((e) => /stoppingCondition/.test(e))).toBe(true);
  });

  it('reports schema-validation failures (maxIterations > hard cap)', () => {
    const md = `## 2.5 Goal Contract

\`\`\`json
{ "objective": "X", "stoppingCondition": "Y", "maxIterations": 100 }
\`\`\`
`;
    const r = parseGoalContract(md);
    expect(r.found).toBe(true);
    expect(r.contract).toBeNull();
    expect(r.errors.some((e) => /hard cap/.test(e))).toBe(true);
  });
});

describe('parseGoalContract — non-greedy matching', () => {
  it('stops at the FIRST closing fence after the heading, not the last fence in the doc', () => {
    const md = `## 2.5 Goal Contract

\`\`\`json
{ "objective": "first", "stoppingCondition": "Y" }
\`\`\`

## 3. 범위

Some code sample below — should NOT pollute parser:

\`\`\`json
{ "objective": "second", "stoppingCondition": "Z" }
\`\`\`
`;
    const r = parseGoalContract(md);
    expect(r.found).toBe(true);
    expect(r.contract.objective).toBe('first');
  });
});
