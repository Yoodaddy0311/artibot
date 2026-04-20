import { beforeEach, describe, expect, it } from 'vitest';
import { Dag } from '../../lib/orchestration/dag.js';

describe('Dag', () => {
  let dag;

  beforeEach(() => {
    dag = new Dag();
  });

  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('starts empty', () => {
      expect(dag.size).toBe(0);
      expect(dag.nodes).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('add()', () => {
    it('adds a standalone node', () => {
      dag.add('a');
      expect(dag.size).toBe(1);
      expect(dag.nodes).toEqual(['a']);
    });

    it('adds a node with dependencies', () => {
      dag.add('a');
      dag.add('b', ['a']);
      expect(dag.size).toBe(2);
      expect(dag.dependencies('b')).toEqual(['a']);
    });

    it('auto-registers unknown dependency nodes', () => {
      dag.add('c', ['a', 'b']);
      expect(dag.size).toBe(3);
      expect(dag.nodes).toContain('a');
      expect(dag.nodes).toContain('b');
    });

    it('is idempotent for the same node', () => {
      dag.add('a');
      dag.add('a');
      expect(dag.size).toBe(1);
    });

    it('merges new dependencies on re-add', () => {
      dag.add('a');
      dag.add('b');
      dag.add('c', ['a']);
      dag.add('c', ['b']);
      expect(dag.dependencies('c')).toContain('a');
      expect(dag.dependencies('c')).toContain('b');
    });

    it('supports chaining', () => {
      const result = dag.add('a').add('b', ['a']);
      expect(result).toBe(dag);
      expect(dag.size).toBe(2);
    });

    it('throws on empty string id', () => {
      expect(() => dag.add('')).toThrow('non-empty string');
    });

    it('throws on non-string id', () => {
      expect(() => dag.add(123)).toThrow('non-empty string');
    });

    it('throws on empty dependency id', () => {
      expect(() => dag.add('a', [''])).toThrow('non-empty string');
    });
  });

  // ---------------------------------------------------------------------------
  describe('dependencies()', () => {
    it('returns direct dependencies', () => {
      dag.add('a').add('b').add('c', ['a', 'b']);
      const deps = dag.dependencies('c');
      expect(deps).toHaveLength(2);
      expect(deps).toContain('a');
      expect(deps).toContain('b');
    });

    it('returns empty array for root nodes', () => {
      dag.add('root');
      expect(dag.dependencies('root')).toEqual([]);
    });

    it('returns a fresh array (non-mutating)', () => {
      dag.add('a').add('b', ['a']);
      const d1 = dag.dependencies('b');
      const d2 = dag.dependencies('b');
      expect(d1).not.toBe(d2);
      expect(d1).toEqual(d2);
    });

    it('throws on unknown node', () => {
      expect(() => dag.dependencies('nonexistent')).toThrow('Unknown node');
    });
  });

  // ---------------------------------------------------------------------------
  describe('ancestors()', () => {
    it('returns all transitive ancestors', () => {
      dag.add('a').add('b', ['a']).add('c', ['b']).add('d', ['c']);
      const anc = dag.ancestors('d');
      expect(anc).toContain('a');
      expect(anc).toContain('b');
      expect(anc).toContain('c');
      expect(anc).toHaveLength(3);
    });

    it('returns empty for root nodes', () => {
      dag.add('root');
      expect(dag.ancestors('root')).toEqual([]);
    });

    it('handles diamond dependencies', () => {
      //   a
      //  / \
      // b   c
      //  \ /
      //   d
      dag.add('a');
      dag.add('b', ['a']);
      dag.add('c', ['a']);
      dag.add('d', ['b', 'c']);
      const anc = dag.ancestors('d');
      expect(anc).toContain('a');
      expect(anc).toContain('b');
      expect(anc).toContain('c');
      expect(anc).toHaveLength(3);
    });

    it('throws on unknown node', () => {
      expect(() => dag.ancestors('missing')).toThrow('Unknown node');
    });
  });

  // ---------------------------------------------------------------------------
  describe('detectCycles()', () => {
    it('returns false for an acyclic graph', () => {
      dag.add('a').add('b', ['a']).add('c', ['b']);
      expect(dag.detectCycles()).toBe(false);
    });

    it('returns false for empty graph', () => {
      expect(dag.detectCycles()).toBe(false);
    });

    it('returns false for single node', () => {
      dag.add('a');
      expect(dag.detectCycles()).toBe(false);
    });

    it('returns true when a cycle is manually introduced', () => {
      // Simulate a cycle by adding mutual dependencies
      dag.add('a', ['c']);
      dag.add('b', ['a']);
      dag.add('c', ['b']);
      expect(dag.detectCycles()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('topologicalSort()', () => {
    it('returns nodes in dependency order', () => {
      dag.add('a').add('b', ['a']).add('c', ['a']).add('d', ['b', 'c']);
      const sorted = dag.topologicalSort();
      expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
      expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('c'));
      expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('d'));
      expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('d'));
    });

    it('returns all nodes', () => {
      dag.add('x').add('y').add('z', ['x', 'y']);
      expect(dag.topologicalSort()).toHaveLength(3);
    });

    it('handles single node', () => {
      dag.add('only');
      expect(dag.topologicalSort()).toEqual(['only']);
    });

    it('handles disconnected components', () => {
      dag.add('a').add('b').add('c');
      const sorted = dag.topologicalSort();
      expect(sorted).toHaveLength(3);
    });

    it('throws on cyclic graph', () => {
      dag.add('a', ['c']);
      dag.add('b', ['a']);
      dag.add('c', ['b']);
      expect(() => dag.topologicalSort()).toThrow('Cycle detected');
    });

    it('returns a linear chain in order', () => {
      dag.add('1').add('2', ['1']).add('3', ['2']).add('4', ['3']);
      expect(dag.topologicalSort()).toEqual(['1', '2', '3', '4']);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getReady()', () => {
    it('returns root nodes when nothing is completed', () => {
      dag.add('a').add('b', ['a']).add('c', ['a']);
      expect(dag.getReady()).toEqual(['a']);
    });

    it('returns dependents when their deps are completed', () => {
      dag.add('a').add('b', ['a']).add('c', ['a']);
      const ready = dag.getReady(new Set(['a']));
      expect(ready).toContain('b');
      expect(ready).toContain('c');
      expect(ready).not.toContain('a');
    });

    it('does not return nodes with unmet deps', () => {
      dag.add('a').add('b').add('c', ['a', 'b']);
      const ready = dag.getReady(new Set(['a']));
      expect(ready).toContain('b');
      expect(ready).not.toContain('c');
    });

    it('returns all nodes when all deps are met', () => {
      dag.add('a').add('b', ['a']).add('c', ['b']);
      const ready = dag.getReady(new Set(['a', 'b']));
      expect(ready).toEqual(['c']);
    });

    it('returns empty when all completed', () => {
      dag.add('a').add('b', ['a']);
      expect(dag.getReady(new Set(['a', 'b']))).toEqual([]);
    });

    it('handles empty graph', () => {
      expect(dag.getReady()).toEqual([]);
    });

    it('returns standalone nodes immediately', () => {
      dag.add('x').add('y').add('z');
      expect(dag.getReady()).toEqual(['x', 'y', 'z']);
    });
  });

  // ---------------------------------------------------------------------------
  describe('skipPropagate()', () => {
    it('returns just the skipped node if no dependents', () => {
      dag.add('a').add('b', ['a']);
      expect(dag.skipPropagate('b')).toEqual(['b']);
    });

    it('propagates skip to direct dependents with no alternative', () => {
      dag.add('a').add('b', ['a']).add('c', ['b']);
      const skipped = dag.skipPropagate('a');
      expect(skipped).toContain('a');
      expect(skipped).toContain('b');
      expect(skipped).toContain('c');
    });

    it('does not skip nodes with alternative dependencies', () => {
      //   a   b
      //    \ /
      //     c
      dag.add('a').add('b').add('c', ['a', 'b']);
      const skipped = dag.skipPropagate('a');
      expect(skipped).toContain('a');
      expect(skipped).not.toContain('c');
    });

    it('skips diamond dependents when root is skipped', () => {
      //     a
      //    / \
      //   b   c
      //    \ /
      //     d
      dag.add('a');
      dag.add('b', ['a']);
      dag.add('c', ['a']);
      dag.add('d', ['b', 'c']);
      const skipped = dag.skipPropagate('a');
      expect(skipped).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
      expect(skipped).toHaveLength(4);
    });

    it('partially propagates in complex graphs', () => {
      //   a   b
      //   |   |
      //   c   d
      //    \ /
      //     e
      dag.add('a').add('b');
      dag.add('c', ['a']).add('d', ['b']);
      dag.add('e', ['c', 'd']);
      const skipped = dag.skipPropagate('a');
      expect(skipped).toContain('a');
      expect(skipped).toContain('c');
      expect(skipped).not.toContain('d');
      expect(skipped).not.toContain('e');
    });

    it('throws on unknown node', () => {
      expect(() => dag.skipPropagate('ghost')).toThrow('Unknown node');
    });
  });

  // ---------------------------------------------------------------------------
  describe('integration', () => {
    it('handles a realistic build pipeline', () => {
      dag
        .add('lint')
        .add('typecheck')
        .add('unit-test', ['lint', 'typecheck'])
        .add('integration-test', ['unit-test'])
        .add('build', ['lint', 'typecheck'])
        .add('deploy', ['build', 'integration-test']);

      expect(dag.size).toBe(6);
      expect(dag.detectCycles()).toBe(false);

      const sorted = dag.topologicalSort();
      expect(sorted.indexOf('lint')).toBeLessThan(sorted.indexOf('unit-test'));
      expect(sorted.indexOf('build')).toBeLessThan(sorted.indexOf('deploy'));

      // Initial ready: lint and typecheck (no deps)
      const wave1 = dag.getReady();
      expect(wave1).toContain('lint');
      expect(wave1).toContain('typecheck');

      // After lint + typecheck: unit-test and build ready
      const wave2 = dag.getReady(new Set(['lint', 'typecheck']));
      expect(wave2).toContain('unit-test');
      expect(wave2).toContain('build');

      // Skip lint → propagate
      const skipped = dag.skipPropagate('lint');
      expect(skipped).toContain('lint');
      // unit-test depends on lint AND typecheck — not all deps skipped,
      // so unit-test is NOT propagated (typecheck still available)
      expect(skipped).not.toContain('unit-test');
      expect(skipped).toHaveLength(1);
    });
  });
});
