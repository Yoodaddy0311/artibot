/**
 * Topology router — Observe stage (record only, route nothing).
 *
 * Maps an ALREADY-COMPUTED `buildWorkflowPlan` result plus the live intent onto
 * one of the six run-ledger `topology.mode` values and attaches a `ParallelGain`
 * breakdown. It is mostly a SIGHTING function over signals produced elsewhere
 * (`lib/cognitive/workflow-plan.js`, `lib/autopilot/fast-profile.js`): no new
 * complexity score, no second team/effort evaluator, no rival opinion about
 * how big a job is.
 *
 * ONE EXCEPTION, and it is load-bearing rather than incidental: the
 * natural-language activation allowlist below IS a classifier of its own, and
 * `decideMode` consults it FIRST, ahead of every derived signal. It holds 9
 * patterns — 7 natural-language rows covering the six example sentences of v5
 * §07 (the first `split` sentence is carried by two rows, a literal one and a
 * more general one), plus 2 literal-invocation rows (`--fast`, `/split`). §07
 * mandates that lexicon, so "not a classifier" would be false; what the router
 * genuinely does not do is re-decide complexity, team size or effort. The
 * overlap between these phrases and `lib/intent/interpreter.js`'s performance
 * lexicon is pinned by a drift gate in the test file, including the one design
 * sentence where the two modules currently DISAGREE.
 *
 * Design: v5 §07 `07_TOPOLOGY_AUTOPILOT_SPLIT.md:8` (the ParallelGain formula)
 * and `:69-77` (the natural-language activation phrases); lane-5 analysis §3-A.
 * Mode enum: `.artibot/guides/v5-design/package/schemas/run-ledger.schema.yaml:17`.
 *
 * Layer: L4, beside `lib/cognitive` (`eslint.config.js:238`). Its only lib edge
 * is a DOWNWARD one into L2 `lib/autopilot/fast-profile.js`.
 *
 * PURE. No fs, no clock, no randomness, no I/O. Every measurement the router
 * cannot take from its arguments is reported as `0` with `measured:false`
 * rather than estimated — an unmeasured term must never look like a measured
 * zero.
 *
 * BEHAVIOR CHANGE = 0. Nothing in this module selects a topology. It reads
 * `config.topology.*` (resolving the `*Ref` dot-paths) purely so the values are
 * auditable in `reason[]`, and it NEVER lets `config.topology.default` override
 * the derived mode — a divergence is recorded as `config-default-ignored:<v>`.
 *
 * @module lib/topology/topology-router
 */

import { areAffectedPathsConflicting } from '../autopilot/fast-profile.js';

/**
 * The run-ledger `topology.mode` enum, in escalation order.
 * @type {readonly string[]}
 */
export const TOPOLOGY_MODES = Object.freeze([
  'solo', 'subagent', 'team', 'autopilot', 'autopilot_fast', 'split',
]);

/**
 * ParallelGain weights used when `config.topology.parallelGain.weights` is
 * absent. As of 2026-09-02 that config key DOES NOT EXIST (T-11 shipped
 * `topology.{default,autopilot_fast,split,reviewTierRef}` only), so these
 * defaults are what every caller gets today.
 *
 * THEY ARE UNCALIBRATED. No run of this repository has been measured against
 * them. They exist so the six terms combine into one comparable number, not
 * because any of them is known to be right. Do not read `net` as a prediction.
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_GAIN_WEIGHTS = Object.freeze({
  work: 1,
  coordination: 0.5,
  contextDup: 0.5,
  mergeRisk: 0.75,
  startup: 0.25,
  tokenDup: 0.5,
});

/**
 * Worker-startup reference window in ms. A median spawn duration at or above
 * this saturates the `startup` term. Uncalibrated, same caveat as the weights.
 */
export const DEFAULT_STARTUP_REFERENCE_MS = 60000;

/** Sub-objective count at which the coordination term saturates. */
const COORDINATION_SATURATION = 5;

/**
 * Natural-language activation patterns, ALLOWLIST-SHAPED (a deny list would
 * fail open on every phrase nobody thought of).
 *
 * The 7 `nl-*` rows transcribe v5 §07 `07_TOPOLOGY_AUTOPILOT_SPLIT.md:69-77`
 * in intent, covering all six example sentences with no orphan row. The 2
 * `flag-*` rows are an ADDITION beyond that list: §07 documents only the NL
 * surface, but a prompt that literally says `--fast` or `/split` is the same
 * request stated non-ambiguously, and a router that missed the explicit
 * invocation while catching the paraphrase would be indefensible. They are
 * kept as separate ids so the addition stays visible in `reason[]`.
 *
 * DRIFT RISK, measured rather than assumed: `lib/intent/interpreter.js`
 * (L2) carries its own performance lexicon over the SAME §07 sentences, and
 * `PERFORMANCE_CUES.maximum_performance` contains the literal string
 * `'토큰 아끼지 말고'` that `nl-fast-spend-tokens` also matches. Two modules
 * reading one design table will drift apart silently. The test file imports
 * that module and pins the current agreement AND the current disagreement, so
 * either side moving turns a gate red instead of quietly diverging. This module
 * deliberately does NOT import the interpreter: it needs none of it at runtime,
 * and an unused import would be dead weight on a purity claim.
 * @type {readonly {id: string, re: RegExp}[]}
 */
const FAST_PATTERNS = Object.freeze([
  { id: 'flag-fast', re: /--fast\b/i },
  { id: 'nl-fast-asap', re: /최대한\s*빨리/ },
  { id: 'nl-fast-spend-tokens', re: /토큰\s*아끼지\s*말/ },
  { id: 'nl-fast-time-matters', re: /시간이\s*중요/ },
]);

/** @type {readonly {id: string, re: RegExp}[]} */
const SPLIT_PATTERNS = Object.freeze([
  { id: 'flag-split', re: /(^|\s)\/split\b/ },
  { id: 'nl-split-many-tasks', re: /여러\s*작업으로\s*나눠/ },
  { id: 'nl-split-per-file', re: /파일별로\s*병렬/ },
  { id: 'nl-split-large-change', re: /대규모\s*변경[\s\S]*병렬/ },
  { id: 'nl-split-divide-concurrent', re: /나눠서?\s*동시에/ },
]);

/** `topology.autopilot_fast` / `topology.split` ref keys, read-only. */
const POLICY_REFS = Object.freeze({
  autopilot_fast: Object.freeze(['hardMaxAgentsRef', 'agentsPerCpuRef', 'maxWorktreesRef', 'maxRiskRef']),
  split: Object.freeze(['maxWindowsRef', 'minStemsRef', 'dispatchBudgetRef']),
});

/**
 * Confidence contributed by the signal that decided the mode. Uncalibrated
 * ordinal: an explicit user statement outranks a derived hint, which outranks
 * an inference. Not a probability.
 */
const SIGNAL_CONFIDENCE = Object.freeze({
  'nl-explicit': 1,
  recommendation: 0.7,
  runner: 0.6,
  'config-default': 0.5,
  inference: 0.4,
});

/** Round to 4 decimals so results are stable and diffable. */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** Round to 2 decimals (confidence only). */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Resolve a dot-path against an object. Returns undefined for any missing or
 * non-object hop — a dangling `*Ref` reports as absent, never as a throw
 * (`tests/firewall/v5-config-firewall.test.js` is what fails on a dangling
 * path; the runtime must stay quiet).
 * @param {unknown} root
 * @param {unknown} dotPath
 * @returns {unknown}
 */
function resolveRef(root, dotPath) {
  if (typeof dotPath !== 'string' || dotPath.length === 0) return undefined;
  let cursor = root;
  for (const segment of dotPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * The prompt text the NL patterns run against.
 *
 * NOTE: `detectIntent` (`lib/intent/index.js:24`) does NOT put the raw prompt on
 * its result — it returns `{intents, matches, recommendations, best, ambiguity}`
 * only. So `intent.text` is a field a CALLER must attach; `evidence.promptText`
 * is the seam the hook path (T-37, `scripts/hooks/runtime-prompt.js`) is
 * expected to fill. With neither present, NL activation is simply off and
 * `reason[]` records `nl:unavailable` so an absent match is never mistaken for
 * a checked non-match.
 * @param {object} intent
 * @param {object} evidence
 * @returns {string|null}
 */
function promptTextOf(intent, evidence) {
  const fromEvidence = evidence?.promptText;
  if (typeof fromEvidence === 'string' && fromEvidence.trim()) return fromEvidence;
  const fromIntent = intent?.text;
  if (typeof fromIntent === 'string' && fromIntent.trim()) return fromIntent;
  return null;
}

/**
 * First matching pattern id, or null.
 * @param {string|null} text
 * @param {readonly {id: string, re: RegExp}[]} patterns
 * @returns {string|null}
 */
function firstMatch(text, patterns) {
  if (typeof text !== 'string') return null;
  for (const pattern of patterns) {
    if (pattern.re.test(text)) return pattern.id;
  }
  return null;
}

/**
 * Sub-objectives, taken from the SAME source `buildWorkflowPlan` uses.
 *
 * On a `team` plan the teammates array already carries them. On an `inline`
 * plan `teammates` is empty by construction (`workflow-plan.js:311`), so the
 * only remaining source is `intent.recommendations[]` — which is exactly what
 * that module's own `extractSubObjectives` (`workflow-plan.js:71-77`) reads.
 * Mirroring it here is reuse of one input, not a second classifier.
 * @param {object} intent
 * @param {object} workflowPlan
 * @returns {{agent: string, command: string}[]}
 */
function extractSubs(intent, workflowPlan) {
  const teammates = Array.isArray(workflowPlan?.teammates) ? workflowPlan.teammates : [];
  if (teammates.length > 0) {
    return teammates.map((mate) => ({
      agent: typeof mate?.agent === 'string' ? mate.agent : '',
      command: typeof mate?.command === 'string' ? mate.command : '',
    }));
  }
  const recs = Array.isArray(intent?.recommendations) ? intent.recommendations : [];
  return recs.map((rec) => ({
    agent: (Array.isArray(rec?.agents) && typeof rec.agents[0] === 'string' ? rec.agents[0] : ''),
    command: (Array.isArray(rec?.commands) && typeof rec.commands[0] === 'string' ? rec.commands[0] : ''),
  }));
}

/** Distinct non-empty agent values — the domain-count proxy. */
function domainCount(subs) {
  return new Set(subs.map((sub) => sub.agent).filter(Boolean)).size;
}

/**
 * Merge-conflict risk: the fraction of task pairs whose affected paths overlap.
 *
 * CITATION CORRECTION: the spec named `fast-profile.js#buildConflictGroups`, but
 * that function is NOT exported (`lib/autopilot/fast-profile.js:258` — module
 * private; the file's exports are `FAST_PROFILE_DEFAULTS`,
 * `normalizeFastProfile`, `areAffectedPathsConflicting`, `buildFastFanoutPlan`).
 * This uses `areAffectedPathsConflicting` instead, which is the exported
 * predicate `buildConflictGroups` is itself built on via `tasksConflict`
 * (`fast-profile.js:253-254`) — same rule, public seam. The alternative,
 * `buildFastFanoutPlan`, would have gated the answer behind `fast:true` and an
 * eligibility filter that can silently return an empty `conflictGroups`, which
 * is a measured-looking zero. That is the failure mode this term must not have.
 *
 * `serverEntry` co-location (the other half of `tasksConflict`) is NOT modeled:
 * it needs `serverEntryPaths`, which no caller supplies here. Its absence means
 * this term can only UNDER-report, never over-report.
 *
 * @param {unknown} tasks - `evidence.tasks`: [{ affectedPaths: string[] }]
 * @returns {{ value: number, measured: boolean, pairs: number, conflicting: number }}
 */
function computeMergeRisk(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const withPaths = list.filter((task) => Array.isArray(task?.affectedPaths) && task.affectedPaths.length > 0);
  if (withPaths.length < 2) return { value: 0, measured: false, pairs: 0, conflicting: 0 };
  let pairs = 0;
  let conflicting = 0;
  for (let left = 0; left < withPaths.length; left += 1) {
    for (let right = left + 1; right < withPaths.length; right += 1) {
      pairs += 1;
      if (areAffectedPathsConflicting(withPaths[left].affectedPaths, withPaths[right].affectedPaths)) {
        conflicting += 1;
      }
    }
  }
  return { value: pairs === 0 ? 0 : conflicting / pairs, measured: true, pairs, conflicting };
}

/**
 * Worker startup cost from observed spawn durations.
 *
 * The port is `evidence.spawnDurationsMs` — a caller-supplied array of finite
 * `durationMs` values from `.artibot/ledger/spawns.ndjson`
 * (`lib/learning/ledger/spawn-ledger.js:109-110`). The router does not read the
 * ledger itself; that would make it impure. With no durations the term is
 * `0 / measured:false`, NOT an estimate.
 * @param {unknown} durations
 * @param {number} referenceMs
 * @param {number} workerCount
 * @returns {{ value: number, measured: boolean, medianMs: number|null, samples: number }}
 */
function computeStartup(durations, referenceMs, workerCount) {
  const values = (Array.isArray(durations) ? durations : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return { value: 0, measured: false, medianMs: null, samples: 0 };
  const mid = Math.floor(values.length / 2);
  const medianMs = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  // Startup is only paid when workers are actually spawned. A solo run pays
  // none of it, however long past spawns took.
  const scale = workerCount >= 2 ? Math.min(1, medianMs / referenceMs) : 0;
  return { value: scale, measured: true, medianMs, samples: values.length };
}

/**
 * Read and validate the gain weights. Per-key: a finite number >= 0 is taken,
 * anything else falls back to the default for THAT key (a malformed key must
 * not silently zero the whole vector).
 * @param {object} config
 * @returns {Record<string, number>}
 */
function resolveWeights(config) {
  const declared = config?.topology?.parallelGain?.weights;
  const source = declared && typeof declared === 'object' ? declared : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_GAIN_WEIGHTS)) {
    const candidate = Number(source[key]);
    out[key] = Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback;
  }
  return out;
}

/**
 * Compute the six ParallelGain terms and their net.
 *
 * `measured` semantics — READ THIS BEFORE TRUSTING A NUMBER: `measured:true`
 * means the term was derived from an input that was actually OBSERVED (a
 * counted sub-objective set, real affected-path lists, real spawn durations).
 * It does NOT mean the term is calibrated: the weights are uncalibrated
 * defaults (see `DEFAULT_GAIN_WEIGHTS`). `measured:false` means the input for
 * that term does not exist in this repository today, so the term is pinned to
 * exactly 0 and contributes nothing to `net`.
 *
 * `contextDup` and `tokenDup` are permanently `measured:false` at this stage:
 * duplicated exploration cannot be measured until `tool-tracker.js#buildContext`
 * keeps file paths, and token duplication needs the usage-receipt work that has
 * not started (lane-5 §3-D).
 *
 * @param {{agent: string, command: string}[]} subs
 * @param {object} config
 * @param {object} evidence
 * @returns {object} frozen parallelGain
 */
function computeParallelGain(subs, config, evidence) {
  const weights = resolveWeights(config);
  const referenceRaw = Number(config?.topology?.parallelGain?.startupReferenceMs);
  const referenceMs = Number.isFinite(referenceRaw) && referenceRaw > 0
    ? referenceRaw
    : DEFAULT_STARTUP_REFERENCE_MS;

  const n = subs.length;
  // Parallelizable fraction: with n independent sub-objectives at equal cost,
  // (n-1)/n of the work can overlap. n<=1 parallelizes nothing.
  const work = n <= 1 ? 0 : weights.work * ((n - 1) / n);
  // Coordination grows with worker count and saturates; the exact shape is a
  // declared assumption, not a measurement of this repository.
  const coordination = n <= 1
    ? 0
    : weights.coordination * Math.min(1, (n - 1) / COORDINATION_SATURATION);

  const merge = computeMergeRisk(evidence?.tasks);
  const start = computeStartup(evidence?.spawnDurationsMs, referenceMs, n);

  const mergeRisk = merge.measured ? weights.mergeRisk * merge.value : 0;
  const startup = start.measured ? weights.startup * start.value : 0;
  const contextDup = 0;
  const tokenDup = 0;

  const net = work - coordination - contextDup - mergeRisk - startup - tokenDup;

  return Object.freeze({
    work: round4(work),
    coordination: round4(coordination),
    contextDup,
    mergeRisk: round4(mergeRisk),
    startup: round4(startup),
    tokenDup,
    net: round4(net),
    measured: Object.freeze({
      work: n >= 1,
      coordination: n >= 1,
      contextDup: false,
      mergeRisk: merge.measured,
      startup: start.measured,
      tokenDup: false,
    }),
  });
}

/**
 * Classify human-gate hits. CLASSIFICATION ONLY — this router sees no tool
 * calls, so it cannot enforce anything. Enforcement is a PreToolUse hook
 * (lane-5 §3-C); the T-38 matrix `lib/security/human-gates.js#HUMAN_GATE_MATRIX`
 * is a sibling task landing in parallel, so it is injected through
 * `evidence.humanGateMatrix` rather than imported (importing a module that may
 * not exist yet would make this file unloadable).
 *
 * Both the matrix and the actions must be supplied. When either is missing the
 * result is `[]` AND the caller is told via a `human-gates:unavailable` reason,
 * because an empty array from "not checked" and an empty array from "checked,
 * zero hits" are different facts.
 *
 * @param {object} evidence
 * @returns {{ hits: string[], available: boolean }}
 */
function classifyHumanGates(evidence) {
  const matrix = Array.isArray(evidence?.humanGateMatrix) ? evidence.humanGateMatrix : null;
  const actions = Array.isArray(evidence?.plannedActions) ? evidence.plannedActions : null;
  if (matrix === null || actions === null) return { hits: [], available: false };

  const texts = actions.filter((action) => typeof action === 'string' && action.length > 0);
  const hits = [];
  for (const row of matrix) {
    const id = typeof row?.id === 'string' ? row.id : null;
    if (id === null) continue;
    const patterns = Array.isArray(row?.patterns) ? row.patterns : [];
    const matched = patterns.some((pattern) => {
      if (pattern instanceof RegExp) return texts.some((text) => pattern.test(text));
      if (typeof pattern === 'string' && pattern.length > 0) return texts.some((text) => text.includes(pattern));
      return false;
    });
    if (matched && !hits.includes(id)) hits.push(id);
  }
  return { hits, available: true };
}

/**
 * Decide the mode. Precedence is MOST-SPECIFIC-SIGNAL FIRST, and the order is a
 * correction to the spec's, not a copy of it.
 *
 * The spec (lane-5 §3-A) lists the rules as: `runner=inline → solo`;
 * `runner=team → team`; `recommendation=autopilot → autopilot`; NL fast →
 * `autopilot_fast`; `recommendation=split` or NL split → `split`; `subagent`
 * when `subs>=2 ∧ domains=1`. Read as a first-match ladder that is
 * CONTRADICTORY: `runner` is always exactly one of `inline`/`team`
 * (`workflow-plan.js#buildWorkflowPlan`), so rules 1-2 always fire and the remaining four
 * modes are unreachable — four of the six enum values could never be produced.
 *
 * The reading that makes all six reachable, and the one implemented here, is
 * that `runner` supplies the BASE mode while `recommendation` and the NL
 * phrases are ESCALATIONS that override it. `deriveRecommendation`
 * (`workflow-plan.js:227-238`) is computed independently of `runner` and set on
 * both inline and team plans, which is what makes the override well-defined.
 *
 * Within the escalations the spec's own relative order is preserved: fast
 * before split. So a prompt carrying both a fast phrase and a split phrase
 * routes to `autopilot_fast`.
 *
 * @param {object} params
 * @returns {{mode: string, signal: string, exception: string|null, reason: string[]}}
 */
function decideMode({ workflowPlan, subs, promptText }) {
  const reason = [];
  const runner = workflowPlan?.runner === 'team' ? 'team' : 'inline';
  const recommendation = typeof workflowPlan?.recommendation === 'string'
    ? workflowPlan.recommendation
    : null;
  reason.push(`runner:${runner}`);
  reason.push(`recommendation:${recommendation ?? 'none'}`);
  reason.push(`subs:${subs.length}`);
  reason.push(`domains:${domainCount(subs)}`);

  if (promptText === null) {
    reason.push('nl:unavailable');
  }

  const fastHit = firstMatch(promptText, FAST_PATTERNS);
  if (fastHit !== null) {
    reason.push(`nl-match:${fastHit}`);
    return { mode: 'autopilot_fast', signal: 'nl-explicit', exception: 'autopilot_fast', reason };
  }

  const splitHit = firstMatch(promptText, SPLIT_PATTERNS);
  if (splitHit !== null) {
    reason.push(`nl-match:${splitHit}`);
    return { mode: 'split', signal: 'nl-explicit', exception: 'split', reason };
  }

  if (recommendation === 'split') {
    return { mode: 'split', signal: 'recommendation', exception: 'split', reason };
  }
  if (recommendation === 'autopilot') {
    return { mode: 'autopilot', signal: 'recommendation', exception: null, reason };
  }
  if (runner === 'team') {
    return { mode: 'team', signal: 'runner', exception: null, reason };
  }
  // `subagent` is the non-team fan-out: several sub-objectives that all sit in
  // ONE agent domain, which is the shape a single delegating session handles
  // without a team. Distinct `agent` is the domain proxy, the same proxy
  // `deriveRecommendation` uses for stems (`workflow-plan.js:236`).
  if (subs.length >= 2 && domainCount(subs) === 1) {
    return { mode: 'subagent', signal: 'inference', exception: null, reason };
  }
  return { mode: 'solo', signal: 'config-default', exception: null, reason };
}

/**
 * Append read-only `config.topology.*` policy values to `reason[]`.
 *
 * The `*Ref` keys are DOT PATHS into this same config object (see the
 * `topology.comment` in `artibot.config.json`), so they are resolved here to
 * prove they still point at something. The values are RECORDED AND NOT APPLIED:
 * nothing downstream of this function reads them. A dangling ref renders as
 * `=unset` rather than throwing.
 * @param {string} mode
 * @param {object} config
 * @param {string[]} reason
 */
function appendPolicyRefs(mode, config, reason) {
  const refKeys = POLICY_REFS[mode];
  if (!refKeys) return;
  const section = config?.topology?.[mode];
  if (!section || typeof section !== 'object') {
    reason.push(`policy:${mode}=absent`);
    return;
  }
  for (const refKey of refKeys) {
    const resolved = resolveRef(config, section[refKey]);
    const rendered = resolved === undefined ? 'unset' : JSON.stringify(resolved);
    reason.push(`policy:${mode}.${refKey.replace(/Ref$/, '')}=${rendered}(observe-only)`);
  }
}

/**
 * Route a request onto a topology mode and score its ParallelGain.
 *
 * OBSERVE STAGE: the return value is a RECORD. It changes nothing. The caller
 * (T-37) writes it to `runtime/decisions/<sessionId>.events.ndjson` as a
 * `topology-recommended` event; no execution path consumes `mode`.
 *
 * @param {object} [params]
 * @param {object} [params.intent] - live `detectIntent` result. May carry a
 *   caller-attached `text`; `detectIntent` itself does not set one.
 * @param {object} [params.workflowPlan] - `buildWorkflowPlan` RESULT
 *   (`{runner, recommendation, teammates, effort, ...}`). Passed in rather than
 *   recomputed, so this router can never disagree with the plan that shipped.
 * @param {object} [params.config] - `artibot.config.json` object.
 * @param {object} [params.evidence] - measurement ports, all optional:
 *   `promptText`, `tasks[{affectedPaths}]`, `spawnDurationsMs[]`,
 *   `humanGateMatrix[{id,patterns}]`, `plannedActions[]`.
 * @returns {Readonly<{mode: string, reason: readonly string[], parallelGain: object,
 *   exception: 'autopilot_fast'|'split'|null, humanGateHits: readonly string[],
 *   confidence: number}>}
 */
export function routeTopology({ intent, workflowPlan, config, evidence } = {}) {
  const safeIntent = intent || {};
  const safePlan = workflowPlan || {};
  const safeConfig = config || {};
  const safeEvidence = evidence || {};

  const subs = extractSubs(safeIntent, safePlan);
  const promptText = promptTextOf(safeIntent, safeEvidence);
  const decision = decideMode({ workflowPlan: safePlan, subs, promptText });
  const reason = decision.reason;

  const parallelGain = computeParallelGain(subs, safeConfig, safeEvidence);
  const gates = classifyHumanGates(safeEvidence);
  if (!gates.available) reason.push('human-gates:unavailable');

  appendPolicyRefs(decision.mode, safeConfig, reason);

  // `topology.default` is read and DELIBERATELY NOT APPLIED. Recording the
  // divergence is what makes the Observe-stage claim "behavior change 0"
  // checkable instead of merely asserted.
  const configuredDefault = safeConfig?.topology?.default;
  if (typeof configuredDefault === 'string' && configuredDefault !== decision.mode) {
    reason.push(`config-default-ignored:${configuredDefault}`);
  }

  const measuredCount = Object.values(parallelGain.measured).filter(Boolean).length;
  const signalConfidence = SIGNAL_CONFIDENCE[decision.signal] ?? 0.4;
  // Half signal strength, half measurement coverage. Uncalibrated, and NOT a
  // probability that the mode is correct.
  const confidence = round2(0.5 * signalConfidence + 0.5 * (measuredCount / 6));

  return Object.freeze({
    mode: decision.mode,
    reason: Object.freeze([...reason]),
    parallelGain,
    exception: decision.exception,
    humanGateHits: Object.freeze(gates.hits),
    confidence,
  });
}
