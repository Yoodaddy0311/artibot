/**
 * Unit tests for lib/autopilot/auto-wire-policy.js
 *
 * Covers:
 *   - defaults (everything enabled)
 *   - frozen return value
 *   - opts.override applies on top of defaults
 *   - opts.override only accepts booleans (drops non-bool)
 *   - config file disables individual features
 *   - opts.override wins over config
 *   - missing config file is non-fatal
 *   - malformed JSON config is non-fatal
 *   - unknown keys in config are ignored
 *   - AUTOWIRE_KEYS shape matches DEFAULT_AUTOWIRE_POLICY
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AUTOWIRE_KEYS,
  DEFAULT_AUTOWIRE_POLICY,
  getAutoWirePolicy,
} from '../../lib/autopilot/auto-wire-policy.js';

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'autowire-policy-'));
});

afterEach(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeConfig(block) {
  const p = path.join(workDir, 'autopilot.config.json');
  writeFileSync(p, JSON.stringify({ autoWire: block }), 'utf-8');
  return p;
}

describe('getAutoWirePolicy — defaults', () => {
  it('returns all-enabled when no config and no override', () => {
    const policy = getAutoWirePolicy({ cwd: workDir });
    expect(policy.costPredict).toBe(true);
    expect(policy.smartSkip).toBe(true);
    expect(policy.autoRollback).toBe(true);
    expect(policy.autoDrift).toBe(true);
    expect(policy.autoFlamegraph).toBe(true);
  });

  it('returns a frozen object', () => {
    const policy = getAutoWirePolicy({ cwd: workDir });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('DEFAULT_AUTOWIRE_POLICY exposes every key in AUTOWIRE_KEYS', () => {
    for (const key of AUTOWIRE_KEYS) {
      expect(DEFAULT_AUTOWIRE_POLICY[key]).toBe(true);
    }
  });
});

describe('getAutoWirePolicy — opts.override', () => {
  it('disables a single feature via override', () => {
    const policy = getAutoWirePolicy({
      cwd: workDir,
      override: { autoRollback: false },
    });
    expect(policy.autoRollback).toBe(false);
    expect(policy.costPredict).toBe(true);
  });

  it('drops non-boolean override values silently', () => {
    const policy = getAutoWirePolicy({
      cwd: workDir,
      override: { costPredict: 'yes', smartSkip: 1, autoDrift: null },
    });
    expect(policy.costPredict).toBe(true);
    expect(policy.smartSkip).toBe(true);
    expect(policy.autoDrift).toBe(true);
  });

  it('ignores unknown override keys', () => {
    const policy = getAutoWirePolicy({
      cwd: workDir,
      override: { bogusFeature: false },
    });
    expect(Object.prototype.hasOwnProperty.call(policy, 'bogusFeature')).toBe(false);
  });
});

describe('getAutoWirePolicy — config file', () => {
  it('reads autoWire block from autopilot.config.json', () => {
    writeConfig({ smartSkip: false, autoFlamegraph: false });
    const policy = getAutoWirePolicy({ cwd: workDir });
    expect(policy.smartSkip).toBe(false);
    expect(policy.autoFlamegraph).toBe(false);
    expect(policy.costPredict).toBe(true);
  });

  it('override wins over config when both present', () => {
    writeConfig({ autoRollback: false });
    const policy = getAutoWirePolicy({
      cwd: workDir,
      override: { autoRollback: true },
    });
    expect(policy.autoRollback).toBe(true);
  });

  it('returns defaults when config file is missing', () => {
    const policy = getAutoWirePolicy({ cwd: workDir });
    expect(policy).toEqual(DEFAULT_AUTOWIRE_POLICY);
  });

  it('returns defaults when config JSON is malformed', () => {
    writeFileSync(path.join(workDir, 'autopilot.config.json'), '{ not valid', 'utf-8');
    const policy = getAutoWirePolicy({ cwd: workDir });
    expect(policy).toEqual(DEFAULT_AUTOWIRE_POLICY);
  });

  it('ignores config when autoWire key is absent', () => {
    writeFileSync(
      path.join(workDir, 'autopilot.config.json'),
      JSON.stringify({ other: 'block' }),
      'utf-8',
    );
    const policy = getAutoWirePolicy({ cwd: workDir });
    expect(policy).toEqual(DEFAULT_AUTOWIRE_POLICY);
  });

  it('accepts explicit configPath override', () => {
    const customPath = path.join(workDir, 'custom.json');
    writeFileSync(customPath, JSON.stringify({ autoWire: { costPredict: false } }), 'utf-8');
    const policy = getAutoWirePolicy({ cwd: workDir, configPath: customPath });
    expect(policy.costPredict).toBe(false);
  });
});
