/**
 * Tests for lib/learning/wakeup-scheduler.js (AGO Self-Control 7 / Wave-2).
 *
 * Covers:
 *   - Master gates (masterEnabled, autoWakeup.enabled) — env gate removed in Wave 2
 *   - Kill-switch integration
 *   - maxPerHour, minDelaySeconds, maxDepth rejections
 *   - happy path: marker file written
 *   - readPendingWakeups / fulfillWakeup round-trip
 *   - resetRateLimit
 *   - redaction in marker
 *   - static guarantee: no ScheduleWakeup tool call in lib/ or scripts/
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _internals,
  evaluateGates,
  fulfillWakeup,
  readPendingWakeups,
  requestWakeup,
  resetRateLimit,
  resolveWakeupConfig,
} from '../../lib/learning/wakeup-scheduler.js';

function makeTempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'wakeup-sched-'));
}

function enabledConfig(overrides = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled: true,
        autoWakeup: {
          enabled: true,
          maxPerHour: 2,
          maxDepth: 2,
          minDelaySeconds: 300,
          ...overrides,
        },
      },
    },
  };
}

const validRequest = () => ({
  reason: 'test regression at session end',
  delaySeconds: 600,
  suggestionId: 'sug-abc',
  depth: 0,
  suggestedAction: 'run vitest',
  category: 'test-regression',
});

describe('wakeup-scheduler / resolveWakeupConfig', () => {
  it('returns Wave-2 defaults (masterEnabled=true, enabled=true) when config is missing', () => {
    const cfg = resolveWakeupConfig(undefined);
    expect(cfg.masterEnabled).toBe(true);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxPerHour).toBe(2);
    expect(cfg.maxDepth).toBe(2);
    expect(cfg.minDelaySeconds).toBe(300);
  });

  it('respects explicit disable (masterEnabled=false)', () => {
    const cfg = resolveWakeupConfig({ ago: { selfControl: { masterEnabled: false } } });
    expect(cfg.masterEnabled).toBe(false);
  });

  it('respects explicit disable (autoWakeup.enabled=false)', () => {
    const cfg = resolveWakeupConfig({
      ago: { selfControl: { autoWakeup: { enabled: false } } },
    });
    expect(cfg.enabled).toBe(false);
  });

  it('respects provided values', () => {
    const cfg = resolveWakeupConfig(
      enabledConfig({ maxPerHour: 5, maxDepth: 3, minDelaySeconds: 120 }),
    );
    expect(cfg.masterEnabled).toBe(true);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxPerHour).toBe(5);
    expect(cfg.maxDepth).toBe(3);
    expect(cfg.minDelaySeconds).toBe(120);
  });
});

describe('wakeup-scheduler / evaluateGates', () => {
  it('rejects when masterEnabled is false', () => {
    const cfg = resolveWakeupConfig({ ago: { selfControl: { masterEnabled: false } } });
    expect(evaluateGates(cfg)).toBe('gate:master-disabled');
  });

  it('rejects when autoWakeup.enabled is false', () => {
    const cfg = resolveWakeupConfig({
      ago: { selfControl: { masterEnabled: true, autoWakeup: { enabled: false } } },
    });
    expect(evaluateGates(cfg)).toBe('gate:autoWakeup-disabled');
  });

  it('passes all gates when fully enabled (env no longer required in Wave-2)', () => {
    const cfg = resolveWakeupConfig(enabledConfig());
    expect(evaluateGates(cfg)).toBeNull();
  });

  it('passes with empty config (Wave-2 defaults are on)', () => {
    const cfg = resolveWakeupConfig(undefined);
    expect(evaluateGates(cfg)).toBeNull();
  });
});

describe('wakeup-scheduler / requestWakeup', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects without pluginRoot', async () => {
    const r = await requestWakeup(validRequest(), { pluginRoot: '', config: enabledConfig() });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('missing-pluginRoot');
  });

  it('rejects when master gate fails', async () => {
    const r = await requestWakeup(validRequest(), {
      pluginRoot: root,
      config: { ago: { selfControl: { masterEnabled: false, autoWakeup: { enabled: true } } } },
    });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('gate:master-disabled');
  });

  it('rejects when autoWakeup gate fails', async () => {
    const r = await requestWakeup(validRequest(), {
      pluginRoot: root,
      config: { ago: { selfControl: { masterEnabled: true, autoWakeup: { enabled: false } } } },
    });
    expect(r.reason).toBe('gate:autoWakeup-disabled');
  });

  it('rejects when kill-switch tripped for auto-wakeup', async () => {
    const ksDir = path.join(root, 'runtime');
    mkdirSync(ksDir, { recursive: true });
    const ksState = {
      features: {
        'auto-wakeup': {
          failures: [],
          trippedAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(path.join(ksDir, 'kill-switch.json'), JSON.stringify(ksState), 'utf8');

    const r = await requestWakeup(validRequest(), {
      pluginRoot: root,
      config: enabledConfig(),
    });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('kill-switch-tripped');
  });

  it('rejects when delaySeconds below minimum', async () => {
    const r = await requestWakeup(
      { ...validRequest(), delaySeconds: 100 },
      { pluginRoot: root, config: enabledConfig() },
    );
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('minDelaySeconds-not-met');
  });

  it('rejects when depth exceeds maxDepth', async () => {
    const r = await requestWakeup(
      { ...validRequest(), depth: 5 },
      { pluginRoot: root, config: enabledConfig() },
    );
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('maxDepth-exceeded');
  });

  it('rejects when maxPerHour exceeded', async () => {
    const opts = { pluginRoot: root, config: enabledConfig() };
    const first = await requestWakeup(validRequest(), opts);
    const second = await requestWakeup(validRequest(), opts);
    const third = await requestWakeup(validRequest(), opts);
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(true);
    expect(third.queued).toBe(false);
    expect(third.reason).toBe('maxPerHour-exceeded');
  });

  it('happy path: writes marker file with redacted content (no env required)', async () => {
    const req = {
      ...validRequest(),
      reason: 'secret=supersecret123 and email leaked foo@example.com',
    };
    const r = await requestWakeup(req, {
      pluginRoot: root,
      config: enabledConfig(),
    });
    expect(r.queued).toBe(true);
    expect(r.markerPath).toBeTruthy();
    const data = JSON.parse(readFileSync(r.markerPath, 'utf8'));
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries).toHaveLength(1);
    const [entry] = data.entries;
    expect(entry.fulfilled).toBe(false);
    expect(entry.requiresApproval).toBe(true);
    expect(entry.reason).not.toContain('supersecret123');
    expect(entry.reason).not.toContain('foo@example.com');
    expect(entry.category).toBe('test-regression');
  });

  it('happy path with empty config (Wave-2 defaults on)', async () => {
    const r = await requestWakeup(validRequest(), { pluginRoot: root, config: {} });
    expect(r.queued).toBe(true);
  });
});

describe('wakeup-scheduler / readPendingWakeups', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty when no marker file exists', async () => {
    const pending = await readPendingWakeups(root);
    expect(pending).toEqual([]);
  });

  it('returns only unfulfilled entries', async () => {
    const opts = { pluginRoot: root, config: enabledConfig() };
    const first = await requestWakeup(validRequest(), opts);
    expect(first.queued).toBe(true);

    const pending = await readPendingWakeups(root);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(first.requestId);
  });
});

describe('wakeup-scheduler / fulfillWakeup', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('marks fulfilled and hides from subsequent reads', async () => {
    const opts = { pluginRoot: root, config: enabledConfig() };
    const { requestId } = await requestWakeup(validRequest(), opts);
    expect(requestId).toBeTruthy();

    const f = await fulfillWakeup(requestId, { pluginRoot: root });
    expect(f.fulfilled).toBe(true);

    const pending = await readPendingWakeups(root);
    expect(pending).toHaveLength(0);

    // Idempotent: second fulfill is a no-op.
    const again = await fulfillWakeup(requestId, { pluginRoot: root });
    expect(again.fulfilled).toBe(false);
  });

  it('returns false for unknown id', async () => {
    const f = await fulfillWakeup('wake-nope', { pluginRoot: root });
    expect(f.fulfilled).toBe(false);
  });
});

describe('wakeup-scheduler / resetRateLimit', () => {
  let root;

  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('clears rate-limit entries allowing new requests', async () => {
    const opts = { pluginRoot: root, config: enabledConfig() };
    await requestWakeup(validRequest(), opts);
    await requestWakeup(validRequest(), opts);
    const blocked = await requestWakeup(validRequest(), opts);
    expect(blocked.reason).toBe('maxPerHour-exceeded');

    await resetRateLimit(root);
    const allowed = await requestWakeup(validRequest(), opts);
    expect(allowed.queued).toBe(true);
  });
});

describe('wakeup-scheduler / static safety invariant', () => {
  /**
   * Recursively walk a directory and return all .js file paths.
   * @param {string} dir
   * @returns {string[]}
   */
  function walkJs(dir) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walkJs(full));
      else if (st.isFile() && full.endsWith('.js')) out.push(full);
    }
    return out;
  }

  it('lib/ and scripts/ contain zero ScheduleWakeup tool invocations', () => {
    const pluginRoot = path.resolve(__dirname, '..', '..');
    const dirs = [path.join(pluginRoot, 'lib'), path.join(pluginRoot, 'scripts')];
    const offenders = [];
    // Match code-level invocations only (callable patterns), not doc mentions.
    const callRe = /ScheduleWakeup\s*\(/;
    for (const d of dirs) {
      for (const file of walkJs(d)) {
        const content = readFileSync(file, 'utf8');
        if (callRe.test(content)) offenders.push(path.relative(pluginRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('wakeup-scheduler / internals', () => {
  it('exposes expected internals for tests', () => {
    expect(_internals.MARKER_REL).toMatch(/runtime.+wakeup-requests\.json$/);
    expect(_internals.RATE_LIMIT_REL).toMatch(/runtime.+wakeup-rate-limit\.json$/);
    expect(_internals.DEFAULTS.maxPerHour).toBe(2);
    expect(_internals.DEFAULTS.maxDepth).toBe(2);
    expect(_internals.DEFAULTS.minDelaySeconds).toBe(300);
  });

  it('redactString masks tokens and emails', () => {
    const out = _internals.redactString('token=abc123 email=jane@doe.com');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('jane@doe.com');
  });
});
