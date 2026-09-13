/**
 * RouteBench offline runner gate - `scripts/bench/routebench.mjs`.
 *
 * What this file proves
 * ---------------------
 *  1. The shipped fixture (`tests/evals/fixtures/routebench/scenarios.example.jsonl`)
 *     runs end to end and produces ZERO scored rows: both of its scenarios carry
 *     `fixture.status: "pending"`, and the scenario schema says a runner MUST
 *     refuse such a scenario rather than scoring it as empty
 *     (scenarios.schema.json#/properties/fixture/properties/status). A green run
 *     here proves the plumbing, NOT that any baseline reproduces live policy.
 *  2. Each module-backed baseline resolves through the real routing module it
 *     names, and the expected tier is recomputed INDEPENDENTLY in the test by
 *     calling that module directly. The test never hardcodes a tier for B2/B3/B4,
 *     because a hardcoded tier would turn a policy change into a green test.
 *  3. Refusal is a first-class outcome with a named reason, never a silent zero.
 *  4. The output is byte-stable apart from the single `generated_at` stamp, and
 *     carries no composite score anywhere (MODEL-SWITCHING-SCORECARD.md section
 *     45 forbids collapsing raw metrics into one number up front).
 *
 * What it CANNOT prove
 * --------------------
 *  - That the fixture corpus is representative. It is 2 rows and both are
 *    pending. Live scenario distribution is unmeasured.
 *  - That B3/B4 predict anything. They are recorded, not validated.
 *
 * @module tests/evals/routebench-runner
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ACTION_CLASS_TIERS, classifyAction } from '../../lib/routing/action-classifier.js';
import {
  parseArgs,
  resolveBaseline,
  runRouteBench,
  scoreScenarios,
} from '../../scripts/bench/routebench.mjs';
import path from 'node:path';
import { resolveModel } from '../../lib/core/model-policy.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const FIXTURE_DIR = path.join(PLUGIN_ROOT, 'tests/evals/fixtures/routebench');
const EXAMPLE_SCENARIOS = path.join(FIXTURE_DIR, 'scenarios.example.jsonl');
const SHIPPED_BASELINES = path.join(FIXTURE_DIR, 'baselines.json');

/**
 * The baselines contract this runner codes against, duplicated here so the
 * runner tests do not depend on a fixture another bundle is still landing.
 * When the shipped `baselines.json` exists, a dedicated assertion checks that
 * this local copy still matches its ids/kinds - so a drift shows up as a red
 * test rather than as two quietly different definitions.
 */
const BASELINES = {
  schema_version: 1,
  agent_type_supply: { note: 'test copy' },
  baselines: [
    {
      id: 'B0',
      name: 'Fixed Sonnet',
      kind: 'fixed',
      required: true,
      status: 'implemented',
      definition_confidence: 'exact',
      resolver: { type: 'constant', tier: 'sonnet' },
    },
    {
      id: 'B1',
      name: 'Fixed Opus',
      kind: 'fixed',
      required: true,
      status: 'implemented',
      definition_confidence: 'exact',
      resolver: { type: 'constant', tier: 'opus' },
    },
    {
      id: 'B2',
      name: 'Current v4 Policy',
      kind: 'policy',
      required: true,
      status: 'implemented',
      definition_confidence: 'exact',
      resolver: {
        type: 'module',
        module: 'lib/core/model-policy.js',
        export: 'resolveModel',
        call: 'resolveModel(agentType, {}, undefined)',
      },
    },
    {
      id: 'B3',
      name: 'v5 Static Heuristic',
      kind: 'heuristic',
      required: true,
      status: 'implemented',
      definition_confidence: 'partial',
      resolver: {
        type: 'module',
        module: 'lib/routing/action-classifier.js',
        export: 'classifyAction',
        call: 'ACTION_CLASS_TIERS[classifyAction({ agentType }).actionClass]',
      },
    },
    {
      id: 'B4',
      name: 'v5 Adaptive Router',
      kind: 'adaptive',
      required: true,
      status: 'implemented',
      definition_confidence: 'partial',
      resolver: {
        type: 'module',
        module: 'lib/routing/adaptive-model-router.js',
        export: 'routeModel',
        call: 'routeModel({ agentType }).models.recommended?.tier ?? null',
      },
    },
    {
      id: 'B5',
      name: 'Fixed Fable',
      kind: 'fixed',
      required: false,
      status: 'implemented',
      definition_confidence: 'exact',
      resolver: { type: 'constant', tier: 'fable' },
    },
    {
      id: 'B6',
      name: 'Hindsight Oracle',
      kind: 'oracle',
      required: false,
      status: 'unimplemented',
      definition_confidence: 'none',
      reason: 'needs recorded outcomes that do not exist yet',
    },
  ],
};

let sandbox = null;
let baselinesPath = null;

/** @returns {string} a fresh empty directory under the sandbox */
function freshDir(tag) {
  return mkdtempSync(path.join(sandbox, `${tag}-`));
}

/**
 * Write a one-line JSONL scenarios file plus the fixture it points at.
 *
 * @param {object} overrides - merged over the default scenario
 * @returns {{ scenariosFile: string, scenario: object }}
 */
function writeScenario(overrides = {}) {
  const dir = freshDir('scen');
  const fixtureFile = path.join(dir, 'corpus.jsonl');
  writeFileSync(fixtureFile, '{"case":1}\n', 'utf-8');
  const scenario = {
    id: 'synthetic-case',
    title: 'synthetic',
    task_class: 'routine_implementation',
    baselines: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5'],
    metrics: ['total_cost'],
    replay_mode: 'simulation',
    fixture: { status: 'present', path: fixtureFile },
    why: 'runner plumbing only',
    source: 'design-v5-8.2',
    ...overrides,
  };
  const scenariosFile = path.join(dir, 'synthetic.jsonl');
  writeFileSync(scenariosFile, `${JSON.stringify(scenario)}\n`, 'utf-8');
  return { scenariosFile, scenario };
}

/** @returns {object} parsed results envelope */
function readResults(outDir, stem) {
  return JSON.parse(readFileSync(path.join(outDir, `${stem}.results.json`), 'utf-8'));
}

/** @returns {object} row for a (scenario, baseline) pair */
function row(results, scenarioId, baseline) {
  const found = results.rows.find(
    (r) => r.scenario_id === scenarioId && r.baseline === baseline,
  );
  if (!found) throw new Error(`no row for ${scenarioId}/${baseline}`);
  return found;
}

/** Collect every object key in a parsed JSON tree. @returns {string[]} */
function allKeys(node, acc = []) {
  if (Array.isArray(node)) {
    for (const item of node) allKeys(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      acc.push(key);
      allKeys(value, acc);
    }
  }
  return acc;
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-routebench-'));
  baselinesPath = path.join(sandbox, 'baselines.json');
  writeFileSync(baselinesPath, `${JSON.stringify(BASELINES, null, 2)}\n`, 'utf-8');
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('routebench runner - shipped fixture', () => {
  it('refuses every pair of scenarios.example.jsonl because both fixtures are pending', async () => {
    const out = freshDir('example');
    const report = await runRouteBench({
      scenarios: EXAMPLE_SCENARIOS,
      baselines: baselinesPath,
      out,
      n: 1,
    });

    expect(report.summary.scored).toBe(0);
    expect(report.summary.refused).toBe(report.rows.length);
    expect(report.rows.length).toBe(11);
    for (const r of report.rows) {
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('fixture-pending');
      expect(r.selection).toBeNull();
    }

    const onDisk = readResults(out, 'scenarios.example');
    expect(onDisk.rows).toEqual(report.rows);
    expect(onDisk.schema_version).toBe(1);
  });

  it('keeps the local baselines contract in step with the shipped baselines.json', () => {
    if (!existsSync(SHIPPED_BASELINES)) {
      expect(existsSync(SHIPPED_BASELINES)).toBe(false);
      return;
    }
    const shipped = JSON.parse(readFileSync(SHIPPED_BASELINES, 'utf-8'));
    expect(shipped.baselines.map((b) => b.id)).toEqual(BASELINES.baselines.map((b) => b.id));
    for (const mine of BASELINES.baselines) {
      const theirs = shipped.baselines.find((b) => b.id === mine.id);
      expect(theirs.status).toBe(mine.status);
      expect(theirs.resolver?.type ?? null).toBe(mine.resolver?.type ?? null);
      if (mine.resolver?.type === 'constant') expect(theirs.resolver.tier).toBe(mine.resolver.tier);
      if (mine.resolver?.type === 'module') {
        expect(theirs.resolver.module).toBe(mine.resolver.module);
        expect(theirs.resolver.export).toBe(mine.resolver.export);
      }
    }
  });
});

describe('routebench runner - scoring a present fixture', () => {
  it('resolves each baseline through the module it names, recomputed independently', async () => {
    const { scenariosFile } = writeScenario({ agentType: 'planner' });
    const out = freshDir('scored');
    const report = await runRouteBench({
      scenarios: scenariosFile,
      baselines: baselinesPath,
      out,
      n: 1,
    });

    expect(report.summary.refused).toBe(0);
    expect(report.summary.scored).toBe(6);

    expect(row(report, 'synthetic-case', 'B0').selection.tier).toBe('sonnet');
    expect(row(report, 'synthetic-case', 'B1').selection.tier).toBe('opus');
    expect(row(report, 'synthetic-case', 'B5').selection.tier).toBe('fable');

    expect(row(report, 'synthetic-case', 'B2').selection.tier)
      .toBe(resolveModel('planner', {}, undefined));
    expect(row(report, 'synthetic-case', 'B3').selection.tier)
      .toBe(ACTION_CLASS_TIERS[classifyAction({ agentType: 'planner' }).actionClass]);
    expect(row(report, 'synthetic-case', 'B4').selection.tier)
      .toBe(routeModel({ agentType: 'planner' }).models.recommended?.tier ?? null);

    expect(row(report, 'synthetic-case', 'B0').selection.resolver).toBe('constant');
    expect(row(report, 'synthetic-case', 'B2').selection.resolver).toBe('module');
    expect(row(report, 'synthetic-case', 'B0').passes).toBe(1);
  });

  it('shows the fable allowlist gate: B2 differs from fixed-fable for a non-allowlisted agent', async () => {
    const { scenariosFile } = writeScenario({
      id: 'synthetic-backend',
      agentType: 'backend-developer',
    });
    const out = freshDir('gate');
    const report = await runRouteBench({
      scenarios: scenariosFile,
      baselines: baselinesPath,
      out,
      n: 1,
    });

    const b2 = row(report, 'synthetic-backend', 'B2').selection.tier;
    const b5 = row(report, 'synthetic-backend', 'B5').selection.tier;
    expect(b2).toBe(resolveModel('backend-developer', {}, undefined));
    expect(b5).toBe('fable');
    expect(b2).not.toBe(b5);
  });

  it('refuses only the module baselines when the scenario carries no agentType', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-noagent' });
    const out = freshDir('noagent');
    const report = await runRouteBench({
      scenarios: scenariosFile,
      baselines: baselinesPath,
      out,
      n: 1,
    });

    for (const id of ['B0', 'B1', 'B5']) {
      expect(row(report, 'synthetic-noagent', id).status).toBe('scored');
    }
    for (const id of ['B2', 'B3', 'B4']) {
      const r = row(report, 'synthetic-noagent', id);
      expect(r.status).toBe('refused');
      expect(r.reason).toBe('agent-type-missing');
      expect(r.selection).toBeNull();
    }
    expect(report.summary.scored).toBe(3);
    expect(report.summary.refused).toBe(3);
  });

  it('refuses an unimplemented baseline and an unknown baseline id by name', async () => {
    const { scenariosFile } = writeScenario({
      id: 'synthetic-oracle',
      agentType: 'planner',
      baselines: ['B6', 'B9'],
    });
    const out = freshDir('oracle');
    const report = await runRouteBench({
      scenarios: scenariosFile,
      baselines: baselinesPath,
      out,
      n: 1,
    });

    expect(row(report, 'synthetic-oracle', 'B6').reason).toBe('baseline-unimplemented');
    expect(row(report, 'synthetic-oracle', 'B9').reason).toBe('baseline-unknown');
    expect(report.summary.scored).toBe(0);
  });

  it('refuses when the fixture path is declared present but absent on disk', async () => {
    const dir = freshDir('missing');
    const scenario = {
      id: 'synthetic-missing',
      task_class: 'debugging',
      baselines: ['B0'],
      metrics: ['total_cost'],
      fixture: { status: 'present', path: path.join(dir, 'nope.jsonl') },
      source: 'design-v5-8.2',
    };
    const scenariosFile = path.join(dir, 'missing.jsonl');
    writeFileSync(scenariosFile, `${JSON.stringify(scenario)}\n`, 'utf-8');

    const report = await runRouteBench({
      scenarios: scenariosFile,
      baselines: baselinesPath,
      out: freshDir('missing-out'),
      n: 1,
    });
    expect(row(report, 'synthetic-missing', 'B0').reason).toBe('fixture-missing');
  });
});

describe('routebench runner - determinism', () => {
  it('produces byte-identical output apart from generated_at', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-det', agentType: 'planner' });
    const outA = freshDir('det-a');
    const outB = freshDir('det-b');
    await runRouteBench({ scenarios: scenariosFile, baselines: baselinesPath, out: outA, n: 1 });
    await runRouteBench({ scenarios: scenariosFile, baselines: baselinesPath, out: outB, n: 1 });

    const a = readResults(outA, 'synthetic');
    const b = readResults(outB, 'synthetic');
    expect(typeof a.generated_at).toBe('string');
    delete a.generated_at;
    delete b.generated_at;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('records the pass count when --n is greater than one', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-n3', agentType: 'planner' });
    const report = await runRouteBench({
      scenarios: scenariosFile,
      baselines: baselinesPath,
      out: freshDir('n3'),
      n: 3,
    });
    for (const r of report.rows) expect(r.passes).toBe(3);
  });

  it('scoreScenarios is a pure function of its inputs', () => {
    const { scenario } = writeScenario({ id: 'synthetic-pure', agentType: 'planner' });
    const first = scoreScenarios([scenario], BASELINES, { n: 1 });
    const second = scoreScenarios([scenario], BASELINES, { n: 1 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('resolveBaseline refuses an unknown resolver key rather than guessing', () => {
    const bogus = {
      id: 'BX',
      status: 'implemented',
      resolver: { type: 'module', module: 'lib/nope.js', export: 'nope' },
    };
    const outcome = resolveBaseline(bogus, { agentType: 'planner' });
    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toBe('resolver-unsupported');
  });
});

describe('routebench runner - completed-pair skip', () => {
  it('carries a prior scored selection forward, and --no-skip recomputes it', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-skip', agentType: 'planner' });
    const out = freshDir('skip');
    const seeded = {
      schema_version: 1,
      generated_at: '2000-01-01T00:00:00.000Z',
      scenarios_file: 'seed',
      baselines_file: 'seed',
      baselines_schema_version: 1,
      metrics_note: 'seed',
      rows: [{
        scenario_id: 'synthetic-skip',
        baseline: 'B0',
        status: 'scored',
        reason: null,
        selection: { tier: 'haiku', resolver: 'constant' },
        passes: 1,
        metrics_requested: ['total_cost'],
        metrics_measured: [],
      }],
      summary: { scored: 1, refused: 0, skipped: 0 },
    };
    writeFileSync(
      path.join(out, 'synthetic.results.json'),
      `${JSON.stringify(seeded, null, 2)}\n`,
      'utf-8',
    );

    const skipped = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out, n: 1,
    });
    const kept = row(skipped, 'synthetic-skip', 'B0');
    expect(kept.status).toBe('skipped');
    expect(kept.reason).toBe('completed-pair');
    expect(kept.selection.tier).toBe('haiku');
    expect(skipped.summary.skipped).toBe(1);

    const recomputed = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out, n: 1, noSkip: true,
    });
    const fresh = row(recomputed, 'synthetic-skip', 'B0');
    expect(fresh.status).toBe('scored');
    expect(fresh.selection.tier).toBe('sonnet');
    expect(recomputed.summary.skipped).toBe(0);
  });
});

describe('routebench runner - CLI surface', () => {
  it('defaults --n to 1 and the baselines path to the shipped fixture', () => {
    const opts = parseArgs(['--scenarios', 'a.jsonl']);
    expect(opts.n).toBe(1);
    expect(opts.noSkip).toBe(false);
    expect(opts.scenarios).toBe('a.jsonl');
    expect(opts.baselines.replace(/\\/g, '/')).toContain(
      'tests/evals/fixtures/routebench/baselines.json',
    );
  });

  it('throws on an unknown flag, a missing --scenarios, and a non-positive --n', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unrecognized argument/);
    expect(() => parseArgs([])).toThrow(/--scenarios/);
    expect(() => parseArgs(['--scenarios', 'a.jsonl', '--n', '0'])).toThrow(/--n/);
  });

  it('documents what --n means in --help', () => {
    const opts = parseArgs(['--help']);
    expect(opts.help).toBe(true);
    const source = readFileSync(
      path.join(PLUGIN_ROOT, 'scripts/bench/routebench.mjs'),
      'utf-8',
    );
    expect(source).toMatch(/--n .*scoring passes/i);
    expect(source).toContain('determinism_violation');
  });

  it('throws with the offending line number on invalid JSONL', async () => {
    const dir = freshDir('badjson');
    const bad = path.join(dir, 'bad.jsonl');
    writeFileSync(bad, '{"id":"ok","task_class":"debugging","baselines":["B0"],"metrics":["total_cost"],"source":"s"}\n{ not json\n', 'utf-8');
    await expect(runRouteBench({
      scenarios: bad, baselines: baselinesPath, out: freshDir('badjson-out'), n: 1,
    })).rejects.toThrow(/line 2/);
  });
});

describe('routebench runner - source hygiene', () => {
  const source = () => readFileSync(path.join(PLUGIN_ROOT, 'scripts/bench/routebench.mjs'), 'utf-8');

  it('requests no network module', () => {
    const text = source();
    for (const forbidden of [
      'node:http', 'node:https', 'node:net', 'node:dns', 'node:tls',
      "'http'", "'https'", 'fetch(',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('uses no clock or randomness in scoring', () => {
    const text = source();
    expect(text).not.toContain('Math.random(');
    expect(text.split('new Date(').length - 1).toBeLessThanOrEqual(1);
    expect(text.split('toISOString(').length - 1).toBeLessThanOrEqual(1);
  });

  it('emits no composite score key anywhere in the envelope', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-nokey', agentType: 'planner' });
    const out = freshDir('nokey');
    await runRouteBench({ scenarios: scenariosFile, baselines: baselinesPath, out, n: 1 });
    const parsed = readResults(out, 'synthetic');
    const keys = allKeys(parsed);
    expect(keys).not.toContain('score');
    expect(keys.filter((k) => k.toLowerCase().includes('composite'))).toEqual([]);
    expect(keys).toContain('metrics_requested');
    expect(keys).toContain('metrics_measured');
  });

  it('is ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(source().match(/[^\x00-\x7F]/gu)).toBeNull();
  });
});
