/**
 * v1.1 status ↔ lane state mapping, and the `failed` allowlist widening.
 *
 * Three vocabularies describe the same question ("what is this worker doing
 * now"): the `/split` leader's ops words, the design's twelve lane states, and
 * v1.1's eight task statuses. `contracts.js` carries ONE authored table
 * between the last two; everything else is derived from it. These tests exist
 * so that "derived" stays true and so the widened ops allowlist cannot quietly
 * change what already-shipped code accepts.
 *
 * @module tests/supervisor/v11-status-mapping.test
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isLaneOpsState,
  isV11Status,
  LANE_OPS_STATES,
  LANE_OPS_TO_LANE_STATE,
  LANE_OPS_TO_V11_STATUS,
  LANE_STATES,
  V11_STATUS_TO_LANE_STATE,
  V11_STATUSES,
} from '../../lib/supervisor/contracts.js';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PLUGIN_ROOT = resolve(HERE, '../..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '../..');
const SCHEMA_PATH = join(PLUGIN_ROOT, 'schemas', 'task-graph.schema.json');

/**
 * The ops→v1.1 table exactly as the design writes it (lane 5 §2-D). Written
 * out by hand ON PURPOSE: the module derives this direction by composition, so
 * a literal copy of the design is the only thing that can catch the
 * composition silently producing something else.
 */
const DESIGN_OPS_TO_V11 = Object.freeze({
  'pending': 'queued',
  'awaiting-dispatch': 'claimed',
  'active': 'executing',
  'closing': 'executing',
  'review': 'reviewing',
  'serial-gate': 'blocked',
  'suspended': 'blocked',
  'done': 'done',
  'failed': 'failed',
});

describe('v1.1 status ↔ lane state', () => {
  it('maps all eight v1.1 statuses onto real lane states, and nothing else', () => {
    expect(V11_STATUSES).toHaveLength(8);
    for (const status of V11_STATUSES) {
      const lane = V11_STATUS_TO_LANE_STATE[status];
      expect(lane, `no lane state for v1.1 '${status}'`).toBeDefined();
      expect(LANE_STATES).toContain(lane);
    }
    // Total in the other direction too: no key that is not a v1.1 status.
    expect(Object.keys(V11_STATUS_TO_LANE_STATE).sort()).toEqual([...V11_STATUSES].sort());
  });

  it('is injective, which is what makes the derived inverse well defined', () => {
    const lanes = Object.values(V11_STATUS_TO_LANE_STATE);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it('pins the four lane states v1.1 cannot express', () => {
    // Losses documented on V11_STATUS_TO_LANE_STATE. Giving one of these a v1.1
    // word later is a vocabulary decision, not a refactor, so it should have to
    // change this line.
    const reachable = new Set(Object.values(V11_STATUS_TO_LANE_STATE));
    const unreachable = LANE_STATES.filter((s) => !reachable.has(s));
    expect(unreachable).toEqual(['CLAIMED', 'CHECKPOINTING', 'FIXING', 'FAILED_TERMINAL']);
  });

  it('accepts only the allowlist as a v1.1 status (fail-closed on unknowns)', () => {
    for (const status of V11_STATUSES) expect(isV11Status(status)).toBe(true);
    expect(isV11Status('QUEUED')).toBe(false);
    expect(isV11Status('running')).toBe(false);
    expect(isV11Status('pending')).toBe(false); // an ops word, not a v1.1 one
    expect(isV11Status(null)).toBe(false);
    expect(isV11Status(undefined)).toBe(false);
  });

  it('stays byte-identical to the task-graph schema enum (T-14 drift guard)', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const enumValues = schema.definitions.task.properties.status.enum;
    // Same values AND same order — the schema enum is the canonical listing.
    expect([...V11_STATUSES]).toEqual(enumValues);
  });
});

describe('ops → v1.1 (derived)', () => {
  it('gives all nine ops states a v1.1 value', () => {
    expect(LANE_OPS_STATES).toHaveLength(9);
    for (const ops of LANE_OPS_STATES) {
      const status = LANE_OPS_TO_V11_STATUS[ops];
      expect(status, `no v1.1 status for ops '${ops}'`).toBeDefined();
      expect(isV11Status(status)).toBe(true);
    }
    expect(Object.keys(LANE_OPS_TO_V11_STATUS).sort()).toEqual([...LANE_OPS_STATES].sort());
  });

  it('reproduces the design table exactly, row for row', () => {
    expect({ ...LANE_OPS_TO_V11_STATUS }).toEqual(DESIGN_OPS_TO_V11);
  });

  it('loses `closing` and `suspended` on the round trip, as designed', () => {
    // Both merge into another word on the way out; nothing brings them back.
    // Asserted so that a future "fix" has to be a deliberate one.
    expect(LANE_OPS_TO_V11_STATUS.closing).toBe(LANE_OPS_TO_V11_STATUS.active);
    expect(LANE_OPS_TO_V11_STATUS.suspended).toBe(LANE_OPS_TO_V11_STATUS['serial-gate']);
  });
});

describe('the `failed` ops state (allowlist widening)', () => {
  it('is the ninth ops state and maps through both tables', () => {
    expect(LANE_OPS_STATES).toContain('failed');
    expect(LANE_OPS_STATES[8]).toBe('failed');
    expect(isLaneOpsState('failed')).toBe(true);
    expect(LANE_OPS_TO_LANE_STATE.failed).toBe('FAILED_RECOVERABLE');
    expect(LANE_OPS_TO_V11_STATUS.failed).toBe('failed');
  });

  it('keeps LANE_OPS_TO_LANE_STATE total over the widened allowlist', () => {
    expect(Object.keys(LANE_OPS_TO_LANE_STATE).sort()).toEqual([...LANE_OPS_STATES].sort());
    for (const ops of LANE_OPS_STATES) {
      expect(LANE_STATES).toContain(LANE_OPS_TO_LANE_STATE[ops]);
    }
  });

  it('has no emitter in the source tree — the widening changes no live behavior', () => {
    // R-11: adding to an allowlist makes `isLaneOpsState` return true more
    // often, so it is only safe while nothing writes the string. Re-measured
    // here on every run rather than trusted from a comment.
    //
    // Scope, stated so the number is not read wider than it is: files with a
    // code/data extension under the repo root, excluding node_modules, .git,
    // build output, and `.artibot/` runtime data (that last one is a human's
    // live run, not an emitter — a person typing `failed` through
    // scripts/split/lane-state.mjs is now legal). This file is excluded
    // because it necessarily contains the pattern it searches for.
    //
    // WHAT THIS GATE CANNOT SEE — written next to the gate so the gate does
    // not become the evidence for the next blind spot:
    // - A DERIVED writer. This is a literal grep, so it misses code that
    //   computes the word instead of spelling it. One exists:
    //   `lib/topology/split-state.js#writeWorkerState({ patch: { status:
    //   'failed' } })` derives the ops word through `opsWordFor` and writes
    //   `state: 'failed'` into run.json with no literal anywhere in the file
    //   (measured 2026-09-02: 0 production consumers of that module; its only
    //   importer is its own test). Reachability, not spelling, is what makes
    //   the count below meaningful.
    // - Non-JS emitters: a shell script, a hook, or a hand-edited run.json.
    // - `.artibot/` runtime data, excluded above on purpose.
    const hits = findEmitters();
    expect(hits, `unexpected emitters of ops state 'failed':\n${hits.join('\n')}`).toEqual([]);
  });
});

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.artibot', 'coverage', 'dist', 'build', '.next', '.cache',
]);
const SCAN_EXT = /\.(?:js|mjs|cjs|ts|mts|cts|json)$/;
const SELF = resolve(HERE, 'v11-status-mapping.test.js');

/**
 * `state` key or assignment set to the literal `failed`, e.g. `state: 'failed'`
 * or `"state": "failed"`. Built from parts so this file does not itself
 * contain a literal the pattern would match.
 */
const EMITTER = new RegExp(String.raw`state["']?\s*[:=]\s*["']` + 'failed' + String.raw`["']`);

/**
 * @returns {string[]} repo-relative `path:line` for each match
 */
function findEmitters() {
  const hits = [];
  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is not an emitter
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || !SCAN_EXT.test(entry.name) || full === SELF) continue;
      let size;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > 2_000_000) continue; // lockfiles and bundles, not emitters
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!EMITTER.test(text)) continue;
      text.split('\n').forEach((line, i) => {
        if (EMITTER.test(line)) hits.push(`${relative(REPO_ROOT, full)}:${i + 1}`);
      });
    }
  };
  walk(REPO_ROOT);
  return hits;
}
