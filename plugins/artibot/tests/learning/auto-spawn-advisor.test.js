/**
 * Tests for lib/learning/auto-spawn-advisor.js (AGO Track G6).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _internals,
  analyzeNextSession,
  buildSuggestion,
  readPendingSuggestions,
  resolveAutoSpawnConfig,
  resolveSuggestion,
} from '../../lib/learning/auto-spawn-advisor.js';

const RUNTIME_REL = _internals.SUGGESTIONS_RELATIVE_PATH;

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'advisor-'));
}

function readSuggestionsFile(root) {
  const p = path.join(root, RUNTIME_REL);
  return JSON.parse(readFileSync(p, 'utf8'));
}

describe('auto-spawn-advisor / resolveAutoSpawnConfig', () => {
  it('returns wave-2 defaults (masterEnabled=true, enabled=true, requireOptIn=false)', () => {
    const cfg = resolveAutoSpawnConfig(undefined);
    expect(cfg.masterEnabled).toBe(true);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxDepth).toBe(2);
    expect(cfg.minConfidence).toBe(0.8);
    expect(cfg.requireOptIn).toBe(false);
  });

  it('respects explicit disable (enabled=false)', () => {
    const cfg = resolveAutoSpawnConfig({
      ago: { autoSpawn: { enabled: false } },
    });
    expect(cfg.enabled).toBe(false);
  });

  it('respects master opt-out (selfControl.masterEnabled=false)', () => {
    const cfg = resolveAutoSpawnConfig({
      ago: { selfControl: { masterEnabled: false } },
    });
    expect(cfg.masterEnabled).toBe(false);
  });

  it('respects provided values', () => {
    const cfg = resolveAutoSpawnConfig({
      ago: { autoSpawn: { enabled: true, maxDepth: 3, minConfidence: 0.9, requireOptIn: true } },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxDepth).toBe(3);
    expect(cfg.minConfidence).toBe(0.9);
    expect(cfg.requireOptIn).toBe(true);
  });
});

describe('auto-spawn-advisor / buildSuggestion', () => {
  it('rejects unknown category', () => {
    expect(buildSuggestion({ category: 'bogus', confidence: 1 }, { minConfidence: 0.8, maxDepth: 2, seq: 0 })).toBeNull();
  });

  it('rejects below minConfidence', () => {
    expect(
      buildSuggestion(
        { category: 'drift', confidence: 0.5, reason: 'x' },
        { minConfidence: 0.8, maxDepth: 2, seq: 0 },
      ),
    ).toBeNull();
  });

  it('rejects depth exceeding maxDepth', () => {
    expect(
      buildSuggestion(
        { category: 'drift', confidence: 0.95, reason: 'x', depth: 3 },
        { minConfidence: 0.8, maxDepth: 2, seq: 0 },
      ),
    ).toBeNull();
  });

  it('builds a valid suggestion with defaults', () => {
    const s = buildSuggestion(
      { category: 'drift', confidence: 0.9, reason: 'agent drift', suggestedAction: 'recal' },
      { minConfidence: 0.8, maxDepth: 2, seq: 1 },
    );
    expect(s).not.toBeNull();
    expect(s.requiresApproval).toBe(true);
    expect(s.resolved).toBe(false);
    expect(s.depth).toBe(0);
    expect(s.confidence).toBe(0.9);
    expect(s.id).toMatch(/^sug-/);
  });
});

describe('auto-spawn-advisor / analyzeNextSession', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes by default when config is empty (Wave-2 default ON)', async () => {
    const result = await analyzeNextSession(
      { testFailures: [{ name: 'foo.test.js' }] },
      { pluginRoot: root, config: {} },
    );
    expect(result.written).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('respects master opt-out (selfControl.masterEnabled=false)', async () => {
    const result = await analyzeNextSession(
      { testFailures: [{ name: 'foo.test.js' }] },
      { pluginRoot: root, config: { ago: { selfControl: { masterEnabled: false } } } },
    );
    expect(result.written).toBe(false);
    expect(result.reason).toBe('master-disabled');
  });

  it('respects feature opt-out (autoSpawn.enabled=false)', async () => {
    const result = await analyzeNextSession(
      { testFailures: [{ name: 'foo.test.js' }] },
      { pluginRoot: root, config: { ago: { autoSpawn: { enabled: false } } } },
    );
    expect(result.written).toBe(false);
    expect(result.reason).toBe('feature-disabled');
  });

  it('legacy opt-in gate still works when requireOptIn=true and enabled not explicitly true', async () => {
    const result = await analyzeNextSession(
      { testFailures: [{ name: 'foo.test.js' }] },
      {
        pluginRoot: root,
        config: { ago: { autoSpawn: { requireOptIn: true } } },
      },
    );
    // enabled defaults to true but the user forced requireOptIn=true and did not set enabled=true explicitly → opt-in-required
    expect(result.written).toBe(false);
    expect(result.reason).toBe('opt-in-required');
  });

  it('kill-switch trip hard-blocks writes', async () => {
    // Seed the kill-switch state file so `isKillSwitchTripped` returns true for 'auto-spawn'.
    const ksDir = path.join(root, 'runtime');
    mkdirSync(ksDir, { recursive: true });
    const ksState = {
      features: {
        'auto-spawn': {
          failures: [],
          trippedAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(path.join(ksDir, 'kill-switch.json'), JSON.stringify(ksState), 'utf8');

    const result = await analyzeNextSession(
      { testFailures: [{ name: 'foo.test.js' }] },
      { pluginRoot: root, config: {} },
    );
    expect(result.written).toBe(false);
    expect(result.reason).toBe('kill-switch-tripped');
  });

  it('writes suggestions when enabled and signals present', async () => {
    const result = await analyzeNextSession(
      {
        testFailures: [{ name: 'a.test.js' }, { name: 'b.test.js' }],
        staleSkills: ['skill-one'],
        driftWarnings: [{ agent: 'alpha', avg: 0.4, threshold: 0.65, confidence: 0.9 }],
      },
      {
        pluginRoot: root,
        config: { ago: { autoSpawn: { enabled: true, maxDepth: 2, minConfidence: 0.8, requireOptIn: true } } },
      },
    );
    expect(result.written).toBe(true);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    const file = readSuggestionsFile(root);
    expect(file.count).toBe(result.suggestions.length);
    expect(file.suggestions.every((s) => s.requiresApproval === true)).toBe(true);
  });

  it('filters suggestions below minConfidence', async () => {
    const result = await analyzeNextSession(
      {
        // drift signal with low confidence
        driftWarnings: [{ agent: 'alpha', avg: 0.5, threshold: 0.65, confidence: 0.5 }],
      },
      {
        pluginRoot: root,
        config: { ago: { autoSpawn: { enabled: true, maxDepth: 2, minConfidence: 0.8, requireOptIn: true } } },
      },
    );
    expect(result.written).toBe(false);
    expect(result.reason).toBe('no-signals');
  });

  it('rejects signals exceeding maxDepth via buildSuggestion gate', async () => {
    // Simulate a learning-incomplete signal with depth 3 by crafting summary → buildSuggestion path.
    // Because collect* helpers produce depth 0 by default, this verifies the guard via direct builder.
    const sig = buildSuggestion(
      { category: 'learning-incomplete', confidence: 0.95, reason: 'r', depth: 3 },
      { minConfidence: 0.8, maxDepth: 2, seq: 0 },
    );
    expect(sig).toBeNull();
  });

  it('returns no-signals when summary is empty', async () => {
    const result = await analyzeNextSession(
      {},
      {
        pluginRoot: root,
        config: { ago: { autoSpawn: { enabled: true, maxDepth: 2, minConfidence: 0.8, requireOptIn: true } } },
      },
    );
    expect(result.written).toBe(false);
    expect(result.reason).toBe('no-signals');
  });
});

describe('auto-spawn-advisor / readPendingSuggestions + resolveSuggestion', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns [] when file missing', async () => {
    const pending = await readPendingSuggestions(root);
    expect(pending).toEqual([]);
  });

  it('reads only unresolved suggestions', async () => {
    const runtimeDir = path.join(root, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      count: 2,
      suggestions: [
        { id: 'sug-1', resolved: false, category: 'drift', confidence: 0.9, requiresApproval: true, depth: 0, reason: 'r', suggestedAction: 'a', createdAt: 'now' },
        { id: 'sug-2', resolved: true, category: 'drift', confidence: 0.9, requiresApproval: true, depth: 0, reason: 'r', suggestedAction: 'a', createdAt: 'now' },
      ],
    };
    writeFileSync(path.join(root, RUNTIME_REL), JSON.stringify(payload), 'utf8');

    const pending = await readPendingSuggestions(root);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('sug-1');
  });

  it('resolveSuggestion marks the target resolved and persists', async () => {
    const result = await analyzeNextSession(
      { testFailures: [{ name: 'x.test.js' }] },
      {
        pluginRoot: root,
        config: { ago: { autoSpawn: { enabled: true, maxDepth: 2, minConfidence: 0.8, requireOptIn: true } } },
      },
    );
    expect(result.written).toBe(true);
    const sugId = result.suggestions[0].id;

    const r1 = await resolveSuggestion(root, sugId);
    expect(r1.resolved).toBe(true);

    const pending = await readPendingSuggestions(root);
    expect(pending.find((s) => s.id === sugId)).toBeUndefined();

    // resolved flag should be persisted — re-read file directly
    const file = readSuggestionsFile(root);
    const entry = file.suggestions.find((s) => s.id === sugId);
    expect(entry.resolved).toBe(true);
    expect(entry.resolvedAt).toBeTypeOf('string');
  });

  it('resolveSuggestion returns {resolved:false} for unknown id', async () => {
    await analyzeNextSession(
      { testFailures: [{ name: 'x.test.js' }] },
      {
        pluginRoot: root,
        config: { ago: { autoSpawn: { enabled: true, maxDepth: 2, minConfidence: 0.8, requireOptIn: true } } },
      },
    );
    const r = await resolveSuggestion(root, 'nonexistent-id');
    expect(r.resolved).toBe(false);
  });
});
