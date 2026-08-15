/**
 * Prototype-pollution regression for
 * lib/swarm/git-backend.js#gitDownloadLatestWeights.
 *
 * The aggregation loop indexes an accumulator with BOTH the category and the
 * key taken from `patterns/{machineHash}/weights-latest.json` — a file authored
 * by another machine and delivered over git. The category index is the severe
 * one:
 *
 *     if (!aggregated[category]) aggregated[category] = {};
 *     aggregated[category][key] = value;
 *
 * For `category === '__proto__'`, the read `aggregated['__proto__']` runs the
 * inherited accessor and returns Object.prototype — which is truthy, so the
 * `if` never creates a fresh sub-object, and the next line assigns onto
 * Object.prototype itself. That is global, process-wide pollution affecting
 * every object subsequently created, not the scoped prototype swap that the
 * dispatcher merges exhibit.
 *
 * FIXTURE MUST REACH THE FAILURE REGION — rules/verification-discipline.md §9.
 * The NEGATIVE CONTROL below replays the pre-fix loop against the exact same
 * payload and asserts the pollution really lands. If it ever stops landing, the
 * fixture no longer exercises the bug and the assertions under it are vacuous.
 * The payload is built with JSON.parse, never an object literal: in a literal,
 * `__proto__:` is dedicated syntax that sets the prototype at construction and
 * the key never becomes an own property, so it would never reach the loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MACHINE_DIR = 'otherMachineHash';

/** Set by each test to whatever the hostile peer "published". */
let weightsPayload;

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => [MACHINE_DIR]),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock('../../lib/core/file.js', () => ({
  ensureDir: vi.fn(async () => {}),
  writeJsonFile: vi.fn(async () => {}),
  readJsonFile: vi.fn(async (p) => {
    const file = String(p).replace(/\\/g, '/');
    if (file.includes('swarm-machine-hash')) return { hash: 'myMachineHash' };
    if (file.includes('weights-latest.json')) return weightsPayload;
    return null;
  }),
}));

const { gitDownloadLatestWeights } = await import('../../lib/swarm/git-backend.js');

/** Marker keys, deleted after every test so a failure cannot leak into others. */
const MARKERS = ['artibotPwned', 'artibotPwnedNested'];

beforeEach(() => {
  weightsPayload = null;
});

afterEach(() => {
  for (const m of MARKERS) delete Object.prototype[m];
});

describe('gitDownloadLatestWeights — fixture reaches the failure region', () => {
  it('NEGATIVE CONTROL: the pre-fix loop really pollutes Object.prototype', () => {
    const payload = JSON.parse('{"weights":{"__proto__":{"artibotPwned":"GLOBAL"}}}');

    // Verbatim replay of the loop as it stood before the guard.
    const aggregated = {};
    for (const [category, entries] of Object.entries(payload.weights)) {
      if (!aggregated[category]) aggregated[category] = {};
      if (typeof entries !== 'object' || entries === null) continue;
      for (const [key, value] of Object.entries(entries)) {
        aggregated[category][key] = value;
      }
    }

    // The accumulator gains nothing; the damage went somewhere else entirely.
    expect(Object.keys(aggregated)).toEqual([]);
    expect({}.artibotPwned).toBe('GLOBAL');
    expect(Object.prototype.artibotPwned).toBe('GLOBAL');
  });

  it('NEGATIVE CONTROL: JSON.parse produces an own __proto__ key, a literal does not', () => {
    const parsed = JSON.parse('{"__proto__":{"artibotPwned":1}}');
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.keys(parsed)).toContain('__proto__');

    const literal = { __proto__: { artibotPwned: 1 } };
    expect(Object.hasOwn(literal, '__proto__')).toBe(false);
  });
});

describe('gitDownloadLatestWeights — hostile weights-latest.json', () => {
  it('does not pollute Object.prototype via a __proto__ category', async () => {
    weightsPayload = JSON.parse(
      '{"version":"v1","weights":{"__proto__":{"artibotPwned":"GLOBAL"}}}',
    );

    const res = await gitDownloadLatestWeights(null, { repoUrl: 'https://github.com/o/r.git' });

    expect(res.success).toBe(true);
    expect({}.artibotPwned).toBeUndefined();
    expect(Object.prototype.artibotPwned).toBeUndefined();
    expect(Object.keys(res.weights)).not.toContain('__proto__');
  });

  it('does not hijack a category object via a __proto__ weight key', async () => {
    weightsPayload = JSON.parse(
      '{"version":"v1","weights":{"tools":{"__proto__":{"artibotPwnedNested":"NESTED"}}}}',
    );

    const res = await gitDownloadLatestWeights(null, { repoUrl: 'https://github.com/o/r.git' });

    expect(res.success).toBe(true);
    expect({}.artibotPwnedNested).toBeUndefined();
    expect(Object.getPrototypeOf(res.weights.tools)).toBe(Object.prototype);
    expect(res.weights.tools.artibotPwnedNested).toBeUndefined();
  });

  it('drops constructor/prototype categories', async () => {
    weightsPayload = JSON.parse(
      '{"version":"v1","weights":{"constructor":{"a":1},"prototype":{"b":2},"tools":{"Read":{"score":1}}}}',
    );

    const res = await gitDownloadLatestWeights(null, { repoUrl: 'https://github.com/o/r.git' });

    expect(Object.keys(res.weights)).toEqual(['tools']);
    expect(res.weights.constructor).toBe(Object);
  });

  it('still aggregates legitimate weights alongside a hostile category', async () => {
    // Guards against over-blocking: the fix must not eat real data.
    weightsPayload = JSON.parse(
      '{"version":"v1","weights":{"__proto__":{"artibotPwned":1},"tools":{"Read":{"score":0.9},"__proto__":{"x":1}}}}',
    );

    const res = await gitDownloadLatestWeights(null, { repoUrl: 'https://github.com/o/r.git' });

    expect(res.weights.tools).toEqual({ Read: { score: 0.9 } });
    expect({}.artibotPwned).toBeUndefined();
  });
});
