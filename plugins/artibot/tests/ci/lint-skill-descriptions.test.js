/**
 * Unit tests for the SKILL.md description linter (CSO compliance + ratchet).
 *
 * Covers:
 *   - extractDescription: inline + block-scalar frontmatter forms
 *   - countTriggers (R1): quotes, KO utterances, enumeration clauses
 *   - detectWorkflowSummary (R2): pipeline tokens, arrows, numbered steps, verb chains
 *   - lintDescription: rule composition + severities (R3 = warn)
 *   - runRatchet: new-violation fail / baseline pass / shrink (fixed) branches
 *   - Calibration: vibe-coding + clarify must FAIL R2; image-generation + quickstart PASS
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
  lintAllSkills,
  lintDescription,
  runRatchet,
  violatingSkillNames,
} from '../../scripts/ci/lint-skill-descriptions.js';
import { getPluginRoot } from '../../scripts/ci/ci-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');

/** Read a real skill's extracted description for calibration assertions. */
function realDesc(name) {
  return extractDescription(readFileSync(join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8'));
}

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

describe('calibration against real skills', () => {
  it('vibe-coding is an R2 violation (verb chain in description)', () => {
    expect(detectWorkflowSummary(realDesc('vibe-coding'))).toContain('verb-chain');
  });

  it('clarify is an R2 violation (prose pipeline)', () => {
    expect(detectWorkflowSummary(realDesc('clarify')).length).toBeGreaterThan(0);
  });

  it('daily is an R2 violation', () => {
    expect(detectWorkflowSummary(realDesc('daily')).length).toBeGreaterThan(0);
  });

  it('image-generation passes (trigger enumeration only)', () => {
    expect(lintDescription(realDesc('image-generation')).violations).toEqual([]);
  });

  it('quickstart passes (Use-when enumeration clears R1, no workflow)', () => {
    expect(lintDescription(realDesc('quickstart')).violations).toEqual([]);
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
});
