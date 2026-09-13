#!/usr/bin/env node
/**
 * RouteBench offline scorer - records which model tier each baseline would pick.
 *
 * WHY THIS EXISTS
 *
 * `tests/evals/fixtures/routebench/` defines scenarios and baselines B0..B6
 * (MODEL-SWITCHING-SCORECARD.md section 11) but nothing reads them. A baseline
 * definition that no program can execute is a document, not a control group:
 * B2 is declared to be "current v4 policy", yet nothing checks that the number
 * anyone quotes for B2 came from `lib/core/model-policy.js` rather than from
 * someone's memory of it. This runner closes exactly that gap and nothing more.
 * It asks each baseline one question - "which tier for this agentType?" - by
 * calling the real module the baseline names, and writes the answers down.
 *
 * It is a MEASURING INSTRUMENT ONLY. It never edits routing. `lib/` is read
 * through its public exports and is never written. A baseline that disagrees
 * with another baseline is reported, not reconciled.
 *
 * WHAT THIS TOOL CANNOT SEE (read before quoting anything it prints)
 *
 *   1. It does not run a task. There is no model call, no token, no latency and
 *      no outcome anywhere in this file. `metrics_measured` is therefore always
 *      empty, and the scenario's `metrics` list is copied through as
 *      `metrics_requested` - a record of what is still owed, not of what was
 *      measured. Do not read a green run as evidence about cost or quality.
 *   2. The shipped fixture is 2 scenarios and BOTH declare
 *      `fixture.status: "pending"`, so the default invocation scores nothing at
 *      all and refuses every pair. That green proves the plumbing works. It
 *      does not prove that any baseline reproduces live policy, because no
 *      scenario with a real corpus exists yet.
 *   3. Live scenario distribution is unmeasured. The design's EXACT / PARTIAL /
 *      SIMULATED replay labels (ARTIBOT-5.0-DESIGN.md section 8.2) exist because
 *      a replay is not a counterfactual; this runner copies `replay_mode`
 *      through untouched and never averages across labels.
 *   4. B3 and B4 are RECORDED, not validated. That `routeModel` recommends a
 *      tier says nothing about whether that tier would have succeeded.
 *   5. There is deliberately NO composite score, here or in the output
 *      envelope. MODEL-SWITCHING-SCORECARD.md section 45 forbids collapsing raw
 *      metrics into one number up front, and the scenario schema has no `score`
 *      property for the same reason.
 *
 * WHICH POLICY ANSWERED
 *
 * B2 calls `resolveModel`, whose answer depends on the fable gate in
 * `artibot.config.json`. The runner loads that config and passes it to every
 * resolver explicitly, and the envelope records `policy_source`
 * (`fable_enabled`, `allowlist_size`) plus `baselines_sha256` so a results file
 * names the policy and the baseline registry it was scored under. A file that
 * does not is not comparable with another one.
 *
 * OFFLINE BY CONSTRUCTION
 *
 * No network module is imported and no request is issued - a firewall test
 * asserts that on this file's source text. Scoring reads no clock and no
 * randomness; the single timestamp in the process is the envelope's
 * `generated_at`. Two runs of the same inputs therefore differ only in that one
 * field, which is what makes `--n` a usable self-check: pass k must reproduce
 * pass 1 exactly, and a mismatch aborts the run with `determinism_violation`
 * rather than quietly recording the last answer.
 *
 * USAGE
 *   node scripts/bench/routebench.mjs --scenarios <file.jsonl> [--baselines p]
 *                                     [--out dir] [--n k] [--no-skip] [--help]
 *
 * @module scripts/bench/routebench
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ACTION_CLASS_TIERS, classifyAction } from '../../lib/routing/action-classifier.js';
import { createHash } from 'node:crypto';
import { isMainEntry } from '../hooks/_main-entry.js';
import { loadConfig } from '../../lib/core/config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModel } from '../../lib/core/model-policy.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BASELINES = path.join(
  PLUGIN_ROOT, 'tests', 'evals', 'fixtures', 'routebench', 'baselines.json',
);
const DEFAULT_OUT = path.join(PLUGIN_ROOT, '_benchmarks', 'routing');
const SCHEMA_VERSION = 1;

const METRICS_NOTE = [
  'This runner records routing decisions offline only. It executes no task and',
  'measures no metric, so metrics_measured is always empty and',
  'metrics_requested is the scenario\'s outstanding list, not a result.',
].join(' ');

/**
 * Baseline resolvers, keyed by the `<module>#<export>` pair the baselines
 * fixture names. Keying on the declared pair rather than on the baseline id is
 * deliberate: if someone repoints B2 at a different module, the key stops
 * matching and the pair is REFUSED as `resolver-unsupported` instead of being
 * silently scored by the old code path. An allowlist, not a deny list.
 *
 * Each entry takes the agentType and the LOADED config, and returns
 * `{ tier, source }` - the tier string (null when the module declines to pick
 * one) and the name of the signal the module decided on, or null when the
 * module exposes no such signal.
 *
 * WHY `config` IS AN ARGUMENT AND NOT LEFT UNDEFINED
 *
 * `resolveModel(agent, {}, undefined)` falls back to `getConfig()`, which
 * THROWS until `loadConfig()` has run; `model-policy.js#resolveConfigSource`
 * catches that throw and returns null, which `loadFableGate` turns into
 * `{ enabled: false, allowlist: [] }`. An un-hydrated B2 therefore scores a
 * fable gate that is OFF against an EMPTY allowlist - not the live policy it
 * claims to be. Measured in this worktree 2026-09-13 with a scratch probe:
 * planner / architect / code-reviewer resolve to `opus` before `loadConfig()`
 * and to `fable` after it. `scripts/ci/validate-model-policy.js#main` hydrates
 * the cache the same way and for the same reason.
 *
 * @type {Record<string, (agentType: string, config: object|undefined) =>
 *   {tier: string|null, source: string|null}>}
 */
const MODULE_RESOLVERS = {
  // B2 - current v4 policy, answered by the config this run loaded. No `role`
  // is passed, because a role would select phaseRoles and that is a different
  // question. `resolveModel` returns a bare tier and names no signal, so
  // `source` is null.
  'lib/core/model-policy.js#resolveModel': (agentType, config) => ({
    tier: resolveModel(agentType, {}, config),
    source: null,
  }),
  // B3 - v5 static heuristic: the frozen actionClass -> tier table. `source` is
  // the classifier's deciding signal, recorded so that a row decided by the
  // `implement` FALLBACK (source `default`, tier `opus`) is distinguishable
  // from one the agent table actually matched (source `agent`). Without it the
  // two are the same row whenever both land on opus.
  'lib/routing/action-classifier.js#classifyAction': (agentType) => {
    const classified = classifyAction({ agentType });
    return {
      tier: ACTION_CLASS_TIERS[classified.actionClass] ?? null,
      source: classified.factors?.source ?? null,
    };
  },
  // B4 - v5 adaptive router. `models.recommended` is the router's own pick;
  // `models.selected` is policy and is already B2, so substituting it here
  // would make B4 a duplicate of B2 and hide every divergence. `config` is
  // threaded for fidelity to the declared call, but note what it does and does
  // not reach: `routeModel` passes it to `resolveModel` for `models.selected`
  // ONLY, so B4's recorded tier is the same with it and without it.
  'lib/routing/adaptive-model-router.js#routeModel': (agentType, config) => {
    const receipt = routeModel({ agentType, config });
    return {
      tier: receipt.models.recommended?.tier ?? null,
      source: classSource(receipt.reason),
    };
  },
};

/**
 * The classifier signal a RouteReceipt used, read out of its `reason` array.
 * `adaptive-model-router.js#routeModel` pushes `class:<source>` as the first
 * reason code and exposes that signal in no other field, so the reason array is
 * the only place it can be read from.
 *
 * Recording it is the point rather than a detail: `routeModel` classifies from
 * `input.input`, NEVER from `input.agentType` (see `resolveClassification`), so
 * B4's class is the `default` fallback for every scenario this runner feeds it.
 * The agent name reaches `models.selected` (policy) and not `models.recommended`
 * (the router's own pick), which is what B4 records.
 *
 * @param {unknown} reason - the receipt's `reason` array
 * @returns {string|null} signal name, or null when no `class:` code is present
 */
function classSource(reason) {
  const codes = Array.isArray(reason) ? reason : [];
  for (const code of codes) {
    if (typeof code === 'string' && code.startsWith('class:')) return code.slice('class:'.length);
  }
  return null;
}

/** @returns {{status:'refused', reason:string, selection:null}} */
function refusal(reason) {
  return { status: 'refused', reason, selection: null };
}

/**
 * Turn a resolver's answer into a row outcome.
 *
 * A null (or non-string) tier is a REFUSAL, not a scored row. `status:
 * "scored"` sitting next to `selection.tier: null` reads as "this baseline
 * chose nothing, and that was fine", and both ways it happens deserve a name
 * instead: an unvalidated `--baselines` file whose constant resolver carries no
 * `tier`, and B4 answering `route:no-candidate` for a class with no candidate
 * in the catalog.
 *
 * `selection` always carries the same three keys in the same order, so rows
 * stay byte-comparable: `tier`, `resolver` ('constant' or 'module'), and
 * `source` (the deciding signal, null when the resolver names none).
 *
 * @param {unknown} tier - what the resolver returned
 * @param {string} resolverKind - 'constant' or 'module'
 * @param {string|null} source - deciding signal, or null
 * @returns {{status:string, reason:string|null, selection:object|null}}
 */
function selectionOrRefusal(tier, resolverKind, source) {
  if (typeof tier !== 'string' || tier === '') return refusal('resolver-returned-null');
  return {
    status: 'scored',
    reason: null,
    selection: { tier, resolver: resolverKind, source: source ?? null },
  };
}

/**
 * Resolve one baseline for one agentType, without touching scenario state.
 *
 * @param {object|undefined} baseline - entry from baselines.json, or undefined
 * @param {{agentType?: string|null, config?: object}} [context] - `config` is
 *   the loaded artibot.config.json; module resolvers receive it verbatim.
 * @returns {{status:string, reason:string|null, selection:object|null}}
 */
export function resolveBaseline(baseline, context = {}) {
  if (!baseline || typeof baseline !== 'object') return refusal('baseline-unknown');
  if (baseline.status !== 'implemented') return refusal('baseline-unimplemented');

  const resolver = baseline.resolver;
  if (!resolver || typeof resolver !== 'object') return refusal('resolver-unsupported');

  if (resolver.type === 'constant') return selectionOrRefusal(resolver.tier, 'constant', null);
  if (resolver.type !== 'module') return refusal('resolver-unsupported');

  const fn = MODULE_RESOLVERS[`${resolver.module}#${resolver.export}`];
  if (typeof fn !== 'function') return refusal('resolver-unsupported');

  const agentType = typeof context.agentType === 'string' && context.agentType !== ''
    ? context.agentType
    : null;
  if (agentType === null) return refusal('agent-type-missing');

  const picked = fn(agentType, context.config);
  return selectionOrRefusal(picked?.tier, 'module', picked?.source ?? null);
}

/**
 * Why this scenario's fixture cannot be scored, or null when it can.
 *
 * `pending` is refused rather than scored as empty because the scenario schema
 * says so in as many words: an empty fixture would otherwise read as "zero
 * failures", which is the most flattering possible wrong answer.
 *
 * @param {object} scenario
 * @returns {string|null}
 */
function fixtureRefusal(scenario) {
  const fixture = scenario.fixture;
  if (!fixture || typeof fixture !== 'object') return 'fixture-pending';
  if (fixture.status === 'pending') return 'fixture-pending';
  if (typeof fixture.path !== 'string' || fixture.path === '') return 'fixture-missing';
  const abs = path.isAbsolute(fixture.path)
    ? fixture.path
    : path.resolve(PLUGIN_ROOT, fixture.path);
  return existsSync(abs) ? null : 'fixture-missing';
}

/** @returns {string} stable key for a completed (scenario, baseline) pair */
function pairKey(scenarioId, baselineId) {
  return `${scenarioId} ${baselineId}`;
}

/**
 * Build one result row. Key insertion order is fixed so the serialized output
 * is byte-comparable between runs.
 *
 * @param {object} scenario
 * @param {string} baselineId
 * @param {object} outcome - { status, reason, selection }
 * @param {number|null} passes
 * @returns {object}
 */
function makeRow(scenario, baselineId, outcome, passes) {
  return {
    scenario_id: scenario.id,
    baseline: baselineId,
    status: outcome.status,
    reason: outcome.reason ?? null,
    selection: outcome.selection ?? null,
    passes,
    metrics_requested: Array.isArray(scenario.metrics) ? [...scenario.metrics] : [],
    metrics_measured: [],
  };
}

/**
 * Score one (scenario, baseline) pair. Refusal order is fixed and documented:
 * a pair already completed is skipped first, then the baseline must exist and
 * be implemented, then the fixture must be usable, and only then is the
 * resolver asked. Each stage names the FIRST thing that is wrong, so the reason
 * is stable rather than dependent on evaluation order.
 *
 * @param {object} scenario
 * @param {string} baselineId
 * @param {Map<string, object>} byId
 * @param {{n: number, prior: Map<string, object>, config?: object}} opts
 * @returns {object} row
 */
function scorePair(scenario, baselineId, byId, opts) {
  const prior = opts.prior.get(pairKey(scenario.id, baselineId));
  if (prior) {
    const carried = {
      status: 'skipped',
      reason: 'completed-pair',
      selection: prior.selection ?? null,
    };
    return makeRow(scenario, baselineId, carried, prior.passes ?? null);
  }

  const baseline = byId.get(baselineId);
  if (!baseline) return makeRow(scenario, baselineId, refusal('baseline-unknown'), null);
  if (baseline.status !== 'implemented') {
    return makeRow(scenario, baselineId, refusal('baseline-unimplemented'), null);
  }

  const blocked = fixtureRefusal(scenario);
  if (blocked !== null) return makeRow(scenario, baselineId, refusal(blocked), null);

  const context = { agentType: scenario.agentType ?? null, config: opts.config };
  const first = resolveBaseline(baseline, context);
  if (first.status !== 'scored') return makeRow(scenario, baselineId, first, null);

  // Self-check passes. Scoring is pure, so a differing pass means a resolver
  // reached hidden state and every number this run produced is suspect.
  for (let pass = 2; pass <= opts.n; pass += 1) {
    const again = resolveBaseline(baseline, context);
    if (JSON.stringify(again) !== JSON.stringify(first)) {
      throw new Error(
        `determinism_violation: ${scenario.id}/${baselineId} pass ${pass} `
        + `returned ${JSON.stringify(again.selection)} after `
        + `${JSON.stringify(first.selection)} on pass 1`,
      );
    }
  }

  return makeRow(scenario, baselineId, first, opts.n);
}

/**
 * Score every (scenario, baseline) pair. Pure: same inputs, same rows.
 *
 * @param {object[]} scenarios
 * @param {object} baselines - parsed baselines.json
 * @param {{n?: number, prior?: Map<string, object>, config?: object}} [opts] -
 *   `config` is the loaded artibot.config.json. It is an ARGUMENT, never read
 *   from a module-level cache inside scoring, so two calls with the same
 *   arguments still produce the same rows.
 * @returns {object[]} rows sorted by (scenario_id, baseline)
 */
export function scoreScenarios(scenarios, baselines, opts = {}) {
  const n = Number.isInteger(opts.n) && opts.n >= 1 ? opts.n : 1;
  const prior = opts.prior instanceof Map ? opts.prior : new Map();
  const config = opts.config;
  const list = Array.isArray(baselines?.baselines) ? baselines.baselines : [];
  const byId = new Map(list.map((entry) => [entry.id, entry]));

  const rows = [];
  for (const scenario of scenarios) {
    const ids = Array.isArray(scenario.baselines) ? scenario.baselines : [];
    for (const baselineId of ids) {
      rows.push(scorePair(scenario, baselineId, byId, { n, prior, config }));
    }
  }

  // Plain byte comparison, NOT localeCompare: `localeCompare` is locale- and
  // ICU-build-dependent, so the same rows can sort differently on two machines
  // and break the byte-for-byte comparison this file's determinism rests on.
  rows.sort((a, b) => compareStrings(a.scenario_id, b.scenario_id)
    || compareStrings(a.baseline, b.baseline));
  return rows;
}

/**
 * Byte-order string comparison. @param {string} a @param {string} b
 * @returns {number} -1, 0 or 1
 */
function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Parse a JSONL scenarios file. A malformed line aborts with its line number -
 * skipping it would silently shrink the benchmark.
 *
 * @param {string} file
 * @returns {object[]}
 */
function readScenarios(file) {
  const text = readFileSync(file, 'utf-8');
  const lines = text.split(/\r?\n/);
  const scenarios = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      scenarios.push(JSON.parse(line));
    } catch (err) {
      throw new Error(
        `invalid JSON on line ${index + 1} of ${path.basename(file)}: ${err.message}`,
        { cause: err },
      );
    }
  }
  return scenarios;
}

/**
 * Is this prior row a COMPLETED pair - one that must not be rescored?
 *
 * Two statuses qualify, and the second one is the bug fix. Run 2 rewrites every
 * row run 1 scored as `skipped`/`completed-pair`, carrying the selection
 * forward. Indexing `scored` alone therefore made the skip survive exactly one
 * run: run 3 read a file full of `skipped` rows, found nothing completed, and
 * rescored everything. `refused` never qualifies - a refusal is an outcome that
 * a fixture landing or a baseline implementation is meant to change, so it must
 * be retried on the next run.
 *
 * @param {object} row
 * @returns {boolean}
 */
function isCompletedRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.status === 'scored') return true;
  return row.status === 'skipped'
    && row.reason === 'completed-pair'
    && row.selection !== null
    && row.selection !== undefined;
}

/**
 * Index the completed rows of a previous results file for completed-pair skip.
 * A missing or unreadable file means "nothing completed", never an abort: the
 * first run of any scenarios file has no prior output by definition.
 *
 * A prior file whose `baselines_sha256` is not byte-identical to the baselines
 * this run loaded is discarded WHOLE. Carrying rows across a baselines edit
 * would let a run report a tier that the current B2 definition never produced,
 * and the skip is silent by design, so nothing downstream would show it. A file
 * written before the field existed has no sha and is discarded for the same
 * reason: unprovable is not the same as matching.
 *
 * @param {string} file
 * @param {string} baselinesSha - sha256 of the baselines file this run read
 * @returns {Map<string, object>}
 */
function readPriorRows(file, baselinesSha) {
  const prior = new Map();
  if (!existsSync(file)) return prior;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return prior;
  }
  if ((parsed?.baselines_sha256 ?? null) !== baselinesSha) return prior;
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  for (const row of rows) {
    if (isCompletedRow(row)) prior.set(pairKey(row.scenario_id, row.baseline), row);
  }
  return prior;
}

/**
 * Path as recorded in the envelope: plugin-relative with forward slashes when
 * the file lives inside the plugin, and an explicit `<external>` marker when it
 * does not. A bare absolute path is never written - results files are read by
 * people on other machines, and a `C:` prefix is noise at best.
 *
 * @param {string} abs
 * @returns {string}
 */
function recordedPath(abs) {
  const rel = path.relative(PLUGIN_ROOT, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return `<external>/${path.basename(abs)}`;
  }
  return rel.split(path.sep).join('/');
}

/**
 * The fable gate exactly as this run saw it.
 *
 * Recorded because B2 IS that gate: the same agent resolves to `fable` with the
 * gate on and `opus` with it off, so two results files that do not each say
 * which policy answered are not comparable with one another at all. Two numbers
 * only - the kill-switch and the allowlist SIZE. The allowlist itself is not
 * copied: a results file that restated the policy would be one more thing to
 * drift, and `artibot.config.json` remains the single source.
 *
 * @param {object|undefined} config - the loaded config
 * @returns {{fable_enabled: boolean, allowlist_size: number}}
 */
function policySource(config) {
  const fable = config?.agents?.modelPolicy?.fable;
  return {
    fable_enabled: fable?.enabled === true,
    allowlist_size: Array.isArray(fable?.allowlist) ? fable.allowlist.length : 0,
  };
}

/** @returns {{scored:number, refused:number, skipped:number}} counts only */
function summarize(rows) {
  const summary = { scored: 0, refused: 0, skipped: 0 };
  for (const row of rows) {
    if (row.status === 'scored') summary.scored += 1;
    else if (row.status === 'refused') summary.refused += 1;
    else if (row.status === 'skipped') summary.skipped += 1;
  }
  return summary;
}

/**
 * Run the benchmark and write the results envelope.
 *
 * @param {object} opts - { scenarios, baselines?, out?, n?, noSkip? }
 * @returns {Promise<object>} the envelope that was written
 */
export async function runRouteBench(opts) {
  if (!opts || typeof opts.scenarios !== 'string' || opts.scenarios === '') {
    throw new Error('--scenarios <file.jsonl> is required');
  }
  const scenariosPath = path.resolve(opts.scenarios);
  const baselinesPath = path.resolve(opts.baselines ?? DEFAULT_BASELINES);
  const outDir = path.resolve(opts.out ?? DEFAULT_OUT);
  const n = Number.isInteger(opts.n) && opts.n >= 1 ? opts.n : 1;

  const scenarios = readScenarios(scenariosPath);
  const baselinesBytes = readFileSync(baselinesPath);
  const baselines = JSON.parse(baselinesBytes.toString('utf-8'));
  const baselinesSha = createHash('sha256').update(baselinesBytes).digest('hex');

  // Hydrate the config cache and pass the result down explicitly, the way
  // scripts/ci/validate-model-policy.js#main does. Without this, B2 scores an
  // empty policy - see the MODULE_RESOLVERS header.
  const config = await loadConfig();

  const stem = path.basename(scenariosPath, path.extname(scenariosPath));
  const outFile = path.join(outDir, `${stem}.results.json`);
  const prior = opts.noSkip === true ? new Map() : readPriorRows(outFile, baselinesSha);

  const rows = scoreScenarios(scenarios, baselines, { n, prior, config });
  const report = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    scenarios_file: recordedPath(scenariosPath),
    baselines_file: recordedPath(baselinesPath),
    baselines_schema_version: baselines.schema_version ?? null,
    baselines_sha256: baselinesSha,
    policy_source: policySource(config),
    metrics_note: METRICS_NOTE,
    rows,
    summary: summarize(rows),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return report;
}

/**
 * Parse CLI arguments. An unrecognized argument aborts rather than being
 * ignored, so a typo cannot quietly run the default benchmark instead.
 *
 * @param {string[]} argv - arguments after the script path
 * @returns {object}
 */
export function parseArgs(argv) {
  const opts = {
    scenarios: null,
    baselines: DEFAULT_BASELINES,
    out: DEFAULT_OUT,
    n: 1,
    noSkip: false,
    help: false,
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--scenarios') { opts.scenarios = next; index += 2; continue; }
    if (arg === '--baselines') { opts.baselines = next; index += 2; continue; }
    if (arg === '--out') { opts.out = next; index += 2; continue; }
    if (arg === '--n') { opts.n = Number(next); index += 2; continue; }
    if (arg === '--no-skip') { opts.noSkip = true; index += 1; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; index += 1; continue; }
    throw new Error(`unrecognized argument "${arg}" (try --help)`);
  }
  if (opts.help) return opts;
  if (typeof opts.scenarios !== 'string' || opts.scenarios === '') {
    throw new Error('--scenarios <file.jsonl> is required');
  }
  if (!Number.isInteger(opts.n) || opts.n < 1) {
    throw new Error('--n must be a positive integer');
  }
  return opts;
}

/** Print usage. @returns {void} */
function printUsage() {
  console.log([
    'Usage: node scripts/bench/routebench.mjs --scenarios <file.jsonl> [options]',
    '',
    'Records which model tier each baseline would pick for each scenario.',
    'Offline: no model is called and no metric is measured.',
    '',
    'Options:',
    '  --scenarios <f>    REQUIRED. JSONL of RouteBench scenarios.',
    '  --baselines <f>    baselines.json (default: the shipped fixture).',
    '  --out <dir>        output directory (default: _benchmarks/routing, gitignored).',
    '  --n <k>            number of scoring passes per (scenario, baseline) pair,',
    '                     default 1. Scoring is offline and deterministic, so extra',
    '                     passes are a SELF-CHECK, not a sample: pass k must return',
    '                     the same selection as pass 1 or the run aborts with',
    '                     determinism_violation. It does not average anything.',
    '  --no-skip          rescore pairs a previous results file already completed.',
    '                     Completed means scored, or skipped as completed-pair with a',
    '                     selection; a refusal is never completed. A prior file whose',
    '                     baselines_sha256 differs from the current baselines file is',
    '                     ignored whole, with or without this flag.',
    '  --help             this text.',
    '',
    'Exit codes: 0 the run completed (refusals are normal outcomes and do not',
    'fail the run), 1 unreadable input, invalid JSONL, unknown argument, or a',
    'determinism violation.',
  ].join('\n'));
}

/** Entry point. @returns {Promise<number>} process exit code */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }
  const report = await runRouteBench(opts);
  const { scored, refused, skipped } = report.summary;
  console.log(
    `[routebench] ${report.rows.length} pairs: ${scored} scored, `
    + `${refused} refused, ${skipped} skipped -> `
    + `${recordedPath(path.resolve(opts.out ?? DEFAULT_OUT))}/`
    + `${path.basename(path.resolve(opts.scenarios), path.extname(opts.scenarios))}.results.json`,
  );
  return 0;
}

if (isMainEntry(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`[routebench] ${err.message}`);
      process.exitCode = 1;
    });
}
