/**
 * Agent frontmatter schema + validator.
 *
 * Pure ESM module defining the Phase 2 WS-B.1 agent frontmatter contract.
 * Artibot agents (agents/*.md) now carry `capabilities` and `lifecycle`
 * metadata so the team router can match tasks to agents deterministically.
 *
 * Zero runtime deps (Artibot policy). Mirrors skill-hash.js style.
 *
 * @module lib/core/agent-frontmatter-schema
 */

/**
 * Allowed lifecycle phase tags. `null` is the sentinel string for agents
 * that operate cross-phase (orchestrator, repo-benchmarker).
 */
export const LIFECYCLE_VALUES = Object.freeze([
  'spec',
  'plan',
  'build',
  'verify',
  'review',
  'ship',
  'marketing',
  'design',
  'null',
]);

/**
 * Schema descriptor for agent frontmatter fields.
 * Consumers can introspect `required` / `optional` lists for docs/UI.
 */
export const AGENT_FRONTMATTER_SCHEMA = Object.freeze({
  required: Object.freeze({
    name: 'string',
    description: 'string',
    capabilities: 'string[] (non-empty)',
  }),
  optional: Object.freeze({
    lifecycle: `enum<${LIFECYCLE_VALUES.join('|')}>`,
    enabled_if: 'string',
    model: 'string',
    tools: 'string[]',
    color: 'string',
  }),
});

/**
 * Type guard — returns true when `value` is a plain non-null object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the `name` field.
 *
 * @param {unknown} name
 * @param {string[]} errors
 */
function checkName(name, errors) {
  if (typeof name !== 'string' || name.trim() === '') {
    errors.push('name: required non-empty string');
  }
}

/**
 * Validate the `description` field.
 *
 * @param {unknown} description
 * @param {string[]} errors
 */
function checkDescription(description, errors) {
  if (typeof description !== 'string' || description.trim() === '') {
    errors.push('description: required non-empty string');
  }
}

/**
 * Validate the `capabilities` field.
 *
 * @param {unknown} capabilities
 * @param {string[]} errors
 */
function checkCapabilities(capabilities, errors) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    errors.push('capabilities: required non-empty array');
    return;
  }
  for (const cap of capabilities) {
    if (typeof cap !== 'string' || cap.trim() === '') {
      errors.push('capabilities: all entries must be non-empty strings');
      return;
    }
  }
}

/**
 * Validate optional fields if present.
 *
 * @param {Record<string, unknown>} fm
 * @param {string[]} errors
 */
function checkOptional(fm, errors) {
  if ('lifecycle' in fm && fm.lifecycle !== undefined) {
    if (typeof fm.lifecycle !== 'string' || !LIFECYCLE_VALUES.includes(fm.lifecycle)) {
      errors.push(`lifecycle: must be one of ${LIFECYCLE_VALUES.join('|')}`);
    }
  }
  if ('enabled_if' in fm && fm.enabled_if !== undefined && typeof fm.enabled_if !== 'string') {
    errors.push('enabled_if: must be a string');
  }
  if ('model' in fm && fm.model !== undefined && typeof fm.model !== 'string') {
    errors.push('model: must be a string');
  }
  if ('tools' in fm && fm.tools !== undefined && !Array.isArray(fm.tools)) {
    errors.push('tools: must be an array');
  }
  if ('color' in fm && fm.color !== undefined && typeof fm.color !== 'string') {
    errors.push('color: must be a string');
  }
}

/**
 * Validate an agent frontmatter object against the schema.
 * Never throws — always returns a result object.
 *
 * @param {unknown} fm - Parsed frontmatter (plain object).
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateFrontmatter(fm) {
  const errors = [];
  if (!isPlainObject(fm)) {
    return { valid: false, errors: ['frontmatter: must be a non-null object'] };
  }
  const record = /** @type {Record<string, unknown>} */ (fm);
  checkName(record.name, errors);
  checkDescription(record.description, errors);
  checkCapabilities(record.capabilities, errors);
  checkOptional(record, errors);
  return { valid: errors.length === 0, errors };
}
