/**
 * Decision Trail tests — AGO Track G3.
 * Covers recordDecision, queryDecisions, pruneDecisionTrail, getDecisionStats,
 * redaction, prototype-pollution rejection, and integration with runtime-prompt,
 * cognitive router, and user-profile subsystems.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as trail from '../../lib/core/decision-trail.js';
import * as router from '../../lib/cognitive/router.js';
import * as profile from '../../lib/core/user-profile.js';

// We redirect the plugin root for these tests so the trail lands in a
// tempdir (isolated per test) and cannot touch the real repo.
const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;

// `process.env` coerces every assigned value to a string — assigning
// `undefined` produces the literal string "undefined", which would then
// flow into `path.join(getPluginRoot(), 'runtime', 'decision-trail.json')`
// and create a real `undefined/runtime/decision-trail.json` directory at
// the repo root. Restore via delete instead of assignment when the
// original was unset.
function restorePluginRoot() {
  if (ORIGINAL_PLUGIN_ROOT === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
  }
}

async function withSandbox(testFn, opts = {}) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'artibot-trail-'));
  const enabled = opts.enabled !== false;
  // Minimal config fixture so resolveConfig reads our overrides
  const config = {
    ago: {
      decisionTrail: {
        enabled,
        path: 'runtime/decision-trail.json',
        retentionDays: 30,
        redactSensitive: true,
      },
    },
  };
  await fs.writeFile(
    path.join(tmpRoot, 'artibot.config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
  process.env.CLAUDE_PLUGIN_ROOT = tmpRoot;

  // Reset module-level caches so resolveConfig picks up the new plugin root
  trail._resetDecisionTrailCache();

  try {
    await testFn(trail, tmpRoot);
  } finally {
    restorePluginRoot();
    trail._resetDecisionTrailCache();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

describe('decision-trail', () => {
  afterEach(() => {
    restorePluginRoot();
  });

  describe('recordDecision()', () => {
    it('persists a decision entry with id and timestamp', async () => {
      await withSandbox(async (mod, root) => {
        const result = await mod.recordDecision({
          subsystem: 'cognitive-router',
          action: 'classified',
          outputs: { system: 2, score: 0.6 },
        });
        expect(result).toBeTruthy();
        expect(result.id).toMatch(/^dec-/);
        expect(typeof result.timestamp).toBe('string');

        const file = path.join(root, 'runtime', 'decision-trail.json');
        expect(fsSync.existsSync(file)).toBe(true);
        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.entries[0].subsystem).toBe('cognitive-router');
      });
    });

    it('returns null for malformed decisions (missing subsystem)', async () => {
      await withSandbox(async (mod) => {
        const result = await mod.recordDecision({ action: 'x' });
        expect(result).toBeNull();
      });
    });

    it('returns null for non-object inputs', async () => {
      await withSandbox(async (mod) => {
        expect(await mod.recordDecision(null)).toBeNull();
        expect(await mod.recordDecision('nope')).toBeNull();
      });
    });

    it('clamps confidence to [0, 1]', async () => {
      await withSandbox(async (mod, root) => {
        await mod.recordDecision({ subsystem: 'x', action: 'y', confidence: 2.5 });
        await mod.recordDecision({ subsystem: 'x', action: 'y', confidence: -0.3 });
        const file = path.join(root, 'runtime', 'decision-trail.json');
        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
        expect(parsed.entries[0].confidence).toBe(1);
        expect(parsed.entries[1].confidence).toBe(0);
      });
    });
  });

  describe('redaction', () => {
    it('redacts api keys, tokens, and passwords in string fields', async () => {
      await withSandbox(async (mod, root) => {
        await mod.recordDecision({
          subsystem: 's',
          action: 'a',
          reason: 'api_key=abc123xyz should not leak',
          inputs: { note: 'bearer my_token_abc' },
        });
        const file = path.join(root, 'runtime', 'decision-trail.json');
        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
        expect(parsed.entries[0].reason).toContain('***REDACTED***');
        expect(parsed.entries[0].reason).not.toContain('abc123xyz');
      });
    });

    it('redacts emails', async () => {
      await withSandbox(async (mod, root) => {
        await mod.recordDecision({
          subsystem: 's',
          action: 'a',
          reason: 'contact jane.doe@example.com for details',
        });
        const file = path.join(root, 'runtime', 'decision-trail.json');
        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
        expect(parsed.entries[0].reason).toContain('{email}');
        expect(parsed.entries[0].reason).not.toContain('jane.doe@example.com');
      });
    });

    it('redacts Windows user paths', async () => {
      await withSandbox(async (mod, root) => {
        await mod.recordDecision({
          subsystem: 's',
          action: 'a',
          inputs: { path: 'C:\\Users\\alice\\project\\file.js' },
        });
        const file = path.join(root, 'runtime', 'decision-trail.json');
        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
        expect(parsed.entries[0].inputs.path).toContain('{user}');
        expect(parsed.entries[0].inputs.path).not.toContain('alice');
      });
    });

    it('exposes _redactForTest for direct string redaction', async () => {
      await withSandbox(async (mod) => {
        expect(mod._redactForTest('api-key=secret123')).toContain('***REDACTED***');
        expect(mod._redactForTest('bob@test.com')).toContain('{email}');
      });
    });
  });

  describe('prototype pollution defense', () => {
    it('drops __proto__ / constructor / prototype keys from inputs and outputs', async () => {
      await withSandbox(async (mod, root) => {
        const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
        await mod.recordDecision({
          subsystem: 's',
          action: 'a',
          inputs: malicious,
          outputs: { constructor: 'evil', prototype: 'evil', ok: 'yes' },
        });
        const file = path.join(root, 'runtime', 'decision-trail.json');
        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
        const entry = parsed.entries[0];
        expect(entry.inputs.safe).toBe(1);
        expect(Object.prototype.hasOwnProperty.call(entry.inputs, '__proto__')).toBe(false);
        expect(entry.outputs.ok).toBe('yes');
        // constructor / prototype are inherited on plain objects, so we check
        // own-property presence, which is what our sanitizer actually drops.
        expect(Object.prototype.hasOwnProperty.call(entry.outputs, 'constructor')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(entry.outputs, 'prototype')).toBe(false);
        // Global Object must not be polluted
        expect({}.polluted).toBeUndefined();
      });
    });
  });

  describe('queryDecisions()', () => {
    it('filters by subsystem and action', async () => {
      await withSandbox(async (mod) => {
        await mod.recordDecision({ subsystem: 'a', action: 'x' });
        await mod.recordDecision({ subsystem: 'b', action: 'x' });
        await mod.recordDecision({ subsystem: 'a', action: 'y' });

        const bySubsystem = await mod.queryDecisions({ subsystem: 'a' });
        expect(bySubsystem).toHaveLength(2);

        const byAction = await mod.queryDecisions({ action: 'x' });
        expect(byAction).toHaveLength(2);

        const both = await mod.queryDecisions({ subsystem: 'a', action: 'x' });
        expect(both).toHaveLength(1);
      });
    });

    it('applies limit and returns newest first', async () => {
      await withSandbox(async (mod) => {
        for (let i = 0; i < 5; i++) {
          await mod.recordDecision({ subsystem: 's', action: `a${i}` });
        }
        const recent = await mod.queryDecisions({ limit: 2 });
        expect(recent).toHaveLength(2);
        expect(recent[0].action).toBe('a4');
        expect(recent[1].action).toBe('a3');
      });
    });

    it('supports since filter by ISO string or Date', async () => {
      await withSandbox(async (mod) => {
        await mod.recordDecision({ subsystem: 's', action: 'old' });
        const before = new Date(Date.now() + 1000).toISOString();
        const res = await mod.queryDecisions({ since: before });
        expect(res).toHaveLength(0);
      });
    });
  });

  describe('pruneDecisionTrail()', () => {
    it('removes entries older than retentionDays', async () => {
      await withSandbox(async (mod, root) => {
        const file = path.join(root, 'runtime', 'decision-trail.json');
        // Seed trail with one ancient + one fresh entry
        const ancientTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
        const freshTs = new Date().toISOString();
        fsSync.mkdirSync(path.dirname(file), { recursive: true });
        fsSync.writeFileSync(file, JSON.stringify({
          entries: [
            { id: 'dec-old', timestamp: ancientTs, subsystem: 's', action: 'a' },
            { id: 'dec-new', timestamp: freshTs, subsystem: 's', action: 'b' },
          ],
          metadata: {},
        }), 'utf-8');

        const result = await mod.pruneDecisionTrail();
        expect(result.removed).toBe(1);
        expect(result.remaining).toBe(1);

        const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
        expect(parsed.entries).toHaveLength(1);
        expect(parsed.entries[0].id).toBe('dec-new');
      });
    });
  });

  describe('getDecisionStats()', () => {
    it('aggregates by subsystem, action, and last24h', async () => {
      await withSandbox(async (mod) => {
        await mod.recordDecision({ subsystem: 'router', action: 'classified' });
        await mod.recordDecision({ subsystem: 'router', action: 'classified' });
        await mod.recordDecision({ subsystem: 'profile', action: 'skill-level-changed' });

        const stats = await mod.getDecisionStats();
        expect(stats.totalDecisions).toBe(3);
        expect(stats.bySubsystem.router).toBe(2);
        expect(stats.bySubsystem.profile).toBe(1);
        expect(stats.byAction.classified).toBe(2);
        expect(stats.last24h).toBe(3);
      });
    });

    it('returns zeroed stats for an empty trail', async () => {
      await withSandbox(async (mod) => {
        const stats = await mod.getDecisionStats();
        expect(stats.totalDecisions).toBe(0);
        expect(stats.bySubsystem).toEqual({});
        expect(stats.byAction).toEqual({});
        expect(stats.last24h).toBe(0);
      });
    });
  });

  describe('disabled mode', () => {
    it('returns null and does not write when ago.decisionTrail.enabled=false', async () => {
      await withSandbox(
        async (mod, root) => {
          const result = await mod.recordDecision({ subsystem: 's', action: 'a' });
          expect(result).toBeNull();
          const file = path.join(root, 'runtime', 'decision-trail.json');
          expect(fsSync.existsSync(file)).toBe(false);
        },
        { enabled: false },
      );
    });
  });

  describe('integration touchpoints', () => {
    it('records an entry when cognitive router.route() runs', async () => {
      await withSandbox(async (mod) => {
        router.resetRouter();
        router.route('analyze security vulnerabilities in auth');

        // router uses Promise-then chains — under full-suite worker
        // saturation a fixed 60ms wait can race the microtask queue.
        // Poll until at least one cognitive-router entry lands instead of
        // sleeping a fixed duration.
        await vi.waitFor(
          async () => {
            const entries = await mod.queryDecisions({ subsystem: 'cognitive-router' });
            expect(entries.length).toBeGreaterThanOrEqual(1);
            expect(entries[0].action).toBe('classified');
            expect(entries[0].outputs).toHaveProperty('system');
          },
          { timeout: 2000, interval: 20 },
        );
      });
    });

    it('records skill-level change when user-profile promotes', async () => {
      await withSandbox(async (mod, root) => {
        profile._resetPathCache();
        const profilePath = path.join(root, 'user-profile.json');
        profile.configureProfilePath(profilePath);

        // Feed 10+ slash-command jargon signals to trigger pro promotion
        const jargon = ['api', 'async', 'regex', 'schema', 'docker', 'webhook',
          'endpoint', 'middleware', 'typescript', 'k8s', 'mock'];
        for (let i = 0; i < jargon.length; i++) {
          await profile.recordSignal({
            type: 'slash-command',
            value: `implement ${jargon[i]}`,
            timestamp: Date.now(),
          });
        }

        const entries = await mod.queryDecisions({ subsystem: 'user-profile' });
        expect(entries.length).toBeGreaterThanOrEqual(1);
        expect(entries[0].action).toBe('skill-level-changed');
        expect(entries[0].outputs.to).toBe('pro');
      });
    });
  });
});
