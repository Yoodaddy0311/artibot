/**
 * Cross-session knowledge graph with adjacency-list storage.
 * Models relationships between files, functions, concepts, decisions,
 * and preferences as a directed graph with typed nodes and edges.
 *
 * @module lib/learning/knowledge-graph
 */

import path from 'node:path';
import { ARTIBOT_DIR } from '../core/config.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** @enum {string} Valid node types. */
export const NODE_TYPES = Object.freeze({
  FILE: 'FILE',
  FUNCTION: 'FUNCTION',
  CONCEPT: 'CONCEPT',
  DECISION: 'DECISION',
  PREFERENCE: 'PREFERENCE',
});

/** @enum {string} Valid edge relation types. */
export const EDGE_RELATIONS = Object.freeze({
  CONTAINS: 'CONTAINS',
  DECIDED_BECAUSE: 'DECIDED_BECAUSE',
  DEPENDS_ON: 'DEPENDS_ON',
  IMPLEMENTS: 'IMPLEMENTS',
  PREFERRED_OVER: 'PREFERRED_OVER',
  RELATED_TO: 'RELATED_TO',
  USED_BY: 'USED_BY',
});

const VALID_NODE_TYPES = new Set(Object.values(NODE_TYPES));
const VALID_EDGE_RELATIONS = new Set(Object.values(EDGE_RELATIONS));
const GRAPH_VERSION = 1;
const DEFAULT_STORAGE = path.join(ARTIBOT_DIR, 'knowledge-graph.json');
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @returns {object} Frozen shallow copy of a node. */
function freezeNode(node) {
  return Object.freeze({ ...node, data: Object.freeze({ ...node.data }) });
}

/** @returns {object} Frozen shallow copy of an edge. */
function freezeEdge(edge) {
  return Object.freeze({ ...edge, data: Object.freeze({ ...(edge.data || {}) }) });
}

/**
 * Build a searchable text blob from a node for keyword matching.
 * @param {object} node
 * @returns {string}
 */
function nodeSearchText(node) {
  const parts = [node.id, node.type];
  if (node.data) {
    for (const v of Object.values(node.data)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Score a node against space-separated keywords.
 * @param {string} text - Pre-computed lowercase search text.
 * @param {string[]} keywords
 * @returns {number}
 */
function scoreNode(text, keywords) {
  let score = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) score += 1;
  }
  return score;
}

/**
 * Compute weakly connected components count using iterative union-find.
 * @param {Map} entries - The adjacency-list map.
 * @returns {number}
 */
function countComponents(entries) {
  const parent = new Map();
  for (const id of entries.keys()) parent.set(id, id);

  function find(x) {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }

  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const [id, entry] of entries) {
    for (const edge of entry.outEdges) union(id, edge.to);
    for (const edge of entry.inEdges) union(id, edge.from);
  }

  const roots = new Set();
  for (const id of entries.keys()) roots.add(find(id));
  return roots.size;
}

/**
 * Check if an edge already exists (same from, to, relation).
 * @param {object[]} edges
 * @param {object} candidate
 * @returns {boolean}
 */
function edgeExists(edges, candidate) {
  return edges.some(
    (e) => e.from === candidate.from
      && e.to === candidate.to
      && e.relation === candidate.relation,
  );
}

// ---------------------------------------------------------------------------
// KnowledgeGraph class
// ---------------------------------------------------------------------------

class KnowledgeGraph {
  /** @param {object} [options] */
  constructor(options = {}) {
    this._storagePath = options.storagePath || DEFAULT_STORAGE;
    /** @type {Map<string, {node: object, outEdges: object[], inEdges: object[]}>} */
    this._entries = new Map();
  }

  /** @returns {string} */
  get storagePath() {
    return this._storagePath;
  }

  /**
   * Add or update a node.
   * @param {string} id
   * @param {string} type - Must be a value from NODE_TYPES.
   * @param {object} [data={}]
   * @returns {object} Frozen node record.
   */
  addNode(id, type, data = {}) {
    if (!id || typeof id !== 'string') throw new Error('Node id is required');
    if (!VALID_NODE_TYPES.has(type)) {
      throw new Error(`Invalid node type: ${type}`);
    }

    const now = Date.now();
    const existing = this._entries.get(id);

    if (existing) {
      const updated = {
        ...existing.node,
        type,
        data: { ...existing.node.data, ...data },
        updatedAt: now,
      };
      existing.node = updated;
      return freezeNode(updated);
    }

    const node = { id, type, data: { ...data }, createdAt: now, updatedAt: now };
    this._entries.set(id, { node, outEdges: [], inEdges: [] });
    return freezeNode(node);
  }

  /**
   * Add a directed edge between two existing nodes.
   * @param {string} from
   * @param {string} to
   * @param {string} relation - Must be a value from EDGE_RELATIONS.
   * @param {object} [data={}]
   * @returns {object} Frozen edge record.
   */
  addEdge(from, to, relation, data = {}) {
    if (!this._entries.has(from)) throw new Error(`Source node not found: ${from}`);
    if (!this._entries.has(to)) throw new Error(`Target node not found: ${to}`);
    if (!VALID_EDGE_RELATIONS.has(relation)) {
      throw new Error(`Invalid edge relation: ${relation}`);
    }

    const edge = { from, to, relation, data: { ...data }, createdAt: Date.now() };
    this._entries.get(from).outEdges.push(edge);
    this._entries.get(to).inEdges.push(edge);
    return freezeEdge(edge);
  }

  /**
   * BFS traversal returning a subgraph of reachable nodes and edges.
   * @param {string} nodeId
   * @param {number} [depth=2]
   * @returns {{ nodes: object[], edges: object[] }}
   */
  query(nodeId, depth = 2) {
    if (!this._entries.has(nodeId)) {
      return Object.freeze({ nodes: [], edges: [] });
    }

    const visited = new Set();
    const resultEdges = [];
    let frontier = [nodeId];
    visited.add(nodeId);

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next = [];
      for (const id of frontier) {
        const entry = this._entries.get(id);
        if (!entry) continue;
        for (const edge of [...entry.outEdges, ...entry.inEdges]) {
          resultEdges.push(freezeEdge(edge));
          const neighbor = edge.from === id ? edge.to : edge.from;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }

    const nodes = [...visited]
      .map((id) => this._entries.get(id))
      .filter(Boolean)
      .map((e) => freezeNode(e.node));

    return Object.freeze({ nodes, edges: resultEdges });
  }

  /**
   * Keyword-based search across all nodes.
   * @param {string} context - Space-separated keywords.
   * @param {number} [topK=10]
   * @returns {object[]} Frozen node copies, sorted by relevance descending.
   */
  findRelated(context, topK = 10) {
    if (!context || typeof context !== 'string') return [];

    const keywords = context.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    const scored = [];
    for (const entry of this._entries.values()) {
      const text = nodeSearchText(entry.node);
      const s = scoreNode(text, keywords);
      if (s > 0) scored.push({ node: entry.node, score: s });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => freezeNode(s.node));
  }

  /**
   * Merge an exported graph into this one.
   * @param {object} sessionGraph - Result of another graph's export().
   * @returns {{ added: number, updated: number }}
   */
  merge(sessionGraph) {
    if (!sessionGraph || !Array.isArray(sessionGraph.nodes)) {
      return Object.freeze({ added: 0, updated: 0 });
    }

    let added = 0;
    let updated = 0;

    for (const node of sessionGraph.nodes) {
      if (this._entries.has(node.id)) {
        this.addNode(node.id, node.type, node.data);
        updated++;
      } else {
        const created = { ...node, createdAt: node.createdAt || Date.now(), updatedAt: Date.now() };
        this._entries.set(node.id, { node: created, outEdges: [], inEdges: [] });
        added++;
      }
    }

    for (const edge of (sessionGraph.edges || [])) {
      if (!this._entries.has(edge.from) || !this._entries.has(edge.to)) continue;
      const entry = this._entries.get(edge.from);
      if (!edgeExists(entry.outEdges, edge)) {
        this.addEdge(edge.from, edge.to, edge.relation, edge.data || {});
      }
    }

    return Object.freeze({ added, updated });
  }

  /**
   * Remove nodes older than maxAgeDays and their edges.
   * @param {number} [maxAgeDays=90]
   * @returns {number} Count of pruned nodes.
   */
  prune(maxAgeDays = 90) {
    const cutoff = Date.now() - (maxAgeDays * MS_PER_DAY);
    const toRemove = [];

    for (const [id, entry] of this._entries) {
      if (entry.node.updatedAt < cutoff) toRemove.push(id);
    }

    for (const id of toRemove) this._removeNode(id);
    return toRemove.length;
  }

  /**
   * Serialize the graph to a JSON-safe object.
   * @returns {object}
   */
  export() {
    const nodes = [];
    const edges = [];

    for (const entry of this._entries.values()) {
      nodes.push({ ...entry.node, data: { ...entry.node.data } });
      for (const e of entry.outEdges) {
        edges.push({ ...e, data: { ...(e.data || {}) } });
      }
    }

    return Object.freeze({
      version: GRAPH_VERSION,
      nodes,
      edges,
      exportedAt: Date.now(),
    });
  }

  /**
   * Replace current state from an exported object.
   * @param {object} data - Previously exported graph data.
   */
  import(data) {
    if (!data || !Array.isArray(data.nodes)) {
      throw new Error('Invalid graph data: nodes array required');
    }

    this._entries.clear();

    for (const node of data.nodes) {
      const entry = {
        node: { ...node, data: { ...(node.data || {}) } },
        outEdges: [],
        inEdges: [],
      };
      this._entries.set(node.id, entry);
    }

    for (const edge of (data.edges || [])) {
      if (!this._entries.has(edge.from) || !this._entries.has(edge.to)) continue;
      const record = { ...edge, data: { ...(edge.data || {}) } };
      this._entries.get(edge.from).outEdges.push(record);
      this._entries.get(edge.to).inEdges.push(record);
    }
  }

  /**
   * Persist the current graph to disk at `storagePath`.
   * Writes the same shape `export()` produces so a later `import()` can
   * round-trip the result. Best-effort: parent dir is created first.
   *
   * @returns {Promise<{ path: string, nodeCount: number, edgeCount: number }>}
   */
  async save() {
    const snapshot = this.export();
    await ensureDir(path.dirname(this._storagePath));
    await writeJsonFile(this._storagePath, snapshot);
    return Object.freeze({
      path: this._storagePath,
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
    });
  }

  /**
   * Hydrate the graph from `storagePath`. Returns false when no file
   * exists yet (first run). Throws on schema mismatch via `import()`.
   *
   * @returns {Promise<boolean>}
   */
  async load() {
    const data = await readJsonFile(this._storagePath);
    if (!data || typeof data !== 'object' || !Array.isArray(data.nodes)) return false;
    this.import(data);
    return true;
  }

  /**
   * Get graph statistics.
   * @returns {object} Frozen stats: { nodes, edges, components, density }.
   */
  getStats() {
    const nodeCount = this._entries.size;
    let edgeCount = 0;
    for (const entry of this._entries.values()) {
      edgeCount += entry.outEdges.length;
    }

    const components = nodeCount > 0 ? countComponents(this._entries) : 0;
    const maxEdges = nodeCount * (nodeCount - 1);
    const density = maxEdges > 0
      ? Math.round((edgeCount / maxEdges) * 10000) / 10000
      : 0;

    return Object.freeze({ nodes: nodeCount, edges: edgeCount, components, density });
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** @private */
  _removeNode(id) {
    const entry = this._entries.get(id);
    if (!entry) return;

    // Remove edges referencing this node from neighbors
    for (const edge of entry.outEdges) {
      const target = this._entries.get(edge.to);
      if (target) {
        target.inEdges = target.inEdges.filter((e) => e.from !== id);
      }
    }
    for (const edge of entry.inEdges) {
      const source = this._entries.get(edge.from);
      if (source) {
        source.outEdges = source.outEdges.filter((e) => e.to !== id);
      }
    }

    this._entries.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new KnowledgeGraph instance.
 * @param {object} [options]
 * @param {string} [options.storagePath] - Override default storage path.
 * @returns {KnowledgeGraph}
 */
export function createKnowledgeGraph(options) {
  return new KnowledgeGraph(options);
}
