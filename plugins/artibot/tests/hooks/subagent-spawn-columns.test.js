/**
 * `lib/runtime/subagent-spawn-columns.js` - the helpers split out of
 * `scripts/hooks/subagent-handler.js` when the hook reached the 800-line cap.
 *
 * The moved bodies keep their behaviour suites where they were (`subagent-handler-served-model`,
 * `subagent-handler-host-meta`, `subagent-handler-resume`, all importing through the hook).
 * This file pins what the split itself added:
 *   - the hook still exports every name those suites import, and each is the module's own
 *     function (not a copy that could drift);
 *   - the three helpers that used to be private to the hook (`extractDepth`, `spawnDurationMs`,
 *     `stoppedEntry`) now have a direct test;
 *   - the hook stays under the file cap it was split to meet.
 *
 * WHAT THIS DOES NOT SEE: the size check reads this one file; it says nothing about any other
 * file's length, and a hook that grows past the cap again fails here by design, not by accident.
 *
 * @module tests/hooks/subagent-spawn-columns
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as handler from '../../scripts/hooks/subagent-handler.js';
import * as columns from '../../lib/runtime/subagent-spawn-columns.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', '..', 'scripts', 'hooks', 'subagent-handler.js');

const REEXPORTED = [
  'HOST_META_MAX_BYTES', 'HOST_META_SOURCE', 'SERVED_TAIL_BYTES', 'carryPolicyColumns',
  'readHostSubagentMeta', 'readServedModel', 'servedFields', 'stopDepthFields',
];

describe('the hook and the module it was split into', () => {
  it.each(REEXPORTED)('%s is exported by the hook and is the module\'s own', (name) => {
    expect(columns[name]).not.toBeUndefined();
    expect(handler[name]).toBe(columns[name]);
  });

  it('keeps the hook under the 800-line file cap', () => {
    const lines = readFileSync(HOOK, 'utf-8').split('\n').length;
    expect(lines, 'subagent-handler.js is at the 800-line cap again: move cohesive helpers into lib/runtime/subagent-*.js')
      .toBeLessThan(800);
  });
});

describe('extractDepth', () => {
  it('takes the first non-negative integer among the four spellings', () => {
    expect(columns.extractDepth({ depth: 2 })).toBe(2);
    expect(columns.extractDepth({ agent_depth: 0 })).toBe(0);
    expect(columns.extractDepth({ nesting_depth: 3 })).toBe(3);
    expect(columns.extractDepth({ tool_input: { depth: 1 } })).toBe(1);
    expect(columns.extractDepth({ depth: -1, agent_depth: 4 })).toBe(4);
  });

  it.each([undefined, null, {}, { depth: 1.5 }, { depth: '2' }, { depth: -1 }, { tool_input: null }])(
    'is null, not a guess, for %j',
    (payload) => {
      expect(columns.extractDepth(payload)).toBeNull();
    },
  );
});

describe('spawnDurationMs', () => {
  const NOW = Date.parse('2026-10-13T00:00:10.000Z');

  it('is the elapsed ms since startedAt', () => {
    expect(columns.spawnDurationMs({ startedAt: '2026-10-13T00:00:00.000Z' }, NOW)).toBe(10000);
    expect(columns.spawnDurationMs({ startedAt: '2026-10-13T00:00:10.000Z' }, NOW)).toBe(0);
  });

  it.each([
    ['no entry', undefined],
    ['a null entry', null],
    ['no stamp', {}],
    ['a null stamp', { startedAt: null }],
    ['a stamp that is not a date', { startedAt: 'garbage' }],
    ['a stamp in the future', { startedAt: '2026-10-13T00:00:20.000Z' }],
  ])('is undefined, not a number, for %s', (_label, tracked) => {
    expect(columns.spawnDurationMs(tracked, NOW)).toBeUndefined();
  });
});

describe('stoppedEntry', () => {
  it('closes the START entry and adds the served columns, without touching the input', () => {
    const existing = Object.freeze({
      role: 'builder', agentType: 'tdd-guide', active: true, startedAt: '2026-10-13T00:00:00.000Z', canonicalModel: 'opus',
    });

    const out = columns.stoppedEntry(existing, { servedModel: 'claude-sonnet-5-5', servedTier: 'sonnet' });

    expect(out).toMatchObject({
      role: 'builder',
      agentType: 'tdd-guide',
      active: false,
      canonicalModel: 'opus',
      servedModel: 'claude-sonnet-5-5',
      servedTier: 'sonnet',
      servedDrift: true,
    });
    expect(new Date(out.stoppedAt).toISOString()).toBe(out.stoppedAt);
    expect(existing.active).toBe(true);
    expect(existing).not.toHaveProperty('stoppedAt');
  });

  it('with nothing served, records explicit nulls and no drift', () => {
    expect(columns.stoppedEntry({ canonicalModel: 'opus' }, undefined)).toMatchObject({
      active: false, servedModel: null, servedTier: null, servedDrift: false,
    });
  });
});
