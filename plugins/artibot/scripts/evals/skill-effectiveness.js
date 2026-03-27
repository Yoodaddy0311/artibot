/**
 * Skill Effectiveness Evaluation Harness.
 * Measures the impact of individual skills by comparing agent performance
 * with skill on vs. off (baseline). Inspired by Google DeepMind's
 * "Closing the Knowledge Gap with Agent Skills" evaluation methodology.
 *
 * @module scripts/evals/skill-effectiveness
 */

import { emit } from '../../lib/core/event-bus.js';

// ---------------------------------------------------------------------------
// ID generation (no crypto dependency)
// ---------------------------------------------------------------------------

let idCounter = 0;

/**
 * Generate a unique test case ID.
 * @returns {string}
 */
function generateId() {
  idCounter += 1;
  return `tc-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single test case result by comparing output against expected behavior.
 * Returns a value between 0 and 1.
 * @param {object} output - Agent output
 * @param {object} testCase - Test case with expectedBehavior
 * @param {Function} [scorer] - Custom scoring function (output, expected) => number
 * @returns {number} Score between 0 and 1
 */
function scoreTestCase(output, testCase, scorer) {
  if (typeof scorer === 'function') {
    const score = scorer(output, testCase.expectedBehavior);
    return Math.max(0, Math.min(1, score));
  }
  // Default: binary pass/fail based on output truthiness
  return output ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

/**
 * Format a skill evaluation report as a readable string.
 * @param {import('./skill-effectiveness.js').SkillEvalResult[]} results
 * @returns {string}
 */
function formatReport(results) {
  if (!results || results.length === 0) {
    return 'No skill evaluation results to report.';
  }

  const sorted = [...results].sort((a, b) => b.improvement - a.improvement);
  const top5 = sorted.slice(0, 5);
  const bottom5 = sorted.slice(-5).reverse();

  const lines = [
    'SKILL EFFECTIVENESS REPORT',
    '==========================',
    `Generated: ${new Date().toISOString()}`,
    `Skills evaluated: ${results.length}`,
    '',
    '| Skill | Baseline | With Skill | Delta | Improvement |',
    '|-------|----------|------------|-------|-------------|',
  ];

  for (const r of sorted) {
    const pct = isFinite(r.improvement)
      ? `${(r.improvement * 100).toFixed(1)}%`
      : 'N/A';
    lines.push(
      `| ${r.skillName} | ${r.baseline.toFixed(3)} | ${r.withSkill.toFixed(3)} | ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)} | ${pct} |`,
    );
  }

  lines.push('');
  lines.push('TOP 5 Most Effective:');
  for (const r of top5) {
    const pct = isFinite(r.improvement)
      ? `${(r.improvement * 100).toFixed(1)}%`
      : 'N/A';
    lines.push(`  ${r.skillName}: ${pct}`);
  }

  lines.push('');
  lines.push('BOTTOM 5 Least Effective:');
  for (const r of bottom5) {
    const pct = isFinite(r.improvement)
      ? `${(r.improvement * 100).toFixed(1)}%`
      : 'N/A';
    lines.push(`  ${r.skillName}: ${pct}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TestCase
 * @property {string} id - Unique identifier
 * @property {string} description - Human-readable description
 * @property {string} input - Prompt or input for the agent
 * @property {object} expectedBehavior - Expected output characteristics
 * @property {string} createdAt - ISO timestamp
 */

/**
 * @typedef {object} SkillEvalResult
 * @property {string} skillName - Skill being evaluated
 * @property {number} baseline - Average score without skill (0-1)
 * @property {number} withSkill - Average score with skill (0-1)
 * @property {number} delta - Absolute improvement (withSkill - baseline)
 * @property {number} improvement - Relative improvement (delta / baseline)
 * @property {number} testCaseCount - Number of test cases evaluated
 * @property {string} evaluatedAt - ISO timestamp
 */

/**
 * Create a skill evaluation harness.
 *
 * @param {object} [config]
 * @param {Function} [config.runWithoutSkill] - (input, testCase) => output (baseline)
 * @param {Function} [config.runWithSkill] - (input, testCase, skillName) => output (with skill)
 * @param {Function} [config.scorer] - (output, expectedBehavior) => score (0-1)
 * @returns {object} Harness API
 */
export function createSkillEvalHarness(config = {}) {
  const { runWithoutSkill, runWithSkill, scorer } = config;

  return Object.freeze({
    /**
     * Create a test case for skill evaluation.
     * @param {string} description
     * @param {string} input
     * @param {object} expectedBehavior
     * @returns {TestCase}
     */
    createTestCase(description, input, expectedBehavior) {
      return Object.freeze({
        id: generateId(),
        description,
        input,
        expectedBehavior,
        createdAt: new Date().toISOString(),
      });
    },

    /**
     * Evaluate a single skill against test cases.
     * @param {string} skillName
     * @param {TestCase[]} testCases
     * @returns {Promise<SkillEvalResult>}
     */
    async evaluateSkill(skillName, testCases) {
      if (!testCases || testCases.length === 0) {
        return {
          skillName,
          baseline: 0,
          withSkill: 0,
          delta: 0,
          improvement: 0,
          testCaseCount: 0,
          evaluatedAt: new Date().toISOString(),
        };
      }

      let baselineTotal = 0;
      let withSkillTotal = 0;

      for (const tc of testCases) {
        const baselineOutput = runWithoutSkill
          ? await runWithoutSkill(tc.input, tc)
          : null;
        const skillOutput = runWithSkill
          ? await runWithSkill(tc.input, tc, skillName)
          : null;

        baselineTotal += scoreTestCase(baselineOutput, tc, scorer);
        withSkillTotal += scoreTestCase(skillOutput, tc, scorer);
      }

      const count = testCases.length;
      const baseline = Math.round((baselineTotal / count) * 1000) / 1000;
      const withSkill = Math.round((withSkillTotal / count) * 1000) / 1000;
      const delta = Math.round((withSkill - baseline) * 1000) / 1000;
      const improvement = baseline > 0
        ? Math.round((delta / baseline) * 1000) / 1000
        : withSkill > 0 ? Infinity : 0;

      const result = {
        skillName,
        baseline,
        withSkill,
        delta,
        improvement,
        testCaseCount: count,
        evaluatedAt: new Date().toISOString(),
      };

      emit('feature:skill-eval', {
        type: 'skill-evaluated',
        ...result,
      });

      return result;
    },

    /**
     * Evaluate multiple skills and return sorted results.
     * @param {string[]} skillNames
     * @param {TestCase[]} testCases
     * @returns {Promise<SkillEvalResult[]>}
     */
    async evaluateAll(skillNames, testCases) {
      const results = [];
      for (const skillName of skillNames) {
        const result = await this.evaluateSkill(skillName, testCases);
        results.push(result);
      }

      return [...results].sort((a, b) => b.improvement - a.improvement);
    },

    /**
     * Generate a formatted report string.
     * @param {SkillEvalResult[]} results
     * @returns {string}
     */
    generateReport(results) {
      return formatReport(results);
    },
  });
}
