import { describe, expect, it, beforeEach } from 'vitest';
import {
  NODE_TYPES,
  EDGE_RELATIONS,
  createKnowledgeGraph,
} from '../../lib/learning/knowledge-graph.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function newGraph() {
  return createKnowledgeGraph({ storagePath: '/tmp/kg-test.json' });
}

function seedTriangle(g) {
  g.addNode('a', NODE_TYPES.FILE, { path: 'a.js' });
  g.addNode('b', NODE_TYPES.FUNCTION, { name: 'doB' });
  g.addNode('c', NODE_TYPES.CONCEPT, { topic: 'caching' });
  g.addEdge('a', 'b', EDGE_RELATIONS.CONTAINS);
  g.addEdge('b', 'c', EDGE_RELATIONS.IMPLEMENTS);
  g.addEdge('a', 'c', EDGE_RELATIONS.RELATED_TO);
}

// ---------------------------------------------------------------------------
// Constructor / factory
// ---------------------------------------------------------------------------

describe('createKnowledgeGraph', () => {
  it('respects custom storagePath', () => {
    const g = createKnowledgeGraph({ storagePath: '/custom/x.json' });
    expect(g.storagePath).toBe('/custom/x.json');
  });

  it('falls back to default storagePath when no options', () => {
    const g = createKnowledgeGraph();
    expect(typeof g.storagePath).toBe('string');
    expect(g.storagePath.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// addNode
// ---------------------------------------------------------------------------

describe('addNode', () => {
  let g;
  beforeEach(() => { g = newGraph(); });

  it('creates a frozen node with timestamps', () => {
    const node = g.addNode('n1', NODE_TYPES.FILE, { path: 'foo.js' });
    expect(node.id).toBe('n1');
    expect(node.type).toBe('FILE');
    expect(node.data.path).toBe('foo.js');
    expect(node.createdAt).toBeTypeOf('number');
    expect(node.updatedAt).toBeTypeOf('number');
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.data)).toBe(true);
  });

  it('defaults data to empty object', () => {
    const node = g.addNode('n2', NODE_TYPES.CONCEPT);
    expect(node.data).toEqual({});
  });

  it('updates existing node, merging data and bumping updatedAt', () => {
    const first = g.addNode('n1', NODE_TYPES.FILE, { path: 'a.js' });
    const second = g.addNode('n1', NODE_TYPES.FILE, { lang: 'js' });
    expect(second.data.path).toBe('a.js');
    expect(second.data.lang).toBe('js');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('throws on missing id', () => {
    expect(() => g.addNode('', NODE_TYPES.FILE)).toThrow(/Node id is required/);
    expect(() => g.addNode(null, NODE_TYPES.FILE)).toThrow(/Node id is required/);
  });

  it('throws on invalid node type', () => {
    expect(() => g.addNode('x', 'NOT_A_TYPE')).toThrow(/Invalid node type/);
  });
});

// ---------------------------------------------------------------------------
// addEdge
// ---------------------------------------------------------------------------

describe('addEdge', () => {
  let g;
  beforeEach(() => {
    g = newGraph();
    g.addNode('a', NODE_TYPES.FILE);
    g.addNode('b', NODE_TYPES.FILE);
  });

  it('creates a frozen directed edge', () => {
    const edge = g.addEdge('a', 'b', EDGE_RELATIONS.DEPENDS_ON, { weight: 1 });
    expect(edge.from).toBe('a');
    expect(edge.to).toBe('b');
    expect(edge.relation).toBe('DEPENDS_ON');
    expect(edge.data.weight).toBe(1);
    expect(Object.isFrozen(edge)).toBe(true);
    expect(Object.isFrozen(edge.data)).toBe(true);
  });

  it('defaults data to empty object', () => {
    const edge = g.addEdge('a', 'b', EDGE_RELATIONS.RELATED_TO);
    expect(edge.data).toEqual({});
  });

  it('throws if source node missing', () => {
    expect(() => g.addEdge('missing', 'b', EDGE_RELATIONS.RELATED_TO))
      .toThrow(/Source node not found/);
  });

  it('throws if target node missing', () => {
    expect(() => g.addEdge('a', 'missing', EDGE_RELATIONS.RELATED_TO))
      .toThrow(/Target node not found/);
  });

  it('throws on invalid relation', () => {
    expect(() => g.addEdge('a', 'b', 'INVALID')).toThrow(/Invalid edge relation/);
  });
});

// ---------------------------------------------------------------------------
// query (BFS)
// ---------------------------------------------------------------------------

describe('query', () => {
  let g;
  beforeEach(() => { g = newGraph(); seedTriangle(g); });

  it('returns empty for unknown node', () => {
    const result = g.query('does-not-exist');
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('returns the start node and immediate neighbors at depth=1', () => {
    const result = g.query('a', 1);
    const ids = result.nodes.map((n) => n.id).sort();
    expect(ids).toContain('a');
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it('explores deeper at depth=2', () => {
    const result = g.query('a', 2);
    const ids = result.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('uses default depth=2 when omitted', () => {
    const r = g.query('a');
    expect(r.nodes.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// findRelated (keyword search)
// ---------------------------------------------------------------------------

describe('findRelated', () => {
  let g;
  beforeEach(() => {
    g = newGraph();
    g.addNode('cache-1', NODE_TYPES.CONCEPT, { topic: 'caching layer' });
    g.addNode('cache-2', NODE_TYPES.FILE, { path: 'cache.js' });
    g.addNode('other', NODE_TYPES.FILE, { path: 'auth.js' });
  });

  it('returns scored matches sorted by hit count', () => {
    const results = g.findRelated('cache caching');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toMatch(/cache/);
  });

  it('returns empty array for null/empty context', () => {
    expect(g.findRelated('')).toEqual([]);
    expect(g.findRelated(null)).toEqual([]);
    expect(g.findRelated(123)).toEqual([]);
  });

  it('returns empty array if context has only whitespace', () => {
    expect(g.findRelated('   ')).toEqual([]);
  });

  it('respects topK limit', () => {
    const all = g.findRelated('cache', 1);
    expect(all.length).toBeLessThanOrEqual(1);
  });

  it('returns frozen node copies', () => {
    const [first] = g.findRelated('cache');
    expect(Object.isFrozen(first)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe('merge', () => {
  let g;
  beforeEach(() => { g = newGraph(); seedTriangle(g); });

  it('returns zero counts on null/invalid input', () => {
    expect(g.merge(null)).toEqual({ added: 0, updated: 0 });
    expect(g.merge({})).toEqual({ added: 0, updated: 0 });
    expect(g.merge({ nodes: 'not-array' })).toEqual({ added: 0, updated: 0 });
  });

  it('adds new nodes and updates existing', () => {
    const session = {
      nodes: [
        { id: 'a', type: 'FILE', data: { extra: '1' } },     // updates
        { id: 'd', type: 'CONCEPT', data: { topic: 'new' } }, // added
      ],
      edges: [
        { from: 'a', to: 'd', relation: 'RELATED_TO', data: {} },
      ],
    };
    const result = g.merge(session);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(1);
    const stats = g.getStats();
    expect(stats.nodes).toBe(4);
  });

  it('skips edges referencing missing endpoints', () => {
    const session = {
      nodes: [{ id: 'd', type: 'FILE', data: {} }],
      edges: [
        { from: 'd', to: 'ghost', relation: 'RELATED_TO' },
      ],
    };
    const before = g.getStats().edges;
    g.merge(session);
    expect(g.getStats().edges).toBe(before);
  });

  it('does not duplicate identical edges', () => {
    const session = {
      nodes: [],
      edges: [
        { from: 'a', to: 'b', relation: 'CONTAINS', data: {} }, // already exists
      ],
    };
    const before = g.getStats().edges;
    g.merge(session);
    expect(g.getStats().edges).toBe(before);
  });

  it('handles edges array missing from input', () => {
    const result = g.merge({ nodes: [{ id: 'z', type: 'FILE', data: {} }] });
    expect(result.added).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe('prune', () => {
  it('removes nodes older than the cutoff and their edges', () => {
    const g = newGraph();
    g.addNode('old', NODE_TYPES.FILE);
    g.addNode('new', NODE_TYPES.FILE);
    g.addEdge('old', 'new', EDGE_RELATIONS.RELATED_TO);

    // Force the "old" node's updatedAt to be ancient.
    const exported = g.export();
    const ancientTs = Date.now() - (200 * 86_400_000);
    const mutated = {
      ...exported,
      nodes: exported.nodes.map((n) =>
        n.id === 'old' ? { ...n, updatedAt: ancientTs } : n,
      ),
    };
    g.import(mutated);

    const removed = g.prune(90);
    expect(removed).toBe(1);
    const stats = g.getStats();
    expect(stats.nodes).toBe(1);
    expect(stats.edges).toBe(0);
  });

  it('returns 0 when nothing to prune', () => {
    const g = newGraph();
    g.addNode('fresh', NODE_TYPES.FILE);
    expect(g.prune(90)).toBe(0);
  });

  it('uses default maxAgeDays=90', () => {
    const g = newGraph();
    g.addNode('fresh', NODE_TYPES.FILE);
    expect(g.prune()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// export / import roundtrip
// ---------------------------------------------------------------------------

describe('export / import', () => {
  it('roundtrips nodes and edges', () => {
    const g1 = newGraph();
    seedTriangle(g1);
    const data = g1.export();
    expect(data.version).toBe(1);
    expect(data.nodes.length).toBe(3);
    expect(data.edges.length).toBe(3);
    expect(typeof data.exportedAt).toBe('number');

    const g2 = newGraph();
    g2.import(data);
    expect(g2.getStats().nodes).toBe(3);
    expect(g2.getStats().edges).toBe(3);
  });

  it('import throws on invalid input', () => {
    const g = newGraph();
    expect(() => g.import(null)).toThrow(/Invalid graph data/);
    expect(() => g.import({})).toThrow(/Invalid graph data/);
    expect(() => g.import({ nodes: 'not-array' })).toThrow(/Invalid graph data/);
  });

  it('import skips edges with missing endpoints', () => {
    const g = newGraph();
    g.import({
      nodes: [{ id: 'a', type: 'FILE', data: {} }],
      edges: [
        { from: 'a', to: 'ghost', relation: 'RELATED_TO' },
      ],
    });
    expect(g.getStats().edges).toBe(0);
  });

  it('import handles missing edges array', () => {
    const g = newGraph();
    g.import({ nodes: [{ id: 'a', type: 'FILE', data: {} }] });
    expect(g.getStats().nodes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('getStats', () => {
  it('returns all-zero stats for empty graph', () => {
    const stats = newGraph().getStats();
    expect(stats).toEqual({ nodes: 0, edges: 0, components: 0, density: 0 });
  });

  it('counts components correctly for disconnected graph', () => {
    const g = newGraph();
    g.addNode('a', NODE_TYPES.FILE);
    g.addNode('b', NODE_TYPES.FILE);
    g.addNode('c', NODE_TYPES.FILE);
    g.addEdge('a', 'b', EDGE_RELATIONS.RELATED_TO);
    expect(g.getStats().components).toBe(2); // {a,b} and {c}
  });

  it('counts a single component when all nodes connected', () => {
    const g = newGraph();
    seedTriangle(g);
    expect(g.getStats().components).toBe(1);
  });

  it('computes density', () => {
    const g = newGraph();
    seedTriangle(g);
    const stats = g.getStats();
    expect(stats.density).toBeGreaterThan(0);
    expect(stats.density).toBeLessThanOrEqual(1);
  });
});
