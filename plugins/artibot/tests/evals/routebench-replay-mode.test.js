/**
 * RouteBench replay-mode surface - `scripts/bench/routebench-replay-mode.mjs`.
 *
 * What this file proves
 * ---------------------
 *  1. The producer vocabulary (`lib/replay/replay-label.js#REPLAY_LABELS`,
 *     upper case) and the scenario schema enum (`scenarios.schema.json`
 *     `properties.replay_mode.enum`, lower case) are joined by ONE mapping, and
 *     that mapping is a bijection read against BOTH real sources. A label
 *     renamed on either side is red here.
 *  2. The envelope block carries the producer's own `exact_reachable` and
 *     reason, counts DECLARATIONS by scenario, and names the declared-`exact`
 *     scenarios the producer can never grade EXACT.
 *  3. `measured` is null for a structural reason that is pinned, not asserted:
 *     every line `labelReplay` can count carries a key the runner's scrub gate
 *     refuses, and the shipped corpora yield zero Actions.
 *
 * What it CANNOT prove
 * --------------------
 *  - That any scenario's declaration is correct. Declarations are copied.
 *  - That a future corpus format could not feed labelReplay under different
 *    key names. The pin is on today's gate list and today's join keys.
 *
 * @module tests/evals/routebench-replay-mode
 */

import { describe, expect, it } from 'vitest';
import {
  EXACT_UNREACHABLE_REASON,
  labelReplay,
  REPLAY_LABELS,
} from '../../lib/replay/replay-label.js';
import {
  MEASURED_UNAVAILABLE_REASON,
  REPLAY_MODE_BY_LABEL,
  REPLAY_MODES,
  replayLabelBlock,
  replayModeOf,
} from '../../scripts/bench/routebench-replay-mode.mjs';
import { corpusViolations, FORBIDDEN_CORPUS_KEYS } from '../../scripts/bench/routebench.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const FIXTURE_DIR = path.join(PLUGIN_ROOT, 'tests/evals/fixtures/routebench');
const SCHEMA = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'scenarios.schema.json'), 'utf-8'));
const SCHEMA_ENUM = SCHEMA.properties.replay_mode.enum;
const MODULE_FILE = path.join(PLUGIN_ROOT, 'scripts/bench/routebench-replay-mode.mjs');

/** @returns {object[]} parsed JSONL, blank lines skipped */
function readJsonl(file) {
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const SHIPPED_SCENARIOS = readJsonl(path.join(FIXTURE_DIR, 'scenarios.example.jsonl'));

/**
 * The smallest line `labelReplay` counts as an Action: the three conditions of
 * `route-bind.js#isPreToolUseReceipt`. Built here rather than imported so the
 * test states the join keys it depends on.
 */
const MIN_ACTION_LINE = Object.freeze({
  event: 'route.selected',
  routing_epoch_id: 'tu-1',
  data: { shadow_of: 'tool_use:tu-1' },
});

describe('replay-mode mapping - producer labels to the scenario schema enum', () => {
  it('pins the table literally', () => {
    expect(REPLAY_MODE_BY_LABEL).toEqual({
      EXACT: 'exact',
      PARTIAL: 'partial',
      SIMULATED: 'simulation',
    });
    expect(Object.isFrozen(REPLAY_MODE_BY_LABEL)).toBe(true);
    expect(Object.isFrozen(REPLAY_MODES)).toBe(true);
  });

  it('has exactly the producer labels as keys, in producer order, and nothing else', () => {
    expect(Object.keys(REPLAY_MODE_BY_LABEL)).toEqual([...REPLAY_LABELS]);
  });

  it('has exactly the schema enum as values, in enum order - a bijection', () => {
    const values = Object.values(REPLAY_MODE_BY_LABEL);
    expect(values).toEqual(SCHEMA_ENUM);
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBe(REPLAY_LABELS.length);
    expect(SCHEMA_ENUM.length).toBe(REPLAY_LABELS.length);
    expect(REPLAY_MODES).toEqual(values);
  });

  it('is not a case-fold: the third word differs, which is why the table exists', () => {
    const folded = REPLAY_LABELS.map((label) => label.toLowerCase());
    expect(folded).not.toEqual(SCHEMA_ENUM);
    expect(folded.filter((word) => !SCHEMA_ENUM.includes(word))).toEqual(['simulated']);
  });

  it('keeps replay_mode optional in the schema, which is why a row can carry null', () => {
    expect(SCHEMA.required).not.toContain('replay_mode');
  });
});

describe('replayModeOf - the value a row carries', () => {
  it('returns each declared enum value unchanged', () => {
    for (const mode of SCHEMA_ENUM) expect(replayModeOf({ replay_mode: mode })).toBe(mode);
  });

  it('returns null for an absent, null, producer-cased or misspelled value - never a guess', () => {
    expect(replayModeOf({})).toBeNull();
    expect(replayModeOf({ replay_mode: null })).toBeNull();
    expect(replayModeOf({ replay_mode: 'SIMULATED' })).toBeNull();
    expect(replayModeOf({ replay_mode: 'simulated' })).toBeNull();
    expect(replayModeOf({ replay_mode: 'EXACT' })).toBeNull();
    expect(replayModeOf(null)).toBeNull();
    expect(replayModeOf('exact')).toBeNull();
  });
});

describe('replayLabelBlock - the envelope block', () => {
  it('fixes its key order and its declared sub-block key order', () => {
    const block = replayLabelBlock(SHIPPED_SCENARIOS);
    expect(Object.keys(block)).toEqual([
      'producer', 'mapping', 'exact_reachable', 'exact_unreachable_reason',
      'declared', 'measured', 'measured_reason',
    ]);
    expect(Object.keys(block.declared)).toEqual([
      'unit', 'scenarios', 'by_mode', 'undeclared', 'unrecognized',
      'exact_unreachable_scenarios',
    ]);
    expect(Object.keys(block.declared.by_mode)).toEqual(SCHEMA_ENUM);
  });

  it('carries the producer answer, not a copy of it', () => {
    const block = replayLabelBlock([]);
    const producer = labelReplay([]);
    expect(block.exact_reachable).toBe(producer.exact_reachable);
    expect(block.exact_reachable).toBe(false);
    expect(block.exact_unreachable_reason).toBe(EXACT_UNREACHABLE_REASON);
    expect(block.exact_unreachable_reason).toBe(producer.exact_unreachable_reason);
    expect(block.producer).toBe('lib/replay/replay-label.js#labelReplay');
    expect(block.mapping).toEqual(REPLAY_MODE_BY_LABEL);
  });

  it('counts the shipped fixture declarations: 1 exact, 1 partial, 4 simulation of 6', () => {
    // Measured from scenarios.example.jsonl on 2026-09-23. A fixture edit that
    // changes a declaration is a red test, not a silently different envelope.
    const { declared, measured, measured_reason: reason } = replayLabelBlock(SHIPPED_SCENARIOS);
    expect(declared).toEqual({
      unit: 'scenario',
      scenarios: 6,
      by_mode: { exact: 1, partial: 1, simulation: 4 },
      undeclared: 0,
      unrecognized: 0,
      exact_unreachable_scenarios: ['seeded-defect-seven-axis-review'],
    });
    expect(measured).toBeNull();
    expect(reason).toBe(MEASURED_UNAVAILABLE_REASON);
  });

  it('separates undeclared from unrecognized and keeps the sum equal to scenarios', () => {
    const list = [
      { id: 'b', replay_mode: 'exact' },
      { id: 'a', replay_mode: 'exact' },
      { id: 'c' },
      { id: 'd', replay_mode: 'SIMULATED' },
      { id: 'e', replay_mode: null },
      { id: 'f', replay_mode: 'partial' },
      42,
    ];
    const { declared } = replayLabelBlock(list);
    expect(declared.by_mode).toEqual({ exact: 2, partial: 1, simulation: 0 });
    expect(declared.undeclared).toBe(2);
    expect(declared.unrecognized).toBe(2);
    const sum = Object.values(declared.by_mode).reduce((x, y) => x + y, 0)
      + declared.undeclared + declared.unrecognized;
    expect(sum).toBe(declared.scenarios);
    expect(declared.exact_unreachable_scenarios).toEqual(['a', 'b']);
  });

  it('lists an exact scenario with no usable id as null, never as the string "undefined"', () => {
    const list = [
      { replay_mode: 'exact' },
      { id: '', replay_mode: 'exact' },
      { id: 7, replay_mode: 'exact' },
      { id: 'z', replay_mode: 'exact' },
    ];
    const { declared } = replayLabelBlock(list);
    expect(declared.exact_unreachable_scenarios).toEqual(['z', null, null, null]);
    expect(declared.exact_unreachable_scenarios).not.toContain('undefined');
    expect(declared.exact_unreachable_scenarios.length).toBe(declared.by_mode.exact);
    const reversed = replayLabelBlock([...list].reverse()).declared.exact_unreachable_scenarios;
    expect(reversed).toEqual(declared.exact_unreachable_scenarios);
  });

  it('reads a non-array as zero scenarios, with zero counts rather than nulls', () => {
    expect(replayLabelBlock(undefined).declared).toEqual({
      unit: 'scenario',
      scenarios: 0,
      by_mode: { exact: 0, partial: 0, simulation: 0 },
      undeclared: 0,
      unrecognized: 0,
      exact_unreachable_scenarios: [],
    });
  });

  it('serializes to the same bytes regardless of scenario order', () => {
    const forward = JSON.stringify(replayLabelBlock(SHIPPED_SCENARIOS));
    const reversed = JSON.stringify(replayLabelBlock([...SHIPPED_SCENARIOS].reverse()));
    expect(reversed).toBe(forward);
  });

  it('hands out a fresh mapping object, so a caller cannot edit the pinned table', () => {
    const block = replayLabelBlock([]);
    block.mapping.SIMULATED = 'simulated';
    expect(REPLAY_MODE_BY_LABEL.SIMULATED).toBe('simulation');
  });
});

describe('measured is null by construction - evidence, not assertion', () => {
  it('the gate forbids both keys labelReplay joins on', () => {
    expect(FORBIDDEN_CORPUS_KEYS).toContain('routing_epoch_id');
    expect(FORBIDDEN_CORPUS_KEYS).toContain('tool_use_id');
  });

  it('a line labelReplay counts is refused by the scrub gate', () => {
    expect(labelReplay([MIN_ACTION_LINE]).actions).toBe(1);
    expect(corpusViolations(`${JSON.stringify(MIN_ACTION_LINE)}\n`))
      .toContain('line 1: forbidden-key:routing_epoch_id');
  });

  it('the same line with the forbidden key removed is no longer an Action', () => {
    const { routing_epoch_id: _dropped, ...scrubbed } = MIN_ACTION_LINE;
    expect(corpusViolations(`${JSON.stringify(scrubbed)}\n`)).toEqual([]);
    expect(labelReplay([scrubbed]).actions).toBe(0);
  });

  it('every shipped corpus yields zero Actions and carries no ledger event name', () => {
    const dir = path.join(FIXTURE_DIR, 'corpus');
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    expect(files.length).toBe(4);
    for (const name of files) {
      const rows = readJsonl(path.join(dir, name));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => Object.hasOwn(r, 'event'))).toEqual([]);
      expect(labelReplay(rows).actions).toBe(0);
    }
  });
});

describe('routebench-replay-mode - source hygiene', () => {
  const source = readFileSync(MODULE_FILE, 'utf-8');
  const ALLOWED_SPECIFIERS = Object.freeze(['../../lib/replay/replay-label.js']);

  /**
   * Plain substrings that must not appear anywhere in the module, comments
   * included - the same rule as routebench-runner.test.js's network scan
   * (both quote styles, `node:` covers every builtin incl. fs and
   * child_process), plus the clock and randomness the module promises not to
   * read.
   */
  const FORBIDDEN_TOKENS = Object.freeze([
    'node:', "'http'", "'https'", "'net'", "'dns'", "'tls'", "'undici'", "'node-fetch'",
    "'axios'", "'child_process'", "'fs'", '"http"', '"https"', '"net"', '"dns"', '"tls"',
    '"undici"', '"node-fetch"', '"axios"', '"child_process"', '"fs"',
    'fetch(', 'XMLHttpRequest', 'WebSocket', 'new Date(', 'Date.now(', 'Math.random(',
  ]);

  /**
   * Every way this module could load code, as findings. Static `from` imports
   * (single- or multi-line: `\s*` spans newlines), side-effect imports, and
   * re-exports are collected as specifiers and must all be on the allowlist;
   * dynamic `import(` and `require(` are refused outright. An allowlist, not a
   * deny list: an unforeseen specifier is a finding by default.
   *
   * @param {string} text - module source
   * @returns {string[]} findings, empty when clean
   */
  function loadFindings(text) {
    const specifiers = [
      ...text.matchAll(/\bfrom\s*(["'])([^"']+)\1/gu),
      ...text.matchAll(/\bimport\s*(["'])([^"']+)\1/gu),
    ].map((m) => m[2]);
    return [
      ...specifiers.filter((s) => !ALLOWED_SPECIFIERS.includes(s)).map((s) => `specifier:${s}`),
      ...(/\bimport\s*\(/u.test(text) ? ['dynamic-import'] : []),
      ...(/\brequire\s*\(/u.test(text) ? ['require'] : []),
      ...FORBIDDEN_TOKENS.filter((t) => text.includes(t)).map((t) => `token:${t}`),
    ];
  }

  it('imports only the producer module, and loads nothing else any way', () => {
    expect(loadFindings(source)).toEqual([]);
    const found = [...source.matchAll(/\bfrom\s*(["'])([^"']+)\1/gu)].map((m) => m[2]);
    expect(found).toEqual([...ALLOWED_SPECIFIERS]);
  });

  it('the scanner fires on every import form - proven by injecting into a copy', () => {
    // Positive controls: each spelling the old single-line regex missed. The
    // file on disk is never written.
    const cases = [
      ["import 'undici';", 'specifier:undici'],
      ['import "undici";', 'specifier:undici'],
      ['import {\n  readFileSync,\n} from "node:fs";', 'specifier:node:fs'],
      ["import x from 'y';", 'specifier:y'],
      ["export { z } from 'w';", 'specifier:w'],
      ["const m = await import('x');", 'dynamic-import'],
      ['const m = await import ("x");', 'dynamic-import'],
      ["const c = require('child_process');", 'require'],
      ['const t = Date.now();', 'token:Date.now('],
    ];
    for (const [injected, expected] of cases) {
      expect(loadFindings(`${source}\n${injected}\n`)).toContain(expected);
    }
  });

  it('has no main entry', () => {
    expect(source).not.toContain('process.argv');
    expect(source).not.toContain('isMainEntry');
  });

  it('is ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(source.match(/[^\x00-\x7F]/gu)).toBeNull();
  });
});
