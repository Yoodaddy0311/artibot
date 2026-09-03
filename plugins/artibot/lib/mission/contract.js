/**
 * Mission Contract vocabulary and validator.
 *
 * The canonical shape lives in `schemas/mission-contract.schema.json` (T-13).
 * That schema is an IN-MEMORY validator for the intent.md parser's output — it
 * is never written to disk — so this module carries the same vocabulary as
 * frozen constants plus a structural checker that runs when no schema-backed
 * validator has been injected.
 *
 * PURITY (design §1-8, L2): no clock, no filesystem, no randomness, no I/O.
 * Every effect arrives as an injected port. `validateMissionContract` takes an
 * optional `validate` port so a caller that has already compiled the JSON
 * Schema can hand it in; without one, the structural fallback runs.
 *
 * WHAT THE STRUCTURAL FALLBACK CANNOT SEE (repo rule: write it next to the gate)
 * ---------------------------------------------------------------------------
 *  - `execution_profile` is a `$ref` to T-18's schema. Nothing here resolves
 *    `$ref`, so that subtree is reported in `unchecked[]` and NEVER counted as
 *    well-formed. Absence of an error there means "not checked".
 *  - It is not a draft-07 implementation. It asserts the constraints this
 *    contract actually uses and must not be reused as a general validator.
 *  - It checks shape, not truth. A contract can be structurally valid and still
 *    have lost the user's words; `checkIntentFidelity` and
 *    `verifyExplicitRequestSpans` are the checks for that, and they are
 *    deliberately separate calls so a caller cannot get one by accident while
 *    believing it got the other.
 *  - In `mode: 'reduced'` the injected port is SKIPPED, because the full schema
 *    marks `success` and `scope` required and a reduced (system1) contract
 *    carries neither. That skip is reported in `unchecked[]`.
 *
 * @module lib/mission/contract
 */

/** The 21 top-level fields of mission-contract.schema.json, in schema order. */
export const MISSION_CONTRACT_FIELDS = Object.freeze([
  'schema_version',
  'mission_id',
  'intent_revision',
  'status',
  'goal',
  'explicit_requests',
  'inferred_outcomes',
  'success',
  'scope',
  'constraints',
  'findings',
  'autonomy',
  'performance',
  'planning',
  'completion',
  'intent_confidence',
  'command_activation',
  'execution_profile',
  'topology',
  'review',
  'user_decisions',
]);

/** Required fields of the full contract (schema `required`). */
export const REQUIRED_FIELDS_FULL = Object.freeze([
  'goal',
  'explicit_requests',
  'success',
  'scope',
]);

/**
 * Required fields of the reduced (system1) contract.
 *
 * Design §3.1 describes the reduced contract as `{goal, explicit_requests,
 * intent_confidence}`. `intent_confidence` is NOT required here: its producer
 * is `lib/intent/confidence.js` (T-24), which has not landed, and requiring a
 * field nothing can populate would make every system1 contract invalid for a
 * reason unrelated to the contract. It stays in the reduced allowlist so it is
 * accepted the moment T-24 supplies it.
 */
export const REQUIRED_FIELDS_REDUCED = Object.freeze([
  'goal',
  'explicit_requests',
]);

/** Fields a reduced contract may carry. Anything else is an error (fail-closed). */
export const REDUCED_ALLOWED_FIELDS = Object.freeze([
  'schema_version',
  'mission_id',
  'goal',
  'explicit_requests',
  'intent_confidence',
]);

/** The canonical 7-state mission vocabulary (package-v1.1/16_STATE_SCHEMA.yaml). */
export const MISSION_STATUS = Object.freeze([
  'queued',
  'planning',
  'executing',
  'blocked',
  'reviewing',
  'completed',
  'failed',
]);

/**
 * Autonomy modes.
 *
 * The schema enum is `guided|agent_led|autonomous`; design 03's contract sample
 * writes `mode: auto`. That conflict is open decision A-2 in the lane-1 report
 * and is NOT resolved here — this module follows the schema, which is the
 * landed artifact.
 */
export const AUTONOMY_MODES = Object.freeze([
  'guided',
  'agent_led',
  'autonomous',
]);

/** Performance priorities. */
export const PERFORMANCE_PRIORITIES = Object.freeze([
  'economy',
  'balanced',
  'quality',
  'fast',
  'maximum_performance',
]);

/** Planning modes. */
export const PLANNING_MODES = Object.freeze([
  'auto',
  'direct',
  'plan',
  'ultraplan',
]);

/** Topology modes — the run-ledger 6-value router-output vocabulary (design §3.5). */
export const TOPOLOGY_MODES = Object.freeze([
  'solo',
  'subagent',
  'team',
  'autopilot',
  'autopilot_fast',
  'split',
]);

/** Blindspot classes (design 03 `findings`, 09). */
export const FINDING_CLASSES = Object.freeze([
  'mission_blockers',
  'bounded_blindspots',
  'future_opportunities',
]);

/** The four `success` sub-sections. */
export const SUCCESS_SECTIONS = Object.freeze([
  'functional',
  'behavioral',
  'regression',
  'evidence',
]);

/** The `command_activation` boolean keys (skills is an array, handled apart). */
export const COMMAND_ACTIVATION_FLAGS = Object.freeze([
  'plan',
  'ultraplan',
  'review',
  'autopilot',
  'autopilot_fast',
  'split',
]);

/**
 * `mission_id` pattern, copied byte-identically from
 * `schemas/mission-contract.schema.json`, which in turn is kept byte-identical
 * to the ledger-envelope and review-output schemas so the join across the three
 * does not break. `\d{3,}` — the counter may run PAST three digits so a busy
 * day cannot overflow the id space. Do not tighten it here alone.
 */
export const MISSION_ID_PATTERN = /^M-\d{8}-(?:\d{3,}|S[0-9A-Za-z]{8})$/;

const SCOPE_LIST_FIELDS = Object.freeze([
  'requested_target',
  'direct',
  'upstream',
  'downstream',
  'bounded_blindspots',
  'excluded',
]);

const CONFIDENCE_AXES = Object.freeze(['goal', 'scope', 'completion_expectation']);

/**
 * Korean particles and generic words stripped before fidelity token matching.
 * An allowlist of things to DROP is safe here because dropping too little only
 * makes matching stricter, never fail-open.
 */
const FIDELITY_STOPWORDS = new Set([
  '을', '를', '이', '가', '은', '는', '의', '에', '에서', '으로', '로',
  '과', '와', '도', '만', '까지', '부터', '한테', '에게',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function checkStringArray(value, path, errors, { minItems = 0, nonEmptyItems = false } = {}) {
  if (!Array.isArray(value)) {
    pushError(errors, path, 'must be an array');
    return;
  }
  if (value.length < minItems) {
    pushError(errors, path, `must have at least ${minItems} item(s)`);
  }
  value.forEach((item, i) => {
    if (typeof item !== 'string') {
      pushError(errors, `${path}[${i}]`, 'must be a string');
    } else if (nonEmptyItems && item.length === 0) {
      pushError(errors, `${path}[${i}]`, 'must not be empty');
    }
  });
}

function checkEnum(value, allowed, path, errors) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    pushError(errors, path, `must be one of: ${allowed.join('|')}`);
  }
}

function checkExplicitRequests(value, errors, warnings) {
  if (!Array.isArray(value)) {
    pushError(errors, 'explicit_requests', 'must be an array');
    return;
  }
  if (value.length < 1) {
    pushError(errors, 'explicit_requests', 'must have at least 1 item');
  }
  value.forEach((entry, i) => {
    const base = `explicit_requests[${i}]`;
    if (!isPlainObject(entry)) {
      pushError(errors, base, 'must be an object');
      return;
    }
    const extra = Object.keys(entry).filter((k) => k !== 'text' && k !== 'span');
    if (extra.length > 0) {
      pushError(errors, base, `unknown propertie(s): ${extra.join(', ')}`);
    }
    if (typeof entry.text !== 'string' || entry.text.length === 0) {
      pushError(errors, `${base}.text`, 'must be a non-empty string');
    }
    if (!isPlainObject(entry.span)) {
      pushError(errors, `${base}.span`, 'must be an object');
      return;
    }
    const spanExtra = Object.keys(entry.span).filter(
      (k) => k !== 'start' && k !== 'end',
    );
    if (spanExtra.length > 0) {
      pushError(errors, `${base}.span`, `unknown propertie(s): ${spanExtra.join(', ')}`);
    }
    for (const key of ['start', 'end']) {
      const n = entry.span[key];
      if (!isInteger(n) || n < 0) {
        pushError(errors, `${base}.span.${key}`, 'must be an integer >= 0');
      }
    }
    // The schema does not order start/end. An inverted span is nonsense but
    // reporting it as an ERROR would make this checker reject contracts the
    // schema accepts, so it is a warning: divergence from the schema is a
    // worse failure mode than a missed nonsense span.
    if (isInteger(entry.span.start) && isInteger(entry.span.end)
      && entry.span.end < entry.span.start) {
      warnings.push({
        path: `${base}.span`,
        message: 'end < start (schema permits it; verifyExplicitRequestSpans will fail)',
      });
    }
  });
}

function checkSuccess(value, errors) {
  if (!isPlainObject(value)) {
    pushError(errors, 'success', 'must be an object');
    return;
  }
  const extra = Object.keys(value).filter((k) => !SUCCESS_SECTIONS.includes(k));
  if (extra.length > 0) {
    pushError(errors, 'success', `unknown propertie(s): ${extra.join(', ')}`);
  }
  for (const section of SUCCESS_SECTIONS) {
    if (value[section] !== undefined) {
      checkStringArray(value[section], `success.${section}`, errors);
    }
  }
}

function checkScope(value, errors) {
  if (!isPlainObject(value)) {
    pushError(errors, 'scope', 'must be an object');
    return;
  }
  const extra = Object.keys(value).filter((k) => !SCOPE_LIST_FIELDS.includes(k));
  if (extra.length > 0) {
    pushError(errors, 'scope', `unknown propertie(s): ${extra.join(', ')}`);
  }
  // Fail-closed: a contract with no requested_target has lost the thing the
  // user pointed at — exactly the context-substitution failure the
  // constitution forbids (design §3.1 first eval case).
  checkStringArray(value.requested_target, 'scope.requested_target', errors, {
    minItems: 1,
    nonEmptyItems: true,
  });
  for (const field of SCOPE_LIST_FIELDS) {
    if (field === 'requested_target') continue;
    if (value[field] !== undefined) {
      checkStringArray(value[field], `scope.${field}`, errors);
    }
  }
}

function checkFindings(value, errors) {
  if (!isPlainObject(value)) {
    pushError(errors, 'findings', 'must be an object');
    return;
  }
  const extra = Object.keys(value).filter((k) => !FINDING_CLASSES.includes(k));
  if (extra.length > 0) {
    pushError(errors, 'findings', `unknown propertie(s): ${extra.join(', ')}`);
  }
  for (const cls of FINDING_CLASSES) {
    if (value[cls] !== undefined) checkStringArray(value[cls], `findings.${cls}`, errors);
  }
}

function checkIntentConfidence(value, errors) {
  if (!isPlainObject(value)) {
    pushError(errors, 'intent_confidence', 'must be an object');
    return;
  }
  const allowed = [...CONFIDENCE_AXES, 'product_decision_required'];
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    pushError(errors, 'intent_confidence', `unknown propertie(s): ${extra.join(', ')}`);
  }
  for (const axis of CONFIDENCE_AXES) {
    const n = value[axis];
    if (n === undefined) continue;
    if (typeof n !== 'number' || Number.isNaN(n) || n < 0 || n > 1) {
      pushError(errors, `intent_confidence.${axis}`, 'must be a number in [0, 1]');
    }
  }
  if (value.product_decision_required !== undefined
    && typeof value.product_decision_required !== 'boolean') {
    pushError(errors, 'intent_confidence.product_decision_required', 'must be a boolean');
  }
}

function checkCommandActivation(value, errors) {
  if (!isPlainObject(value)) {
    pushError(errors, 'command_activation', 'must be an object');
    return;
  }
  const allowed = [...COMMAND_ACTIVATION_FLAGS, 'skills'];
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    pushError(errors, 'command_activation', `unknown propertie(s): ${extra.join(', ')}`);
  }
  for (const flag of COMMAND_ACTIVATION_FLAGS) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') {
      pushError(errors, `command_activation.${flag}`, 'must be a boolean');
    }
  }
  if (value.skills !== undefined) {
    checkStringArray(value.skills, 'command_activation.skills', errors);
  }
}

function checkNestedObjects(contract, errors) {
  if (contract.autonomy !== undefined) {
    if (!isPlainObject(contract.autonomy)) {
      pushError(errors, 'autonomy', 'must be an object');
    } else {
      const extra = Object.keys(contract.autonomy)
        .filter((k) => k !== 'mode' && k !== 'human_gates');
      if (extra.length > 0) {
        pushError(errors, 'autonomy', `unknown propertie(s): ${extra.join(', ')}`);
      }
      checkEnum(contract.autonomy.mode, AUTONOMY_MODES, 'autonomy.mode', errors);
      if (contract.autonomy.human_gates !== undefined) {
        checkStringArray(contract.autonomy.human_gates, 'autonomy.human_gates', errors);
      }
    }
  }
  if (contract.performance !== undefined) {
    if (!isPlainObject(contract.performance)) {
      pushError(errors, 'performance', 'must be an object');
    } else {
      const extra = Object.keys(contract.performance)
        .filter((k) => k !== 'priority' && k !== 'fast_mode');
      if (extra.length > 0) {
        pushError(errors, 'performance', `unknown propertie(s): ${extra.join(', ')}`);
      }
      checkEnum(
        contract.performance.priority,
        PERFORMANCE_PRIORITIES,
        'performance.priority',
        errors,
      );
      if (contract.performance.fast_mode !== undefined
        && typeof contract.performance.fast_mode !== 'boolean') {
        pushError(errors, 'performance.fast_mode', 'must be a boolean');
      }
    }
  }
  if (contract.planning !== undefined) {
    if (!isPlainObject(contract.planning)) {
      pushError(errors, 'planning', 'must be an object');
    } else {
      const extra = Object.keys(contract.planning).filter((k) => k !== 'mode');
      if (extra.length > 0) {
        pushError(errors, 'planning', `unknown propertie(s): ${extra.join(', ')}`);
      }
      checkEnum(contract.planning.mode, PLANNING_MODES, 'planning.mode', errors);
    }
  }
  if (contract.topology !== undefined) {
    if (!isPlainObject(contract.topology)) {
      pushError(errors, 'topology', 'must be an object');
    } else {
      const extra = Object.keys(contract.topology).filter((k) => k !== 'mode');
      if (extra.length > 0) {
        pushError(errors, 'topology', `unknown propertie(s): ${extra.join(', ')}`);
      }
      checkEnum(contract.topology.mode, TOPOLOGY_MODES, 'topology.mode', errors);
    }
  }
  if (contract.completion !== undefined) {
    if (!isPlainObject(contract.completion)) {
      pushError(errors, 'completion', 'must be an object');
    } else {
      const extra = Object.keys(contract.completion)
        .filter((k) => k !== 'expected_actions');
      if (extra.length > 0) {
        pushError(errors, 'completion', `unknown propertie(s): ${extra.join(', ')}`);
      }
      if (contract.completion.expected_actions !== undefined) {
        checkStringArray(
          contract.completion.expected_actions,
          'completion.expected_actions',
          errors,
        );
      }
    }
  }
  if (contract.review !== undefined) {
    if (!isPlainObject(contract.review)) {
      pushError(errors, 'review', 'must be an object');
    } else {
      const extra = Object.keys(contract.review)
        .filter((k) => !['required', 'model', 'status'].includes(k));
      if (extra.length > 0) {
        pushError(errors, 'review', `unknown propertie(s): ${extra.join(', ')}`);
      }
      if (contract.review.required !== undefined
        && typeof contract.review.required !== 'boolean') {
        pushError(errors, 'review.required', 'must be a boolean');
      }
      for (const key of ['model', 'status']) {
        if (contract.review[key] !== undefined && typeof contract.review[key] !== 'string') {
          pushError(errors, `review.${key}`, 'must be a string');
        }
      }
    }
  }
}

function checkScalars(contract, errors) {
  if (contract.schema_version !== undefined
    && (!isInteger(contract.schema_version) || contract.schema_version < 1)) {
    pushError(errors, 'schema_version', 'must be an integer >= 1');
  }
  if (contract.mission_id !== undefined
    && (typeof contract.mission_id !== 'string'
      || !MISSION_ID_PATTERN.test(contract.mission_id))) {
    pushError(errors, 'mission_id', `must match ${MISSION_ID_PATTERN.source}`);
  }
  if (contract.intent_revision !== undefined
    && (!isInteger(contract.intent_revision) || contract.intent_revision < 1)) {
    pushError(errors, 'intent_revision', 'must be an integer >= 1');
  }
  checkEnum(contract.status, MISSION_STATUS, 'status', errors);
  if (contract.goal !== undefined
    && (typeof contract.goal !== 'string' || contract.goal.length === 0)) {
    pushError(errors, 'goal', 'must be a non-empty string');
  }
  if (contract.inferred_outcomes !== undefined) {
    checkStringArray(contract.inferred_outcomes, 'inferred_outcomes', errors);
  }
  if (contract.constraints !== undefined) {
    checkStringArray(contract.constraints, 'constraints', errors);
  }
  if (contract.user_decisions !== undefined && !Array.isArray(contract.user_decisions)) {
    pushError(errors, 'user_decisions', 'must be an array');
  }
}

function structuralCheckFull(contract, errors, warnings, unchecked) {
  const unknown = Object.keys(contract)
    .filter((k) => !MISSION_CONTRACT_FIELDS.includes(k));
  if (unknown.length > 0) {
    pushError(errors, '', `unknown top-level propertie(s): ${unknown.join(', ')}`);
  }
  for (const field of REQUIRED_FIELDS_FULL) {
    if (contract[field] === undefined) {
      pushError(errors, field, 'is required');
    }
  }
  checkScalars(contract, errors);
  if (contract.explicit_requests !== undefined) {
    checkExplicitRequests(contract.explicit_requests, errors, warnings);
  }
  if (contract.success !== undefined) checkSuccess(contract.success, errors);
  if (contract.scope !== undefined) checkScope(contract.scope, errors);
  if (contract.findings !== undefined) checkFindings(contract.findings, errors);
  if (contract.intent_confidence !== undefined) {
    checkIntentConfidence(contract.intent_confidence, errors);
  }
  if (contract.command_activation !== undefined) {
    checkCommandActivation(contract.command_activation, errors);
  }
  checkNestedObjects(contract, errors);
  if (contract.execution_profile !== undefined) {
    // $ref to execution-profile.schema.json (T-18). Not resolved here — an
    // absent error on this subtree means NOT CHECKED, never well-formed.
    unchecked.push({
      path: 'execution_profile',
      reason: '$ref to execution-profile.schema.json is not resolved by this checker',
    });
  }
}

function structuralCheckReduced(contract, errors, warnings) {
  const unknown = Object.keys(contract)
    .filter((k) => !REDUCED_ALLOWED_FIELDS.includes(k));
  if (unknown.length > 0) {
    pushError(
      errors,
      '',
      `reduced contract may only carry ${REDUCED_ALLOWED_FIELDS.join(', ')};`
      + ` found: ${unknown.join(', ')}`,
    );
  }
  for (const field of REQUIRED_FIELDS_REDUCED) {
    if (contract[field] === undefined) pushError(errors, field, 'is required');
  }
  checkScalars(contract, errors);
  if (contract.explicit_requests !== undefined) {
    checkExplicitRequests(contract.explicit_requests, errors, warnings);
  }
  if (contract.intent_confidence !== undefined) {
    checkIntentConfidence(contract.intent_confidence, errors);
  }
}

/**
 * Validate a Mission Contract object.
 *
 * @param {object} contract - The contract to validate.
 * @param {object} [options]
 * @param {'full'|'reduced'} [options.mode='full'] - `reduced` is the system1
 *   contract of design §3.1: goal + explicit_requests (+ intent_confidence when
 *   T-24 supplies it), with `success`/`scope` relaxed out of `required`.
 * @param {(contract: object) => {valid: boolean, errors?: Array}} [options.validate]
 *   Injected schema validator port. Used in `full` mode only; in `reduced` mode
 *   it is skipped (the full schema requires success+scope) and the skip is
 *   reported in `unchecked`.
 * @returns {{
 *   valid: boolean,
 *   mode: 'full'|'reduced',
 *   checkedBy: 'schema-port'|'structural',
 *   errors: {path: string, message: string}[],
 *   warnings: {path: string, message: string}[],
 *   unchecked: {path: string, reason: string}[]
 * }}
 * @throws {TypeError} on an unknown mode — fail-closed, so a typo cannot
 *   silently widen what is accepted.
 */
export function validateMissionContract(contract, options = {}) {
  const { mode = 'full', validate = null } = options;
  if (mode !== 'full' && mode !== 'reduced') {
    throw new TypeError(`validateMissionContract: unknown mode "${mode}" (full|reduced)`);
  }

  const errors = [];
  const warnings = [];
  const unchecked = [];

  if (!isPlainObject(contract)) {
    return {
      valid: false,
      mode,
      checkedBy: 'structural',
      errors: [{ path: '', message: 'contract must be a plain object' }],
      warnings,
      unchecked,
    };
  }

  if (typeof validate === 'function' && mode === 'full') {
    const result = validate(contract) || {};
    const portErrors = Array.isArray(result.errors) ? result.errors : [];
    return {
      valid: result.valid === true,
      mode,
      checkedBy: 'schema-port',
      errors: portErrors,
      warnings,
      unchecked,
    };
  }
  if (typeof validate === 'function' && mode === 'reduced') {
    unchecked.push({
      path: '',
      reason: 'injected schema validator skipped: the full schema requires success+scope,'
        + ' which a reduced contract does not carry',
    });
  }

  if (mode === 'full') {
    structuralCheckFull(contract, errors, warnings, unchecked);
  } else {
    structuralCheckReduced(contract, errors, warnings);
  }

  return { valid: errors.length === 0, mode, checkedBy: 'structural', errors, warnings, unchecked };
}

/**
 * Normalize a string into comparable tokens (Hangul + alphanumerics kept).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForFidelity(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/u)
    .filter((t) => t.length > 0 && !FIDELITY_STOPWORDS.has(t));
}

/**
 * Intent Fidelity check (design §3.4, constitution 01§4).
 *
 * Every `explicit_requests` entry must be covered by something in
 * `scope.requested_target ∪ scope.direct ∪ scope.upstream`. A systemic finding
 * that swaps the user's target for a "root cause" leaves an entry uncovered,
 * which is the RED this check exists to produce.
 *
 * This is a SEPARATE call from `validateMissionContract` on purpose: a
 * structurally valid contract can still have lost the user's words, and folding
 * the two together would let a caller believe one verdict covered both.
 *
 * @param {object} contract
 * @returns {{ok: boolean, unmatched: {index: number, text: string}[],
 *   matched: {index: number, text: string, coveredBy: string}[]}}
 */
export function checkIntentFidelity(contract) {
  const requests = Array.isArray(contract?.explicit_requests)
    ? contract.explicit_requests
    : [];
  const scope = isPlainObject(contract?.scope) ? contract.scope : {};
  const targets = [
    ...(Array.isArray(scope.requested_target) ? scope.requested_target : []),
    ...(Array.isArray(scope.direct) ? scope.direct : []),
    ...(Array.isArray(scope.upstream) ? scope.upstream : []),
  ].filter((t) => typeof t === 'string');

  const targetTokens = targets.map((t) => ({ target: t, tokens: new Set(tokenizeForFidelity(t)) }));
  const matched = [];
  const unmatched = [];

  requests.forEach((entry, index) => {
    const text = typeof entry?.text === 'string' ? entry.text : '';
    const tokens = tokenizeForFidelity(text);
    const hit = targetTokens.find(({ tokens: tt }) => tokens.some((tok) => tt.has(tok)));
    if (hit) matched.push({ index, text, coveredBy: hit.target });
    else unmatched.push({ index, text });
  });

  return { ok: unmatched.length === 0 && requests.length > 0, unmatched, matched };
}

/**
 * Verify each `explicit_requests[].span` still points at its own text inside
 * the preserved original request.
 *
 * This is the binding that makes the fidelity rule mechanical rather than
 * rhetorical: an entry whose text is not the exact substring at its span has
 * been summarized, normalized, or substituted.
 *
 * @param {object} contract
 * @param {string} originalRequest - The preserved raw prompt.
 * @returns {{ok: boolean, mismatches: {index: number, text: string,
 *   span: {start: number, end: number}, actual: string}[]}}
 */
export function verifyExplicitRequestSpans(contract, originalRequest) {
  const source = String(originalRequest ?? '');
  const requests = Array.isArray(contract?.explicit_requests)
    ? contract.explicit_requests
    : [];
  const mismatches = [];

  requests.forEach((entry, index) => {
    const text = typeof entry?.text === 'string' ? entry.text : '';
    const start = entry?.span?.start;
    const end = entry?.span?.end;
    if (!isInteger(start) || !isInteger(end)) {
      mismatches.push({ index, text, span: { start, end }, actual: null });
      return;
    }
    const actual = source.slice(start, end);
    if (actual !== text) {
      mismatches.push({ index, text, span: { start, end }, actual });
    }
  });

  return { ok: mismatches.length === 0, mismatches };
}
