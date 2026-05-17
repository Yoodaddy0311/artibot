/**
 * Goal-vs-actual drift detector for autopilot (Track H).
 *
 * Given a Goal Contract (deliverables the user committed to) and the
 * accumulated phase outputs (deliverables that actually shipped), compute
 * the drift percentage, list missing items, and flag any extras (scope
 * creep) that appeared in execution but weren't in the contract.
 *
 * Pure function — no I/O. Inputs are objects; output is a plain object.
 *
 * Public surface:
 *   - extractGoalFields(contract)
 *   - extractPhaseFields(phaseOutput)
 *   - computeDrift(goal, phaseOutputs)
 *
 * @module lib/autopilot/goal-drift-detector
 */

/**
 * Normalize an arbitrary token into a canonical comparable string.
 * Returns null when the input is not a usable string.
 * @param {unknown} s
 * @returns {string|null}
 */
function canonicalize(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/[\s_.-]+/g, '-');
}

/**
 * Add every string in an array (or a single string) into the target Set
 * using canonicalize(). Non-string entries are silently ignored.
 * @param {Set<string>} set
 * @param {unknown} input
 */
function addAll(set, input) {
  if (Array.isArray(input)) {
    for (const item of input) {
      const c = canonicalize(item);
      if (c) set.add(c);
    }
    return;
  }
  const c = canonicalize(input);
  if (c) set.add(c);
}

/**
 * Extract the set of required deliverables from a Goal Contract.
 *
 * Sources (combined, deduped):
 *   - contract.deliverables[]        explicit list
 *   - contract.requiredFiles[]       file paths the user expects
 *   - contract.stoppingCondition     parsed for `file: <path>` mentions
 *
 * @param {object|null|undefined} contract
 * @returns {Set<string>}
 */
export function extractGoalFields(contract) {
  const out = new Set();
  if (!contract || typeof contract !== 'object') return out;
  addAll(out, contract.deliverables);
  addAll(out, contract.requiredFiles);
  if (typeof contract.stoppingCondition === 'string') {
    const matches = contract.stoppingCondition.match(/file:\s*([^\s,;]+)/gi) || [];
    for (const m of matches) {
      const cleaned = m.replace(/^file:\s*/i, '');
      const c = canonicalize(cleaned);
      if (c) out.add(c);
    }
  }
  return out;
}

/**
 * Extract the set of actual deliverables from a single phase output.
 *
 * Recognized fields:
 *   - deliverables[]      explicit list
 *   - changedFiles[]      git-level file list
 *   - artifacts[]         arbitrary named outputs
 *
 * @param {object|null|undefined} phaseOutput
 * @returns {Set<string>}
 */
export function extractPhaseFields(phaseOutput) {
  const out = new Set();
  if (!phaseOutput || typeof phaseOutput !== 'object') return out;
  addAll(out, phaseOutput.deliverables);
  addAll(out, phaseOutput.changedFiles);
  addAll(out, phaseOutput.artifacts);
  return out;
}

/**
 * Merge multiple phase outputs into a single Set of canonicalized fields.
 * @param {Array<object>|object|null|undefined} phaseOutputs
 * @returns {Set<string>}
 */
function mergePhaseFields(phaseOutputs) {
  const out = new Set();
  if (Array.isArray(phaseOutputs)) {
    for (const p of phaseOutputs) {
      for (const f of extractPhaseFields(p)) out.add(f);
    }
    return out;
  }
  for (const f of extractPhaseFields(phaseOutputs)) out.add(f);
  return out;
}

/**
 * Round to one decimal place (matches cost-tracker percent format).
 * @param {number} n
 * @returns {number}
 */
function oneDecimal(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Compute goal-vs-actual drift.
 *
 * Definitions:
 *   - missing  : in goal, not in actuals (deliverable still owed)
 *   - extra    : in actuals, not in goal (scope creep)
 *   - inScope  : in both (delivered on-spec)
 *   - driftPct : 100% when goal is empty AND extras exist (pure scope
 *                creep); otherwise missing.size / goal.size * 100,
 *                rounded to one decimal.
 *
 * @param {object|Set<string>|null|undefined} goal      contract or pre-extracted Set
 * @param {Array<object>|object|Set<string>|null|undefined} phaseOutputs
 * @returns {{
 *   driftPct: number,
 *   missing: string[],
 *   extra: string[],
 *   inScope: string[],
 *   goalCount: number,
 *   actualCount: number,
 * }}
 */
export function computeDrift(goal, phaseOutputs) {
  const goalSet = goal instanceof Set ? new Set(goal) : extractGoalFields(goal);
  const actualSet = phaseOutputs instanceof Set
    ? new Set(phaseOutputs)
    : mergePhaseFields(phaseOutputs);
  const missing = [];
  const inScope = [];
  for (const g of goalSet) {
    if (actualSet.has(g)) inScope.push(g);
    else missing.push(g);
  }
  const extra = [];
  for (const a of actualSet) {
    if (!goalSet.has(a)) extra.push(a);
  }
  missing.sort();
  extra.sort();
  inScope.sort();
  let driftPct;
  if (goalSet.size === 0) {
    driftPct = extra.length > 0 ? 100 : 0;
  } else {
    driftPct = oneDecimal((missing.length / goalSet.size) * 100);
  }
  return {
    driftPct,
    missing,
    extra,
    inScope,
    goalCount: goalSet.size,
    actualCount: actualSet.size,
  };
}
