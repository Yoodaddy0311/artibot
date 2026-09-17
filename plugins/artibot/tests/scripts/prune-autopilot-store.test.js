/**
 * Pins for `scripts/dev/prune-autopilot-store.mjs`.
 *
 * The autopilot store accumulates three kinds of residue that are not sessions:
 * `test-engine-state-*` files left by harnesses, `*.events.ndjson` whose paired
 * `*.json` is gone, and `*.json.v<n>.bak` schema-upgrade backups. They inflate
 * every denominator computed by counting store entries, so a pruner has to
 * classify them EXACTLY -- a file counted in two buckets reports a total larger
 * than the directory, and a real session swept as residue is data loss.
 *
 * What these tests pin, and why each one exists:
 *   - single-bucket classification. `test-engine-state-bbb.events.ndjson` has no
 *     paired `.json`, so it satisfies both rule (a) and rule (b). The fixture
 *     keeps it deliberately: a naive implementation counts it twice and reports
 *     6 targets out of 5.
 *   - dry-run really is dry. Default `pruneStore(dir)` must leave the file count
 *     untouched, proven by a count before and after rather than by reading the
 *     returned `deleted` field (which a broken implementation controls).
 *   - survivors. `ap-20260102-000000-keep.json` and its events stream must be
 *     present after `--apply`. Asserting only "5 deleted" cannot tell apart
 *     "deleted the right 5" from "deleted 5 of 7".
 *   - the real store is never touched. Test 6 runs the CLI as a child with
 *     `CLAUDE_PLUGIN_ROOT` pointed at a throwaway root that holds residue, and
 *     asserts that residue survives an `--apply` aimed elsewhere via `--store`.
 *     This is the one failure that would be destructive rather than merely
 *     wrong, so it is proven against a real child process, not a mocked path.
 *
 * What these tests do NOT cover: concurrent writers appending to the store
 * mid-scan, permission-denied unlinks (the `failed` list is returned but no
 * fixture can produce one portably), and non-Windows filesystems.
 *
 * @module tests/scripts/prune-autopilot-store
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruneStore, scanStore } from '../../scripts/dev/prune-autopilot-store.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/dev/prune-autopilot-store.mjs', import.meta.url),
);

/** @type {string[]} every temp dir made here, removed in afterEach */
const temps = [];

/**
 * @returns {string} a fresh temp directory registered for cleanup
 */
function makeTemp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prune-store-'));
  temps.push(dir);
  return dir;
}

/**
 * Residue fixture: 5 prunable files plus 2 that must survive.
 *
 * @param {string} dir store directory (created if absent)
 * @returns {{ prunable: string[], survivors: string[] }}
 */
function seedStore(dir) {
  mkdirSync(dir, { recursive: true });
  // (a) test-engine-state-*: two paired, one events-only. The events-only file
  //     also matches rule (b); it must land in (a) and be counted once.
  const prunable = [
    'test-engine-state-aaa.json',
    'test-engine-state-aaa.events.ndjson',
    'test-engine-state-bbb.events.ndjson',
    // (b) orphan events: no `ap-20260101-000000-orphan.json` exists.
    'ap-20260101-000000-orphan.events.ndjson',
    // (c) schema-upgrade backup.
    'ap-20260102-000000-keep.json.v1.bak',
  ];
  const survivors = [
    'ap-20260102-000000-keep.json',
    'ap-20260102-000000-keep.events.ndjson',
  ];
  for (const [i, name] of [...prunable, ...survivors].entries()) {
    // Distinct sizes so a bytes total cannot pass by accident.
    writeFileSync(path.join(dir, name), 'x'.repeat(i + 1), 'utf8');
  }
  return { prunable, survivors };
}

/**
 * @param {string} dir
 * @returns {string[]} sorted entry names
 */
function listing(dir) {
  return readdirSync(dir).sort();
}

/**
 * @param {string} dir
 * @param {string[]} names
 * @returns {number} summed byte size
 */
function bytesOf(dir, names) {
  return names.reduce((sum, n) => sum + statSync(path.join(dir, n)).size, 0);
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('scanStore', () => {
  it('classifies each residue file into exactly one bucket', () => {
    const dir = makeTemp();
    seedStore(dir);

    const scan = scanStore(dir);

    expect(scan.testEngineState.files.sort()).toEqual(
      [
        'test-engine-state-aaa.events.ndjson',
        'test-engine-state-aaa.json',
        'test-engine-state-bbb.events.ndjson',
      ].sort(),
    );
    expect(scan.orphanEvents.files).toEqual(['ap-20260101-000000-orphan.events.ndjson']);
    expect(scan.schemaBackups.files).toEqual(['ap-20260102-000000-keep.json.v1.bak']);
    expect(scan.total.files).toBe(5);
  });

  it('reports byte totals that match statSync on the same files', () => {
    const dir = makeTemp();
    const { prunable } = seedStore(dir);

    const scan = scanStore(dir);

    expect(scan.testEngineState.bytes).toBe(bytesOf(dir, scan.testEngineState.files));
    expect(scan.orphanEvents.bytes).toBe(bytesOf(dir, scan.orphanEvents.files));
    expect(scan.schemaBackups.bytes).toBe(bytesOf(dir, scan.schemaBackups.files));
    expect(scan.total.bytes).toBe(bytesOf(dir, prunable));
  });

  it('excludes live sessions and their paired event streams', () => {
    const dir = makeTemp();
    const { survivors } = seedStore(dir);
    const all = [
      ...scanStore(dir).testEngineState.files,
      ...scanStore(dir).orphanEvents.files,
      ...scanStore(dir).schemaBackups.files,
    ];
    for (const name of survivors) expect(all).not.toContain(name);
  });

  it('returns zeroes without throwing when the directory is absent', () => {
    const dir = path.join(makeTemp(), 'no-such-store');
    expect(existsSync(dir)).toBe(false);

    const scan = scanStore(dir);

    expect(scan.total).toEqual({ files: 0, bytes: 0 });
    expect(scan.testEngineState.files).toEqual([]);
    expect(scan.orphanEvents.files).toEqual([]);
    expect(scan.schemaBackups.files).toEqual([]);
  });
});

describe('pruneStore', () => {
  it('deletes nothing by default', () => {
    const dir = makeTemp();
    seedStore(dir);
    const before = listing(dir);

    const result = pruneStore(dir);

    expect(listing(dir)).toEqual(before);
    expect(listing(dir)).toHaveLength(7);
    expect(result.deleted).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.total.files).toBe(5);
  });

  it('removes all three residue kinds and keeps live sessions when applied', () => {
    const dir = makeTemp();
    const { survivors } = seedStore(dir);

    const result = pruneStore(dir, { apply: true });

    expect(result.deleted).toBe(5);
    expect(result.failed).toEqual([]);
    expect(listing(dir)).toEqual(survivors.sort());
  });

  it('is idempotent: a second apply finds nothing left to delete', () => {
    const dir = makeTemp();
    seedStore(dir);
    pruneStore(dir, { apply: true });

    const second = pruneStore(dir, { apply: true });

    expect(second.deleted).toBe(0);
    expect(second.total.files).toBe(0);
  });

  it('returns zeroes without throwing when the directory is absent', () => {
    const dir = path.join(makeTemp(), 'no-such-store');

    const result = pruneStore(dir, { apply: true });

    expect(result.deleted).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.total.files).toBe(0);
  });
});

describe('CLI', () => {
  /**
   * @param {string[]} args
   * @param {Record<string,string>} [env] extra env for the child
   * @returns {{ status: number|null, stdout: string, stderr: string }}
   */
  function run(args, env) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('prints counts and deletes nothing without --apply', () => {
    const dir = makeTemp();
    seedStore(dir);

    const r = run(['--store', dir]);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/test-engine-state/);
    expect(r.stdout).toMatch(/\b5\b/);
    expect(listing(dir)).toHaveLength(7);
  });

  it('emits one machine-readable object with --json', () => {
    const dir = makeTemp();
    seedStore(dir);

    const r = run(['--store', dir, '--json']);

    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.total.files).toBe(5);
    expect(parsed.applied).toBe(false);
    expect(listing(dir)).toHaveLength(7);
  });

  it('leads with the owner-decision notice and deletes the residue with --apply', () => {
    const dir = makeTemp();
    const { survivors } = seedStore(dir);

    const r = run(['--store', dir, '--apply']);

    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toMatch(
      /^O6: run only after the isolation commit has landed \(owner decision 2026-09-15\)/,
    );
    expect(listing(dir)).toEqual(survivors.sort());
  });

  it('exits 2 with help text on an unknown flag', () => {
    const dir = makeTemp();
    seedStore(dir);

    const r = run(['--store', dir, '--bogus']);

    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toMatch(/usage:/);
    expect(listing(dir)).toHaveLength(7);
  });

  it('never touches the default store when --store names another directory', () => {
    // A throwaway plugin root, complete with the config file `getPluginRoot`
    // looks for, standing in for the developer's real installation.
    const pluginRoot = makeTemp();
    writeFileSync(path.join(pluginRoot, 'artibot.config.json'), '{}', 'utf8');
    const defaultStore = path.join(pluginRoot, 'runtime', 'autopilot');
    seedStore(defaultStore);
    const defaultBefore = listing(defaultStore);

    const target = makeTemp();
    seedStore(target);

    const applied = run(['--store', target, '--apply'], { CLAUDE_PLUGIN_ROOT: pluginRoot });

    expect(applied.status).toBe(0);
    // The explicitly named store was pruned...
    expect(listing(target)).toHaveLength(2);
    // ...and the default store was not read from, written to, or deleted from.
    expect(listing(defaultStore)).toEqual(defaultBefore);
    expect(listing(defaultStore)).toHaveLength(7);
  });

  it('falls back to the plugin-root store when --store is omitted', () => {
    const pluginRoot = makeTemp();
    writeFileSync(path.join(pluginRoot, 'artibot.config.json'), '{}', 'utf8');
    const defaultStore = path.join(pluginRoot, 'runtime', 'autopilot');
    seedStore(defaultStore);

    const r = run(['--json'], { CLAUDE_PLUGIN_ROOT: pluginRoot });

    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.total.files).toBe(5);
    expect(parsed.applied).toBe(false);
    expect(listing(defaultStore)).toHaveLength(7);
  });
});
