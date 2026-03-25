/**
 * Runtime guardrail middleware.
 * Policy-based tool call authorization with allow/deny/ask rules.
 * Integrates with the existing Guard Registry for centralized safety.
 *
 * @module lib/runtime/middleware/guardrail
 */

// ---------------------------------------------------------------------------
// Default policy rules
// ---------------------------------------------------------------------------

/**
 * @typedef {'allow' | 'deny' | 'ask'} PolicyDecision
 *
 * @typedef {object} PolicyRule
 * @property {string} tool - Tool name pattern (exact or glob-like with '*')
 * @property {PolicyDecision} decision - What to do when matched
 * @property {string} [reason] - Human-readable explanation
 * @property {object} [conditions] - Optional extra conditions
 * @property {string[]} [conditions.args] - Argument substrings that trigger this rule
 * @property {string[]} [conditions.phases] - Restrict to routing phases
 */

/** @type {PolicyRule[]} */
const DEFAULT_RULES = Object.freeze([
  { tool: 'Bash', decision: 'ask', reason: 'Shell commands require confirmation by default' },
  { tool: 'Write', decision: 'allow', reason: 'File writes are permitted' },
  { tool: 'Edit', decision: 'allow', reason: 'File edits are permitted' },
  { tool: 'Read', decision: 'allow', reason: 'File reads are always safe' },
  { tool: 'Grep', decision: 'allow', reason: 'Search operations are always safe' },
  { tool: 'Glob', decision: 'allow', reason: 'File pattern matching is always safe' },
]);

// ---------------------------------------------------------------------------
// Helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/**
 * Deep-freeze a policy array so consumers cannot mutate it.
 *
 * @param {PolicyRule[]} rules
 * @returns {readonly PolicyRule[]}
 */
function freezeRules(rules) {
  return Object.freeze(rules.map((r) => Object.freeze({ ...r })));
}

/**
 * Match a tool name against a pattern.
 * Supports exact match and trailing wildcard (e.g. "Task*").
 *
 * @param {string} toolName
 * @param {string} pattern
 * @returns {boolean}
 */
function matchToolPattern(toolName, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return toolName === pattern;
}

/**
 * Check whether extra conditions on a rule are satisfied.
 *
 * @param {PolicyRule} rule
 * @param {object} evalContext
 * @param {string} [evalContext.routingPhase]
 * @param {string} [evalContext.toolArgs]
 * @returns {boolean}
 */
function conditionsMet(rule, evalContext) {
  const cond = rule.conditions;
  if (!cond) return true;

  if (Array.isArray(cond.phases) && cond.phases.length > 0) {
    if (!cond.phases.includes(evalContext.routingPhase)) return false;
  }

  if (Array.isArray(cond.args) && cond.args.length > 0) {
    const argsStr = evalContext.toolArgs || '';
    const anyMatch = cond.args.some((a) => argsStr.includes(a));
    if (!anyMatch) return false;
  }

  return true;
}

/**
 * Find the first matching rule for a tool invocation.
 *
 * @param {PolicyRule[]} rules
 * @param {string} toolName
 * @param {object} evalContext
 * @returns {PolicyRule | null}
 */
function findMatchingRule(rules, toolName, evalContext) {
  for (const rule of rules) {
    if (matchToolPattern(toolName, rule.tool) && conditionsMet(rule, evalContext)) {
      return rule;
    }
  }
  return null;
}

/**
 * Evaluate a single tool call against the policy.
 *
 * @param {PolicyRule[]} rules
 * @param {string} toolName
 * @param {object} evalContext
 * @param {boolean} failClosed
 * @returns {{ decision: PolicyDecision, rule: PolicyRule | null, reason: string }}
 */
function evaluateToolCall(rules, toolName, evalContext, failClosed) {
  const matched = findMatchingRule(rules, toolName, evalContext);

  if (matched) {
    return {
      decision: matched.decision,
      rule: matched,
      reason: matched.reason || `Matched rule for "${matched.tool}"`,
    };
  }

  if (failClosed) {
    return {
      decision: 'deny',
      rule: null,
      reason: `No matching policy for tool "${toolName}" — fail_closed mode`,
    };
  }

  return {
    decision: 'allow',
    rule: null,
    reason: `No matching policy — default allow (fail_open mode)`,
  };
}

/**
 * Build an evaluation context from pipeline state.
 *
 * @param {object} state
 * @returns {object}
 */
function buildEvalContext(state) {
  return {
    routingPhase: state.context.routing?.system || 'system1',
    toolArgs: state.userPrompt || '',
  };
}

/**
 * Collect tool names from state context that may be invoked.
 * Pulls from subagent contracts and skill-suggested tools.
 *
 * @param {object} state
 * @returns {string[]}
 */
function collectToolCandidates(state) {
  const tools = new Set();

  const subagentTools = state.context.subagents?.contract?.tools;
  if (Array.isArray(subagentTools)) {
    for (const t of subagentTools) tools.add(t);
  }

  const taskMode = state.context.tasks?.mode;
  if (taskMode === 'agentTeam') {
    tools.add('TeamCreate');
    tools.add('SendMessage');
    tools.add('TaskCreate');
  }

  return [...tools];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a guardrail middleware for policy-based tool call authorization.
 *
 * @param {object} [options]
 * @param {PolicyRule[]} [options.rules] - Custom policy rules (merged after defaults).
 * @param {boolean} [options.failClosed=true] - Deny unmatched tools when true.
 * @param {boolean} [options.includeDefaults=true] - Include DEFAULT_RULES.
 * @param {boolean} [options.enabled=true] - Disable middleware entirely.
 * @returns {(state: object) => Promise<object>}
 */
export function createGuardrailMiddleware(options = {}) {
  const {
    rules: customRules = [],
    failClosed = true,
    includeDefaults = true,
    enabled = true,
  } = options;

  const baseRules = includeDefaults ? [...DEFAULT_RULES] : [];
  const mergedRules = freezeRules([...baseRules, ...customRules]);

  return async function guardrailMiddleware(state) {
    if (!enabled) {
      state.context.guardrail = { enabled: false, evaluations: [] };
      return state;
    }

    const evalContext = buildEvalContext(state);
    const candidates = collectToolCandidates(state);
    const evaluations = [];
    const denied = [];
    const asked = [];

    for (const toolName of candidates) {
      const result = evaluateToolCall(mergedRules, toolName, evalContext, failClosed);
      evaluations.push({
        tool: toolName,
        decision: result.decision,
        reason: result.reason,
        rulePattern: result.rule?.tool || null,
      });

      if (result.decision === 'deny') {
        denied.push(toolName);
      } else if (result.decision === 'ask') {
        asked.push(toolName);
      }
    }

    state.context.guardrail = {
      enabled: true,
      failClosed,
      ruleCount: mergedRules.length,
      evaluated: evaluations.length,
      denied,
      asked,
      evaluations,
    };

    if (denied.length > 0) {
      state.messageParts.push(`guardrail=denied:${denied.join(',')}`);
      state.userPrompt += `\n\n⚠️ Guardrail: tools denied by policy — ${denied.join(', ')}`;
    } else if (asked.length > 0) {
      state.messageParts.push(`guardrail=ask:${asked.join(',')}`);
    } else {
      state.messageParts.push(`guardrail=ok`);
    }

    return state;
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  matchToolPattern as _matchToolPattern,
  conditionsMet as _conditionsMet,
  findMatchingRule as _findMatchingRule,
  evaluateToolCall as _evaluateToolCall,
  DEFAULT_RULES,
};
