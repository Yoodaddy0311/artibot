/**
 * Per-tool input/output guardrail registry.
 * Pattern adopted from openai-agents-python tool_guardrails.py (AD-02).
 * Zero new deps. Behaviors: 'reject_content' (continue with refusal) | 'raise_exception' (throw).
 * @module lib/orchestration/tool-guardrails
 */

export class ToolGuardrailRejection extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'ToolGuardrailRejection';
    this.info = info ?? null;
  }
}

const REGISTRY = new Map();

/**
 * @typedef {Object} GuardrailEntry
 * @property {(params: any) => (Promise<{tripwireTriggered: boolean, info?: any, refusal?: string}> | {tripwireTriggered: boolean, info?: any, refusal?: string})} guardrail
 * @property {'reject_content' | 'raise_exception'} behavior
 */

/**
 * Register a guardrail for a tool.
 * @param {string} toolName
 * @param {Function} guardrail
 * @param {'reject_content' | 'raise_exception'} [behavior='reject_content']
 */
export function registerToolGuardrail(toolName, guardrail, behavior = 'reject_content') {
  if (!toolName || typeof toolName !== 'string') {
    throw new TypeError('toolName must be string');
  }
  if (typeof guardrail !== 'function') {
    throw new TypeError('guardrail must be a function');
  }
  if (behavior !== 'reject_content' && behavior !== 'raise_exception') {
    throw new TypeError(`unknown behavior: ${behavior}`);
  }
  const list = REGISTRY.get(toolName) ?? [];
  list.push({ guardrail, behavior });
  REGISTRY.set(toolName, list);
}

/**
 * Clear registry entries for a tool (or all tools when no name given).
 * @param {string} [toolName]
 */
export function clearToolGuardrails(toolName) {
  if (toolName === undefined) {
    REGISTRY.clear();
    return;
  }
  REGISTRY.delete(toolName);
}

/**
 * Evaluate registered guardrails for a tool's input.
 * Behavior:
 *  - reject_content: returns { allowed: false, refusal: string }
 *  - raise_exception: throws ToolGuardrailRejection
 *  - all pass: returns { allowed: true }
 * @param {string} toolName
 * @param {*} params
 * @returns {Promise<{allowed: boolean, refusal?: string, info?: any}>}
 */
export async function evaluateToolInput(toolName, params) {
  const entries = REGISTRY.get(toolName);
  if (!entries || entries.length === 0) {
    return { allowed: true };
  }
  for (const entry of entries) {
    const out = await entry.guardrail(params);
    if (out?.tripwireTriggered) {
      if (entry.behavior === 'raise_exception') {
        throw new ToolGuardrailRejection(
          `Tool guardrail rejected '${toolName}'`,
          out.info ?? null,
        );
      }
      return {
        allowed: false,
        refusal: out.refusal ?? `Tool '${toolName}' input rejected by guardrail`,
        info: out.info ?? null,
      };
    }
  }
  return { allowed: true };
}

/**
 * Inspect registry (read-only snapshot).
 * @returns {Record<string, number>} toolName -> guardrail count
 */
export function inspectRegistry() {
  const out = {};
  for (const [k, v] of REGISTRY.entries()) {
    out[k] = v.length;
  }
  return out;
}
