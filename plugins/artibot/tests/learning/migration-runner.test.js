import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  __internals,
  checkAndMigrate,
  createMigrationRunner,
} from '../../lib/learning/migration-runner.js';

const { SCHEMA_VERSION } = __internals;

async function makeTempScope() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'artibot-mig-'));
  return dir;
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function readStateJson(scope) {
  const p = path.join(scope, 'migration-state.json');
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

function fakeRunner({ totalTagged = 7, shouldThrow = null, reports = [] } = {}) {
  return vi.fn(async () => {
    if (shouldThrow) throw shouldThrow;
    return {
      totalTagged,
      reports: reports.length > 0 ? reports : [
        { file: 'user-preferences.json', status: 'migrated', tagged: 3, total: 3 },
        { file: 'project-contexts.json', status: 'skipped', tagged: 0, total: 0 },
        { file: 'command-history.json', status: 'migrated', tagged: 4, total: 4 },
        { file: 'error-patterns.json', status: 'missing', tagged: 0, total: 0 },
      ],
    };
  });
}

describe('learning/migration-runner', () => {
  let scope;

  beforeEach(async () => {
    scope = await makeTempScope();
  });

  afterEach(async () => {
    await cleanup(scope);
  });

  describe('checkAndMigrate', () => {
    it('throws when targetVersion is missing', async () => {
      await expect(
        checkAndMigrate({ userScope: scope }),
      ).rejects.toThrow(/targetVersion/);
    });

    it('throws when userScope is missing', async () => {
      await expect(
        checkAndMigrate({ targetVersion: '3.5.0' }),
      ).rejects.toThrow(/userScope/);
    });

    it('runs migration on first execution and writes state file', async () => {
      const runner = fakeRunner({ totalTagged: 7 });
      const logs = [];

      const result = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: runner,
        logger: (m) => logs.push(m),
      });

      expect(result.status).toBe('migrated');
      expect(result.rollback).toBe(false);
      expect(result.tagged).toBe(7);
      expect(result.toVersion).toBe('3.5.0');
      expect(runner).toHaveBeenCalledTimes(1);
      expect(logs.some((l) => l.includes('Upgrading memory'))).toBe(true);
      expect(logs.some((l) => l.includes('complete'))).toBe(true);

      const state = await readStateJson(scope);
      expect(state.schemaVersion).toBe(SCHEMA_VERSION);
      expect(state.version).toBe('3.5.0');
      expect(state.outcome).toBe('success');
      expect(state.totalTagged).toBe(7);
      expect(Array.isArray(state.reports)).toBe(true);
      expect(state.reports[0].file).toBe('user-preferences.json');
    });

    it('no-ops when state already records the target version', async () => {
      const runner = fakeRunner();
      await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: runner,
      });
      expect(runner).toHaveBeenCalledTimes(1);

      const secondRunner = fakeRunner();
      const result = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: secondRunner,
      });

      expect(result.status).toBe('already-migrated');
      expect(result.rollback).toBe(false);
      expect(secondRunner).not.toHaveBeenCalled();
    });

    it('re-runs when target version differs from recorded version', async () => {
      const runnerA = fakeRunner({ totalTagged: 3 });
      await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: runnerA,
      });

      const runnerB = fakeRunner({ totalTagged: 11 });
      const result = await checkAndMigrate({
        targetVersion: '3.6.0',
        userScope: scope,
        runMigration: runnerB,
      });

      expect(result.status).toBe('migrated');
      expect(runnerB).toHaveBeenCalledTimes(1);

      const state = await readStateJson(scope);
      expect(state.version).toBe('3.6.0');
      expect(state.previousVersion).toBe('3.5.0');
      expect(state.totalTagged).toBe(11);
    });

    it('rollback=true and error captured when migration throws', async () => {
      const errs = [];
      const runner = fakeRunner({ shouldThrow: new Error('disk full') });

      const result = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: runner,
        errorLogger: (m) => errs.push(m),
      });

      expect(result.status).toBe('failed');
      expect(result.rollback).toBe(true);
      expect(result.error).toMatch(/disk full/);
      expect(errs.some((m) => m.includes('Falling back'))).toBe(true);

      const state = await readStateJson(scope);
      expect(state.outcome).toBe('failed');
      expect(state.error).toMatch(/disk full/);
    });

    it('after a failed run, retrying will re-invoke the runner', async () => {
      const failing = fakeRunner({ shouldThrow: new Error('transient') });
      const first = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: failing,
      });
      expect(first.status).toBe('failed');

      const succeeding = fakeRunner({ totalTagged: 2 });
      const second = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: succeeding,
      });

      expect(second.status).toBe('migrated');
      expect(succeeding).toHaveBeenCalledTimes(1);
    });

    it('skips migration entirely when hierarchicalEnabled=false (opt-out)', async () => {
      const runner = fakeRunner();
      const result = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        hierarchicalEnabled: false,
        runMigration: runner,
      });

      expect(result.status).toBe('skipped');
      expect(result.rollback).toBe(false);
      expect(runner).not.toHaveBeenCalled();

      await expect(readStateJson(scope)).rejects.toBeTruthy();
    });

    it('treats a corrupt migration-state.json as "no prior migration"', async () => {
      await fs.writeFile(
        path.join(scope, 'migration-state.json'),
        '{not valid json',
        'utf8',
      );

      const runner = fakeRunner({ totalTagged: 5 });
      const result = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: runner,
      });

      expect(result.status).toBe('migrated');
      expect(runner).toHaveBeenCalledTimes(1);
      const state = await readStateJson(scope);
      expect(state.outcome).toBe('success');
    });

    it('treats stale-schema state file as "no prior migration"', async () => {
      await fs.writeFile(
        path.join(scope, 'migration-state.json'),
        JSON.stringify({ schemaVersion: 'old-v0', version: '3.5.0', outcome: 'success' }),
        'utf8',
      );

      const runner = fakeRunner();
      const result = await checkAndMigrate({
        targetVersion: '3.5.0',
        userScope: scope,
        runMigration: runner,
      });

      expect(result.status).toBe('migrated');
      expect(runner).toHaveBeenCalledTimes(1);
    });
  });

  describe('createMigrationRunner factory', () => {
    it('captures deps and forwards per-call options', async () => {
      const runner = fakeRunner();
      const logs = [];
      const boundRunner = createMigrationRunner({
        userScope: scope,
        runMigration: runner,
        logger: (m) => logs.push(m),
      });

      const result = await boundRunner({ targetVersion: '3.5.0' });

      expect(result.status).toBe('migrated');
      expect(runner).toHaveBeenCalledTimes(1);
      expect(logs.length).toBeGreaterThan(0);
    });

    it('per-call options override captured deps', async () => {
      const runnerA = fakeRunner({ totalTagged: 1 });
      const runnerB = fakeRunner({ totalTagged: 99 });
      const boundRunner = createMigrationRunner({
        userScope: scope,
        runMigration: runnerA,
      });

      const result = await boundRunner({
        targetVersion: '3.5.0',
        runMigration: runnerB,
      });

      expect(result.tagged).toBe(99);
      expect(runnerA).not.toHaveBeenCalled();
      expect(runnerB).toHaveBeenCalledTimes(1);
    });
  });

  describe('internal helpers', () => {
    it('expandHome resolves ~/ prefix', () => {
      const { expandHome } = __internals;
      const expanded = expandHome('~/foo/bar');
      expect(expanded).toContain('foo');
      expect(expanded.startsWith('~')).toBe(false);
    });

    it('expandHome leaves absolute paths untouched', () => {
      const { expandHome } = __internals;
      const abs = path.resolve('/tmp/abs-path');
      expect(expandHome(abs)).toBe(abs);
    });
  });
});
