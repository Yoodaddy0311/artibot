/**
 * Lifecycle router — pure routing from lifecycle id + context to
 * `{agent, toolset, skills}`.
 *
 * Phase 2 WS-A.2 — Lifecycle Router (no cognitive integration yet).
 *
 * The router is a thin, pure layer over {@link module:lib/core/lifecycle-manifest}.
 * It never throws on missing lifecycles — callers receive `null` or a safe
 * default so upstream pipelines can degrade gracefully.
 *
 * @module lib/core/lifecycle-router
 */

import {
  getLifecycle,
  listLifecycles,
  matchContextToLifecycle,
} from './lifecycle-manifest.js';

/**
 * @typedef {object} RouteContext
 * @property {string} [hint] - Free-form user text used as a tiebreaker.
 * @property {string} [preferredAgent] - Agent name to pick if it is a candidate.
 * @property {string} [preferredToolset] - Toolset override (bypasses mapping).
 */

/**
 * @typedef {object} RouteResult
 * @property {string} lifecycle - Lifecycle id (e.g., `build`).
 * @property {string|null} agent - Selected agent name, or `null` when none.
 * @property {string|null} toolset - Toolset bucket, or `null` when unmapped.
 * @property {string[]} skills - Recommended skill names (may be empty).
 * @property {string[]} candidates - Candidate agent list from the manifest.
 */

/**
 * Static lifecycle → toolset mapping.
 * Kept inline (not data-driven) to preserve the "pure function" contract.
 * @type {Readonly<Record<string, string>>}
 */
const LIFECYCLE_TOOLSET = Object.freeze({
  build: 'code',
  verify: 'code',
  review: 'code',
  ship: 'devops',
  marketing: 'marketing',
  design: 'design',
  plan: 'team',
  spec: 'meta',
});

/**
 * Static lifecycle → skills mapping. Empty arrays are allowed — callers should
 * treat the list as advisory and merge with their own skill discovery.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const LIFECYCLE_SKILLS = Object.freeze({
  build: Object.freeze(['coding-standards', 'tdd-workflow']),
  verify: Object.freeze(['tdd-workflow']),
  review: Object.freeze(['coding-standards']),
  ship: Object.freeze([]),
  marketing: Object.freeze([]),
  design: Object.freeze([]),
  plan: Object.freeze(['principles']),
  spec: Object.freeze([]),
});

/**
 * Map a lifecycle id to its toolset bucket.
 *
 * @param {string} lifecycleId - Lifecycle key.
 * @returns {string|null} Toolset name, or `null` when unmapped.
 */
export function toolsetForLifecycle(lifecycleId) {
  if (!lifecycleId) return null;
  return LIFECYCLE_TOOLSET[lifecycleId] ?? null;
}

/**
 * Return a defensive copy of the skill list for a lifecycle.
 *
 * @param {string} lifecycleId - Lifecycle key.
 * @returns {string[]} Skill names, empty when none registered.
 */
export function skillsForLifecycle(lifecycleId) {
  const entry = LIFECYCLE_SKILLS[lifecycleId];
  return entry ? [...entry] : [];
}

/**
 * Pick the best agent for a lifecycle given user context.
 *
 * Priority: `context.preferredAgent` (if in candidates) > `default_agent` >
 * `null`. Never throws.
 *
 * @param {object} entry - Raw lifecycle entry from the manifest.
 * @param {RouteContext} [context] - Caller-provided routing context.
 * @returns {string|null} Agent name or `null`.
 */
function pickAgent(entry, context = {}) {
  const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
  const preferred = context.preferredAgent;
  if (preferred && candidates.includes(preferred)) {
    return preferred;
  }
  return entry?.default_agent ?? null;
}

/**
 * Route a lifecycle id + optional context to a `{agent, toolset, skills}`
 * result. Returns `null` when the lifecycle is unknown.
 *
 * @param {string} lifecycleId - Lifecycle key (e.g., `build`).
 * @param {RouteContext} [context] - Optional routing hints.
 * @returns {Promise<RouteResult|null>} Resolution, or `null` when unknown.
 */
export async function routeLifecycle(lifecycleId, context = {}) {
  if (!lifecycleId || typeof lifecycleId !== 'string') return null;
  const entry = await getLifecycle(lifecycleId);
  if (!entry) return null;
  const agent = pickAgent(entry, context);
  const toolset = context.preferredToolset ?? toolsetForLifecycle(lifecycleId);
  const skills = skillsForLifecycle(lifecycleId);
  const candidates = Array.isArray(entry.candidates) ? [...entry.candidates] : [];
  return { lifecycle: lifecycleId, agent, toolset, skills, candidates };
}

/**
 * Suggest the best lifecycle id for a free-form text. Thin wrapper around
 * {@link matchContextToLifecycle} that returns just the id (or `null`).
 *
 * @param {string} text - Free-form user input.
 * @returns {Promise<string|null>} Lifecycle id, or `null` when no match.
 */
export async function suggestLifecycle(text) {
  const match = await matchContextToLifecycle(text);
  return match?.lifecycle ?? null;
}

/**
 * Convenience combo: detect the lifecycle from text and route it. Returns
 * `null` when the text cannot be classified.
 *
 * @param {string} text - Free-form user input.
 * @param {RouteContext} [context] - Optional routing hints.
 * @returns {Promise<RouteResult|null>}
 */
export async function routeByContext(text, context = {}) {
  const lifecycleId = await suggestLifecycle(text);
  if (!lifecycleId) return null;
  return routeLifecycle(lifecycleId, { ...context, hint: text });
}

/**
 * List all lifecycle ids known to the router. Re-exported for convenience so
 * callers do not need to import two modules.
 *
 * @returns {Promise<string[]>}
 */
export async function listRoutableLifecycles() {
  return listLifecycles();
}
