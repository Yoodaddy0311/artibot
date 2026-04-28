/**
 * Handoff history filter. Drops summary-only item types when transferring
 * conversation history to the next agent.
 * Mirrors openai-agents-python `_SUMMARY_ONLY_INPUT_TYPES` (AD-04).
 * @module lib/orchestration/handoff-filter
 */

export const SUMMARY_ONLY_INPUT_TYPES = Object.freeze([
  'function_call',
  'function_call_output',
  'reasoning',
]);

/**
 * Drop history items whose `type` is in the drop list.
 * @param {Array<{type?: string}>} history
 * @param {object} [options]
 * @param {string[]} [options.dropTypes] - Override default drop list
 * @param {(item: any) => boolean} [options.keep] - Custom keep predicate (overrides dropTypes)
 * @returns {Array} Filtered history (new array, never mutates input)
 */
export function filterHandoffHistory(history, options = {}) {
  if (!Array.isArray(history)) return [];
  if (typeof options.keep === 'function') {
    return history.filter(options.keep);
  }
  const drop = new Set(options.dropTypes ?? SUMMARY_ONLY_INPUT_TYPES);
  return history.filter((item) => !drop.has(item?.type));
}

/**
 * Convenience: keep only types explicitly allowed.
 * @param {Array<{type?: string}>} history
 * @param {string[]} allowedTypes
 * @returns {Array}
 */
export function keepOnlyTypes(history, allowedTypes) {
  if (!Array.isArray(history)) return [];
  const allow = new Set(allowedTypes ?? []);
  return history.filter((item) => allow.has(item?.type));
}
