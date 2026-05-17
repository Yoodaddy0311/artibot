/**
 * Goal Auto-Launcher (Track L — Claude /goal Native Integration, v4.11.0).
 *
 * Bridges parsed goal intent to a structured "setup" that the
 * orchestrator can surface to the main Claude session. The launcher
 * DOES NOT emit `/goal` directly — surfacing is the orchestrator's
 * job. This module is a pure function: given a parsed intent it builds
 *
 *   - a minimal Goal Contract fragment (matches goal-schema.js shape),
 *   - the literal `/goal <condition>` string Claude Code accepts,
 *   - an evaluator strategy (haiku | validation | hybrid),
 *   - a human-readable instruction block (markdown) for transparency.
 *
 * Per DATA POLICY: no I/O, no external calls. Session-local only.
 *
 * @module lib/cognitive/goal-auto-launcher
 */

import {
  DEFAULT_MAX_ITERATIONS,
  HARD_MAX_ITERATIONS,
} from '../autopilot/goal-schema.js';

/**
 * Supported evaluator strategies.
 *   - 'haiku'      : Claude Haiku judges condition each turn (LLM-based,
 *                    fast, used when no validation command is available).
 *   - 'validation' : run validationCommand and inspect exit code only.
 *   - 'hybrid'     : Haiku first; on low-confidence escalate to
 *                    validation; consensus when both agree.
 *
 * @type {readonly ['haiku', 'validation', 'hybrid']}
 */
export const EVALUATOR_STRATEGIES = Object.freeze([
  'haiku',
  'validation',
  'hybrid',
]);

/**
 * Choose evaluator strategy from parsed intent. Pure helper.
 *
 *   - No suggested validation command → 'haiku'
 *   - Validation command present AND opts.preferValidation → 'validation'
 *   - Validation command present (default)                → 'hybrid'
 *
 * @param {object} parsed parseGoalIntent() output
 * @param {{ preferValidation?: boolean, forceHaiku?: boolean }} [opts]
 * @returns {'haiku'|'validation'|'hybrid'}
 */
export function selectEvaluator(parsed, opts = {}) {
  if (opts.forceHaiku) return 'haiku';
  if (!parsed || !parsed.suggestedValidationCommand) return 'haiku';
  if (opts.preferValidation) return 'validation';
  return 'hybrid';
}

/**
 * Derive a short objective string from the condition. Trims to 80 chars
 * so the contract objective stays scannable in tail-render UIs.
 *
 * @param {string} condition
 * @returns {string}
 */
function deriveObjective(condition) {
  const trimmed = condition.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + '...';
}

/**
 * Build a minimal Goal Contract fragment matching the shape the
 * `validateGoalContract()` schema expects. Caller may pass through
 * `validateGoalContract()` for full normalization before persisting.
 *
 * @param {object} parsed
 * @returns {object}
 */
function buildContractFragment(parsed) {
  const maxIter = Math.min(
    parsed.maxIterations || DEFAULT_MAX_ITERATIONS,
    HARD_MAX_ITERATIONS,
  );
  return {
    objective: deriveObjective(parsed.condition),
    stoppingCondition: parsed.condition.trim(),
    validationCommand: parsed.suggestedValidationCommand || null,
    forbiddenChanges: [],
    maxIterations: maxIter,
  };
}

/**
 * Build the literal slash-command string Claude Code's native /goal
 * feature accepts. The condition is passed verbatim — Claude Haiku
 * judges completion per-turn. This string is only RETURNED, never
 * executed by this module.
 *
 * @param {string} condition
 * @returns {string}
 */
function buildClaudeGoalCommand(condition) {
  return `/goal ${condition.trim()}`;
}

/**
 * Build the markdown instruction block surfaced to the orchestrator.
 * Format is intentionally compact (front-loaded per CLAUDE.md context
 * efficiency rule) and tells the user exactly what was auto-detected.
 *
 * @param {object} parsed
 * @param {string} evaluatorChoice
 * @param {string} sessionId
 * @returns {string}
 */
function buildInstruction(parsed, evaluatorChoice, sessionId) {
  const cmdLine = parsed.suggestedValidationCommand
    ? `- Validation command: \`${parsed.suggestedValidationCommand}\``
    : '- Validation command: _(none — Haiku evaluator)_';
  return [
    `### Auto-detected goal intent (session ${sessionId})`,
    `- Stopping condition: \`${parsed.condition}\``,
    `- Max iterations: ${parsed.maxIterations}`,
    `- Evaluator: \`${evaluatorChoice}\``,
    cmdLine,
    `- Confidence: ${parsed.confidence}`,
    '',
    'Artibot will set up Claude Code\'s native `/goal` workflow ' +
      'automatically. No manual slash-command typing required.',
  ].join('\n');
}

/**
 * Build the full goal-setup bundle.
 *
 * @param {object} parsed parseGoalIntent() output. Must have `found:true`.
 * @param {string} sessionId opaque session identifier (for logging only)
 * @param {{ preferValidation?: boolean, forceHaiku?: boolean }} [opts]
 * @returns {{
 *   contractFragment: object|null,
 *   claudeGoalCommand: string|null,
 *   evaluatorChoice: 'haiku'|'validation'|'hybrid'|null,
 *   instruction: string|null,
 *   ready: boolean,
 *   reason?: string
 * }}
 */
export function buildGoalSetup(parsed, sessionId, opts = {}) {
  if (!parsed || !parsed.found || !parsed.condition) {
    return {
      contractFragment: null,
      claudeGoalCommand: null,
      evaluatorChoice: null,
      instruction: null,
      ready: false,
      reason: 'no goal intent detected',
    };
  }
  const sid = typeof sessionId === 'string' && sessionId
    ? sessionId
    : 'unknown';
  const evaluatorChoice = selectEvaluator(parsed, opts);
  const contractFragment = buildContractFragment(parsed);
  const claudeGoalCommand = buildClaudeGoalCommand(parsed.condition);
  const instruction = buildInstruction(parsed, evaluatorChoice, sid);
  return {
    contractFragment,
    claudeGoalCommand,
    evaluatorChoice,
    instruction,
    ready: true,
  };
}
