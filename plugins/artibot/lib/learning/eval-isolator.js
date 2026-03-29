/**
 * Eval Isolator.
 * Separates evaluation context from implementation reasoning to prevent
 * self-evaluation bias ("self-praise" effect).
 * Evaluator receives only final outputs + original requirements, never
 * the chain-of-thought or intermediate attempts.
 *
 * @module lib/learning/eval-isolator
 */

import { emit } from '../core/event-bus.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an eval isolator instance.
 *
 * @param {object} [config]
 * @param {boolean} [config.emitEvents=true] - Emit event-bus notifications.
 * @returns {{ prepareEvalContext: Function, tagEvalResult: Function }}
 */
export function createEvalIsolator(config = {}) {
  const emitEvents = config.emitEvents ?? true;

  return {
    /**
     * Extract evaluation-safe context from an implementation result.
     * Strips reasoning, intermediate attempts, and debug logs.
     *
     * @param {object} implementationResult
     * @returns {object} Filtered context safe for unbiased evaluation
     */
    prepareEvalContext(implementationResult) {
      if (!implementationResult || typeof implementationResult !== 'object') {
        return {
          outputs: [],
          modifiedFiles: [],
          testResults: null,
          originalRequest: null,
          contract: null,
        };
      }

      const filtered = {
        // Include: final deliverables
        outputs: implementationResult.outputs || [],
        modifiedFiles: implementationResult.modifiedFiles || [],
        testResults: implementationResult.testResults ?? null,

        // Include: original requirements (what was asked)
        originalRequest: implementationResult.originalRequest ?? null,
        contract: implementationResult.contract ?? null,

        // Explicitly EXCLUDED:
        // - reasoning (chain-of-thought, rationale)
        // - attempts (intermediate tries, revisions)
        // - debugLog (debug traces, console output)
      };

      if (emitEvents) {
        emit('feature:eval-separated', {
          hasOutputs: filtered.outputs.length > 0,
          hasModifiedFiles: filtered.modifiedFiles.length > 0,
          hasTestResults: filtered.testResults !== null,
          hasContract: filtered.contract !== null,
          timestamp: new Date().toISOString(),
        });
      }

      return filtered;
    },

    /**
     * Tag an evaluation result with isolation metadata.
     *
     * @param {object} evalResult
     * @returns {object} New object with isolation metadata appended
     */
    tagEvalResult(evalResult) {
      if (!evalResult || typeof evalResult !== 'object') {
        return {
          isolation: {
            method: 'context-separation',
            reasoningExcluded: true,
            evaluatorBias: 'skeptical',
            timestamp: new Date().toISOString(),
          },
        };
      }

      return {
        ...evalResult,
        isolation: {
          method: 'context-separation',
          reasoningExcluded: true,
          evaluatorBias: 'skeptical',
          timestamp: new Date().toISOString(),
        },
      };
    },
  };
}
