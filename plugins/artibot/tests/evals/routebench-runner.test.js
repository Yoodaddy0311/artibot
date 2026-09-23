/**
 * RouteBench offline runner gate - `scripts/bench/routebench.mjs`.
 *
 * What this file proves
 * ---------------------
 *  1. The shipped fixture (`tests/evals/fixtures/routebench/scenarios.example.jsonl`)
 *     runs end to end. Its 2 original scenarios carry `fixture.status:
 *     "pending"` and every one of their rows is REFUSED, because the scenario
 *     schema says a runner must refuse such a scenario rather than score it as
 *     empty (scenarios.schema.json#/properties/fixture/properties/status). Its
 *     4 live scenarios carry scrubbed corpora and are scored. A green run here
 *     proves the plumbing, NOT that any baseline reproduces live policy.
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
 *  - That the fixture corpus is representative. It is 6 scenarios: 2 still
 *    `fixture.status: "pending"` and 4 with scrubbed live corpora. Live
 *    scenario distribution is unmeasured.
 *  - That B3/B4 predict anything. They are recorded, not validated.
 *
 * @module tests/evals/routebench-runner
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { ACTION_CLASS_TIERS, classifyAction } from '../../lib/routing/action-classifier.js';
import {
  corpusViolations,
  FORBIDDEN_CORPUS_KEYS,
  parseArgs,
  resolveBaseline,
  runRouteBench,
  scoreScenarios,
} from '../../scripts/bench/routebench.mjs';
import {
  FORBIDDEN_CORPUS_KEYS as EXTRACTOR_FORBIDDEN_KEYS,
} from '../../scripts/bench/routebench-corpus.mjs';
import { replayLabelBlock } from '../../scripts/bench/routebench-replay-mode.mjs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../lib/core/config.js';
import path from 'node:path';
import { resolveModel } from '../../lib/core/model-policy.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The live config, loaded once here and passed to every expectation.
 *
 * The runner hydrates the same cache internally, so an expectation written as
 * `resolveModel(agent, {}, undefined)` would ALSO be right - but only because
 * the runner ran first. That is an order dependency, not an assertion, and it
 * would go green again the day the runner stops loading the config. Every
 * expectation below names the config it scored against.
 */
const CONFIG = await loadConfig();

/** @returns {string} sha256 of a file's bytes, hex - the runner's own spelling */
function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

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
        call: 'resolveModel(scenario.agentType, {}, config)',
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
        call: 'routeModel({ agentType: scenario.agentType, config, input: { agentType: scenario.agentType } }).models.recommended?.tier ?? null',
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
 * @param {string} [corpus] - the fixture file's contents. Defaults to one clean
 *   scrubbed row, so every pre-existing caller keeps scoring.
 * @returns {{ scenariosFile: string, scenario: object }}
 */
function writeScenario(overrides = {}, corpus = '{"case":1}\n') {
  const dir = freshDir('scen');
  const fixtureFile = path.join(dir, 'corpus.jsonl');
  writeFileSync(fixtureFile, corpus, 'utf-8');
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

/** @returns {object} a structural clone safe to mutate */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

/**
 * The shipped fixture's scenario ids and their declared baseline sets, as
 * MEASURED on 2026-09-14 from scenarios.example.jsonl. Pinned as a literal so
 * that adding, removing or re-baselining a scenario is a red test rather than a
 * silently different benchmark. Tiers are NOT pinned here - they are recomputed
 * from the modules below, per this file's rule.
 */
const SHIPPED_PENDING = Object.freeze({
  'split-four-window-fanout': ['B0', 'B1', 'B2', 'B3', 'B4'],
  'seeded-defect-seven-axis-review': ['B0', 'B1', 'B2', 'B3', 'B4', 'B5'],
});
const SHIPPED_LIVE = Object.freeze({
  'live-investigator-explore': { agentType: 'investigator', baselines: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5'] },
  'live-tdd-guide-implement': { agentType: 'tdd-guide', baselines: ['B0', 'B1', 'B2', 'B3', 'B4'] },
  'live-code-reviewer-review': { agentType: 'code-reviewer', baselines: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5'] },
  'live-doc-updater-edit-routine': { agentType: 'doc-updater', baselines: ['B0', 'B1', 'B2', 'B3', 'B4'] },
});

/** The tier a baseline id picks for an agentType, recomputed. @returns {string} */
function expectedTier(baselineId, agentType) {
  if (baselineId === 'B0') return 'sonnet';
  if (baselineId === 'B1') return 'opus';
  if (baselineId === 'B5') return 'fable';
  if (baselineId === 'B2') return resolveModel(agentType, {}, CONFIG);
  if (baselineId === 'B3') {
    return ACTION_CLASS_TIERS[classifyAction({ agentType }).actionClass];
  }
  return routeModel({ agentType, config: CONFIG, input: { agentType } })
    .models.recommended?.tier ?? null;
}

describe('routebench runner - shipped fixture', () => {
  it('refuses the pending scenarios and scores the live ones, tier by recomputed tier', async () => {
    const out = freshDir('example');
    const report = await runRouteBench({
      scenarios: EXAMPLE_SCENARIOS,
      baselines: baselinesPath,
      out,
      n: 1,
    });

    // 11 pending rows + 22 live rows. Both halves are pinned, because a fixture
    // edit that silently drops a scenario would otherwise still be green.
    expect(report.rows.length).toBe(33);
    expect(report.summary).toEqual({ scored: 22, refused: 11, skipped: 0 });

    for (const [id, ids] of Object.entries(SHIPPED_PENDING)) {
      for (const baselineId of ids) {
        const r = row(report, id, baselineId);
        expect(r.status).toBe('refused');
        expect(r.reason).toBe('fixture-pending');
        expect(r.selection).toBeNull();
      }
    }

    for (const [id, spec] of Object.entries(SHIPPED_LIVE)) {
      for (const baselineId of spec.baselines) {
        const r = row(report, id, baselineId);
        expect(`${id}/${baselineId}:${r.status}`).toBe(`${id}/${baselineId}:scored`);
        expect(r.selection.tier).toBe(expectedTier(baselineId, spec.agentType));
        // Reading the corpus measured nothing. This is the whole point of the
        // fixture-invalid gate being a GATE and not an instrument.
        expect(r.metrics_measured).toEqual([]);
        expect(r.metrics_requested.length).toBeGreaterThan(0);
      }
    }

    // The live set is not degenerate: at least one scenario has the three
    // policy baselines disagreeing, which is the divergence the benchmark
    // exists to record. Measured 2026-09-14: investigator is B2 fable, B3
    // sonnet, B4 opus - three different tiers on one row.
    const inv = 'live-investigator-explore';
    const tiers = ['B2', 'B3', 'B4'].map((b) => row(report, inv, b).selection.tier);
    expect(new Set(tiers).size).toBe(3);

    const onDisk = readResults(out, 'scenarios.example');
    expect(onDisk.rows).toEqual(report.rows);
    expect(onDisk.schema_version).toBe(1);
  });

  it('every live corpus on disk passes the scrub gate it is scored under', () => {
    // The runner's acceptance is the assertion above; this one names WHY each
    // file was accepted, so a corpus that starts leaking an id fails here with
    // the offending line rather than as a bare fixture-invalid row.
    for (const id of Object.keys(SHIPPED_LIVE)) {
      const file = path.join(FIXTURE_DIR, 'corpus', `${id}.jsonl`);
      expect(existsSync(file)).toBe(true);
      expect(corpusViolations(readFileSync(file, 'utf-8'))).toEqual([]);
    }
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
      .toBe(resolveModel('planner', {}, CONFIG));
    expect(row(report, 'synthetic-case', 'B3').selection.tier)
      .toBe(ACTION_CLASS_TIERS[classifyAction({ agentType: 'planner' }).actionClass]);
    expect(row(report, 'synthetic-case', 'B4').selection.tier)
      .toBe(routeModel({
        agentType: 'planner', config: CONFIG, input: { agentType: 'planner' },
      }).models.recommended?.tier ?? null);

    expect(row(report, 'synthetic-case', 'B0').selection.resolver).toBe('constant');
    expect(row(report, 'synthetic-case', 'B2').selection.resolver).toBe('module');
    expect(row(report, 'synthetic-case', 'B0').passes).toBe(1);
  });

  it('records one selection shape everywhere: tier, resolver, source', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-shape', agentType: 'planner' });
    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out: freshDir('shape'), n: 1,
    });
    for (const r of report.rows) {
      expect(Object.keys(r.selection)).toEqual(['tier', 'resolver', 'source']);
    }
    // A constant resolver decides nothing, so it names no signal. So does
    // resolveModel, which returns a bare tier string.
    expect(row(report, 'synthetic-shape', 'B0').selection.source).toBeNull();
    expect(row(report, 'synthetic-shape', 'B2').selection.source).toBeNull();
    expect(row(report, 'synthetic-shape', 'B3').selection.source).toBe('agent');
  });

  it('scores B2 against the LOADED policy, not the empty one resolveModel falls back to', async () => {
    // The regression this pins: resolveModel(agent, {}, undefined) reaches
    // getConfig(), which throws until loadConfig() has run; model-policy.js
    // catches that and answers from an EMPTY fable gate. B2 would then be
    // "current v4 policy" in name only. 'planner' is read out of the live
    // allowlist below rather than assumed to be in it.
    const allowlist = CONFIG.agents.modelPolicy.fable.allowlist;
    expect(CONFIG.agents.modelPolicy.fable.enabled).toBe(true);
    expect(allowlist).toContain('planner');

    const loaded = resolveModel('planner', {}, CONFIG);
    const empty = resolveModel('planner', {}, {});
    expect(loaded).not.toBe(empty);

    const { scenariosFile } = writeScenario({ id: 'synthetic-gate2', agentType: 'planner' });
    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out: freshDir('gate2'), n: 1,
    });
    expect(row(report, 'synthetic-gate2', 'B2').selection.tier).toBe(loaded);
    expect(row(report, 'synthetic-gate2', 'B2').selection.tier).not.toBe(empty);
  });

  it('records the policy the run was scored under in the envelope', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-policy', agentType: 'planner' });
    const out = freshDir('policy');
    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out, n: 1,
    });
    const fable = CONFIG.agents.modelPolicy.fable;
    expect(report.policy_source).toEqual({
      fable_enabled: fable.enabled === true,
      allowlist_size: fable.allowlist.length,
    });
    expect(report.baselines_sha256).toBe(sha256Of(baselinesPath));
    expect(readResults(out, 'synthetic').policy_source).toEqual(report.policy_source);

    // The second half of "which policy answered": policy_source names the gate,
    // b4_input names what B4 was ASKED. A file that records the gate but not
    // the question is not comparable with one written under the other supply,
    // and the two cannot be told apart by tier alone (they agree on opus for
    // every agent the ceiling pins there). Adjacent by design.
    expect(report.b4_input).toEqual({ agentType: true });
    const onDisk = readResults(out, 'synthetic');
    expect(onDisk.b4_input).toEqual({ agentType: true });
    const keys = Object.keys(onDisk);
    expect(keys.indexOf('b4_input')).toBe(keys.indexOf('policy_source') + 1);
    expect(Object.keys(report).indexOf('b4_input'))
      .toBe(Object.keys(report).indexOf('policy_source') + 1);

    // b4_input is a CONSTANT in the runner, so on its own it is a claim, not a
    // measurement: it would still read `{ agentType: true }` if the resolver
    // stopped supplying the field. This binds the declaration to the run that
    // produced it - source `agent` is reachable only when the classifier
    // actually received an agentType. The tier is not asserted here; the B4
    // tier expectations live in their own tests and are recomputed there.
    expect(row(report, 'synthetic-policy', 'B4').selection.source)
      .toBe(classifyAction({ agentType: 'planner' }).factors.source);
    expect(row(report, 'synthetic-policy', 'B4').selection.source).toBe('agent');
  });

  it('refuses rather than scoring when a resolver returns no tier', () => {
    // Reachable two ways: an unvalidated --baselines file whose constant
    // resolver has no `tier`, and a module resolver answering null. Both used
    // to produce status:"scored" with selection.tier:null, which reads as a
    // decision rather than an absence.
    const noTier = resolveBaseline(
      { id: 'BX', status: 'implemented', resolver: { type: 'constant' } },
      { agentType: 'planner' },
    );
    expect(noTier.status).toBe('refused');
    expect(noTier.reason).toBe('resolver-returned-null');
    expect(noTier.selection).toBeNull();

    const blankTier = resolveBaseline(
      { id: 'BY', status: 'implemented', resolver: { type: 'constant', tier: '' } },
      { agentType: 'planner' },
    );
    expect(blankTier.reason).toBe('resolver-returned-null');
  });

  it('keeps the classifier signal for B3, so a fallback class is not read as a match', () => {
    // classifyAction falls back to `implement` (-> opus) for an agent it does
    // not know. That row and a genuine agent-table hit on opus are the same
    // tier; only `source` tells them apart.
    const b3 = BASELINES.baselines.find((b) => b.id === 'B3');
    const known = resolveBaseline(b3, { agentType: 'planner', config: CONFIG });
    const unknown = resolveBaseline(b3, { agentType: 'no-such-agent-xyz', config: CONFIG });

    expect(known.selection.source).toBe(classifyAction({ agentType: 'planner' }).factors.source);
    expect(known.selection.source).toBe('agent');
    expect(unknown.selection.source)
      .toBe(classifyAction({ agentType: 'no-such-agent-xyz' }).factors.source);
    expect(unknown.selection.source).not.toBe('agent');
    expect(unknown.selection.tier).toBe(ACTION_CLASS_TIERS.implement);
  });

  /** @returns {object} the B4 baseline entry from the local contract */
  function b4Baseline() {
    return BASELINES.baselines.find((b) => b.id === 'B4');
  }

  /**
   * B4 as the runner now asks it: agentType supplied as classifier input.
   *
   * @param {string} agentType
   * @returns {object} RouteReceipt
   */
  function b4Receipt(agentType) {
    return routeModel({ agentType, config: CONFIG, input: { agentType } });
  }

  it('supplies agentType to B4s classifier, so no row falls back to the default class', () => {
    // Owner decision 3 (2026-09-14): B4 feeds scenario.agentType to routeModel
    // as classifier INPUT. Before that, `routeModel({ agentType, config })`
    // left `src.input` empty and every row classified as `default`/implement -
    // a class no live caller ever produces (`route-observe-pre.js` passes
    // `input: { agentType }`). Tiers are recomputed here, never hardcoded.
    const agents = ['planner', 'architect', 'code-reviewer', 'security-reviewer', 'tdd-guide'];
    for (const agentType of agents) {
      const outcome = resolveBaseline(b4Baseline(), { agentType, config: CONFIG });
      expect(outcome.status).toBe('scored');
      expect(outcome.selection.source).toBe(classifyAction({ agentType }).factors.source);
      expect(outcome.selection.source).toBe('agent');
      expect(outcome.selection.source).not.toBe('default');
      expect(outcome.selection.tier).toBe(b4Receipt(agentType).models.recommended?.tier ?? null);
    }
  });

  it('changes B4s answer: the unsupplied call it replaced scored the default class', () => {
    // Both halves are asserted so the test itself witnesses that the old shape
    // was RED, not just that the new one is green. The divergence is only
    // visible while the fable gate is on and planner is allowlisted, so that
    // precondition is read out of the live config first (gate2 pattern above).
    expect(CONFIG.agents.modelPolicy.fable.enabled).toBe(true);
    expect(CONFIG.agents.modelPolicy.fable.allowlist).toContain('planner');

    const supplied = b4Receipt('planner');
    const unsupplied = routeModel({ agentType: 'planner', config: CONFIG });
    expect(unsupplied.reason).toContain('class:default');
    expect(supplied.reason).toContain('class:agent');

    const scored = resolveBaseline(b4Baseline(), { agentType: 'planner', config: CONFIG });
    expect(scored.selection.tier).toBe(supplied.models.recommended?.tier ?? null);
    expect(scored.selection.tier).not.toBe(unsupplied.models.recommended?.tier ?? null);
  });

  it('keeps the policy ceiling above the class for B4: security-reviewer stays at its B2 tier', () => {
    // security-reviewer is on FABLE_DENYLIST, so `policyAllowedTiers` bounds
    // the candidate set no matter which class the classifier picks. Its B4
    // class IS the agent table's `review` - the supply reached it - and the
    // tier is still B2's. Recomputed from both modules, no literal tier here.
    const receipt = b4Receipt('security-reviewer');
    expect(receipt.reason).toContain('class:agent');
    expect(receipt.action.type)
      .toBe(classifyAction({ agentType: 'security-reviewer' }).actionClass);

    const scored = resolveBaseline(b4Baseline(), {
      agentType: 'security-reviewer', config: CONFIG,
    });
    expect(scored.selection.tier).toBe(resolveModel('security-reviewer', {}, CONFIG));
    // The class on its own would rank a different tier first (that is B3).
    expect(scored.selection.tier)
      .not.toBe(ACTION_CLASS_TIERS[classifyAction({ agentType: 'security-reviewer' }).actionClass]);
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
    expect(b2).toBe(resolveModel('backend-developer', {}, CONFIG));
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

/**
 * A 40-hex identifier, the shape the scrub is supposed to have removed. It is
 * ASSEMBLED from five 8-hex chunks rather than written out, because a literal
 * 40-hex string in a source file trips this repo's secret scanner - the value
 * at runtime is identical, and each chunk on its own is a legal scrubbed hash.
 */
const RAW_ID = ['3f2a9c1b', '7e4d8a6f', '5c0b2d9e', '8a7f6c5b', '4a3d2e1f'].join('');

describe('routebench runner - corpus scrub gate', () => {
  /**
   * Score a one-scenario run whose present fixture holds `corpus`.
   *
   * @param {string} id - scenario id
   * @param {string} corpus - fixture file contents
   * @returns {Promise<object>} the report
   */
  async function runWithCorpus(id, corpus) {
    const { scenariosFile } = writeScenario({ id, agentType: 'planner' }, corpus);
    return runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out: freshDir(`corpus-${id}`), n: 1,
    });
  }

  it('refuses every pair as fixture-invalid when a present corpus is EMPTY', async () => {
    // The false green this closes: fixtureRefusal used to stop at existsSync,
    // so a zero-byte file declared `present` scored every baseline. "Zero rows"
    // then read as "the corpus agrees with policy", which is the most
    // flattering possible wrong answer - the same one `pending` exists to stop.
    const report = await runWithCorpus('synthetic-empty', '');
    expect(report.summary.scored).toBe(0);
    expect(report.summary.refused).toBe(report.rows.length);
    expect(report.rows.length).toBe(6);
    for (const r of report.rows) {
      expect(r.reason).toBe('fixture-invalid');
      expect(r.selection).toBeNull();
    }
  });

  it('treats a whitespace-only corpus as empty, not as one blank row', async () => {
    const report = await runWithCorpus('synthetic-blank', '\n   \n\r\n');
    for (const r of report.rows) expect(r.reason).toBe('fixture-invalid');
  });

  it('accepts a minimal scrubbed row: one line of {} scores every baseline', async () => {
    // The gate must not be a content schema. It checks that rows EXIST and are
    // clean; what a row carries is bundle A's extractor contract, not this one.
    const report = await runWithCorpus('synthetic-minimal', '{}\n');
    expect(report.summary.scored).toBe(6);
    expect(report.summary.refused).toBe(0);
    expect(row(report, 'synthetic-minimal', 'B0').selection.tier).toBe('sonnet');
  });

  it('refuses a corpus row carrying a forbidden raw identifier key', async () => {
    const report = await runWithCorpus(
      'synthetic-sid', '{"agentType":"planner"}\n{"session_id":"c58ea3e3"}\n',
    );
    expect(report.summary.scored).toBe(0);
    for (const r of report.rows) expect(r.reason).toBe('fixture-invalid');
  });

  it('refuses a corpus row whose string value holds a hex run longer than 8', async () => {
    const report = await runWithCorpus('synthetic-hex', `{"trace":"${RAW_ID}"}\n`);
    expect(report.summary.scored).toBe(0);
    for (const r of report.rows) expect(r.reason).toBe('fixture-invalid');
  });

  it('refuses the whole scenario when any corpus line is malformed JSON', async () => {
    // Consistent with readScenarios aborting on bad JSONL, except that here it
    // is a refusal row: one bad corpus must not stop the other scenarios.
    const report = await runWithCorpus('synthetic-badline', '{"ok":1}\n{ not json\n');
    expect(report.summary.scored).toBe(0);
    for (const r of report.rows) expect(r.reason).toBe('fixture-invalid');
  });

  it('keeps the refusal order: an unknown or unimplemented baseline outranks the corpus check', async () => {
    // Order matters because a run with BOTH problems must name the same reason
    // every time. The baseline stages come first, so an empty corpus does not
    // rename them.
    const { scenariosFile } = writeScenario(
      { id: 'synthetic-order', agentType: 'planner', baselines: ['B6', 'B9', 'B0'] }, '',
    );
    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out: freshDir('order'), n: 1,
    });
    expect(row(report, 'synthetic-order', 'B6').reason).toBe('baseline-unimplemented');
    expect(row(report, 'synthetic-order', 'B9').reason).toBe('baseline-unknown');
    expect(row(report, 'synthetic-order', 'B0').reason).toBe('fixture-invalid');
  });

  it('keeps fixture-missing ahead of fixture-invalid: an absent file is not an invalid one', async () => {
    const dir = freshDir('gone');
    const scenario = {
      id: 'synthetic-gone',
      task_class: 'debugging',
      baselines: ['B0'],
      metrics: ['total_cost'],
      fixture: { status: 'present', path: path.join(dir, 'nope.jsonl') },
      source: 'design-v5-8.2',
    };
    const scenariosFile = path.join(dir, 'gone.jsonl');
    writeFileSync(scenariosFile, `${JSON.stringify(scenario)}\n`, 'utf-8');
    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out: freshDir('gone-out'), n: 1,
    });
    expect(row(report, 'synthetic-gone', 'B0').reason).toBe('fixture-missing');
  });
});

describe('routebench runner - corpusViolations predicate', () => {
  it('returns no violation for a clean multi-row corpus', () => {
    expect(corpusViolations('{"a":1}\n{"b":{"c":["x",2,null]}}\n')).toEqual([]);
    expect(corpusViolations('{}\n')).toEqual([]);
  });

  it('keeps the 8-hex hashes the scrub deliberately preserves', () => {
    // The corpora bundle A ships carry `session`/`mission`/`epoch` truncated to
    // 8 hex characters. Nine is the first length the scrub cannot produce, so
    // the boundary is asserted from both sides.
    expect(corpusViolations('{"session":"c58ea3e3","mission":"27f8e247"}\n')).toEqual([]);
    expect(corpusViolations('{"h":"abcdefab"}\n')).toEqual([]);
    expect(corpusViolations('{"h":"abcdefab1"}\n')).toEqual(['line 1: raw-hex-run']);
  });

  it('names each violation kind with the line it came from', () => {
    expect(corpusViolations('')).toEqual(['corpus-empty']);
    expect(corpusViolations('\n \n')).toEqual(['corpus-empty']);
    expect(corpusViolations('{"ok":1}\n{ not json\n')).toEqual(['line 2: not-json']);
    expect(corpusViolations('[1,2]\n')).toEqual(['line 1: not-an-object']);
    expect(corpusViolations('"a string"\n')).toEqual(['line 1: not-an-object']);
    expect(corpusViolations('null\n')).toEqual(['line 1: not-an-object']);
    expect(corpusViolations('{"pid":42}\n')).toEqual(['line 1: forbidden-key:pid']);
    expect(corpusViolations(`{"t":"${RAW_ID}"}\n`)).toEqual(['line 1: raw-hex-run']);
  });

  it('finds a forbidden key and a raw hex run at any depth, in objects and arrays', () => {
    expect(corpusViolations('{"a":{"b":[{"seq":3}]}}\n'))
      .toEqual(['line 1: forbidden-key:seq']);
    expect(corpusViolations(`{"rows":[{"nested":{"v":"${RAW_ID}"}}]}\n`))
      .toEqual(['line 1: raw-hex-run']);
  });

  it('catches every key in FORBIDDEN_CORPUS_KEYS, one per key', () => {
    // A frozen list nothing exercises is a comment. Each entry is proven to
    // refuse on its own, so removing one turns red here.
    for (const key of FORBIDDEN_CORPUS_KEYS) {
      expect(corpusViolations(`${JSON.stringify({ [key]: 'v' })}\n`))
        .toEqual([`line 1: forbidden-key:${key}`]);
    }
    expect(FORBIDDEN_CORPUS_KEYS).toEqual([
      'session_id', 'mission_id', 'pid', 'seq', 'idempotency_key',
      'tool_use_id', 'routing_epoch_id', 'route_receipt_id', 'action_id',
    ]);
    expect(Object.isFrozen(FORBIDDEN_CORPUS_KEYS)).toBe(true);
  });

  it('holds the same forbidden-key list as the extractor that writes the corpora', () => {
    // The runner's JSDoc says the two copies are kept byte-identical by
    // convention. A convention with no gate is a comment, so this is the gate.
    // The import is STATIC and unguarded on purpose: the extractor and this
    // file land in the same commit, so an existsSync guard here would fail open
    // - the day the extractor moved or was deleted, the drift check would go
    // quietly green instead of red.
    expect(EXTRACTOR_FORBIDDEN_KEYS).toEqual(FORBIDDEN_CORPUS_KEYS);
  });

  it('reports every violation it finds rather than stopping at the first', () => {
    expect(corpusViolations(`{"pid":1}\n{"t":"${RAW_ID}"}\n{ bad\n`)).toEqual([
      'line 1: forbidden-key:pid',
      'line 2: raw-hex-run',
      'line 3: not-json',
    ]);
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

  it('produces identical rows for the SHIPPED fixture across two --n 2 runs', async () => {
    // The synthetic determinism test above uses one hand-written scenario. This
    // one runs the real fixture, including the four live corpora, so the corpus
    // read is covered too: reading a file per pair must not make a row depend
    // on which pass or which run opened it. Separate out dirs, because a shared
    // one would let run 2 carry run 1 forward as completed-pair and prove
    // nothing.
    const args = { scenarios: EXAMPLE_SCENARIOS, baselines: baselinesPath, n: 2 };
    const first = await runRouteBench({ ...args, out: freshDir('shipped-a') });
    const second = await runRouteBench({ ...args, out: freshDir('shipped-b') });

    expect(JSON.stringify(first.rows)).toBe(JSON.stringify(second.rows));
    expect(first.summary).toEqual(second.summary);
    expect(first.summary.skipped).toBe(0);
    for (const r of first.rows) {
      expect(r.passes).toBe(r.status === 'scored' ? 2 : null);
    }
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
  /**
   * Write a prior results file into `out` with one row, stamped with the sha of
   * the baselines file the run will read.
   *
   * @param {string} out - output directory
   * @param {object} row0 - the single prior row
   * @returns {void}
   */
  function seedPrior(out, row0) {
    const seeded = {
      schema_version: 1,
      generated_at: '2000-01-01T00:00:00.000Z',
      scenarios_file: 'seed',
      baselines_file: 'seed',
      baselines_schema_version: 1,
      baselines_sha256: sha256Of(baselinesPath),
      policy_source: { fable_enabled: true, allowlist_size: 0 },
      metrics_note: 'seed',
      rows: [row0],
      summary: { scored: 1, refused: 0, skipped: 0 },
    };
    writeFileSync(
      path.join(out, 'synthetic.results.json'),
      `${JSON.stringify(seeded, null, 2)}\n`,
      'utf-8',
    );
  }

  it('carries a prior scored selection forward, and --no-skip recomputes it', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-skip', agentType: 'planner' });
    const out = freshDir('skip');
    seedPrior(out, {
      scenario_id: 'synthetic-skip',
      baseline: 'B0',
      status: 'scored',
      reason: null,
      selection: { tier: 'haiku', resolver: 'constant', source: null },
      passes: 1,
      metrics_requested: ['total_cost'],
      metrics_measured: [],
    });

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

  it('keeps skipping across a THIRD run, because run 2 rewrote the rows as skipped', async () => {
    // The regression: run 2 writes every carried pair as
    // status:"skipped"/reason:"completed-pair". Indexing only status:"scored"
    // made run 3 read a file with no scored row, find nothing completed, and
    // rescore the lot - so the skip survived exactly one run and the feature
    // silently did nothing from run 3 onward.
    const { scenariosFile } = writeScenario({ id: 'synthetic-run3', agentType: 'planner' });
    const out = freshDir('run3');
    const args = { scenarios: scenariosFile, baselines: baselinesPath, out, n: 1 };

    const run1 = await runRouteBench(args);
    expect(run1.summary.scored).toBe(6);
    expect(run1.summary.skipped).toBe(0);

    const run2 = await runRouteBench(args);
    expect(run2.summary.skipped).toBe(6);
    expect(run2.summary.scored).toBe(0);

    const run3 = await runRouteBench(args);
    expect(run3.summary.skipped).toBe(6);
    expect(run3.summary.scored).toBe(0);
    expect(row(run3, 'synthetic-run3', 'B0').selection.tier).toBe('sonnet');
  });

  it('rescores a prior REFUSED pair instead of carrying the refusal forward', async () => {
    // A refusal is the outcome a landed fixture or an implemented baseline is
    // supposed to change. Treating it as completed would freeze the run at the
    // first thing that ever went wrong.
    const { scenariosFile } = writeScenario({ id: 'synthetic-refused', agentType: 'planner' });
    const out = freshDir('refused');
    seedPrior(out, {
      scenario_id: 'synthetic-refused',
      baseline: 'B0',
      status: 'refused',
      reason: 'fixture-pending',
      selection: null,
      passes: null,
      metrics_requested: ['total_cost'],
      metrics_measured: [],
    });

    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out, n: 1,
    });
    const r = row(report, 'synthetic-refused', 'B0');
    expect(r.status).toBe('scored');
    expect(r.selection.tier).toBe('sonnet');
    expect(report.summary.skipped).toBe(0);
  });

  it('ignores a prior file whose baselines_sha256 does not match this run', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-sha', agentType: 'planner' });
    const out = freshDir('sha');
    const args = { scenarios: scenariosFile, baselines: baselinesPath, out, n: 1 };

    await runRouteBench(args);
    expect((await runRouteBench(args)).summary.skipped).toBe(6);

    // Edit the baselines file the run reads. Every carried row was produced by
    // a definition that no longer exists, so none of them may be reused.
    const edited = clone(BASELINES);
    edited.baselines.find((b) => b.id === 'B0').resolver.tier = 'haiku';
    writeFileSync(baselinesPath, `${JSON.stringify(edited, null, 2)}\n`, 'utf-8');
    try {
      const after = await runRouteBench(args);
      expect(after.summary.skipped).toBe(0);
      expect(after.summary.scored).toBe(6);
      expect(row(after, 'synthetic-sha', 'B0').selection.tier).toBe('haiku');
    } finally {
      writeFileSync(baselinesPath, `${JSON.stringify(BASELINES, null, 2)}\n`, 'utf-8');
    }
  });

  it('ignores a prior file written before baselines_sha256 existed', async () => {
    // Unprovable is not the same as matching: a file with no sha cannot be
    // shown to have come from these baselines, so it is discarded whole.
    const { scenariosFile } = writeScenario({ id: 'synthetic-nosha', agentType: 'planner' });
    const out = freshDir('nosha');
    seedPrior(out, {
      scenario_id: 'synthetic-nosha',
      baseline: 'B0',
      status: 'scored',
      reason: null,
      selection: { tier: 'haiku', resolver: 'constant', source: null },
      passes: 1,
      metrics_requested: ['total_cost'],
      metrics_measured: [],
    });
    const seededPath = path.join(out, 'synthetic.results.json');
    const doc = JSON.parse(readFileSync(seededPath, 'utf-8'));
    delete doc.baselines_sha256;
    writeFileSync(seededPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');

    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out, n: 1,
    });
    expect(report.summary.skipped).toBe(0);
    expect(row(report, 'synthetic-nosha', 'B0').selection.tier).toBe('sonnet');
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

describe('routebench runner - replay_mode surface', () => {
  /** Row key order, pinned: replay_mode sits with the identity keys. */
  const ROW_KEYS = Object.freeze([
    'scenario_id', 'baseline', 'replay_mode', 'status', 'reason', 'selection',
    'passes', 'metrics_requested', 'metrics_measured',
  ]);

  it('gives every row the same key order, scored, refused and skipped alike', async () => {
    const report = await runRouteBench({
      scenarios: EXAMPLE_SCENARIOS, baselines: baselinesPath, out: freshDir('rm-keys'), n: 1,
    });
    const statuses = new Set();
    for (const r of report.rows) {
      expect(Object.keys(r)).toEqual([...ROW_KEYS]);
      statuses.add(r.status);
    }
    expect([...statuses].sort()).toEqual(['refused', 'scored']);

    const { scenariosFile } = writeScenario({ id: 'synthetic-rm-skip', agentType: 'planner' });
    const out = freshDir('rm-keys-skip');
    await runRouteBench({ scenarios: scenariosFile, baselines: baselinesPath, out, n: 1 });
    const again = await runRouteBench({ scenarios: scenariosFile, baselines: baselinesPath, out, n: 1 });
    expect(again.summary.skipped).toBe(6);
    for (const r of again.rows) expect(Object.keys(r)).toEqual([...ROW_KEYS]);
  });

  it('copies each shipped scenario declaration onto every one of its rows', async () => {
    const declared = new Map(readFileSync(EXAMPLE_SCENARIOS, 'utf-8')
      .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
      .map((s) => [s.id, s.replay_mode]));
    const report = await runRouteBench({
      scenarios: EXAMPLE_SCENARIOS, baselines: baselinesPath, out: freshDir('rm-copy'), n: 1,
    });
    for (const r of report.rows) expect(r.replay_mode).toBe(declared.get(r.scenario_id));
    // Pending rows carry their declaration too: refusing to score is not the
    // same as having no declared mode.
    expect(row(report, 'seeded-defect-seven-axis-review', 'B0').replay_mode).toBe('exact');
    expect(row(report, 'split-four-window-fanout', 'B0').replay_mode).toBe('partial');
  });

  it('carries null, not a default, when the scenario omits replay_mode', async () => {
    const { scenariosFile } = writeScenario({ id: 'synthetic-rm-none', agentType: 'planner', replay_mode: undefined });
    const report = await runRouteBench({
      scenarios: scenariosFile, baselines: baselinesPath, out: freshDir('rm-none'), n: 1,
    });
    for (const r of report.rows) expect(r.replay_mode).toBeNull();
    expect(report.replay_label.declared.undeclared).toBe(1);
    expect(report.replay_label.declared.scenarios).toBe(1);
  });

  it('gives a carried row the CURRENT scenario declaration, not the prior file', async () => {
    // Prior results files predate the field, or were written under a different
    // declaration. A completed-pair carry takes the selection forward, never
    // the replay_mode: the declaration belongs to the scenario being run.
    const { scenariosFile } = writeScenario({ id: 'synthetic-rm-carry', agentType: 'planner' });
    const out = freshDir('rm-carry');
    const prior = {
      schema_version: 1,
      baselines_sha256: sha256Of(baselinesPath),
      rows: [
        {
          scenario_id: 'synthetic-rm-carry', baseline: 'B0', status: 'scored', reason: null,
          selection: { tier: 'haiku', resolver: 'constant', source: null }, passes: 1,
          metrics_requested: ['total_cost'], metrics_measured: [],
        },
        {
          scenario_id: 'synthetic-rm-carry', baseline: 'B1', replay_mode: 'exact', status: 'scored',
          reason: null, selection: { tier: 'opus', resolver: 'constant', source: null }, passes: 1,
          metrics_requested: ['total_cost'], metrics_measured: [],
        },
      ],
    };
    writeFileSync(path.join(out, 'synthetic.results.json'), JSON.stringify(prior), 'utf-8');
    const report = await runRouteBench({ scenarios: scenariosFile, baselines: baselinesPath, out, n: 1 });
    for (const baseline of ['B0', 'B1']) {
      const r = row(report, 'synthetic-rm-carry', baseline);
      expect(r.status).toBe('skipped');
      expect(r.replay_mode).toBe('simulation');
    }
    expect(row(report, 'synthetic-rm-carry', 'B0').selection.tier).toBe('haiku');
  });

  it('writes the replay_label block between metrics_note and rows, equal to the pure builder', async () => {
    const out = freshDir('rm-block');
    const report = await runRouteBench({
      scenarios: EXAMPLE_SCENARIOS, baselines: baselinesPath, out, n: 1,
    });
    const scenarios = readFileSync(EXAMPLE_SCENARIOS, 'utf-8')
      .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    expect(report.replay_label).toEqual(replayLabelBlock(scenarios));
    expect(report.replay_label.measured).toBeNull();
    const onDisk = readResults(out, 'scenarios.example');
    const keys = Object.keys(onDisk);
    expect(keys.indexOf('replay_label')).toBe(keys.indexOf('metrics_note') + 1);
    expect(keys.indexOf('rows')).toBe(keys.indexOf('replay_label') + 1);
    expect(onDisk.replay_label).toEqual(report.replay_label);
  });
});

describe('routebench runner - source hygiene', () => {
  const source = () => readFileSync(path.join(PLUGIN_ROOT, 'scripts/bench/routebench.mjs'), 'utf-8');

  /**
   * Every spelling that would put a network (or a shell-out to one) in this
   * file. Both quote styles are listed because the old list only had single
   * quotes, and this repo's lint does not forbid double-quoted imports - so
   * `import "undici"` would have sailed past it. `node:child_process` is here
   * for the same reason a network import is: a spawned curl is a request.
   *
   * Bare `'net'` and `"net"` carry their quotes so the token cannot match the
   * word inside prose; `fetch(` carries its paren for the same reason.
   */
  const FORBIDDEN_SOURCE_TOKENS = Object.freeze([
    'node:http', 'node:https', 'node:net', 'node:dns', 'node:tls', 'node:child_process',
    "'node:http'", "'node:https'", "'node:net'", "'node:dns'", "'node:tls'",
    "'node:child_process'", "'http'", "'https'", "'net'", "'dns'", "'tls'",
    "'undici'", "'node-fetch'", "'axios'", "'child_process'",
    '"node:http"', '"node:https"', '"node:net"', '"node:dns"', '"node:tls"',
    '"node:child_process"', '"http"', '"https"', '"net"', '"dns"', '"tls"',
    '"undici"', '"node-fetch"', '"axios"', '"child_process"',
    'fetch(', 'XMLHttpRequest', 'WebSocket',
  ]);

  /**
   * The scan itself, so the positive and the negative case run the SAME code.
   *
   * @param {string} text - source text to scan
   * @returns {string[]} every forbidden token present
   */
  function networkTokensIn(text) {
    return FORBIDDEN_SOURCE_TOKENS.filter((token) => text.includes(token));
  }

  it('requests no network module', () => {
    expect(networkTokensIn(source())).toEqual([]);
  });

  it('the network scan actually fires - proven by injecting into a copy', () => {
    // A not-to-contain assertion nothing has ever tripped is a list of strings,
    // not a gate. The file on disk is never written: the import is appended to
    // an in-memory copy of its text.
    for (const forbidden of FORBIDDEN_SOURCE_TOKENS) {
      const injected = `${source()}\nimport ${forbidden};\n`;
      expect(networkTokensIn(injected)).toContain(forbidden);
    }
    expect(networkTokensIn(`${source()}\nimport 'undici';\n`)).toEqual(["'undici'"]);
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
