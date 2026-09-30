/**
 * artibot.get_memory_stats — where the metrics file is looked for (O2).
 *
 * `memory-metrics.json` is GLOBAL: one per user, `<state dir>/runtime/memory-metrics.json`
 * (`~/.claude/artibot`), not `<pluginRoot>/runtime/` — in a marketplace install that is a
 * version-scoped cache directory that a plugin update replaces.
 *
 * WHAT THIS CANNOT SEE: who writes the file. Measured 2026-09-30, no module in this
 * repository does (`grep -rn "memory-metrics"` over the whole tree finds this reader and two
 * 2026-04-24 design notes), so on a real install the tool reports zeros. These tests pin
 * the READER's location so that whichever writer is added later has one place to agree with.
 * `tests/mcp/server.test.js` covers the tool through the registry with an explicit
 * `metricsPath`, which never reaches the default this file is about.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getMemoryStatsTool } from '../../lib/mcp/tools/get-memory-stats.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const METRICS = {
  date: '2026-09-29',
  working: { hits: 3, queries: 4, rate: 0.75 },
  episodic: { hits: 1, queries: 2, rate: 0.5 },
  semantic: { hits: 0, queries: 0, rate: 0 },
};

let base;
let stateDir;
let restoreState;
let savedPluginRoot;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-memstats-'));
  stateDir = path.join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  restoreState = pointStateDirAt(stateDir);
  savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
});

afterEach(() => {
  restoreState();
  if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
  rmSync(base, { recursive: true, force: true });
});

const call = async (args = {}) => JSON.parse((await getMemoryStatsTool.handler(args)).content[0].text);

function seed(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe('artibot.get_memory_stats — default metrics path', () => {
  it('reads <state dir>/runtime/memory-metrics.json', async () => {
    seed(path.join(stateDir, 'runtime', 'memory-metrics.json'), METRICS);

    const out = await call();

    expect(out.present).toBe(true);
    expect(out.metricsPath).toBe(path.join(stateDir, 'runtime', 'memory-metrics.json'));
    expect(out.layers.working.hits).toBe(3);
    expect(out.aggregate).toMatchObject({ hits: 4, queries: 6 });
  });

  it('reports zeros, creates nothing, and does not look in the plugin root when the file is absent', async () => {
    const pluginRoot = path.join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

    const out = await call();

    expect(out.present).toBe(false);
    expect(out.aggregate).toMatchObject({ hits: 0, queries: 0, rate: 0 });
    expect(existsSync(path.join(stateDir, 'runtime'))).toBe(false);
    expect(existsSync(path.join(pluginRoot, 'runtime'))).toBe(false);
  });

  it('carries a file the previous version left in the plugin root over, once', async () => {
    const pluginRoot = path.join(base, 'plugin');
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    seed(path.join(pluginRoot, 'runtime', 'memory-metrics.json'), METRICS);

    const out = await call();

    expect(out.present).toBe(true);
    expect(out.layers.episodic.hits).toBe(1);
    expect(existsSync(path.join(stateDir, 'runtime', 'memory-metrics.json'))).toBe(true);
  });

  it('carries the previous VERSION\'s file over when the running plugin root is a version directory', async () => {
    const cache = path.join(base, 'cache', 'artibot', 'artibot');
    process.env.CLAUDE_PLUGIN_ROOT = path.join(cache, '4.71.0');
    mkdirSync(process.env.CLAUDE_PLUGIN_ROOT, { recursive: true });
    seed(path.join(cache, '4.70.0', 'runtime', 'memory-metrics.json'), METRICS);

    expect((await call()).layers.working.hits).toBe(3);
  });

  it('an explicit metricsPath is honoured as given — no migration, no state-dir lookup', async () => {
    const explicit = path.join(base, 'elsewhere', 'm.json');
    seed(explicit, { ...METRICS, working: { hits: 9, queries: 9, rate: 1 } });
    seed(path.join(stateDir, 'runtime', 'memory-metrics.json'), METRICS);

    const out = await call({ metricsPath: explicit });

    expect(out.metricsPath).toBe(explicit);
    expect(out.layers.working.hits).toBe(9);
  });
});
