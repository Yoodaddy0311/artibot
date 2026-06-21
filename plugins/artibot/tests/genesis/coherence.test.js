/**
 * Tests for the genesis cross-document coherence checker (checkCoherence).
 * Covers the coherent happy path, each of the four rules' violation cases,
 * and graceful tolerance of missing/empty input (never throws).
 * @module tests/genesis/coherence
 */

import { describe, expect, it } from 'vitest';

import { checkCoherence } from '../../lib/genesis/coherence.js';

/**
 * A fully coherent blueprint: every entity has a home in the tree, every
 * workflow step maps to a feature/entity, every flow edge points at a declared
 * node, and every relation targets a real entity.
 */
function coherentInput() {
  return {
    tree: {
      name: 'app',
      children: [
        {
          name: 'src',
          children: [
            { name: 'users', children: [], note: 'user feature' },
            { name: 'orders', children: [], note: 'order feature' },
          ],
        },
      ],
    },
    flows: {
      workflow: [
        { step: 1, action: 'User signs up' },
        { step: 2, action: 'User places Order' },
      ],
      featureFlows: [
        { name: 'User', nodes: ['start', 'verify', 'done'], edges: [['start', 'verify'], ['verify', 'done']] },
      ],
    },
    schemas: [
      {
        entity: 'User',
        fields: [{ name: 'id', type: 'uuid' }],
        relations: [{ type: '1:N', target: 'Order', via: 'user_id' }],
      },
      { entity: 'Order', fields: [{ name: 'id', type: 'uuid' }] },
    ],
    prdFeatures: ['User', 'Order', 'signup'],
  };
}

describe('coherence / coherent input', () => {
  it('returns ok:true with zero issues for a fully coherent blueprint', () => {
    const res = checkCoherence(coherentInput());
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });
});

describe('coherence / rule 1 — orphan dataset (warn)', () => {
  it('flags a schema entity that has no trace in the file tree', () => {
    const input = coherentInput();
    // Add an entity with no matching file/dir anywhere in the tree.
    input.schemas.push({ entity: 'Invoice', fields: [{ name: 'id', type: 'uuid' }] });
    const res = checkCoherence(input);
    const orphan = res.issues.find((i) => i.kind === 'dataset-not-in-tree');
    expect(orphan).toBeDefined();
    expect(orphan.severity).toBe('warn');
    expect(orphan.detail).toContain('Invoice');
    // Warn-only ⇒ blueprint is still ok.
    expect(res.ok).toBe(true);
  });

  it('matches singular entity against a plural directory name', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      schemas: [{ entity: 'User', fields: [] }],
    });
    expect(res.issues.find((i) => i.kind === 'dataset-not-in-tree')).toBeUndefined();
  });
});

describe('coherence / rule 2 — workflow orphan (warn)', () => {
  it('flags a workflow step that maps to no feature/entity/file', () => {
    const input = coherentInput();
    input.flows.workflow.push({ step: 3, action: 'Reconcile quantum ledger zzz' });
    const res = checkCoherence(input);
    const orphan = res.issues.find((i) => i.kind === 'workflow-orphan');
    expect(orphan).toBeDefined();
    expect(orphan.severity).toBe('warn');
    expect(orphan.detail).toContain('Reconcile quantum ledger zzz');
    expect(res.ok).toBe(true);
  });

  it('flags a feature-flow name that maps to nothing', () => {
    const input = coherentInput();
    input.flows.featureFlows.push({ name: 'Nonexistentthing', nodes: ['a'], edges: [] });
    const res = checkCoherence(input);
    const orphan = res.issues.find(
      (i) => i.kind === 'workflow-orphan' && i.detail.includes('Nonexistentthing'),
    );
    expect(orphan).toBeDefined();
  });
});

describe('coherence / rule 3 — broken flow edge + empty (error)', () => {
  it('flags an edge endpoint that is not a declared node', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      flows: {
        featureFlows: [
          { name: 'User', nodes: ['start', 'done'], edges: [['start', 'GHOST']] },
        ],
      },
      schemas: [{ entity: 'User', fields: [] }],
    });
    const broken = res.issues.find((i) => i.kind === 'broken-flow-edge');
    expect(broken).toBeDefined();
    expect(broken.severity).toBe('error');
    expect(broken.detail).toContain('GHOST');
    // Error severity ⇒ not ok.
    expect(res.ok).toBe(false);
  });

  it('flags a completely empty blueprint as an error', () => {
    const res = checkCoherence({});
    const empty = res.issues.find((i) => i.kind === 'empty-blueprint');
    expect(empty).toBeDefined();
    expect(empty.severity).toBe('error');
    expect(res.ok).toBe(false);
  });

  it('flags object-form edges (from/to) that reference an undeclared node', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      flows: {
        featureFlows: [
          {
            name: 'User',
            nodes: ['start', 'done'],
            edges: [
              { from: 'start', to: 'done', label: 'ok' },
              { from: 'start', to: 'GHOST' },
            ],
          },
        ],
      },
      schemas: [{ entity: 'User', fields: [] }],
    });
    const broken = res.issues.filter((i) => i.kind === 'broken-flow-edge');
    expect(broken).toHaveLength(1);
    expect(broken[0].detail).toContain('GHOST');
  });

  it('treats a primitive (non-array, non-object) edge entry as broken on both ends', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      flows: { featureFlows: [{ name: 'User', nodes: ['a'], edges: ['not-an-edge'] }] },
      schemas: [{ entity: 'User', fields: [] }],
    });
    expect(res.issues.filter((i) => i.kind === 'broken-flow-edge').length).toBeGreaterThan(0);
    expect(res.ok).toBe(false);
  });
});

describe('coherence / rule 4 — dangling relation (error)', () => {
  it('flags a structured relation targeting a non-existent entity', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      schemas: [
        {
          entity: 'User',
          fields: [{ name: 'id', type: 'uuid' }],
          relations: [{ type: '1:N', target: 'Ghost', via: 'ghost_id' }],
        },
      ],
    });
    const dangling = res.issues.find((i) => i.kind === 'dangling-relation');
    expect(dangling).toBeDefined();
    expect(dangling.severity).toBe('error');
    expect(dangling.detail).toContain('Ghost');
    expect(res.ok).toBe(false);
  });

  it('does NOT flag a structured relation targeting a declared entity', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }, { name: 'orders', children: [] }] },
      schemas: [
        { entity: 'User', fields: [], relations: [{ target: 'Order' }] },
        { entity: 'Order', fields: [] },
      ],
    });
    expect(res.issues.find((i) => i.kind === 'dangling-relation')).toBeUndefined();
  });

  it('flags a free-form string relation that references no known entity', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      schemas: [
        { entity: 'User', fields: [], relations: ['belongs to some unknown realm'] },
      ],
    });
    const dangling = res.issues.find((i) => i.kind === 'dangling-relation');
    expect(dangling).toBeDefined();
    expect(dangling.severity).toBe('error');
  });

  it('does NOT flag a string relation that mentions a known entity', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }, { name: 'orders', children: [] }] },
      schemas: [
        { entity: 'User', fields: [], relations: ['User 1:N Order (자유 서술)'] },
        { entity: 'Order', fields: [] },
      ],
    });
    expect(res.issues.find((i) => i.kind === 'dangling-relation')).toBeUndefined();
  });

  it('resolves relation target from `to` and `entity` keys, not just `target`', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      schemas: [
        { entity: 'User', fields: [], relations: [{ to: 'Ghost1' }, { entity: 'Ghost2' }] },
      ],
    });
    const dangling = res.issues.filter((i) => i.kind === 'dangling-relation');
    expect(dangling).toHaveLength(2);
    expect(dangling.some((i) => i.detail.includes('Ghost1'))).toBe(true);
    expect(dangling.some((i) => i.detail.includes('Ghost2'))).toBe(true);
  });

  it('ignores a structured relation with no resolvable target (nothing to validate)', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      schemas: [{ entity: 'User', fields: [], relations: [{ type: '1:N', via: 'x' }] }],
    });
    expect(res.issues.find((i) => i.kind === 'dangling-relation')).toBeUndefined();
  });

  it('tolerates a primitive (non-string, non-object) relation entry without throwing', () => {
    const res = checkCoherence({
      tree: { name: 'app', children: [{ name: 'users', children: [] }] },
      schemas: [{ entity: 'User', fields: [], relations: [42, null] }],
    });
    expect(res.issues.find((i) => i.kind === 'dangling-relation')).toBeUndefined();
    expect(typeof res.ok).toBe('boolean');
  });
});

describe('coherence / graceful input tolerance', () => {
  it('does not throw on entirely undefined input', () => {
    expect(() => checkCoherence()).not.toThrow();
    const res = checkCoherence();
    expect(res).toHaveProperty('ok');
    expect(Array.isArray(res.issues)).toBe(true);
  });

  it('does not throw when individual fields are missing', () => {
    expect(() => checkCoherence({ tree: { name: 'app', children: [] } })).not.toThrow();
    expect(() => checkCoherence({ schemas: [{ entity: 'User' }] })).not.toThrow();
    expect(() => checkCoherence({ flows: {} })).not.toThrow();
  });

  it('tolerates malformed shapes (null entries, wrong types) without throwing', () => {
    const res = checkCoherence({
      tree: [null, { name: 'src', children: [null] }],
      flows: { workflow: [null, {}], featureFlows: [null, { nodes: null, edges: null }] },
      schemas: [null, { entity: 'User', fields: null, relations: null }],
      prdFeatures: [null, 'X'],
    });
    expect(Array.isArray(res.issues)).toBe(true);
    expect(typeof res.ok).toBe('boolean');
  });

  it('treats array-form tree roots the same as a root node', () => {
    const res = checkCoherence({
      tree: [{ name: 'users', children: [] }],
      schemas: [{ entity: 'User', fields: [] }],
    });
    expect(res.issues.find((i) => i.kind === 'dataset-not-in-tree')).toBeUndefined();
  });
});
