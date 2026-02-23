/**
 * Playbook string parser for Artibot orchestration workflows.
 * Converts playbook strings like "[leader] plan -> [council] design -> ..." into
 * structured phase objects.
 *
 * Zero runtime dependencies. ESM only.
 * @module lib/core/playbook-parser
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Known orchestration patterns */
export const KNOWN_PATTERNS = new Set(['leader', 'council', 'swarm', 'pipeline', 'watchdog']);

/** Known phase actions */
export const KNOWN_ACTIONS = new Set([
  'plan', 'design', 'implement', 'review', 'merge',
  'analyze', 'fix', 'verify', 'scan', 'assess',
  'refactor', 'test', 'strategy', 'create', 'launch',
  'optimize', 'publish', 'research', 'synthesize', 'report',
]);

/** Regex to match a single phase token: [pattern] action */
const PHASE_REGEX = /^\[([^\]]+)\]\s+(\S+)$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PlaybookPhase
 * @property {number} order - Zero-based index of this phase
 * @property {string} pattern - Orchestration pattern (e.g. 'leader', 'swarm')
 * @property {string} action - Phase action (e.g. 'plan', 'implement')
 * @property {string} label - Display label (same as action)
 */

/**
 * @typedef {object} Playbook
 * @property {PlaybookPhase[]} phases - Ordered list of phases
 */

/**
 * Parse a playbook string into a structured playbook object.
 * Also accepts an already-parsed playbook object for backward compatibility.
 *
 * Format: "[pattern] action -> [pattern] action -> ..."
 *
 * @param {string|Playbook} playbookInput - Playbook string or already-parsed object
 * @returns {Playbook} Parsed playbook with phases array
 * @example
 * const pb = parsePlaybook('[leader] plan -> [swarm] implement -> [leader] merge');
 * // { phases: [{ order: 0, pattern: 'leader', action: 'plan', label: 'plan' }, ...] }
 */
export function parsePlaybook(playbookInput) {
  // Backward compatibility: already-parsed object
  if (playbookInput && typeof playbookInput === 'object' && Array.isArray(playbookInput.phases)) {
    return playbookInput;
  }

  if (!playbookInput || typeof playbookInput !== 'string') {
    return { phases: [] };
  }

  const raw = playbookInput.trim();
  if (!raw) {
    return { phases: [] };
  }

  const segments = raw.split('->').map((s) => s.trim()).filter(Boolean);
  const phases = segments.map((segment, index) => {
    const match = PHASE_REGEX.exec(segment);
    if (!match) {
      return null;
    }
    const pattern = match[1].trim().toLowerCase();
    const action = match[2].trim().toLowerCase();
    return {
      order: index,
      pattern,
      action,
      label: action,
    };
  }).filter(Boolean);

  return { phases };
}

/**
 * Validate a parsed playbook object.
 *
 * @param {Playbook} playbook - Playbook object to validate
 * @returns {{ valid: boolean, errors: string[] }}
 * @example
 * const pb = parsePlaybook('[leader] plan -> [unknown] do');
 * const result = validatePlaybook(pb);
 * // { valid: false, errors: ["Phase 1: unknown pattern 'unknown'"] }
 */
export function validatePlaybook(playbook) {
  const errors = [];

  if (!playbook || typeof playbook !== 'object') {
    return { valid: false, errors: ['Playbook must be an object'] };
  }

  if (!Array.isArray(playbook.phases)) {
    return { valid: false, errors: ['Playbook must have a phases array'] };
  }

  if (playbook.phases.length === 0) {
    errors.push('Playbook must have at least 1 phase');
    return { valid: false, errors };
  }

  for (const phase of playbook.phases) {
    const idx = phase.order ?? '?';

    if (!phase.pattern || typeof phase.pattern !== 'string') {
      errors.push(`Phase ${idx}: pattern is required`);
    } else if (!KNOWN_PATTERNS.has(phase.pattern)) {
      errors.push(`Phase ${idx}: unknown pattern '${phase.pattern}'`);
    }

    if (!phase.action || typeof phase.action !== 'string' || !phase.action.trim()) {
      errors.push(`Phase ${idx}: action must be a non-empty string`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Serialize a playbook object back to a string.
 *
 * @param {Playbook} playbook - Playbook object to serialize
 * @returns {string} Playbook string in "[pattern] action -> ..." format
 * @example
 * const pb = { phases: [{ pattern: 'leader', action: 'plan', order: 0, label: 'plan' }] };
 * serializePlaybook(pb);
 * // '[leader] plan'
 */
export function serializePlaybook(playbook) {
  if (!playbook || !Array.isArray(playbook.phases)) {
    return '';
  }

  return playbook.phases
    .map((phase) => `[${phase.pattern}] ${phase.action}`)
    .join(' -> ');
}
