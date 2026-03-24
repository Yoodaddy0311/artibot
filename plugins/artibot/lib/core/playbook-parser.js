/**
 * Playbook string parser for Artibot orchestration workflows.
 * Converts playbook strings like "[leader] plan -> [council] design -> ..." into
 * structured phase objects. Also supports DAG-based playbooks with parallel
 * execution and dependency management.
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
// Types (JSDoc only)
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
 * @typedef {object} DagNode
 * @property {string} id - Unique node identifier
 * @property {string} action - Phase action
 * @property {string} [agent] - Assigned agent name
 * @property {string} [pattern] - Orchestration pattern
 * @property {boolean} [parallel] - Whether this node can run in parallel with siblings
 * @property {string[]} [dependsOn] - IDs of nodes that must complete before this one
 * @property {string} [condition] - Optional condition expression for conditional branching
 */

/**
 * @typedef {object} DagPlaybook
 * @property {string} name - Playbook name
 * @property {DagNode[]} nodes - DAG nodes
 * @property {PlaybookPhase[]} phases - Flattened phases (for backward compat)
 * @property {boolean} isDag - Always true for DAG playbooks
 */

// ---------------------------------------------------------------------------
// Legacy string parser (Public API — unchanged)
// ---------------------------------------------------------------------------

/**
 * Parse a playbook string into a structured playbook object.
 * Also accepts an already-parsed playbook object or DAG object for backward compatibility.
 *
 * Format: "[pattern] action -> [pattern] action -> ..."
 *
 * @param {string|Playbook|object} playbookInput - Playbook string, already-parsed object, or DAG object
 * @returns {Playbook} Parsed playbook with phases array
 * @example
 * const pb = parsePlaybook('[leader] plan -> [swarm] implement -> [leader] merge');
 * // { phases: [{ order: 0, pattern: 'leader', action: 'plan', label: 'plan' }, ...] }
 */
export function parsePlaybook(playbookInput) {
  // Backward compatibility: already-parsed object with phases
  if (playbookInput && typeof playbookInput === 'object' && Array.isArray(playbookInput.phases)) {
    return playbookInput;
  }

  // DAG format: object with nodes array
  if (playbookInput && typeof playbookInput === 'object' && Array.isArray(playbookInput.nodes)) {
    return parseDagPlaybook(playbookInput);
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

// ---------------------------------------------------------------------------
// DAG Parser
// ---------------------------------------------------------------------------

/**
 * Parse a DAG playbook object into a structured playbook with both nodes and phases.
 *
 * @param {object} dagInput - DAG object with nodes array
 * @returns {DagPlaybook} Parsed DAG playbook
 */
export function parseDagPlaybook(dagInput) {
  if (!dagInput || typeof dagInput !== 'object' || !Array.isArray(dagInput.nodes)) {
    return { phases: [], nodes: [], isDag: true };
  }

  const nodes = dagInput.nodes.map((node) => ({
    id: node.id || '',
    action: (node.action || '').toLowerCase(),
    agent: node.agent || undefined,
    pattern: node.pattern ? node.pattern.toLowerCase() : undefined,
    parallel: node.parallel === true,
    dependsOn: Array.isArray(node.dependsOn) ? [...node.dependsOn] : [],
    condition: node.condition || undefined,
  }));

  // Convert to phases via topological order for backward compat
  const ordered = topologicalSort(nodes);
  const phases = ordered.map((node, index) => ({
    order: index,
    pattern: node.pattern || 'swarm',
    action: node.action,
    label: node.action,
  }));

  return {
    name: dagInput.name || '',
    nodes,
    phases,
    isDag: true,
  };
}

/**
 * Validate a DAG playbook, including cycle detection and reference integrity.
 *
 * @param {DagPlaybook} dagPlaybook - DAG playbook to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDagPlaybook(dagPlaybook) {
  const errors = [];

  if (!dagPlaybook || typeof dagPlaybook !== 'object') {
    return { valid: false, errors: ['DAG playbook must be an object'] };
  }

  if (!Array.isArray(dagPlaybook.nodes)) {
    return { valid: false, errors: ['DAG playbook must have a nodes array'] };
  }

  if (dagPlaybook.nodes.length === 0) {
    return { valid: false, errors: ['DAG playbook must have at least 1 node'] };
  }

  const nodeIds = new Set();
  for (const node of dagPlaybook.nodes) {
    if (!node.id || typeof node.id !== 'string') {
      errors.push('Each node must have a non-empty string id');
      continue;
    }
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: '${node.id}'`);
    }
    nodeIds.add(node.id);

    if (!node.action || typeof node.action !== 'string') {
      errors.push(`Node '${node.id}': action is required`);
    }
  }

  // Check dependsOn references
  for (const node of dagPlaybook.nodes) {
    if (!Array.isArray(node.dependsOn)) continue;
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) {
        errors.push(`Node '${node.id}': dependsOn references unknown node '${dep}'`);
      }
    }
  }

  // Cycle detection
  if (errors.length === 0) {
    const cycle = detectCycle(dagPlaybook.nodes);
    if (cycle) {
      errors.push(`Cycle detected: ${cycle.join(' -> ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// DAG Utilities
// ---------------------------------------------------------------------------

/**
 * Detect cycles in a DAG. Returns the cycle path if found, null otherwise.
 *
 * @param {DagNode[]} nodes - DAG nodes
 * @returns {string[]|null} Cycle path or null
 */
export function detectCycle(nodes) {
  const adjacency = new Map();
  for (const node of nodes) {
    adjacency.set(node.id, node.dependsOn || []);
  }

  const visited = new Set();
  const inStack = new Set();
  const path = [];

  for (const node of nodes) {
    const cycle = dfsDetectCycle(node.id, adjacency, visited, inStack, path);
    if (cycle) return cycle;
  }

  return null;
}

function dfsDetectCycle(nodeId, adjacency, visited, inStack, path) {
  if (inStack.has(nodeId)) {
    const cycleStart = path.indexOf(nodeId);
    return [...path.slice(cycleStart), nodeId];
  }
  if (visited.has(nodeId)) return null;

  visited.add(nodeId);
  inStack.add(nodeId);
  path.push(nodeId);

  const deps = adjacency.get(nodeId) || [];
  for (const dep of deps) {
    const cycle = dfsDetectCycle(dep, adjacency, visited, inStack, path);
    if (cycle) return cycle;
  }

  inStack.delete(nodeId);
  path.pop();
  return null;
}

/**
 * Topological sort of DAG nodes using Kahn's algorithm.
 * Returns nodes in execution order (dependencies first).
 *
 * @param {DagNode[]} nodes - DAG nodes
 * @returns {DagNode[]} Topologically sorted nodes
 */
export function topologicalSort(nodes) {
  if (!nodes || nodes.length === 0) return [];

  const nodeMap = new Map();
  const inDegree = new Map();
  const adjacency = new Map();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  // Build reverse adjacency: for each dep, that dep has an outgoing edge to this node
  for (const node of nodes) {
    const deps = node.dependsOn || [];
    for (const dep of deps) {
      if (adjacency.has(dep)) {
        adjacency.get(dep).push(node.id);
      }
      inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
    }
  }

  const queue = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    // Sort queue for deterministic output
    queue.sort();
    const current = queue.shift();
    sorted.push(nodeMap.get(current));

    for (const neighbor of adjacency.get(current) || []) {
      const newDegree = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

/**
 * Get execution order as an array of node IDs respecting dependencies.
 *
 * @param {DagNode[]} nodes - DAG nodes
 * @returns {string[]} Ordered node IDs
 */
export function getExecutionOrder(nodes) {
  return topologicalSort(nodes).map((n) => n.id);
}

/**
 * Get parallel execution groups. Each group contains nodes that can run
 * concurrently (same topological level and parallel-eligible).
 *
 * @param {DagNode[]} nodes - DAG nodes
 * @returns {string[][]} Array of groups, each group is an array of node IDs
 */
export function getParallelGroups(nodes) {
  if (!nodes || nodes.length === 0) return [];

  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Compute topological levels
  const levels = new Map();

  function getLevel(nodeId) {
    if (levels.has(nodeId)) return levels.get(nodeId);

    const node = nodeMap.get(nodeId);
    const deps = node?.dependsOn || [];
    if (deps.length === 0) {
      levels.set(nodeId, 0);
      return 0;
    }

    let maxDepLevel = 0;
    for (const dep of deps) {
      if (nodeMap.has(dep)) {
        maxDepLevel = Math.max(maxDepLevel, getLevel(dep) + 1);
      }
    }
    levels.set(nodeId, maxDepLevel);
    return maxDepLevel;
  }

  for (const node of nodes) {
    getLevel(node.id);
  }

  // Group by level
  const groupMap = new Map();
  for (const node of nodes) {
    const level = levels.get(node.id);
    if (!groupMap.has(level)) groupMap.set(level, []);
    groupMap.get(level).push(node.id);
  }

  // Sort by level and return
  const sortedLevels = [...groupMap.keys()].sort((a, b) => a - b);
  return sortedLevels.map((level) => groupMap.get(level).sort());
}
