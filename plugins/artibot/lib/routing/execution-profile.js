/**
 * Execution Profile — the mission-level performance intent the v5 router reads
 * before it classifies a single action.
 *
 * This is the FIRST of the five routing concepts that
 * `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` §3.2 separates
 * (Execution Profile -> Routing -> Switching -> Escalation -> Pinning). It
 * answers exactly one question: **what performance intent is this mission
 * running under?** It does not pick a model, an effort band, or a topology
 * runner — those belong to `adaptive-model-router.js` (T-31) and are computed
 * per action, not per mission.
 *
 * Two input paths, one output shape:
 *
 *   1. `intent.md` frontmatter carries `execution_profile` (the eight-key
 *      contract validated by `schemas/execution-profile.schema.json`, T-18).
 *      That object is passed through VERBATIM — this module never invents,
 *      renames, or fills in a key the author did not write.
 *   2. `intent.md` does not exist yet. The mission is then identified only by
 *      the flags the operator actually used, so this module doubles as the
 *      compatibility adapter the PRD calls for: `--fast` -> `maximum`,
 *      `/split` -> `split`, neither -> `balanced`.
 *
 * Stage: OBSERVE. Nothing here changes a spawn. `artibot.config.json#routing`
 * ships `observe: true` with an EMPTY `canary.actionClasses`, so the caller
 * (T-31) records this result and routes on `lib/core/model-policy.js`
 * `resolveModel` exactly as before.
 *
 * Layer: L2 pure. No `fs`, no `process`, no clock, no imports at all. The
 * config object and the schema validator both arrive by injection, which is
 * what makes the "schema validation is a port" requirement real rather than
 * decorative.
 *
 * Recompute cadence: once per mission, and again whenever
 * `intent_revision` changes (ADDENDUM-HARDENING §20, mirrored by the
 * `derived_from.intent_revision` staleness rule in the T-18 schema). Because
 * this function is pure, the caller supplies the prior result as `previous`
 * and the version counter advances here rather than in a module-level global.
 *
 * ## Open gap G-1 — `performance.priority` has eight values and no mapping
 *
 * The T-18 schema accepts the UNION of four independent vocabularies:
 * `balanced | maximum | split | economy | quality | fast |
 * maximum_performance | speed_accuracy`
 * (`schemas/execution-profile.schema.json`, sourced per value in
 * `schemas/execution-profile.README.md`). The design assigns routing weights
 * to exactly THREE of them (`ARTIBOT-5.0-DESIGN.md §3.2`). No document in the
 * corpus supplies a normalization table for the other five.
 *
 * The tempting synonyms — `maximum_performance` and `speed_accuracy` "obviously"
 * meaning `maximum`, `quality`/`economy` "obviously" meaning `balanced` — are
 * exactly what this module refuses to write. `normalizePerformancePriority`
 * returns `{ normalized: null, reason: 'G-1 unresolved' }` for all five, and a
 * mission carrying one of them gets `objective: null` and `directives: null`.
 * Fail-closed: an unmapped priority produces no routing directive at all,
 * rather than a guessed one that would quietly become the de-facto decision.
 * Resolving G-1 is an owner decision and needs a citation, not an inference.
 *
 * @module lib/routing/execution-profile
 */

// ---------------------------------------------------------------------------
// Vocabularies (allowlists — never negative lists)
// ---------------------------------------------------------------------------

/**
 * The three priorities the design actually assigns routing weights to.
 * Source: ARTIBOT-5.0-DESIGN.md §3.2.
 */
export const DESIGN_PRIORITIES = Object.freeze(['balanced', 'maximum', 'split']);

/**
 * Every value `schemas/execution-profile.schema.json` accepts for
 * `performance.priority`. Kept here as an allowlist so a value that is
 * schema-legal but design-unmapped (G-1) is distinguishable from a value that
 * is simply not a priority at all.
 */
export const SCHEMA_PRIORITIES = Object.freeze([
  'balanced',
  'maximum',
  'split',
  'economy',
  'quality',
  'fast',
  'maximum_performance',
  'speed_accuracy',
]);

/**
 * `topology` allowlist, transcribed from the T-18 schema (itself the
 * run-ledger topology.mode enum plus `auto`). Used only to reject an
 * out-of-enum `config.topology.default` instead of emitting it.
 */
const TOPOLOGY_VALUES = Object.freeze([
  'auto',
  'solo',
  'subagent',
  'team',
  'autopilot',
  'autopilot_fast',
  'split',
]);

/**
 * Performance intent -> optimization objective.
 *
 * Read `OBJECTIVE_ATTESTATION` before treating all three as equally grounded:
 * the third token is NOT attested in the design corpus.
 */
export const OBJECTIVE_BY_PRIORITY = Object.freeze({
  balanced: 'cost_per_accepted_outcome',
  maximum: 'time_to_verified_outcome',
  split: 'wallclock_throughput',
});

/**
 * Where each objective token comes from. Recorded in code because two of the
 * three are quoted from the corpus and one is not, and a consumer that records
 * this objective into the ledger should be able to tell which is which
 * (the EXACT / PARTIAL / SIMULATED labelling principle).
 *
 * Measured 2026-09-02 by a repo-wide grep for the three tokens.
 */
export const OBJECTIVE_ATTESTATION = Object.freeze({
  cost_per_accepted_outcome:
    'ATTESTED — package/config/artibot-v5-policy.example.yaml:38 (routing.objective.normal), :95 (observability.primary_kpi); ARTIBOT-5.0-DESIGN.md §3.2.',
  time_to_verified_outcome:
    'ATTESTED — package/config/artibot-v5-policy.example.yaml:70 (topology.autopilot_fast.optimization.primary, paired with accuracy); ARTIBOT-5.0-DESIGN.md §3.2.',
  wallclock_throughput:
    'UNATTESTED — zero occurrences in the design corpus (repo-wide grep, 2026-09-02). ARTIBOT-5.0-DESIGN.md §3.2 defines split as "maximum + ContextAffinity 0 + budget ceiling" and names no separate objective token; policy.example.yaml:74-79 gives topology.split no optimization block at all. The token is a coinage of the lane-2 routing analysis (§4.3 prose "wallclock + throughput + accepted quality"). Kept because the task contract names it, flagged because a coined token must not be mistaken for a quoted one.',
});

/**
 * Performance intent -> the routing-weight changes ARTIBOT-5.0-DESIGN.md §3.2
 * assigns to it. This module owns the table; `route-scorer.js` (T-27) and
 * `escalation-controller.js` (T-29) consume it rather than restating it.
 *
 * `budgetCeilingRef` is a DOT PATH into config, never a copied number — the
 * same discipline `artibot.config.json#topology` already uses for its `*Ref`
 * keys, so the ceiling cannot rot out of sync with `split.dispatch.budget`.
 *
 * `effortFloor` is a band name consumed by the effort resolver; this module
 * does not resolve it and deliberately imports nothing to do so.
 */
export const PERFORMANCE_DIRECTIVES = Object.freeze({
  balanced: Object.freeze({
    costWeight: 1,
    contextAffinityWeight: 1,
    downgradeEnabled: true,
    effortFloor: null,
    accuracySecondaryObjective: false,
    budgetCeilingRef: null,
  }),
  maximum: Object.freeze({
    costWeight: 0,
    contextAffinityWeight: 1,
    downgradeEnabled: false,
    effortFloor: 'xhigh',
    accuracySecondaryObjective: true,
    budgetCeilingRef: null,
  }),
  split: Object.freeze({
    costWeight: 0,
    contextAffinityWeight: 0,
    downgradeEnabled: false,
    effortFloor: 'xhigh',
    accuracySecondaryObjective: true,
    budgetCeilingRef: 'split.dispatch.budget',
  }),
});

/** Thrown when the injected validator rejects the compiled profile. */
export const SCHEMA_INVALID_CODE = 'EXECUTION_PROFILE_SCHEMA_INVALID';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve a dot path against a config object. Returns `undefined` for any
 * dangling segment — a dangling path is never an exception here, because the
 * caller's config is allowed to predate the key.
 * @param {object} root
 * @param {string} dotPath
 * @returns {unknown}
 */
function readPath(root, dotPath) {
  if (!isPlainObject(root) || typeof dotPath !== 'string' || dotPath === '') {
    return undefined;
  }
  let cursor = root;
  for (const segment of dotPath.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Deep clone of a JSON-shaped value, dropping `undefined` members so the
 * compiled profile is comparable and serializable. Frontmatter that cannot
 * round-trip through JSON (a cycle) is a caller bug, not a profile.
 */
function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    const error = new Error(
      'executionProfile: intentFrontmatter.execution_profile is not JSON-shaped',
    );
    error.cause = cause;
    throw error;
  }
}

/** Deterministic stringify (sorted keys) used only for change detection. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function deepFreeze(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// G-1 normalization
// ---------------------------------------------------------------------------

/**
 * Map a schema-legal `performance.priority` onto one of the three priorities
 * the design assigns weights to.
 *
 * Four outcomes, all explicit:
 *  - one of the design three         -> `{ normalized: <same>, reason: 'design' }`
 *  - absent                          -> `{ normalized: 'balanced', reason: 'default: …' }`
 *  - schema-legal but design-unmapped-> `{ normalized: null, reason: 'G-1 unresolved' }`
 *  - anything else                   -> `{ normalized: null, reason: 'unknown: …' }`
 *
 * The third outcome is the point of this function. `economy`, `quality`,
 * `fast`, `maximum_performance` and `speed_accuracy` all LOOK like synonyms of
 * one of the three; the corpus never says so, so nothing here says so either.
 *
 * @param {unknown} value `execution_profile.performance.priority`, or absent.
 * @returns {{ normalized: 'balanced'|'maximum'|'split'|null, reason: string }}
 */
export function normalizePerformancePriority(value) {
  if (value === undefined || value === null || value === '') {
    return {
      normalized: 'balanced',
      reason:
        'default: performance.priority absent — routing.objective.normal (policy.example.yaml:38)',
    };
  }
  if (typeof value !== 'string') {
    return { normalized: null, reason: 'invalid: performance.priority is not a string' };
  }
  if (DESIGN_PRIORITIES.includes(value)) {
    return { normalized: value, reason: 'design vocabulary (ARTIBOT-5.0-DESIGN.md §3.2)' };
  }
  if (SCHEMA_PRIORITIES.includes(value)) {
    return { normalized: null, reason: 'G-1 unresolved' };
  }
  return {
    normalized: null,
    reason: 'unknown: outside the execution-profile.schema.json performance.priority enum',
  };
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/**
 * Build the routing directives for a normalized priority, resolving
 * `budgetCeilingRef` against the injected config.
 *
 * The ceiling is looked up through `topology.split.dispatchBudgetRef` when the
 * config declares that indirection (as `artibot.config.json` does), and only
 * then falls back to the literal path. Following the declared `*Ref` is what
 * keeps a later rename of `split.dispatch.budget` from silently zeroing the
 * ceiling.
 *
 * @param {'balanced'|'maximum'|'split'} priority
 * @param {object} config
 * @returns {object} frozen directives, with `budgetCeiling` resolved or null
 */
function buildDirectives(priority, config) {
  const base = PERFORMANCE_DIRECTIVES[priority];
  let budgetCeiling = null;
  let budgetCeilingPath = base.budgetCeilingRef;

  if (budgetCeilingPath) {
    const declaredRef = readPath(config, 'topology.split.dispatchBudgetRef');
    if (typeof declaredRef === 'string' && declaredRef !== '') budgetCeilingPath = declaredRef;
    const resolved = readPath(config, budgetCeilingPath);
    budgetCeiling = Number.isFinite(resolved) ? resolved : null;
  }

  return Object.freeze({ ...base, budgetCeilingPath: budgetCeilingPath ?? null, budgetCeiling });
}

// ---------------------------------------------------------------------------
// Flag adapter
// ---------------------------------------------------------------------------

/**
 * Recognized flags, as an allowlist. An unrecognized flag is ignored rather
 * than guessed at; a negative list here would fail OPEN the moment a new flag
 * appears.
 */
const FLAG_TO_PRIORITY = Object.freeze([
  // Order is precedence order. `split` outranks `fast` because the design
  // defines split as maximum PLUS two further constraints (ContextAffinity 0
  // and a budget ceiling) — taking split therefore loses nothing that `--fast`
  // would have contributed, while the reverse would drop the ceiling.
  Object.freeze({ flag: 'split', priority: 'split' }),
  Object.freeze({ flag: 'fast', priority: 'maximum' }),
]);

function priorityFromFlags(flags) {
  if (!isPlainObject(flags)) return null;
  for (const { flag, priority } of FLAG_TO_PRIORITY) {
    if (flags[flag] === true) return priority;
  }
  return null;
}

function resolveTopology(priority, config) {
  if (priority === 'maximum') return 'autopilot_fast';
  if (priority === 'split') return 'split';
  const declared = readPath(config, 'topology.default');
  if (typeof declared === 'string' && TOPOLOGY_VALUES.includes(declared)) return declared;
  return 'auto';
}

/**
 * Compile a profile for a mission that has no `intent.md` yet.
 *
 * Only keys the flags and config actually DETERMINE are emitted. `reasoning`,
 * `autonomy`, `context` and `completion` are mission-level statements about
 * what the operator wants verified and how much autonomy to grant; a CLI flag
 * says nothing about any of them, so they are absent rather than defaulted.
 * Every key that IS emitted is quoted below.
 *
 * @param {'balanced'|'maximum'|'split'} priority
 * @param {object} config
 * @returns {object} an eight-key-schema-valid subset
 */
function synthesizeProfile(priority, config) {
  const profile = {
    // ARTIBOT-5.0-DESIGN.md §3.2 — the three design weights.
    performance: { priority },
    // policy.example.yaml:72 (autopilot_fast.parallel_exploration: aggressive)
    // and :76 (split.parallelism: aggressive); :66 (topology.normal.
    // parallelism_objective: net_gain) for the balanced case. The key rename
    // parallelism_objective -> strategy is the T-18 schema's judgment call,
    // flagged as G-5 in schemas/execution-profile.README.md.
    parallelism: { strategy: priority === 'balanced' ? 'net_gain' : 'aggressive' },
    // policy.example.yaml:20-28 — planning default is auto.
    planning: { mode: 'auto' },
    // policy.example.yaml:53 (review.independent), :71 (autopilot_fast) and
    // :78 (split) all say true. `review.model` is deliberately NOT set: the
    // corpus writes fable-5.1, which is not a catalog id, and the coordination
    // rules forbid hardcoding a model id outside lib/core/model-catalog.js.
    review: { independent: true },
  };

  if (priority !== 'balanced') {
    // ADDENDUM-HARDENING.md:126; policy.example.yaml:69 and :74 (token_policy:
    // generous). `generous` is the only budget token attested anywhere, so the
    // balanced case gets no budget key rather than an invented counterpart.
    profile.performance.budget = 'generous';
  }

  const topology = resolveTopology(priority, config);
  if (topology) profile.topology = topology;

  return profile;
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Advance the profile revision.
 *
 * Pure by construction: the counter lives in the caller's `previous` result,
 * not in this module. Recomputing an unchanged mission is idempotent (the
 * version holds); any change to the compiled profile, to `derived_from`
 * (which is where a bumped `intent_revision` shows up), or to the source path
 * advances it by one.
 */
function nextVersion(previous, identityKey) {
  const priorVersion =
    isPlainObject(previous) && Number.isInteger(previous.version) && previous.version >= 1
      ? previous.version
      : null;
  if (priorVersion === null) return 1;

  const priorKey = stableStringify({
    profile: previous.profile ?? null,
    derived_from: previous.derived_from ?? null,
    source: previous.source ?? null,
  });
  return priorKey === identityKey ? priorVersion : priorVersion + 1;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compile the mission's execution profile.
 *
 * @param {object} [input]
 * @param {object|null} [input.intentFrontmatter]
 *   Parsed `intent.md` frontmatter. Only `execution_profile` and
 *   `intent_revision` are read; every other field is ignored.
 * @param {{fast?: boolean, split?: boolean}} [input.flags]
 *   Used only when the frontmatter carries no `execution_profile`.
 * @param {object} [input.config]
 *   `artibot.config.json`-shaped object, injected. Read for
 *   `topology.default` and the split budget ceiling.
 * @param {object|null} [input.previous]
 *   The previous return value of this function for the same mission. Supplies
 *   the version counter; omit it on the first compile.
 * @param {((profile: object) => boolean|{valid: boolean, errors?: unknown})|null} [input.validate]
 *   Schema-validation PORT. When supplied it receives the schema view
 *   (`profile` plus `version` and `derived_from`) and its rejection is fatal:
 *   an invalid profile throws rather than being returned, so a malformed
 *   profile can never reach the router. Omit it and no validation happens —
 *   this module reads no files.
 *
 * @returns {{
 *   profile: object,
 *   objective: string|null,
 *   objective_reason: string,
 *   directives: object|null,
 *   version: number,
 *   derived_from: {intent_revision: number}|null,
 *   source: 'intent'|'flags'|'default'
 * }} Frozen. `objective` and `directives` are null exactly when the priority
 *   could not be normalized (G-1) — the fail-closed case.
 *
 * @throws {Error} with `code === SCHEMA_INVALID_CODE` when the injected
 *   validator rejects the compiled profile.
 */
export function executionProfile(input = {}) {
  const {
    intentFrontmatter = null,
    flags = {},
    config = {},
    previous = null,
    validate = null,
  } = isPlainObject(input) ? input : {};

  const safeConfig = isPlainObject(config) ? config : {};
  const declaredProfile = isPlainObject(intentFrontmatter)
    ? intentFrontmatter.execution_profile
    : undefined;

  /** @type {'intent'|'flags'|'default'} */
  let source;
  let profile;

  if (isPlainObject(declaredProfile)) {
    // Pass-through. The author's profile is the contract; nothing is filled in.
    source = 'intent';
    profile = cloneJson(declaredProfile);
  } else {
    const flagPriority = priorityFromFlags(flags);
    source = flagPriority ? 'flags' : 'default';
    profile = synthesizeProfile(flagPriority ?? 'balanced', safeConfig);
  }

  const { normalized, reason } = normalizePerformancePriority(profile?.performance?.priority);
  const objective = normalized ? OBJECTIVE_BY_PRIORITY[normalized] : null;
  const directives = normalized ? buildDirectives(normalized, safeConfig) : null;

  const revision = isPlainObject(intentFrontmatter) ? intentFrontmatter.intent_revision : undefined;
  const derived_from =
    source === 'intent' && Number.isInteger(revision) && revision >= 1
      ? { intent_revision: revision }
      : null;

  const version = nextVersion(
    previous,
    stableStringify({ profile, derived_from, source }),
  );

  // Schema view: the T-18 schema declares `version` and `derived_from` as
  // root-level properties of the profile itself, so validation must see them
  // together with the eight keys. `additionalProperties: false` means a stray
  // key here is caught rather than ignored.
  const schemaView = { ...profile, version };
  if (derived_from) schemaView.derived_from = derived_from;

  if (typeof validate === 'function') {
    const verdict = validate(schemaView);
    const ok = verdict === true || (isPlainObject(verdict) && verdict.valid === true);
    if (!ok) {
      const error = new Error(
        `executionProfile: compiled profile failed schema validation (source=${source})`,
      );
      error.code = SCHEMA_INVALID_CODE;
      error.errors = isPlainObject(verdict) ? (verdict.errors ?? null) : null;
      error.profile = schemaView;
      throw error;
    }
  }

  return deepFreeze({
    profile,
    objective,
    objective_reason: reason,
    directives,
    version,
    derived_from,
    source,
  });
}

export default executionProfile;
