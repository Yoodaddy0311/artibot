/**
 * Agent resolver shim — Phase 2 WS-B.3 additive integration layer.
 *
 * Wraps `lib/core/agent-registry.js` with a stable resolution API intended
 * for future runtime integration. This module is purely additive: no
 * existing file (cognitive/router.js, runtime/*) is modified. Consumers
 * opt in by importing this module directly.
 *
 * Feature flag: `process.env.ARTIBOT_AGENT_REGISTRY === 'enabled'`
 *   - Defaults to disabled. Kept as an opt-in signal so downstream code
 *     can gate migration behavior without branching on module presence.
 *
 * Design constraints:
 *   - Zero new deps
 *   - Pure resolution logic, no side effects beyond registry cache reads
 *   - Never throws: returns null or [] on miss
 *   - Korean-path safe (imports via relative specifier, no pathToFileURL)
 *
 * @module lib/runtime/agent-resolver
 */

import {
  filterAgents,
  getAgent,
  getAgentsForLifecycle,
} from '../core/agent-registry.js';

/** @typedef {import('../core/agent-registry.js').AgentEntry} AgentEntry */

/**
 * Resolution criteria for {@link pickBestAgent}.
 *
 * @typedef {object} PickCriteria
 * @property {string} [lifecycle] - Lifecycle phase filter (build/review/...).
 * @property {string} [capability] - Required capability string.
 * @property {string} [preferred] - Preferred agent name if it satisfies filters.
 */

/**
 * Telemetry stub. Swapped for a real emitter when runtime integration lands.
 * Kept as a no-op so importing this module has zero observable side effects.
 *
 * @param {string} _event
 * @param {object} [_payload]
 * @returns {void}
 */
function emit(_event, _payload) {
  // Intentional no-op. Future: wire to lib/core/event-bus.js.
}

/**
 * Resolve a single agent by exact name.
 *
 * @param {string} name
 * @returns {Promise<AgentEntry | null>}
 */
export async function resolveAgent(name) {
  if (typeof name !== 'string' || name.trim() === '') return null;
  try {
    const entry = await getAgent(name);
    emit('agent-resolver.resolve', { name, hit: Boolean(entry) });
    return entry;
  } catch {
    return null;
  }
}

/**
 * Resolve all agents belonging to a lifecycle phase.
 *
 * @param {string} lifecycle
 * @returns {Promise<AgentEntry[]>}
 */
export async function resolveAgentsByLifecycle(lifecycle) {
  if (typeof lifecycle !== 'string' || lifecycle.trim() === '') return [];
  try {
    const list = await getAgentsForLifecycle(lifecycle);
    emit('agent-resolver.by-lifecycle', { lifecycle, count: list.length });
    return list;
  } catch {
    return [];
  }
}

/**
 * Resolve all agents whose capabilities array includes the given string.
 *
 * @param {string} capability
 * @returns {Promise<AgentEntry[]>}
 */
export async function resolveAgentByCapability(capability) {
  if (typeof capability !== 'string' || capability.trim() === '') return [];
  try {
    const list = await filterAgents((a) =>
      Array.isArray(a.capabilities) && a.capabilities.includes(capability),
    );
    emit('agent-resolver.by-capability', { capability, count: list.length });
    return list;
  } catch {
    return [];
  }
}

/**
 * Apply criteria filters to a candidate list.
 *
 * @param {AgentEntry[]} list
 * @param {PickCriteria} criteria
 * @returns {AgentEntry[]}
 */
function applyCriteria(list, criteria) {
  let out = list;
  if (typeof criteria.lifecycle === 'string' && criteria.lifecycle.trim() !== '') {
    const target = criteria.lifecycle === 'null' ? null : criteria.lifecycle;
    out = out.filter((a) => a.lifecycle === target);
  }
  if (typeof criteria.capability === 'string' && criteria.capability.trim() !== '') {
    const cap = criteria.capability;
    out = out.filter(
      (a) => Array.isArray(a.capabilities) && a.capabilities.includes(cap),
    );
  }
  return out;
}

/**
 * Composite picker: filter by lifecycle/capability, then return the
 * preferred agent if it still satisfies the filters, otherwise the first
 * match. Returns null on empty result.
 *
 * @param {PickCriteria} [criteria]
 * @returns {Promise<AgentEntry | null>}
 */
export async function pickBestAgent(criteria = {}) {
  if (!criteria || typeof criteria !== 'object') return null;
  try {
    const all = await filterAgents(() => true);
    const candidates = applyCriteria(all, criteria);
    if (candidates.length === 0) return null;
    if (typeof criteria.preferred === 'string' && criteria.preferred.trim() !== '') {
      const match = candidates.find((a) => a.name === criteria.preferred);
      if (match) {
        emit('agent-resolver.pick', { picked: match.name, preferred: true });
        return match;
      }
    }
    const first = candidates[0];
    emit('agent-resolver.pick', { picked: first.name, preferred: false });
    return first;
  } catch {
    return null;
  }
}

/**
 * Check whether the registry-backed resolver is enabled via env var.
 * Defaults to `false` so importing this module is safe everywhere.
 *
 * @returns {boolean}
 */
export function isRegistryEnabled() {
  return process.env.ARTIBOT_AGENT_REGISTRY === 'enabled';
}
