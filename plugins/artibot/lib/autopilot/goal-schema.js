/**
 * Goal Contract schema for autopilot goal-driven mode (v4.6.0).
 *
 * Provides a machine-readable stopping condition for the autopilot
 * iteration loop. Inspired by OpenAI Codex `/goal` patterns — durable
 * objective + verifiable stopping condition + validation command +
 * forbidden-change scope + iteration cap.
 *
 * Pure validation only — no I/O, no async, no dependencies.
 *
 * @module lib/autopilot/goal-schema
 */

/**
 * Hard upper bound on iteration count. Prevents runaway loops in the
 * style of the v4.5.6 dev-verify-gate infinite-fire incident, even if
 * a user-supplied contract sets a higher maxIterations.
 */
export const HARD_MAX_ITERATIONS = 10;

/**
 * Default maxIterations when a contract omits the field.
 */
export const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Validate a Goal Contract candidate object.
 *
 * Returns a discriminated result:
 *   - `{ valid: true,  errors: [], contract: <normalized> }` on success
 *   - `{ valid: false, errors: [<string>], contract: null }` on failure
 *
 * Normalization: trimmed strings, forbiddenChanges defaults to [],
 * validationCommand defaults to null, maxIterations defaults to
 * DEFAULT_MAX_ITERATIONS.
 *
 * @param {*} input candidate object (may be malformed)
 * @returns {{ valid: boolean, errors: string[], contract: object|null }}
 */
export function validateGoalContract(input) {
  const errors = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      errors: ['contract must be a non-null object'],
      contract: null,
    };
  }

  if (
    !input.objective ||
    typeof input.objective !== 'string' ||
    !input.objective.trim()
  ) {
    errors.push('objective is required and must be a non-empty string');
  }

  if (
    !input.stoppingCondition ||
    typeof input.stoppingCondition !== 'string' ||
    !input.stoppingCondition.trim()
  ) {
    errors.push(
      'stoppingCondition is required and must be a non-empty string',
    );
  }

  if (input.validationCommand !== undefined && input.validationCommand !== null) {
    if (
      typeof input.validationCommand !== 'string' ||
      !input.validationCommand.trim()
    ) {
      errors.push(
        'validationCommand, if provided, must be a non-empty string',
      );
    }
  }

  if (input.forbiddenChanges !== undefined && input.forbiddenChanges !== null) {
    if (!Array.isArray(input.forbiddenChanges)) {
      errors.push('forbiddenChanges, if provided, must be an array');
    } else if (input.forbiddenChanges.some((x) => typeof x !== 'string')) {
      errors.push('forbiddenChanges must contain only strings');
    }
  }

  let maxIter = DEFAULT_MAX_ITERATIONS;
  if (input.maxIterations !== undefined && input.maxIterations !== null) {
    if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1) {
      errors.push('maxIterations must be a positive integer');
    } else if (input.maxIterations > HARD_MAX_ITERATIONS) {
      errors.push(
        `maxIterations cannot exceed hard cap ${HARD_MAX_ITERATIONS}`,
      );
    } else {
      maxIter = input.maxIterations;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, contract: null };
  }

  return {
    valid: true,
    errors: [],
    contract: {
      objective: input.objective.trim(),
      stoppingCondition: input.stoppingCondition.trim(),
      validationCommand:
        typeof input.validationCommand === 'string'
          ? input.validationCommand.trim()
          : null,
      forbiddenChanges: Array.isArray(input.forbiddenChanges)
        ? [...input.forbiddenChanges]
        : [],
      maxIterations: maxIter,
    },
  };
}
