import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetUpgradeCheckState,
  createUpgradeCheckMiddleware,
} from '../../../lib/runtime/middleware/upgrade-check.js';

function makeConfig(overrides = {}) {
  return {
    version: '3.5.0',
    learning: {
      memoryScopes: {
        user: '~/.claude/artibot/',
      },
      hierarchicalMemory: {
        enabled: true,
      },
      ...overrides.learning,
    },
    ...overrides,
  };
}

function makeState() {
  return {
    context: {
      routing: { system: 'system1' },
    },
    messageParts: [],
    userPrompt: 'hello',
  };
}

function mockRunner(result) {
  return vi.fn(async () => result);
}

describe('middleware/upgrade-check', () => {
  beforeEach(() => {
    __resetUpgradeCheckState();
  });

  describe('createUpgradeCheckMiddleware', () => {
    it('throws when config is missing', () => {
      expect(() => createUpgradeCheckMiddleware({
        migrationRunner: () => {},
      })).toThrow(/config required/);
    });

    it('throws when migrationRunner is missing', () => {
      expect(() => createUpgradeCheckMiddleware({
        config: makeConfig(),
      })).toThrow(/migrationRunner required/);
    });

    it('detects version mismatch and dispatches to the runner', async () => {
      const runner = mockRunner({
        status: 'migrated',
        fromVersion: '3.4.0',
        toVersion: '3.5.0',
        rollback: false,
        tagged: 4,
      });
      const mw = createUpgradeCheckMiddleware({
        config: makeConfig(),
        migrationRunner: runner,
      });

      const state = makeState();
      await mw(state);

      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0][0].targetVersion).toBe('3.5.0');
      expect(runner.mock.calls[0][0].userScope).toBe('~/.claude/artibot/');
      expect(runner.mock.calls[0][0].hierarchicalEnabled).toBe(true);
      expect(state.context.upgradeCheck).toMatchObject({
        ran: true,
        status: 'migrated',
        toVersion: '3.5.0',
        rollback: false,
      });
      expect(state.messageParts).toContain('upgrade-check=migrated');
    });

    it('is idempotent within a single process for the same version', async () => {
      const runner = mockRunner({
        status: 'migrated',
        fromVersion: '3.4.0',
        toVersion: '3.5.0',
        rollback: false,
      });
      const mw = createUpgradeCheckMiddleware({
        config: makeConfig(),
        migrationRunner: runner,
      });

      await mw(makeState());
      await mw(makeState());
      await mw(makeState());

      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('forceRerun option bypasses the process-local guard', async () => {
      const runner = mockRunner({
        status: 'already-migrated',
        fromVersion: '3.5.0',
        toVersion: '3.5.0',
        rollback: false,
      });
      const mw = createUpgradeCheckMiddleware({
        config: makeConfig(),
        migrationRunner: runner,
        forceRerun: true,
      });

      await mw(makeState());
      await mw(makeState());

      expect(runner).toHaveBeenCalledTimes(2);
    });

    it('applies runtime rollback when runner reports rollback=true', async () => {
      const runner = mockRunner({
        status: 'failed',
        fromVersion: '3.4.0',
        toVersion: '3.5.0',
        rollback: true,
        error: 'disk full',
      });
      const mw = createUpgradeCheckMiddleware({
        config: makeConfig(),
        migrationRunner: runner,
      });

      const state = makeState();
      await mw(state);

      expect(state.context.runtimeOverrides.learning.hierarchicalMemory).toMatchObject({
        enabled: false,
        rollbackReason: 'disk full',
      });
      expect(state.context.upgradeCheck.rollback).toBe(true);
      expect(state.messageParts).toContain('upgrade-check=failed');
    });

    it('applies runtime rollback when the runner itself throws', async () => {
      const runner = vi.fn(async () => {
        throw new Error('unexpected crash');
      });
      const errs = [];
      const mw = createUpgradeCheckMiddleware({
        config: makeConfig(),
        migrationRunner: runner,
        errorLogger: (m) => errs.push(m),
      });

      const state = makeState();
      await mw(state);

      expect(state.context.runtimeOverrides.learning.hierarchicalMemory.enabled).toBe(false);
      expect(state.context.runtimeOverrides.learning.hierarchicalMemory.rollbackReason)
        .toMatch(/unexpected crash/);
      expect(errs.some((m) => m.includes('crashed'))).toBe(true);
    });

    it('passes hierarchicalEnabled=false through when user has opted out', async () => {
      const runner = mockRunner({
        status: 'skipped',
        fromVersion: 'none',
        toVersion: '3.5.0',
        rollback: false,
      });
      const cfg = makeConfig({
        learning: {
          memoryScopes: { user: '~/.claude/artibot/' },
          hierarchicalMemory: { enabled: false },
        },
      });
      const mw = createUpgradeCheckMiddleware({
        config: cfg,
        migrationRunner: runner,
      });

      const state = makeState();
      await mw(state);

      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0][0].hierarchicalEnabled).toBe(false);
      expect(state.context.upgradeCheck.status).toBe('skipped');
      expect(state.context.runtimeOverrides).toBeUndefined();
    });

    it('returns state untouched when version is missing from config', async () => {
      const runner = mockRunner({});
      const cfg = makeConfig();
      delete cfg.version;

      const mw = createUpgradeCheckMiddleware({
        config: cfg,
        migrationRunner: runner,
      });

      const state = makeState();
      const result = await mw(state);

      expect(runner).not.toHaveBeenCalled();
      expect(result.context.upgradeCheck).toBeUndefined();
    });

    it('returns state untouched when userScope is missing from config', async () => {
      const runner = mockRunner({});
      const cfg = {
        version: '3.5.0',
        learning: { hierarchicalMemory: { enabled: true } },
      };

      const mw = createUpgradeCheckMiddleware({
        config: cfg,
        migrationRunner: runner,
      });

      const state = makeState();
      await mw(state);

      expect(runner).not.toHaveBeenCalled();
    });

    it('guards are per-version — new version re-runs once', async () => {
      const runner = mockRunner({
        status: 'migrated',
        fromVersion: '3.4.0',
        toVersion: '3.5.0',
        rollback: false,
      });
      const mw1 = createUpgradeCheckMiddleware({
        config: makeConfig({ version: '3.5.0' }),
        migrationRunner: runner,
      });

      await mw1(makeState());
      await mw1(makeState());
      expect(runner).toHaveBeenCalledTimes(1);

      const runner2 = mockRunner({
        status: 'migrated',
        fromVersion: '3.5.0',
        toVersion: '3.6.0',
        rollback: false,
      });
      const mw2 = createUpgradeCheckMiddleware({
        config: { ...makeConfig(), version: '3.6.0' },
        migrationRunner: runner2,
      });

      await mw2(makeState());
      expect(runner2).toHaveBeenCalledTimes(1);
    });

    it('forwards logger and errorLogger to the runner', async () => {
      const runner = vi.fn(async ({ logger, errorLogger }) => {
        logger('hi from runner');
        errorLogger('err from runner');
        return {
          status: 'migrated',
          fromVersion: '3.4.0',
          toVersion: '3.5.0',
          rollback: false,
        };
      });

      const logs = [];
      const errs = [];
      const mw = createUpgradeCheckMiddleware({
        config: makeConfig(),
        migrationRunner: runner,
        logger: (m) => logs.push(m),
        errorLogger: (m) => errs.push(m),
      });

      await mw(makeState());

      expect(logs).toContain('hi from runner');
      expect(errs).toContain('err from runner');
    });
  });
});
