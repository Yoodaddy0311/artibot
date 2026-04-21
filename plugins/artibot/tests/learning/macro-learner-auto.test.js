/**
 * Macro Learner auto-register tests — AGO Self-Control Track 4.
 *
 * Verifies the triple safety gate, occurrence threshold, 30-day rejection
 * cooldown, confidence floor, and sweep behaviour.
 *
 * @module tests/learning/macro-learner-auto
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  sweepAutoRegister,
  tryAutoRegister,
} from '../../lib/learning/macro-learner.js';

function makeAutoConfig(overrides = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled: true,
        autoMacroRegister: {
          enabled: true,
          minOccurrences: 5,
          noRejectionWindowDays: 30,
          ...overrides,
        },
        // Bypass first-run observe mode for deterministic tests.
        firstRunMode: { enabled: false },
      },
      macroLearning: {
        enabled: true,
        // auto-with-safety posture: users CAN auto-register if all other
        // safety layers (occurrence count, 30d rejection window, confidence)
        // pass. The 30d rejection window remains enforced.
        mode: 'suggest-only',
        minOccurrences: 3,
        requireUserApproval: false,
        suggestionsPath: 'runtime/macro-suggestions.json',
      },
    },
  };
}

function seedFirstRunBypass(root) {
  const dir = path.join(root, 'runtime');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'first-run-state.json'),
    JSON.stringify({ globalRuns: 999, features: {}, transitions: [] }),
    'utf-8',
  );
}

function seedStore(root, suggestions) {
  const storePath = path.join(root, 'runtime', 'macro-suggestions.json');
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(
    storePath,
    JSON.stringify({ suggestions, observations: {} }, null, 2),
    'utf-8',
  );
  return storePath;
}

function makePending(overrides = {}) {
  return {
    id: 'macro-test-1',
    detectedAt: '2026-04-19T10:00:00Z',
    pattern: {
      fingerprint: 'security-review>test>build',
      triggerPhrase: 'security test build',
      actions: ['security-review', 'test', 'build'],
      occurrences: 6,
    },
    confidence: 0.9,
    status: 'pending',
    approvedAt: null,
    rejectedAt: null,
    ...overrides,
  };
}

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-macro-auto-'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  writeFileSync(
    path.join(root, 'artibot.config.json'),
    JSON.stringify({ version: '0.0.0' }, null, 2),
    'utf-8',
  );
  seedFirstRunBypass(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// tryAutoRegister — gate enforcement
// ---------------------------------------------------------------------------

describe('tryAutoRegister gate', () => {
  it('refuses when masterEnabled is false', async () => {
    const cfg = makeAutoConfig();
    cfg.ago.selfControl.masterEnabled = false;
    seedStore(root, [makePending()]);
    const r = await tryAutoRegister(makePending(), { pluginRoot: root, config: cfg });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('master-disabled');
  });

  it('refuses when module is disabled', async () => {
    const cfg = makeAutoConfig({ enabled: false });
    seedStore(root, [makePending()]);
    const r = await tryAutoRegister(makePending(), { pluginRoot: root, config: cfg });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('module-disabled');
  });

  it('proceeds with default config (no env var required)', async () => {
    seedStore(root, [makePending()]);
    const r = await tryAutoRegister(makePending(), { pluginRoot: root, config: makeAutoConfig() });
    expect(r.registered).toBe(true);
  });

  it('refuses when kill-switch is tripped', async () => {
    writeFileSync(
      path.join(root, 'runtime', 'kill-switch.json'),
      JSON.stringify({
        features: {
          'auto-macro-register': {
            failures: [{ at: Date.now(), error: 'seed' }],
            trippedAt: new Date().toISOString(),
          },
        },
      }),
      'utf-8',
    );
    seedStore(root, [makePending()]);
    const r = await tryAutoRegister(makePending(), { pluginRoot: root, config: makeAutoConfig() });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('kill-switch-tripped');
  });

  it('still enforces 30-day rejection window under default-ON', async () => {
    const now = Date.parse('2026-04-20T00:00:00Z');
    const recentReject = makePending({
      id: 'macro-rejected',
      status: 'rejected',
      rejectedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const pending = makePending({ id: 'macro-new' });
    seedStore(root, [recentReject, pending]);
    const r = await tryAutoRegister(pending, {
      pluginRoot: root,
      config: makeAutoConfig(),
      now,
    });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('recent-rejection');
  });
});

// ---------------------------------------------------------------------------
// tryAutoRegister — criteria
// ---------------------------------------------------------------------------

describe('tryAutoRegister criteria', () => {
  it('refuses when occurrences below minOccurrences', async () => {
    const suggestion = makePending({ pattern: {
      fingerprint: 'security-review>test>build',
      triggerPhrase: 'x',
      actions: ['security-review', 'test', 'build'],
      occurrences: 3,
    } });
    seedStore(root, [suggestion]);
    const r = await tryAutoRegister(suggestion, { pluginRoot: root, config: makeAutoConfig() });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('below-occurrences');
  });

  it('refuses when confidence below 0.85', async () => {
    const suggestion = makePending({ confidence: 0.7 });
    seedStore(root, [suggestion]);
    const r = await tryAutoRegister(suggestion, { pluginRoot: root, config: makeAutoConfig() });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('low-confidence');
  });

  it('refuses when an identical fingerprint was rejected within 30 days', async () => {
    const now = Date.parse('2026-04-20T00:00:00Z');
    const recentReject = makePending({
      id: 'macro-rejected-old',
      status: 'rejected',
      rejectedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const pending = makePending({ id: 'macro-new' });
    seedStore(root, [recentReject, pending]);
    const r = await tryAutoRegister(pending, {
      pluginRoot: root,
      config: makeAutoConfig(),
      now,
    });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('recent-rejection');
  });

  it('permits registration when rejection is outside the window', async () => {
    const now = Date.parse('2026-04-20T00:00:00Z');
    const oldReject = makePending({
      id: 'macro-rejected-ancient',
      status: 'rejected',
      rejectedAt: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const pending = makePending({ id: 'macro-ok' });
    seedStore(root, [oldReject, pending]);
    const r = await tryAutoRegister(pending, {
      pluginRoot: root,
      config: makeAutoConfig(),
      now,
    });
    expect(r.registered).toBe(true);
    expect(r.macroId).toMatch(/^m_/);
  });

  it('registers a fully qualifying suggestion and writes to artibot.config.json', async () => {
    const suggestion = makePending();
    seedStore(root, [suggestion]);
    const r = await tryAutoRegister(suggestion, { pluginRoot: root, config: makeAutoConfig() });
    expect(r.registered).toBe(true);

    const cfg = JSON.parse(readFileSync(path.join(root, 'artibot.config.json'), 'utf-8'));
    expect(cfg.macros).toBeDefined();
    expect(cfg.macros[r.macroId].source).toBe('macro-learner-auto');
    expect(cfg.macros[r.macroId].suggestionId).toBe(suggestion.id);

    const store = JSON.parse(
      readFileSync(path.join(root, 'runtime', 'macro-suggestions.json'), 'utf-8'),
    );
    const updated = store.suggestions.find((s) => s.id === suggestion.id);
    expect(updated.status).toBe('approved');
    expect(updated.autoRegistered).toBe(true);
  });

  it('refuses non-pending suggestions', async () => {
    const approved = makePending({ status: 'approved', approvedAt: '2026-04-20T00:00:00Z' });
    seedStore(root, [approved]);
    const r = await tryAutoRegister(approved, { pluginRoot: root, config: makeAutoConfig() });
    expect(r.registered).toBe(false);
    expect(r.reason).toBe('not-pending');
  });
});

// ---------------------------------------------------------------------------
// sweepAutoRegister
// ---------------------------------------------------------------------------

describe('sweepAutoRegister', () => {
  it('processes multiple pending suggestions and records outcomes per entry', async () => {
    const now = Date.parse('2026-04-20T00:00:00Z');
    const good = makePending({ id: 'macro-good' });
    const lowConf = makePending({
      id: 'macro-low',
      confidence: 0.5,
      pattern: {
        fingerprint: 'test>build',
        triggerPhrase: 't b',
        actions: ['test', 'build'],
        occurrences: 6,
      },
    });
    const rejectedTwin = makePending({
      id: 'macro-twin-rejected',
      status: 'rejected',
      pattern: {
        fingerprint: 'deploy>lint',
        triggerPhrase: 'd l',
        actions: ['deploy', 'lint'],
        occurrences: 1,
      },
      rejectedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const twinPending = makePending({
      id: 'macro-twin-pending',
      pattern: {
        fingerprint: 'deploy>lint',
        triggerPhrase: 'd l',
        actions: ['deploy', 'lint'],
        occurrences: 7,
      },
    });
    seedStore(root, [good, lowConf, rejectedTwin, twinPending]);

    const r = await sweepAutoRegister({ pluginRoot: root, config: makeAutoConfig(), now });
    expect(r.registered).toHaveLength(1);
    expect(r.skipped.length).toBeGreaterThanOrEqual(2);
    const skippedReasons = r.skipped.map((s) => s.reason);
    expect(skippedReasons).toContain('low-confidence');
    expect(skippedReasons).toContain('recent-rejection');

    const cfg = JSON.parse(readFileSync(path.join(root, 'artibot.config.json'), 'utf-8'));
    expect(Object.keys(cfg.macros || {})).toHaveLength(1);
  });

  it('short-circuits when user opts out (masterEnabled=false)', async () => {
    const cfg = makeAutoConfig();
    cfg.ago.selfControl.masterEnabled = false;
    seedStore(root, [makePending()]);
    const r = await sweepAutoRegister({ pluginRoot: root, config: cfg });
    expect(r.registered).toHaveLength(0);
    expect(r.reason).toBe('master-disabled');
  });
});
