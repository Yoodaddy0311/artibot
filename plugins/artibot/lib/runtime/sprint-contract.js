/**
 * Sprint Contract.
 * Pre-agreement protocol between implementation and evaluation agents
 * on "done" criteria before work begins.
 * Source: Anthropic Harness Design blog.
 *
 * @module lib/runtime/sprint-contract
 */

import { emit } from '../core/event-bus.js';

// ---------------------------------------------------------------------------
// ID generation (deterministic in tests via options.idGenerator)
// ---------------------------------------------------------------------------

let counter = 0;

/**
 * Generate a unique ID for contract/criterion.
 * @returns {string}
 */
function defaultIdGenerator() {
  counter += 1;
  return `sc-${Date.now()}-${counter}`;
}

// ---------------------------------------------------------------------------
// Contract lifecycle
// ---------------------------------------------------------------------------

/**
 * Valid status transitions.
 * @type {Readonly<Record<string, string[]>>}
 */
const VALID_TRANSITIONS = Object.freeze({
  draft: ['agreed'],
  agreed: ['in_progress'],
  in_progress: ['evaluated'],
  evaluated: [],
});

/**
 * Create a new sprint contract in draft state.
 *
 * @param {string} taskDescription
 * @param {object} [options]
 * @param {Function} [options.idGenerator] - Custom ID generator for deterministic tests.
 * @param {() => string} [options.now] - Clock injection.
 * @returns {object}
 */
export function createSprintContract(taskDescription, options = {}) {
  const genId = options.idGenerator || defaultIdGenerator;
  const now = options.now || (() => new Date().toISOString());

  const contract = Object.freeze({
    taskId: genId(),
    description: String(taskDescription || ''),
    criteria: Object.freeze([]),
    testable: Object.freeze([]),
    boundaries: Object.freeze([]),
    createdAt: now(),
    status: 'draft',
  });

  emit('feature:sprint-contract', { action: 'created', taskId: contract.taskId });

  return contract;
}

/**
 * Add a criterion to a contract (immutable).
 *
 * @param {object} contract
 * @param {object} criterion - { description, type?, weight? }
 * @param {object} [options]
 * @param {Function} [options.idGenerator]
 * @returns {object} New contract with criterion added
 */
export function addCriterion(contract, criterion, options = {}) {
  if (!criterion || !criterion.description) {
    throw new Error('Criterion must have a description');
  }

  const genId = options.idGenerator || defaultIdGenerator;

  const newCriterion = Object.freeze({
    id: genId(),
    description: criterion.description,
    type: criterion.type || 'functional',
    weight: criterion.weight ?? 1,
  });

  return Object.freeze({
    ...contract,
    criteria: Object.freeze([...contract.criteria, newCriterion]),
  });
}

/**
 * Add a testable behavior to a contract (immutable).
 *
 * @param {object} contract
 * @param {string} behavior
 * @returns {object}
 */
export function addTestable(contract, behavior) {
  if (!behavior || typeof behavior !== 'string') {
    throw new Error('Testable behavior must be a non-empty string');
  }

  return Object.freeze({
    ...contract,
    testable: Object.freeze([...contract.testable, behavior]),
  });
}

/**
 * Add a boundary constraint to a contract (immutable).
 *
 * @param {object} contract
 * @param {string} boundary
 * @returns {object}
 */
export function addBoundary(contract, boundary) {
  if (!boundary || typeof boundary !== 'string') {
    throw new Error('Boundary must be a non-empty string');
  }

  return Object.freeze({
    ...contract,
    boundaries: Object.freeze([...contract.boundaries, boundary]),
  });
}

/**
 * Transition a contract to 'agreed' status.
 * Requires at least 1 criterion.
 *
 * @param {object} contract
 * @param {object} [options]
 * @param {() => string} [options.now]
 * @returns {object}
 */
export function agreeContract(contract, options = {}) {
  validateTransition(contract.status, 'agreed');

  if (contract.criteria.length === 0) {
    throw new Error('Cannot agree on a contract with no criteria');
  }

  const now = options.now || (() => new Date().toISOString());

  const agreed = Object.freeze({
    ...contract,
    status: 'agreed',
    agreedAt: now(),
  });

  emit('feature:sprint-contract', { action: 'agreed', taskId: contract.taskId });

  return agreed;
}

/**
 * Transition a contract to 'in_progress' status.
 *
 * @param {object} contract
 * @param {object} [options]
 * @param {() => string} [options.now]
 * @returns {object}
 */
export function startContract(contract, options = {}) {
  validateTransition(contract.status, 'in_progress');

  const now = options.now || (() => new Date().toISOString());

  const started = Object.freeze({
    ...contract,
    status: 'in_progress',
    startedAt: now(),
  });

  emit('feature:sprint-contract', { action: 'started', taskId: contract.taskId });

  return started;
}

/**
 * Evaluate a contract against results.
 *
 * @param {object} contract
 * @param {Array<{ criterionId: string, passed: boolean, evidence?: string }>} results
 * @param {object} [options]
 * @param {() => string} [options.now]
 * @returns {object}
 */
export function evaluateContract(contract, results, options = {}) {
  validateTransition(contract.status, 'evaluated');

  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Results must be a non-empty array');
  }

  const now = options.now || (() => new Date().toISOString());

  const frozenResults = Object.freeze(
    results.map((r) => Object.freeze({ ...r })),
  );

  const passed = frozenResults.filter((r) => r.passed).length;

  const evaluated = Object.freeze({
    ...contract,
    status: 'evaluated',
    results: frozenResults,
    passRate: passed / frozenResults.length,
    passCount: passed,
    failCount: frozenResults.length - passed,
    evaluatedAt: now(),
  });

  emit('feature:sprint-contract', {
    action: 'evaluated',
    taskId: contract.taskId,
    passRate: evaluated.passRate,
  });

  return evaluated;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a status transition.
 *
 * @param {string} currentStatus
 * @param {string} targetStatus
 * @throws {Error} If transition is invalid
 */
function validateTransition(currentStatus, targetStatus) {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new Error(
      `Invalid transition: "${currentStatus}" → "${targetStatus}"`,
    );
  }
}

/**
 * Reset the internal counter (for tests).
 */
export function _resetCounter() {
  counter = 0;
}

export { VALID_TRANSITIONS };
