/**
 * Unit tests for the SKILL.md description linter (CSO compliance + ratchet).
 *
 * Covers:
 *   - extractDescription: inline + block-scalar frontmatter forms
 *   - countTriggers (R1): quotes, KO utterances, enumeration clauses
 *   - detectWorkflowSummary (R2): pipeline tokens, arrows, numbered steps, verb chains
 *   - lintDescription: rule composition + severities (R3 = warn)
 *   - runRatchet: new-violation fail / baseline pass / shrink (fixed) branches
 *   - Calibration: every detectWorkflowSummary branch is exercised by SYNTHETIC
 *     fixture strings, never by real skill descriptions. Real-skill coupling broke
 *     this twice (each time the ratchet legitimately fixed the example skill), so it
 *     is banned here — synthetic fixtures keep detector coverage live and stable.
 *
 * @module tests/ci/lint-skill-descriptions
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  countTriggers,
  detectWorkflowSummary,
  extractDescription,
  hasRedFlagsSection,
  lintAllSkills,
  lintDescription,
  redFlagViolatingSkillNames,
  runRatchet,
  violatingSkillNames,
} from '../../scripts/ci/lint-skill-descriptions.js';
import { getPluginRoot } from '../../scripts/ci/ci-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');

describe('extractDescription', () => {
  it('reads an inline quoted description', () => {
    const md = '---\nname: x\ndescription: "Use when foo, bar, baz happens."\n---\nbody';
    expect(extractDescription(md)).toBe('Use when foo, bar, baz happens.');
  });

  it('reads a block-scalar (|) multiline description', () => {
    const md = ['---', 'name: x', 'description: |', '  line one', '  line two', 'lang: [en]', '---'].join(
      '\n'
    );
    expect(extractDescription(md)).toBe('line one line two');
  });

  it('returns null when no frontmatter is present', () => {
    expect(extractDescription('no frontmatter here')).toBeNull();
  });

  it('returns null when description key is absent', () => {
    expect(extractDescription('---\nname: x\nlang: [en]\n---')).toBeNull();
  });
});

describe('countTriggers (R1)', () => {
  it('counts quoted utterances', () => {
    expect(countTriggers("Fires on 'fix this' and 'change that' and 'add foo'")).toBeGreaterThanOrEqual(3);
  });

  it('counts Korean colloquial request endings', () => {
    expect(countTriggers('이미지 만들어줘, 그림 그려줘, 색감 바꿔')).toBeGreaterThanOrEqual(3);
  });

  it('credits enumeration clauses with comma items (no quotes needed)', () => {
    const d = 'Use when user says quickstart, getting started, first run, onboarding.';
    expect(countTriggers(d)).toBeGreaterThanOrEqual(3);
  });

  it('returns a low count for a description with no activation signals', () => {
    expect(countTriggers('A guide describing internal architecture concepts.')).toBeLessThan(3);
  });
});

describe('detectWorkflowSummary (R2 / CSO)', () => {
  it('flags uppercase pipeline tokens', () => {
    expect(detectWorkflowSummary('Runs DECOMPOSE-EXECUTE-VERIFY internally.')).toContain('pipeline-token');
  });

  it('flags arrow chains', () => {
    expect(detectWorkflowSummary('Read -> change -> re-read flow.')).toContain('arrow-chain');
    expect(detectWorkflowSummary('분석 → 생성 → 검증')).toContain('arrow-chain');
  });

  it('flags numbered / phased steps', () => {
    expect(detectWorkflowSummary('Step 1 do this. Phase 2 do that.')).toContain('numbered-step');
  });

  it('flags a 3+ process-verb comma list', () => {
    expect(
      detectWorkflowSummary('every request is decomposed, executed, verified, and reported')
    ).toContain('verb-chain');
  });

  it('flags 3+ sentence-leading process verbs (prose pipeline)', () => {
    expect(
      detectWorkflowSummary('Transforms requests. Classifies ambiguity. Generates questions.')
    ).toContain('verb-chain');
  });

  it('flags Korean connective verb chains', () => {
    expect(detectWorkflowSummary('요청을 분해하고 실행하고 검증한다')).toContain('verb-chain');
  });

  it('does NOT flag a plain trigger enumeration', () => {
    expect(detectWorkflowSummary('Use when user asks to generate, create, or edit images.')).toEqual([]);
  });
});

describe('lintDescription', () => {
  it('passes a compliant description (≥3 triggers, no workflow)', () => {
    const d = "Use when user says 'build', 'create', 'make', or 'add' a feature.";
    expect(lintDescription(d).violations).toEqual([]);
  });

  it('emits R1 error when triggers are below floor', () => {
    const r = lintDescription('Internal architecture reference document.');
    expect(r.violations.some((v) => v.rule === 'R1' && v.severity === 'error')).toBe(true);
  });

  it('emits R2 error for a workflow summary', () => {
    const d = "Use when 'fix', 'add', 'change'. Decomposes, executes, and verifies each step.";
    expect(lintDescription(d).violations.some((v) => v.rule === 'R2' && v.severity === 'error')).toBe(true);
  });

  it('emits R3 as warn (not error) for over-length descriptions', () => {
    const long = "Use when user says 'go'. " + 'x'.repeat(1100);
    const r3 = lintDescription(long).violations.find((v) => v.rule === 'R3');
    expect(r3).toBeDefined();
    expect(r3.severity).toBe('warn');
  });

  it('treats a missing description as an R1 error', () => {
    expect(lintDescription(null).violations.some((v) => v.rule === 'R1')).toBe(true);
  });
});

describe('runRatchet', () => {
  it('FAILS when a skill not in baseline newly violates', () => {
    const r = runRatchet(['alpha', 'beta'], ['alpha']);
    expect(r.pass).toBe(false);
    expect(r.newViolations).toEqual(['beta']);
  });

  it('PASSES when all current violations are baselined', () => {
    const r = runRatchet(['alpha', 'beta'], ['alpha', 'beta', 'gamma']);
    expect(r.pass).toBe(true);
    expect(r.newViolations).toEqual([]);
    expect(r.stillViolating.sort()).toEqual(['alpha', 'beta']);
  });

  it('reports fixed skills to remove from baseline (shrink branch)', () => {
    const r = runRatchet(['alpha'], ['alpha', 'beta']);
    expect(r.pass).toBe(true);
    expect(r.fixed).toEqual(['beta']);
  });
});

// Detector branch calibration — SYNTHETIC FIXTURES ONLY. Do NOT couple these
// assertions to real skill descriptions: skill content is mutable, and a
// legitimate description fix would silently break detector coverage. That coupling
// already broke twice (vibe-coding/clarify, then report-generation/tdd-workflow/daily,
// each fixed by the description-lint ratchet). Synthetic strings exercise every
// detectWorkflowSummary branch directly and never go stale.
describe('detectWorkflowSummary branch coverage (synthetic fixtures)', () => {
  it('flags a 3+ procedural verb chain (verb-chain branch)', () => {
    const desc = 'Decomposes the request, executes each step, and verifies the result.';
    expect(detectWorkflowSummary(desc)).toContain('verb-chain');
  });

  it('flags an uppercase pipeline token (pipeline-token branch)', () => {
    const desc = 'Runs the DECOMPOSE-EXECUTE-VERIFY loop on the input.';
    expect(detectWorkflowSummary(desc)).toContain('pipeline-token');
  });

  it('flags numbered / phased steps (numbered-step branch)', () => {
    const desc = 'Phase 1 gathers context. Step 2 plans the work.';
    expect(detectWorkflowSummary(desc)).toContain('numbered-step');
  });

  it('flags an arrow chain (arrow-chain branch)', () => {
    const desc = 'Pipeline: gather -> plan -> build.';
    expect(detectWorkflowSummary(desc)).toContain('arrow-chain');
  });

  it('flags a Korean procedural verb chain (KO verb-chain branch)', () => {
    const desc = '입력을 분해하고 실행하고 검증한다.';
    expect(detectWorkflowSummary(desc)).toContain('verb-chain');
  });

  it('returns no hits for a CSO-compliant Use-when description', () => {
    const desc = 'Use when the user wants a daily recap or retrospective.';
    expect(detectWorkflowSummary(desc)).toEqual([]);
  });
});

describe('lintDescription calibration (synthetic fixtures)', () => {
  it('passes a trigger-enumeration description with no workflow summary', () => {
    const desc =
      'Use when generating, editing, or refining images. Triggers: image generate, ' +
      'create image, edit image, modify image, refine image.';
    expect(lintDescription(desc).violations).toEqual([]);
  });

  it('passes a Use-when enumeration that clears R1 and has no workflow', () => {
    const desc = 'Use when the user wants project detection, framework hints, or command suggestions.';
    expect(lintDescription(desc).violations).toEqual([]);
  });
});

describe('hasRedFlagsSection (R4 body-rule)', () => {
  it('detects a `## Red Flags` body heading', () => {
    const md = '---\nname: x\ndescription: "d"\n---\n# Title\n\n## Red Flags\n- never do X';
    expect(hasRedFlagsSection(md)).toBe(true);
  });

  it('detects a deeper `### Red Flags` heading with trailing decoration', () => {
    const md = '---\nname: x\n---\nbody\n### Red Flags (anti-patterns)\n- foo';
    expect(hasRedFlagsSection(md)).toBe(true);
  });

  it('is case-insensitive and tolerant of spacing', () => {
    const md = '---\nname: x\n---\n##  red flags\n- foo';
    expect(hasRedFlagsSection(md)).toBe(true);
  });

  it('returns false when no Red Flags heading exists in the body', () => {
    const md = '---\nname: x\ndescription: "d"\n---\n# Title\n\n## Usage\nsteps';
    expect(hasRedFlagsSection(md)).toBe(false);
  });

  it('does NOT count a "Red Flags" mention inside the frontmatter description', () => {
    const md = '---\nname: x\ndescription: "Use when listing Red Flags, warnings, antipatterns."\n---\n# Title\nbody';
    expect(hasRedFlagsSection(md)).toBe(false);
  });

  it('does NOT match an inline (non-heading) "Red Flags" mention in the body', () => {
    const md = '---\nname: x\n---\nWatch for Red Flags during review.';
    expect(hasRedFlagsSection(md)).toBe(false);
  });
});

describe('redFlagViolatingSkillNames (R4 reducer)', () => {
  it('selects only skills carrying an R4 violation, sorted', () => {
    const results = [
      { name: 'beta', violations: [{ rule: 'R4', severity: 'warn', detail: 'x' }] },
      { name: 'alpha', violations: [{ rule: 'R4', severity: 'warn', detail: 'x' }] },
      { name: 'gamma', violations: [{ rule: 'R1', severity: 'error', detail: 'x' }] },
      { name: 'delta', violations: [] },
    ];
    expect(redFlagViolatingSkillNames(results)).toEqual(['alpha', 'beta']);
  });

  it('keeps R4 (warn) out of the error-severity description ratchet', () => {
    const results = [{ name: 'x', violations: [{ rule: 'R4', severity: 'warn', detail: 'x' }] }];
    // R4 must not promote a skill into the description (error) violator set.
    expect(violatingSkillNames(results)).toEqual([]);
    expect(redFlagViolatingSkillNames(results)).toEqual(['x']);
  });
});

describe('lintAllSkills + ratchet against committed baseline', () => {
  it('produces a stable result set and the committed baseline keeps CI green', () => {
    const results = lintAllSkills(getPluginRoot());
    expect(results.length).toBeGreaterThan(100);
    const current = violatingSkillNames(results);
    const baseline = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, 'scripts', 'ci', 'skill-lint-baseline.json'), 'utf8')
    ).skills;
    // The committed baseline must already cover every current violation → no NEW violations.
    expect(runRatchet(current, baseline).pass).toBe(true);
  });

  it('keeps the Red Flags ratchet green against its committed baseline', () => {
    const results = lintAllSkills(getPluginRoot());
    const current = redFlagViolatingSkillNames(results);
    const baseline = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, 'scripts', 'ci', 'skill-redflags-baseline.json'), 'utf8')
    ).skills;
    // Every skill currently missing a Red Flags section must already be baselined.
    expect(runRatchet(current, baseline).pass).toBe(true);
    // Sanity: the convention's adopters are NOT in the regression baseline.
    expect(baseline).not.toContain('coding-standards');
    expect(baseline).not.toContain('tdd-workflow');
  });

  it('attaches an R4 warn to skills without a Red Flags section', () => {
    const results = lintAllSkills(getPluginRoot());
    const withR4 = results.filter((r) => r.violations.some((v) => v.rule === 'R4'));
    // R4 must always be warn-severity (ratchet, never a hard error).
    for (const r of withR4) {
      const r4 = r.violations.find((v) => v.rule === 'R4');
      expect(r4.severity).toBe('warn');
    }
  });
});
