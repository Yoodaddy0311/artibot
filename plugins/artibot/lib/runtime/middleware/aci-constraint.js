/**
 * ACI Constraint Middleware.
 * Enforces role-based tool and output restrictions per agent type,
 * improving LLM accuracy by narrowing the action space.
 * Source: SWE-Agent (Princeton NLP) ACI pattern.
 *
 * @module lib/runtime/middleware/aci-constraint
 */

import { emit } from '../../core/event-bus.js';

// ---------------------------------------------------------------------------
// Role constraint definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RoleConstraint
 * @property {string[]} tools - Allowed tool names
 * @property {boolean} [readOnly] - If true, agent is read-only
 * @property {RegExp} [bashPattern] - Regex to validate Bash commands
 */

/** @type {Readonly<Record<string, RoleConstraint>>} */
const ROLE_CONSTRAINTS = Object.freeze({
  'tdd-guide': Object.freeze({
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    bashPattern: /test|vitest|jest|npm test|npx vitest|npx jest|npm run test/,
  }),
  'security-reviewer': Object.freeze({
    tools: ['Read', 'Grep', 'Glob'],
    readOnly: true,
  }),
  'code-reviewer': Object.freeze({
    tools: ['Read', 'Grep', 'Glob'],
    readOnly: true,
  }),
  'spec-reviewer': Object.freeze({
    tools: ['Read', 'Grep', 'Glob'],
    readOnly: true,
  }),
  'quality-reviewer': Object.freeze({
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    readOnly: true,
  }),
  'doc-updater': Object.freeze({
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  }),
  'data-analyst': Object.freeze({
    tools: ['Read', 'Write', 'Glob', 'Grep', 'Bash'],
  }),
  'planner': Object.freeze({
    tools: ['Read', 'Grep', 'Glob'],
  }),
  'architect': Object.freeze({
    tools: ['Read', 'Glob', 'Grep'],
  }),
});

// ---------------------------------------------------------------------------
// Helpers (pure, no side effects)
// ---------------------------------------------------------------------------

/**
 * Resolve the constraint set for a given agent role.
 * Returns null for unknown roles (default = unconstrained).
 *
 * @param {string} role
 * @param {Record<string, RoleConstraint>} [overrides]
 * @returns {RoleConstraint | null}
 */
function resolveConstraints(role, overrides) {
  if (overrides && overrides[role]) {
    return overrides[role];
  }
  return ROLE_CONSTRAINTS[role] || null;
}

/**
 * Build the ACI constraint info object attached to state.context.
 *
 * @param {string} role
 * @param {RoleConstraint | null} constraint
 * @returns {object}
 */
function buildConstraintInfo(role, constraint) {
  if (!constraint) {
    return {
      applied: false,
      role,
      reason: 'no constraints defined — full access',
    };
  }

  return {
    applied: true,
    role,
    allowedTools: [...constraint.tools],
    readOnly: Boolean(constraint.readOnly),
    hasBashPattern: Boolean(constraint.bashPattern),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ACI constraint middleware that restricts tools based on agent role.
 *
 * @param {object} [options]
 * @param {Record<string, RoleConstraint>} [options.roleOverrides] - Extra or override role constraints.
 * @param {boolean} [options.enabled=true] - Disable middleware entirely.
 * @returns {(state: object, next: Function) => Promise<object>}
 */
export function createAciConstraintMiddleware(options = {}) {
  const { roleOverrides, enabled = true } = options;

  return async function aciConstraint(state, next) {
    if (!enabled) {
      state.context.aciConstraints = { applied: false, reason: 'middleware disabled' };
      return typeof next === 'function' ? next(state) : state;
    }

    const role = state.agent?.type
      || state.context?.agent?.type
      || state.context?.subagents?.contract?.agentType
      || null;

    if (!role) {
      state.context.aciConstraints = { applied: false, reason: 'no agent role detected' };
      state.messageParts.push('aci=skip');
      return typeof next === 'function' ? next(state) : state;
    }

    const constraint = resolveConstraints(role, roleOverrides);
    const info = buildConstraintInfo(role, constraint);

    state.context.aciConstraints = info;

    if (constraint) {
      state.context.allowedTools = [...constraint.tools];

      if (constraint.readOnly) {
        state.context.readOnly = true;
      }

      if (constraint.bashPattern) {
        state.context.bashPattern = constraint.bashPattern;
      }

      state.messageParts.push(`aci=${role}:${constraint.tools.length}tools`);
    } else {
      state.messageParts.push('aci=default');
    }

    emit('feature:aci-applied', { role, constraints: info });

    return typeof next === 'function' ? next(state) : state;
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  ROLE_CONSTRAINTS,
  resolveConstraints as _resolveConstraints,
  buildConstraintInfo as _buildConstraintInfo,
};
