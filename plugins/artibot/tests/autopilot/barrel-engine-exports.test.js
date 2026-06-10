/**
 * Regression guard for the autopilot public barrel (audit 2026-06-10, Critical #2).
 *
 * Defect: commands/autopilot.md drives the orchestrator to call
 * engine.recordPhaseResult / recordCheckpoint / classifyFailure / recordSecretLeak
 * and the preflight/recovery helpers, but lib/autopilot/index.js did not re-export
 * them — so the documented orchestration API was absent from the public surface.
 *
 * Fix: re-export the 8 functions. This test (1) asserts they are present and
 * (2) scans autopilot.md for every `engine.<name>(` reference and asserts each
 * resolves to a named export — so doc/code drift can't silently recur.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as autopilot from '../../lib/autopilot/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

const REQUIRED = [
  'recordPhaseResult',
  'recordCheckpoint',
  'classifyFailure',
  'recordSecretLeak',
  'buildPreflightInstruction',
  'renderPreflightSummary',
  'detectInterruptedPhase',
  'buildRecoveryNote',
];

describe('autopilot barrel re-exports the documented engine helpers', () => {
  it.each(REQUIRED)('exports %s as a function', (name) => {
    expect(typeof autopilot[name]).toBe('function');
  });
});

describe('commands/autopilot.md references no undefined engine.* function', () => {
  it('every engine.<name>( in autopilot.md is a named export of the barrel', () => {
    const md = readFileSync(path.join(PLUGIN_ROOT, 'commands', 'autopilot.md'), 'utf-8');
    const referenced = new Set();
    for (const m of md.matchAll(/\bengine\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      referenced.add(m[1]);
    }
    expect(referenced.size).toBeGreaterThan(0); // sanity: the doc does reference engine.*

    const missing = [...referenced].filter((name) => typeof autopilot[name] !== 'function');
    expect(missing).toEqual([]);
  });
});
