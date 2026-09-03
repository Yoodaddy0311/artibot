import { describe, expect, it } from 'vitest';
import { emitYaml } from '../../lib/project-state/yaml.js';

describe('emitYaml — scalars', () => {
  it('emits the v1.1 §06 shape without gratuitous quoting', () => {
    expect(emitYaml({ project: 'artibot', state_version: 12 }))
      .toBe('project: artibot\nstate_version: 12\n');
  });

  it('leaves an ISO-8601 instant unquoted', () => {
    expect(emitYaml({ updated_at: '2026-09-02T13:40:00+09:00' }))
      .toBe('updated_at: 2026-09-02T13:40:00+09:00\n');
  });

  it('quotes strings a reader would resolve to another type', () => {
    const cases = {
      bool_like: 'true',
      null_like: 'null',
      yaml11_bool: 'no',
      number_like: '12',
      float_like: '1.5e3',
      empty: '',
      padded: ' x ',
      colon_space: 'a: b',
      hash_comment: 'a #b',
      leading_dash: '-x',
    };
    const out = emitYaml(cases);
    for (const line of out.trim().split('\n')) {
      expect(line, line).toMatch(/: "/);
    }
  });

  it('does not quote a plain string that only contains a colon', () => {
    // `lane:worker-1` is a blocker reason; quoting it would be harmless but
    // noisy, and it is unambiguous because no space follows the colon.
    expect(emitYaml({ b: 'lane:worker-1' })).toBe('b: lane:worker-1\n');
  });

  it('normalises -0 so two renders of one store cannot differ', () => {
    expect(emitYaml({ revision: -0 })).toBe('revision: 0\n');
  });

  it('quotes a KEY a YAML 1.1 reader would resolve to a boolean', () => {
    // 'n' is YAML 1.1 false. Keys go through the same quoting rule as values,
    // because a map key that resolves to `false` is the same corruption.
    expect(emitYaml({ n: 1 })).toBe('"n": 1\n');
  });

  it('emits null explicitly', () => {
    expect(emitYaml({ heartbeat_at: null })).toBe('heartbeat_at: null\n');
  });
});

describe('emitYaml — containers', () => {
  it('renders nested maps at two-space indent', () => {
    expect(emitYaml({ a: { b: { c: 1 } } })).toBe('a:\n  b:\n    c: 1\n');
  });

  it('puts a sequence at its parent key indent', () => {
    expect(emitYaml({ owns: ['lib/**', 'tests/**'] }))
      .toBe('owns:\n- lib/**\n- tests/**\n');
  });

  it('uses flow style for empty containers', () => {
    expect(emitYaml({ blocked_by: [], workers: {} })).toBe('blocked_by: []\nworkers: {}\n');
  });

  it('hoists the first key of a mapping inside a sequence onto the dash', () => {
    expect(emitYaml({ tasks: [{ id: 'T-1', status: 'queued' }] }))
      .toBe('tasks:\n- id: T-1\n  status: queued\n');
  });
});

describe('emitYaml — refusals', () => {
  it.each([
    ['undefined value', { a: undefined }],
    ['a function', { a: () => {} }],
    ['a Date', { a: new Date(0) }],
    ['NaN', { a: NaN }],
    ['Infinity', { a: Infinity }],
    ['a BigInt', { a: 1n }],
  ])('throws on %s rather than emitting something that does not round-trip', (_label, input) => {
    expect(() => emitYaml(input)).toThrow(TypeError);
  });

  it('throws on a circular reference instead of recursing forever', () => {
    const a = { name: 'a' };
    a.self = a;
    expect(() => emitYaml(a)).toThrow(/circular/);
  });

  it('requires a mapping at the root', () => {
    expect(() => emitYaml([1, 2])).toThrow(/root must be a plain object/);
  });
});

describe('emitYaml — determinism', () => {
  it('is a pure function of its input', () => {
    const doc = { project: 'artibot', active_missions: { 'M-20260902-001': { status: 'executing' } } };
    expect(emitYaml(doc)).toBe(emitYaml(doc));
  });

  it('preserves key insertion order rather than sorting', () => {
    expect(emitYaml({ z: 1, a: 2 })).toBe('z: 1\na: 2\n');
  });
});
