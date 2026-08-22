/**
 * Unit tests for the SKILL.md description linter (CSO compliance + ratchet).
 *
 * Covers:
 *   - extractDescription: inline + block-scalar frontmatter forms
 *   - countTriggers (R1): quotes, KO utterances, enumeration clauses
 *   - detectWorkflowSummary (R2): pipeline tokens, arrows, numbered steps, verb chains
 *   - lintDescription: rule composition + severities (R3 = warn)
 *   - runRatchet: new-violation fail / baseline pass / shrink (fixed) branches
 *   - evaluateGates: shrink enforcement — a baseline entry whose skill no longer
 *     violates ("fossil") fails the gate, and the message carries the exact
 *     baseline-regeneration command
 *   - CLI end-to-end (spawned against a SYNTHETIC plugin tree in os.tmpdir()):
 *     fossil → exit 1, fossil-free → exit 0, plus both pre-existing verdicts
 *     (new violation → exit 1, baselined violation → exit 0) so the shrink gate
 *     is proven to be additive rather than a rewrite of the grow gate
 *   - Calibration: every detectWorkflowSummary branch is exercised by SYNTHETIC
 *     fixture strings, never by real skill descriptions. Real-skill coupling broke
 *     this twice (each time the ratchet legitimately fixed the example skill), so it
 *     is banned here — synthetic fixtures keep detector coverage live and stable.
 *
 * @module tests/ci/lint-skill-descriptions
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BASELINE_REGEN_CMD,
  countTriggers,
  detectWorkflowSummary,
  evaluateGates,
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

// ── Shrink enforcement (unit) ────────────────────────────────────────────────
// A "fossil" is a baseline entry whose skill no longer violates. It is not idle
// debt: the name stays excused, so a later regression of that same skill would
// pass the ratchet silently. evaluateGates must fail on it in BOTH gates.
describe('evaluateGates (shrink enforcement)', () => {
  const clean = { pass: true, newViolations: [], fixed: [] };

  it('passes when neither ratchet has new violations or fossils', () => {
    const v = evaluateGates({ ratchet: { ...clean }, redFlagRatchet: { ...clean } });
    expect(v.failed).toBe(false);
    expect(v.messages).toEqual([]);
  });

  it('FAILS on a fossil in the description baseline', () => {
    const v = evaluateGates({
      ratchet: { pass: true, newViolations: [], fixed: ['ghost-skill'] },
      redFlagRatchet: { ...clean },
    });
    expect(v.failed).toBe(true);
    const text = v.messages.join('\n');
    expect(text).toContain('skill-lint-baseline.json');
    expect(text).toContain('ghost-skill');
  });

  it('FAILS on a fossil in the Red Flags baseline', () => {
    const v = evaluateGates({
      ratchet: { ...clean },
      redFlagRatchet: { pass: true, newViolations: [], fixed: ['ghost-skill'] },
    });
    expect(v.failed).toBe(true);
    expect(v.messages.join('\n')).toContain('skill-redflags-baseline.json');
  });

  it('names the exact baseline-regeneration command in the failure message', () => {
    const v = evaluateGates({
      ratchet: { pass: true, newViolations: [], fixed: ['ghost-skill'] },
      redFlagRatchet: { ...clean },
    });
    const text = v.messages.join('\n');
    expect(text).toContain(BASELINE_REGEN_CMD);
    expect(text).toContain('--update-baseline');
    // The command must match the npm script actually shipped in package.json,
    // or the operator is told to run something that does not exist.
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['skill:lint:desc:baseline']).toContain('--update-baseline');
    expect(BASELINE_REGEN_CMD).toBe('npm run skill:lint:desc:baseline');
  });

  it('keeps the pre-existing verdicts intact (grow direction + denominator)', () => {
    expect(
      evaluateGates({
        ratchet: { pass: false, newViolations: ['newbie'], fixed: [] },
        redFlagRatchet: { ...clean },
      }).failed
    ).toBe(true);
    expect(
      evaluateGates({
        ratchet: { ...clean },
        redFlagRatchet: { pass: false, newViolations: ['newbie'], fixed: [] },
      }).failed
    ).toBe(true);
    expect(
      evaluateGates({
        ratchet: { ...clean },
        redFlagRatchet: { ...clean },
        floorFailures: ['artibot scanned 0 skills'],
      }).failed
    ).toBe(true);
  });

  it('does not re-render floor failures (main prints them earlier — no double count)', () => {
    const v = evaluateGates({
      ratchet: { ...clean },
      redFlagRatchet: { ...clean },
      floorFailures: ['artibot scanned 0 skills'],
    });
    expect(v.messages).toEqual([]);
  });
});

// ── Shrink enforcement (CLI end-to-end) ──────────────────────────────────────
// Spawns the real CLI against a SYNTHETIC plugin tree so the exit code — not a
// return value — is what gets asserted. The tree is built once and only the
// baseline files change between cases, so a differing exit code is attributable
// to the baseline content and nothing else (negative control: the same tree with
// fossil-free baselines must exit 0).
describe('CLI shrink enforcement (spawned, synthetic plugin tree)', () => {
  const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'ci', 'lint-skill-descriptions.js');
  // Floors from skill-scan-roots.js#MIN_ENTITY_COUNTS: artibot 100, cowork 40.
  // Below them the denominator check fails first and the run proves nothing.
  const ARTIBOT_SKILLS = 100;
  const COWORK_SKILLS = 40;
  const COMPLIANT = [
    '---',
    "name: NAME",
    "description: Use when user says 'alpha', 'beta', 'gamma'.",
    '---',
    '',
    '# NAME',
    '',
    '## Red Flags',
    '',
    '- none',
    '',
  ].join('\n');
  // R1 (1 signal < 3) + R2 (arrow-chain) → an error-severity violator.
  const VIOLATING = ['---', 'name: NAME', 'description: Parses -> renders.', '---', '', '# NAME', '', '## Red Flags', '', '- none', ''].join('\n');

  let tmpRoot; // <tmp>/plugins/artibot
  let baseDir; // <tmp>/plugins

  const skillDir = (root, name) => join(baseDir, root, 'skills', name);

  function writeSkill(root, name, template) {
    const dir = skillDir(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), template.replaceAll('NAME', name), 'utf8');
  }

  function writeBaselines(skills, redFlagSkills) {
    const dir = join(tmpRoot, 'scripts', 'ci');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill-lint-baseline.json'), JSON.stringify({ skills }), 'utf8');
    writeFileSync(
      join(dir, 'skill-redflags-baseline.json'),
      JSON.stringify({ skills: redFlagSkills }),
      'utf8'
    );
  }

  function run() {
    return spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: tmpRoot },
    });
  }

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'artibot-shrink-'));
    baseDir = join(tmp, 'plugins');
    tmpRoot = join(baseDir, 'artibot');
    for (let i = 0; i < ARTIBOT_SKILLS; i++) {
      writeSkill('artibot', `skill-${String(i).padStart(3, '0')}`, COMPLIANT);
    }
    for (let i = 0; i < COWORK_SKILLS; i++) {
      writeSkill('artibot-cowork', `co-skill-${String(i).padStart(3, '0')}`, COMPLIANT);
    }
  }, 60000);

  afterAll(() => {
    if (baseDir) rmSync(dirname(baseDir), { recursive: true, force: true });
  });

  it('FIXTURE REACHES THE GATE: fossil-free baselines exit 0 (negative control)', () => {
    writeBaselines([], []);
    const r = run();
    // If this ever fails, every red case below is red for the wrong reason.
    expect(r.stderr).not.toContain('FAIL');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS: no new violations, no stale baseline entries');
    // Prove the scan really saw the synthetic tree (not the real repo's 159).
    expect(r.stdout).toContain(`artibot=${ARTIBOT_SKILLS}`);
    expect(r.stdout).toContain(`artibot-cowork=${COWORK_SKILLS}`);
  }, 30000);

  it('exits non-zero when the description baseline holds a fossil', () => {
    // skill-000 exists and is compliant → its baseline entry is a fossil.
    writeBaselines(['skill-000'], []);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('skill-lint-baseline.json');
    expect(r.stderr).toContain('skill-000');
    expect(r.stderr).toContain(BASELINE_REGEN_CMD);
  }, 30000);

  it('exits non-zero when the Red Flags baseline holds a fossil', () => {
    writeBaselines([], ['skill-000']);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('skill-redflags-baseline.json');
    expect(r.stderr).toContain(BASELINE_REGEN_CMD);
  }, 30000);

  it('still exits non-zero on a NEW violation (grow direction unchanged)', () => {
    writeSkill('artibot', 'skill-bad', VIOLATING);
    try {
      writeBaselines([], []);
      const r = run();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('NEW description-violating');
      expect(r.stderr).toContain('skill-bad');
    } finally {
      rmSync(skillDir('artibot', 'skill-bad'), { recursive: true, force: true });
    }
  }, 30000);

  it('still exits 0 for a baselined violation (shrink gate did not over-tighten)', () => {
    writeSkill('artibot', 'skill-bad', VIOLATING);
    try {
      writeBaselines(['skill-bad'], []);
      const r = run();
      expect(r.stderr).not.toContain('FAIL');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('desc: 1 baselined');
    } finally {
      rmSync(skillDir('artibot', 'skill-bad'), { recursive: true, force: true });
    }
  }, 30000);

  it('--update-baseline clears the fossil and the next run is green', () => {
    writeBaselines(['skill-000'], ['skill-000']);
    expect(run().status).not.toBe(0);
    const upd = spawnSync(process.execPath, [SCRIPT, '--update-baseline'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: tmpRoot },
    });
    expect(upd.status).toBe(0);
    const after = run();
    expect(after.stderr).not.toContain('FAIL');
    expect(after.status).toBe(0);
  }, 60000);
});
