/**
 * DAG-based task orchestration.
 * Directed Acyclic Graph for modeling task dependencies and execution ordering.
 *
 * @module lib/orchestration/dag
 */

// ---------------------------------------------------------------------------
// Dag class
// ---------------------------------------------------------------------------

/**
 * Directed Acyclic Graph for task dependency management.
 *
 * Nodes represent tasks; edges represent "depends on" relationships.
 * All methods are non-mutating on returned collections — callers receive
 * fresh arrays/sets so they cannot corrupt internal state.
 */
export class Dag {
  /** @type {Map<string, Set<string>>} node → direct dependencies */
  #deps;

  /** @type {Map<string, Set<string>>} node → direct dependents (reverse edges) */
  #dependents;

  constructor() {
    this.#deps = new Map();
    this.#dependents = new Map();
  }

  /** @returns {number} Total node count */
  get size() {
    return this.#deps.size;
  }

  /** @returns {string[]} All node ids (insertion order) */
  get nodes() {
    return [...this.#deps.keys()];
  }

  /**
   * Add a node with optional dependencies.
   * Idempotent for the node itself; new dependencies are merged.
   *
   * @param {string} id - Unique node identifier
   * @param {string[]} dependsOn - Ids this node depends on
   * @returns {this} For chaining
   */
  add(id, dependsOn = []) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Node id must be a non-empty string');
    }

    if (!this.#deps.has(id)) {
      this.#deps.set(id, new Set());
      this.#dependents.set(id, new Set());
    }

    for (const dep of dependsOn) {
      if (typeof dep !== 'string' || dep.length === 0) {
        throw new Error(`Dependency id must be a non-empty string, got: "${dep}"`);
      }
      // Auto-register dependency node if missing
      if (!this.#deps.has(dep)) {
        this.#deps.set(dep, new Set());
        this.#dependents.set(dep, new Set());
      }
      this.#deps.get(id).add(dep);
      this.#dependents.get(dep).add(id);
    }

    return this;
  }

  /**
   * Get direct dependencies of a node.
   *
   * @param {string} id
   * @returns {string[]}
   */
  dependencies(id) {
    const deps = this.#deps.get(id);
    if (!deps) {
      throw new Error(`Unknown node: "${id}"`);
    }
    return [...deps];
  }

  /**
   * Get all ancestor nodes (transitive dependencies) via BFS.
   *
   * @param {string} id
   * @returns {string[]}
   */
  ancestors(id) {
    if (!this.#deps.has(id)) {
      throw new Error(`Unknown node: "${id}"`);
    }

    const visited = new Set();
    const queue = [...this.#deps.get(id)];

    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const parents = this.#deps.get(current);
      if (parents) {
        for (const p of parents) {
          if (!visited.has(p)) queue.push(p);
        }
      }
    }

    return [...visited];
  }

  /**
   * Detect cycles using DFS with coloring.
   * White (unvisited) → Grey (in-stack) → Black (done).
   *
   * @returns {boolean} true if a cycle exists
   */
  detectCycles() {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map();

    for (const node of this.#deps.keys()) {
      color.set(node, WHITE);
    }

    const hasCycle = (node) => {
      color.set(node, GREY);
      const deps = this.#deps.get(node);
      if (deps) {
        for (const dep of deps) {
          const c = color.get(dep);
          if (c === GREY) return true;
          if (c === WHITE && hasCycle(dep)) return true;
        }
      }
      color.set(node, BLACK);
      return false;
    };

    for (const node of this.#deps.keys()) {
      if (color.get(node) === WHITE && hasCycle(node)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Kahn's algorithm for topological sort.
   * Returns nodes in valid execution order (dependencies first).
   *
   * @returns {string[]}
   * @throws {Error} If the graph contains a cycle
   */
  topologicalSort() {
    const inDegree = new Map();
    for (const [node, deps] of this.#deps) {
      inDegree.set(node, deps.size);
    }

    const queue = [];
    for (const [node, deg] of inDegree) {
      if (deg === 0) queue.push(node);
    }

    const sorted = [];
    while (queue.length > 0) {
      const node = queue.shift();
      sorted.push(node);
      const children = this.#dependents.get(node);
      if (children) {
        for (const child of children) {
          const newDeg = inDegree.get(child) - 1;
          inDegree.set(child, newDeg);
          if (newDeg === 0) queue.push(child);
        }
      }
    }

    if (sorted.length !== this.#deps.size) {
      throw new Error('Cycle detected: topological sort is not possible');
    }

    return sorted;
  }

  /**
   * Get nodes whose dependencies are all satisfied (ready to execute).
   *
   * @param {Set<string>} completed - Set of already-completed node ids
   * @returns {string[]} Nodes that can be started now
   */
  getReady(completed = new Set()) {
    const ready = [];
    for (const [node, deps] of this.#deps) {
      if (completed.has(node)) continue;
      let allMet = true;
      for (const dep of deps) {
        if (!completed.has(dep)) {
          allMet = false;
          break;
        }
      }
      if (allMet) ready.push(node);
    }
    return ready;
  }

  /**
   * Propagate a skip: when a node is skipped, all downstream nodes
   * that transitively depend on it (and have no alternative path) are
   * also marked as skipped.
   *
   * Returns the full set of nodes to skip (including the original).
   *
   * @param {string} skippedId - The node being skipped
   * @returns {string[]} All nodes that should be skipped
   */
  skipPropagate(skippedId) {
    if (!this.#deps.has(skippedId)) {
      throw new Error(`Unknown node: "${skippedId}"`);
    }

    const skipped = new Set([skippedId]);
    const queue = [...(this.#dependents.get(skippedId) || [])];

    while (queue.length > 0) {
      const candidate = queue.shift();
      if (skipped.has(candidate)) continue;

      const deps = this.#deps.get(candidate);
      const allDepsSkipped = deps && [...deps].every((d) => skipped.has(d));

      if (allDepsSkipped) {
        skipped.add(candidate);
        const children = this.#dependents.get(candidate);
        if (children) {
          for (const child of children) {
            if (!skipped.has(child)) queue.push(child);
          }
        }
      }
    }

    return [...skipped];
  }
}
