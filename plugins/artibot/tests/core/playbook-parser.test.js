import { describe, expect, it } from 'vitest';
import {
  detectCycle,
  getExecutionOrder,
  getParallelGroups,
  KNOWN_ACTIONS,
  KNOWN_PATTERNS,
  parseDagPlaybook,
  parsePlaybook,
  serializePlaybook,
  topologicalSort,
  validateDagPlaybook,
  validatePlaybook,
} from '../../lib/core/playbook-parser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('KNOWN_PATTERNS', () => {
  it('contains expected patterns', () => {
    expect(KNOWN_PATTERNS.has('leader')).toBe(true);
    expect(KNOWN_PATTERNS.has('council')).toBe(true);
    expect(KNOWN_PATTERNS.has('swarm')).toBe(true);
    expect(KNOWN_PATTERNS.has('pipeline')).toBe(true);
    expect(KNOWN_PATTERNS.has('watchdog')).toBe(true);
    expect(KNOWN_PATTERNS.has('unknown')).toBe(false);
  });
});

describe('KNOWN_ACTIONS', () => {
  it('contains expected actions', () => {
    for (const action of ['plan', 'design', 'implement', 'review', 'merge', 'analyze', 'fix', 'verify', 'scan', 'assess']) {
      expect(KNOWN_ACTIONS.has(action)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parsePlaybook()
// ---------------------------------------------------------------------------

describe('parsePlaybook()', () => {
  it('parses a simple 1-phase playbook', () => {
    const result = parsePlaybook('[leader] plan');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]).toEqual({ order: 0, pattern: 'leader', action: 'plan', label: 'plan' });
  });

  it('parses the feature playbook', () => {
    const result = parsePlaybook('[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge');
    expect(result.phases).toHaveLength(5);
    expect(result.phases[0]).toEqual({ order: 0, pattern: 'leader', action: 'plan', label: 'plan' });
    expect(result.phases[1]).toEqual({ order: 1, pattern: 'council', action: 'design', label: 'design' });
    expect(result.phases[2]).toEqual({ order: 2, pattern: 'swarm', action: 'implement', label: 'implement' });
    expect(result.phases[3]).toEqual({ order: 3, pattern: 'council', action: 'review', label: 'review' });
    expect(result.phases[4]).toEqual({ order: 4, pattern: 'leader', action: 'merge', label: 'merge' });
  });

  it('parses the bugfix playbook', () => {
    const result = parsePlaybook('[leader] analyze -> [pipeline] fix -> [council] verify');
    expect(result.phases).toHaveLength(3);
    expect(result.phases[1]).toEqual({ order: 1, pattern: 'pipeline', action: 'fix', label: 'fix' });
  });

  it('parses the refactor playbook', () => {
    const result = parsePlaybook('[council] assess -> [pipeline] refactor -> [swarm] test -> [council] review');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].pattern).toBe('council');
    expect(result.phases[1].action).toBe('refactor');
  });

  it('parses the security playbook', () => {
    const result = parsePlaybook('[leader] scan -> [council] assess -> [pipeline] fix -> [council] verify');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].action).toBe('scan');
    expect(result.phases[2].pattern).toBe('pipeline');
  });

  it('parses the marketing-campaign playbook', () => {
    const result = parsePlaybook('[leader] strategy -> [council] plan -> [swarm] create -> [council] review -> [leader] launch');
    expect(result.phases).toHaveLength(5);
    expect(result.phases[4].action).toBe('launch');
  });

  it('parses the marketing-audit playbook', () => {
    const result = parsePlaybook('[leader] scan -> [council] assess -> [pipeline] optimize -> [council] verify');
    expect(result.phases).toHaveLength(4);
  });

  it('parses the content-launch playbook', () => {
    const result = parsePlaybook('[leader] plan -> [swarm] create -> [council] review -> [leader] publish');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[3].action).toBe('publish');
  });

  it('parses the competitive-analysis playbook', () => {
    const result = parsePlaybook('[council] research -> [swarm] analyze -> [council] synthesize -> [leader] report');
    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].action).toBe('research');
    expect(result.phases[3].action).toBe('report');
  });

  it('trims whitespace around segments', () => {
    const result = parsePlaybook('  [leader] plan  ->  [swarm] implement  ');
    expect(result.phases).toHaveLength(2);
  });

  it('returns empty phases for empty string', () => {
    expect(parsePlaybook('')).toEqual({ phases: [] });
    expect(parsePlaybook('   ')).toEqual({ phases: [] });
  });

  it('returns empty phases for null or undefined', () => {
    expect(parsePlaybook(null)).toEqual({ phases: [] });
    expect(parsePlaybook(undefined)).toEqual({ phases: [] });
  });

  it('returns empty phases for non-string non-object', () => {
    expect(parsePlaybook(42)).toEqual({ phases: [] });
  });

  it('skips segments with invalid format (no brackets)', () => {
    const result = parsePlaybook('leader plan -> [council] design');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].pattern).toBe('council');
  });

  it('handles backward-compatible already-parsed object', () => {
    const alreadyParsed = {
      phases: [
        { order: 0, pattern: 'leader', action: 'plan', label: 'plan' },
      ],
    };
    const result = parsePlaybook(alreadyParsed);
    expect(result).toBe(alreadyParsed); // same reference
  });

  it('normalizes pattern and action to lowercase', () => {
    const result = parsePlaybook('[LEADER] PLAN -> [Council] Design');
    expect(result.phases[0].pattern).toBe('leader');
    expect(result.phases[0].action).toBe('plan');
    expect(result.phases[1].pattern).toBe('council');
    expect(result.phases[1].action).toBe('design');
  });
});

// ---------------------------------------------------------------------------
// validatePlaybook()
// ---------------------------------------------------------------------------

describe('validatePlaybook()', () => {
  it('validates a correct playbook as valid', () => {
    const pb = parsePlaybook('[leader] plan -> [swarm] implement');
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects a playbook with zero phases', () => {
    const { valid, errors } = validatePlaybook({ phases: [] });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('at least 1'))).toBe(true);
  });

  it('rejects null input', () => {
    const { valid, errors } = validatePlaybook(null);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-object input', () => {
    const { valid, errors } = validatePlaybook('bad');
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects playbook without phases array', () => {
    const { valid, errors } = validatePlaybook({ foo: 'bar' });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('phases array'))).toBe(true);
  });

  it('rejects unknown patterns', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'unknown', action: 'plan', label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("unknown pattern 'unknown'"))).toBe(true);
  });

  it('rejects empty action', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'leader', action: '', label: '' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('action'))).toBe(true);
  });

  it('validates all 8 system playbooks correctly', () => {
    const playbooks = [
      '[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge',
      '[leader] analyze -> [pipeline] fix -> [council] verify',
      '[council] assess -> [pipeline] refactor -> [swarm] test -> [council] review',
      '[leader] scan -> [council] assess -> [pipeline] fix -> [council] verify',
      '[leader] strategy -> [council] plan -> [swarm] create -> [council] review -> [leader] launch',
      '[leader] scan -> [council] assess -> [pipeline] optimize -> [council] verify',
      '[leader] plan -> [swarm] create -> [council] review -> [leader] publish',
      '[council] research -> [swarm] analyze -> [council] synthesize -> [leader] report',
    ];

    for (const pb of playbooks) {
      const parsed = parsePlaybook(pb);
      const { valid, errors } = validatePlaybook(parsed);
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    }
  });

  it('accumulates multiple errors', () => {
    const pb = {
      phases: [
        { order: 0, pattern: 'bad1', action: '', label: '' },
        { order: 1, pattern: 'bad2', action: 'plan', label: 'plan' },
      ],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects phase with null pattern', () => {
    const pb = {
      phases: [{ order: 0, pattern: null, action: 'plan', label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('pattern is required'))).toBe(true);
  });

  it('rejects phase with undefined pattern', () => {
    const pb = {
      phases: [{ order: 0, action: 'plan', label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('pattern is required'))).toBe(true);
  });

  it('rejects phase with numeric pattern (non-string)', () => {
    const pb = {
      phases: [{ order: 0, pattern: 42, action: 'plan', label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('pattern is required'))).toBe(true);
  });

  it('rejects phase with null action', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'leader', action: null, label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('action must be a non-empty string'))).toBe(true);
  });

  it('rejects phase with undefined action', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'leader', label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('action must be a non-empty string'))).toBe(true);
  });

  it('rejects phase with numeric action (non-string)', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'leader', action: 123, label: 'plan' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('action must be a non-empty string'))).toBe(true);
  });

  it('rejects phase with whitespace-only action', () => {
    const pb = {
      phases: [{ order: 0, pattern: 'leader', action: '   ', label: '' }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('action must be a non-empty string'))).toBe(true);
  });

  it('uses "?" for order when phase has no order property', () => {
    const pb = {
      phases: [{ pattern: null, action: null }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('Phase ?'))).toBe(true);
  });

  it('reports both pattern and action errors for same phase', () => {
    const pb = {
      phases: [{ order: 0, pattern: null, action: null }],
    };
    const { valid, errors } = validatePlaybook(pb);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('pattern is required'))).toBe(true);
    expect(errors.some((e) => e.includes('action must be a non-empty string'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// serializePlaybook()
// ---------------------------------------------------------------------------

describe('serializePlaybook()', () => {
  it('serializes a single-phase playbook', () => {
    const pb = { phases: [{ order: 0, pattern: 'leader', action: 'plan', label: 'plan' }] };
    expect(serializePlaybook(pb)).toBe('[leader] plan');
  });

  it('serializes a multi-phase playbook', () => {
    const pb = parsePlaybook('[leader] plan -> [council] design -> [swarm] implement');
    const str = serializePlaybook(pb);
    expect(str).toBe('[leader] plan -> [council] design -> [swarm] implement');
  });

  it('round-trips all 8 system playbooks', () => {
    const originals = [
      '[leader] plan -> [council] design -> [swarm] implement -> [council] review -> [leader] merge',
      '[leader] analyze -> [pipeline] fix -> [council] verify',
      '[council] assess -> [pipeline] refactor -> [swarm] test -> [council] review',
      '[leader] scan -> [council] assess -> [pipeline] fix -> [council] verify',
      '[leader] strategy -> [council] plan -> [swarm] create -> [council] review -> [leader] launch',
      '[leader] scan -> [council] assess -> [pipeline] optimize -> [council] verify',
      '[leader] plan -> [swarm] create -> [council] review -> [leader] publish',
      '[council] research -> [swarm] analyze -> [council] synthesize -> [leader] report',
    ];

    for (const orig of originals) {
      const parsed = parsePlaybook(orig);
      const serialized = serializePlaybook(parsed);
      expect(serialized).toBe(orig);
    }
  });

  it('returns empty string for null input', () => {
    expect(serializePlaybook(null)).toBe('');
    expect(serializePlaybook(undefined)).toBe('');
  });

  it('returns empty string for object without phases', () => {
    expect(serializePlaybook({})).toBe('');
  });

  it('returns empty string for empty phases array', () => {
    expect(serializePlaybook({ phases: [] })).toBe('');
  });

  it('returns empty string when phases is not an array', () => {
    expect(serializePlaybook({ phases: 'not-an-array' })).toBe('');
  });

  it('returns empty string for boolean false input', () => {
    expect(serializePlaybook(false)).toBe('');
  });

  it('returns empty string for number input', () => {
    expect(serializePlaybook(42)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseDagPlaybook()
// ---------------------------------------------------------------------------

describe('parseDagPlaybook()', () => {
  it('parses a simple DAG with 2 nodes', () => {
    const result = parseDagPlaybook({
      name: 'simple',
      nodes: [
        { id: 'plan', action: 'plan', pattern: 'leader' },
        { id: 'impl', action: 'implement', pattern: 'swarm', dependsOn: ['plan'] },
      ],
    });
    expect(result.isDag).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].action).toBe('plan');
    expect(result.phases[1].action).toBe('implement');
  });

  it('returns empty for null input', () => {
    const result = parseDagPlaybook(null);
    expect(result.isDag).toBe(true);
    expect(result.nodes).toHaveLength(0);
    expect(result.phases).toHaveLength(0);
  });

  it('returns empty for input without nodes', () => {
    const result = parseDagPlaybook({ name: 'bad' });
    expect(result.nodes).toHaveLength(0);
  });

  it('normalizes action and pattern to lowercase', () => {
    const result = parseDagPlaybook({
      nodes: [{ id: 'a', action: 'PLAN', pattern: 'LEADER' }],
    });
    expect(result.nodes[0].action).toBe('plan');
    expect(result.nodes[0].pattern).toBe('leader');
  });

  it('preserves parallel flag', () => {
    const result = parseDagPlaybook({
      nodes: [
        { id: 'a', action: 'plan', parallel: true },
        { id: 'b', action: 'impl', parallel: false },
      ],
    });
    expect(result.nodes[0].parallel).toBe(true);
    expect(result.nodes[1].parallel).toBe(false);
  });

  it('preserves condition field', () => {
    const result = parseDagPlaybook({
      nodes: [{ id: 'a', action: 'plan', condition: 'hasTests === true' }],
    });
    expect(result.nodes[0].condition).toBe('hasTests === true');
  });

  it('preserves agent field', () => {
    const result = parseDagPlaybook({
      nodes: [{ id: 'a', action: 'plan', agent: 'planner' }],
    });
    expect(result.nodes[0].agent).toBe('planner');
  });

  it('parsePlaybook dispatches to parseDagPlaybook for DAG input', () => {
    const dagInput = {
      nodes: [
        { id: 'plan', action: 'plan', pattern: 'leader' },
        { id: 'impl', action: 'implement', pattern: 'swarm', dependsOn: ['plan'] },
      ],
    };
    const result = parsePlaybook(dagInput);
    expect(result.isDag).toBe(true);
    expect(result.nodes).toHaveLength(2);
    expect(result.phases).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// validateDagPlaybook()
// ---------------------------------------------------------------------------

describe('validateDagPlaybook()', () => {
  it('validates a correct DAG', () => {
    const dag = parseDagPlaybook({
      nodes: [
        { id: 'a', action: 'plan', pattern: 'leader' },
        { id: 'b', action: 'implement', pattern: 'swarm', dependsOn: ['a'] },
      ],
    });
    const { valid, errors } = validateDagPlaybook(dag);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects null input', () => {
    const { valid } = validateDagPlaybook(null);
    expect(valid).toBe(false);
  });

  it('rejects missing nodes array', () => {
    const { valid, errors } = validateDagPlaybook({ name: 'bad' });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('nodes array');
  });

  it('rejects empty nodes array', () => {
    const { valid } = validateDagPlaybook({ nodes: [] });
    expect(valid).toBe(false);
  });

  it('rejects node without id', () => {
    const dag = { nodes: [{ action: 'plan' }] };
    const { valid, errors } = validateDagPlaybook(dag);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('non-empty string id'))).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const dag = {
      nodes: [
        { id: 'a', action: 'plan' },
        { id: 'a', action: 'implement' },
      ],
    };
    const { valid, errors } = validateDagPlaybook(dag);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("Duplicate node id: 'a'"))).toBe(true);
  });

  it('rejects node without action', () => {
    const dag = { nodes: [{ id: 'a' }] };
    const { valid, errors } = validateDagPlaybook(dag);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('action is required'))).toBe(true);
  });

  it('rejects dependsOn referencing unknown node', () => {
    const dag = {
      nodes: [{ id: 'a', action: 'plan', dependsOn: ['nonexistent'] }],
    };
    const { valid, errors } = validateDagPlaybook(dag);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("unknown node 'nonexistent'"))).toBe(true);
  });

  it('detects cycles', () => {
    const dag = {
      nodes: [
        { id: 'a', action: 'plan', dependsOn: ['b'] },
        { id: 'b', action: 'implement', dependsOn: ['a'] },
      ],
    };
    const { valid, errors } = validateDagPlaybook(dag);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('Cycle detected'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectCycle()
// ---------------------------------------------------------------------------

describe('detectCycle()', () => {
  it('returns null for acyclic graph', () => {
    const nodes = [
      { id: 'a', action: 'plan', dependsOn: [] },
      { id: 'b', action: 'impl', dependsOn: ['a'] },
      { id: 'c', action: 'review', dependsOn: ['b'] },
    ];
    expect(detectCycle(nodes)).toBeNull();
  });

  it('detects a simple 2-node cycle', () => {
    const nodes = [
      { id: 'a', action: 'plan', dependsOn: ['b'] },
      { id: 'b', action: 'impl', dependsOn: ['a'] },
    ];
    const cycle = detectCycle(nodes);
    expect(cycle).toBeTruthy();
    expect(cycle.length).toBeGreaterThanOrEqual(2);
  });

  it('detects a 3-node cycle', () => {
    const nodes = [
      { id: 'a', action: 'plan', dependsOn: ['c'] },
      { id: 'b', action: 'impl', dependsOn: ['a'] },
      { id: 'c', action: 'review', dependsOn: ['b'] },
    ];
    const cycle = detectCycle(nodes);
    expect(cycle).toBeTruthy();
  });

  it('returns null for single node without deps', () => {
    expect(detectCycle([{ id: 'a', action: 'plan', dependsOn: [] }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// topologicalSort()
// ---------------------------------------------------------------------------

describe('topologicalSort()', () => {
  it('sorts a linear chain', () => {
    const nodes = [
      { id: 'c', action: 'review', dependsOn: ['b'] },
      { id: 'a', action: 'plan', dependsOn: [] },
      { id: 'b', action: 'impl', dependsOn: ['a'] },
    ];
    const sorted = topologicalSort(nodes);
    const ids = sorted.map((n) => n.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });

  it('handles parallel nodes at same level', () => {
    const nodes = [
      { id: 'root', action: 'plan', dependsOn: [] },
      { id: 'b', action: 'impl-be', dependsOn: ['root'] },
      { id: 'a', action: 'impl-fe', dependsOn: ['root'] },
    ];
    const sorted = topologicalSort(nodes);
    expect(sorted[0].id).toBe('root');
    // a and b should both come after root (order between them is deterministic: alphabetical)
    expect(sorted.map((n) => n.id)).toEqual(['root', 'a', 'b']);
  });

  it('returns empty for empty input', () => {
    expect(topologicalSort([])).toEqual([]);
    expect(topologicalSort(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getExecutionOrder()
// ---------------------------------------------------------------------------

describe('getExecutionOrder()', () => {
  it('returns node IDs in dependency order', () => {
    const nodes = [
      { id: 'plan', action: 'plan', dependsOn: [] },
      { id: 'impl', action: 'implement', dependsOn: ['plan'] },
      { id: 'review', action: 'review', dependsOn: ['impl'] },
    ];
    const order = getExecutionOrder(nodes);
    expect(order).toEqual(['plan', 'impl', 'review']);
  });
});

// ---------------------------------------------------------------------------
// getParallelGroups()
// ---------------------------------------------------------------------------

describe('getParallelGroups()', () => {
  it('groups parallel-eligible nodes at the same level', () => {
    const nodes = [
      { id: 'plan', action: 'plan', dependsOn: [] },
      { id: 'impl-fe', action: 'implement', parallel: true, dependsOn: ['plan'] },
      { id: 'impl-be', action: 'implement', parallel: true, dependsOn: ['plan'] },
      { id: 'review', action: 'review', dependsOn: ['impl-fe', 'impl-be'] },
    ];
    const groups = getParallelGroups(nodes);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(['plan']);
    expect(groups[1]).toEqual(['impl-be', 'impl-fe']);
    expect(groups[2]).toEqual(['review']);
  });

  it('returns single groups for linear chain', () => {
    const nodes = [
      { id: 'a', action: 'plan', dependsOn: [] },
      { id: 'b', action: 'impl', dependsOn: ['a'] },
      { id: 'c', action: 'review', dependsOn: ['b'] },
    ];
    const groups = getParallelGroups(nodes);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(['a']);
    expect(groups[1]).toEqual(['b']);
    expect(groups[2]).toEqual(['c']);
  });

  it('returns empty for empty input', () => {
    expect(getParallelGroups([])).toEqual([]);
    expect(getParallelGroups(null)).toEqual([]);
  });

  it('handles diamond dependency pattern', () => {
    const nodes = [
      { id: 'start', action: 'plan', dependsOn: [] },
      { id: 'left', action: 'impl', dependsOn: ['start'] },
      { id: 'right', action: 'impl', dependsOn: ['start'] },
      { id: 'end', action: 'merge', dependsOn: ['left', 'right'] },
    ];
    const groups = getParallelGroups(nodes);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(['start']);
    expect(groups[1]).toEqual(['left', 'right']);
    expect(groups[2]).toEqual(['end']);
  });
});
