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
 *   2. The shipped fixture is 6 scenarios: 2 still `fixture.status: "pending"`
 *      and refuse every pair, 4 with scrubbed live corpora under
 *      `tests/evals/fixtures/routebench/corpus/`. The runner OPENS those, but
 *      only to check the file is non-empty, every line is a JSON object, and no
 *      row carries a raw identifier (`FORBIDDEN_CORPUS_KEYS`, or a hex run
 *      longer than the 8-char hashes the scrub keeps). It measures NOTHING from
 *      them: `metrics_measured` stays empty for every pair, and a scored row
 *      means "this baseline picked this tier for this agentType", never "this
 *      baseline was replayed against these rows".
 *   3. Row `replay_mode` is the scenario's DECLARATION, never a measurement; the
 *      envelope's `replay_label.measured` is null by construction, because the
 *      scrub gate refuses the join keys labelReplay needs (routebench-replay-mode.mjs).
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
 * `b4_input` records the other half of that: which fields B4 handed the
 * classifier, `{ agentType: true }` since owner decision 3 (2026-09-14).
 * A results file written BEFORE that decision is not comparable with one
 * written after it - B4 then classified every row as `default`/`implement`
 * rather than from the agent's own class, and `baselines_sha256` differs too
 * because the B4 `call` string in the baselines registry changed with it.
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
import { replayLabelBlock, replayModeOf } from './routebench-replay-mode.mjs';
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
 * Which fields B4 hands `routeModel` as CLASSIFIER input, recorded in every
 * envelope. A flag map rather than a list because the question a reader has is
 * "was agentType supplied?", and a boolean answers it without the reader
 * having to know how the array is ordered. Frozen and serialized as-is, so the
 * field changes only when this constant does - see the B4 resolver comment.
 */
const B4_INPUT_FIELDS = Object.freeze({ agentType: true });

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
  // would make B4 a duplicate of B2 and hide every divergence.
  //
  // `config` reaches BOTH halves of that receipt, not just policy:
  // `pickRoute` -> `resolveCandidateTiers(src)` -> `policyAllowedTiers(
  // src.agentType, ..., src.config)` makes the CANDIDATE CEILING itself
  // config-dependent. Measured 2026-09-13: the ceiling for `planner` is
  // ['opus'] with no config and ['opus', 'fable'] with the loaded one.
  //
  // The agent name is supplied TWICE, on purpose, because the router reads it
  // in two unrelated places. `agentType` at the top level reaches
  // `models.recommended` only through `policyAllowedTiers` (the ceiling
  // above); it also answers `models.selected` directly, via
  // `resolveModel(src.agentType, ...)` (adaptive-model-router.js, in
  // `routeModel`, measured 2026-09-14) - but that half is B2 and is not what
  // B4 records. The CLASS comes from
  // `src.input`: `resolveClassification` spreads `src.input` into
  // `classifyAction`, which maps `input.agentType` through AGENT_ACTION_CLASS.
  // Passing the top-level field alone leaves `src.input` empty and every row
  // classifies as `default` -> `implement`, which is a class no live caller
  // produces: `scripts/hooks/route-observe-pre.js` passes `input: {agentType}`.
  // Owner decision 3, 2026-09-14: B4 supplies it, and `lib/` is not touched.
  //
  // THE CEILING STILL BEATS THE CLASS. Measured in this worktree 2026-09-14:
  // `security-reviewer` classifies as `review` (source `agent`) exactly like
  // `code-reviewer`, yet recommends opus where code-reviewer recommends fable,
  // because FABLE_DENYLIST keeps fable out of its candidate set. A B4 row is
  // therefore "top-ranked tier for this agent's own action class, within the
  // ceiling the loaded policy allows it" - never the class's pick on its own.
  // That is B3, and the two differing is the divergence B4 exists to show.
  'lib/routing/adaptive-model-router.js#routeModel': (agentType, config) => {
    const receipt = routeModel({ agentType, config, input: { agentType } });
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
 * It is still recorded now that B4 supplies `input: {agentType}`, because the
 * supply does not guarantee a match: `classifyAction` maps only the agents in
 * AGENT_ACTION_CLASS, and anything outside that table falls back to source
 * `default` / class `implement`. A fallback row and a genuine agent-table hit
 * are the same tier whenever both land on opus, so without this field the two
 * are indistinguishable - which is exactly the confusion that made every row
 * look scored before the supply landed.
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
 * Keys that must never appear in a scrubbed corpus row, at any depth. Each is a
 * raw runtime identifier: it names one execution, so it leaks operational
 * detail and lets two corpora be joined back together. The extractor that
 * WRITES the corpora exports the same list under the same name, kept
 * byte-identical by convention - a key added there is added here in the same
 * edit. Duplicated rather than imported on purpose: the gate must be able to
 * refuse a corpus written by an extractor version this runner never saw.
 *
 * @type {readonly string[]}
 */
export const FORBIDDEN_CORPUS_KEYS = Object.freeze([
  'session_id', 'mission_id', 'pid', 'seq', 'idempotency_key',
  'tool_use_id', 'routing_epoch_id', 'route_receipt_id', 'action_id',
]);

/**
 * A hex run longer than the 8 characters the scrub's truncated hashes use, so 9
 * is the first length that cannot have come from the scrub: a raw id (uuid
 * segment, sha, trace id) that leaked past it.
 */
const RAW_HEX_RUN = /[0-9a-f]{9,}/;

/**
 * Every scrub violation reachable from one parsed value, recursively.
 * @param {unknown} node @param {string[]} acc - appended in place
 * @returns {string[]} acc
 */
function scanNode(node, acc) {
  if (typeof node === 'string') {
    if (RAW_HEX_RUN.test(node)) acc.push('raw-hex-run');
  } else if (Array.isArray(node)) {
    for (const item of node) scanNode(item, acc);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_CORPUS_KEYS.includes(key)) acc.push(`forbidden-key:${key}`);
      scanNode(value, acc);
    }
  }
  return acc;
}

/**
 * Why this corpus text is not a usable scrubbed corpus. Empty array means it is.
 * Pure and exported so the predicate is testable without a file on disk. It
 * reads the rows and MEASURES NOTHING from them - nothing it returns reaches a
 * result row. A malformed line refuses the whole scenario rather than being
 * skipped, matching `readScenarios` on bad JSONL; a refusal row rather than an
 * abort, so one bad corpus cannot stop the other scenarios.
 *
 * @param {string} text - the corpus file's contents
 * @returns {string[]} violation codes, prefixed with their 1-based line number
 */
export function corpusViolations(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const violations = [];
  let rows = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    rows += 1;
    let parsed;
    try { parsed = JSON.parse(line); } catch { parsed = undefined; }
    if (parsed === undefined) { violations.push(`line ${index + 1}: not-json`); continue; }
    const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    if (!isObject) { violations.push(`line ${index + 1}: not-an-object`); continue; }
    for (const code of scanNode(parsed, [])) violations.push(`line ${index + 1}: ${code}`);
  }
  if (rows === 0) violations.push('corpus-empty');
  return violations;
}

/**
 * Why this scenario's fixture cannot be scored, or null when it can.
 *
 * `pending` is refused rather than scored as empty because the scenario schema
 * says so in as many words: an empty fixture would otherwise read as "zero
 * failures", the most flattering possible wrong answer. `present` used to be
 * checked with `existsSync` alone, which made a zero-byte file a green run -
 * the same wrong answer with a file next to it. Owner decision E3 (2026-09-14):
 * a present corpus is OPENED and must be non-empty and scrubbed, or the
 * scenario refuses as `fixture-invalid`. Reading it measures nothing;
 * `metrics_measured` stays `[]` for every row this function admits.
 *
 * @param {object} scenario
 * @returns {string|null} 'fixture-pending', 'fixture-missing',
 *   'fixture-invalid', or null when the fixture is usable
 */
function fixtureRefusal(scenario) {
  const fixture = scenario.fixture;
  if (!fixture || typeof fixture !== 'object') return 'fixture-pending';
  if (fixture.status === 'pending') return 'fixture-pending';
  if (typeof fixture.path !== 'string' || fixture.path === '') return 'fixture-missing';
  const abs = path.isAbsolute(fixture.path)
    ? fixture.path
    : path.resolve(PLUGIN_ROOT, fixture.path);
  if (!existsSync(abs)) return 'fixture-missing';
  return corpusViolations(readFileSync(abs, 'utf-8')).length > 0 ? 'fixture-invalid' : null;
}

/**
 * Stable key for a completed (scenario, baseline) pair. The separator is NUL
 * because it cannot occur in either id, so no pair of ids can collide - but it
 * is written as the ESCAPE `\0`, never as a raw 0x00 byte in the source. A raw
 * byte here made `file` report this script as binary data and slipped past the
 * ASCII-only test, which treats 0x00 as in-range. The runtime string is
 * identical either way, and this key never leaves memory: it is a Map key only
 * (used at the two call sites below), and nothing serializes it.
 *
 * @param {string} scenarioId
 * @param {string} baselineId
 * @returns {string}
 */
function pairKey(scenarioId, baselineId) {
  return `${scenarioId}\0${baselineId}`;
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
    replay_mode: replayModeOf(scenario),
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
    b4_input: B4_INPUT_FIELDS,
    metrics_note: METRICS_NOTE,
    replay_label: replayLabelBlock(scenarios),
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
