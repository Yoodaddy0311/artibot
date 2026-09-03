/**
 * Problem Boundary — the 5-way classification of design 09.
 *
 *   Requested target → Direct behavior → Upstream causes → Downstream effects
 *   → Adjacent system
 *
 * | Class      | Meaning                          | Default action     |
 * |------------|----------------------------------|--------------------|
 * | direct     | the target itself                | always inspect     |
 * | upstream   | causes the target behavior       | inspect when causal|
 * | downstream | may regress from the change      | verify             |
 * | adjacent   | relevant but weakly causal       | optional           |
 * | unrelated  | not part of the mission          | exclude            |
 *
 * PURITY (design §1-8, L2): no clock, no filesystem, no randomness. The caller
 * supplies candidates already gathered; this module only classifies them.
 *
 * FAIL-CLOSED DIRECTION. "Scope may expand only with a causal justification"
 * (design 03). So a claimed relation WITHOUT evidence is demoted to `adjacent`,
 * never promoted to upstream/downstream, and anything unrecognized lands in
 * `unrelated`. Widening scope therefore costs evidence; narrowing costs nothing.
 *
 * WHAT THIS MODULE CANNOT SEE
 * ---------------------------
 *  - It does not discover candidates. It classifies the list it is given, so a
 *    candidate nobody collected is invisible here and will never appear as a
 *    blindspot either.
 *  - `relation` and `evidence` are asserted by the caller. This module checks
 *    that evidence is PRESENT, not that it is true. A caller that passes a
 *    fabricated `file:line` gets an upstream classification it did not earn.
 *  - Target matching is textual (path prefix / token overlap). It has no module
 *    graph, so a real causal edge expressed in neither the path nor the words
 *    reads as `unrelated`.
 *
 * @module lib/mission/problem-boundary
 */

import { tokenizeForFidelity } from './contract.js';

/** The 5 boundary classes, in causal order. */
export const BOUNDARY_CLASSES = Object.freeze([
  'direct',
  'upstream',
  'downstream',
  'adjacent',
  'unrelated',
]);

/**
 * Relations a caller may assert about a candidate.
 * `causes` → candidate causes the target's behavior (upstream when evidenced).
 * `affected-by` → candidate may regress from changing the target (downstream).
 * `related` → relevant but not claimed causal (adjacent at best).
 */
export const CANDIDATE_RELATIONS = Object.freeze(['causes', 'affected-by', 'related']);

/** Dispositions for a worker finding (design §6.1 asymmetry). */
export const FINDING_DISPOSITIONS = Object.freeze([
  'plan-revision',
  'intent-revision',
  'rejected',
]);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function hasEvidence(candidate) {
  const ev = candidate?.evidence;
  if (Array.isArray(ev)) return ev.some((e) => typeof e === 'string' && e.trim().length > 0);
  return typeof ev === 'string' && ev.trim().length > 0;
}

function matchesTarget(subject, targets) {
  const subj = normalizePath(subject);
  if (subj.length === 0) return null;
  for (const target of targets) {
    const t = normalizePath(target);
    if (t.length === 0) continue;
    if (subj === t || subj.startsWith(`${t}/`) || t.startsWith(`${subj}/`)) return target;
  }
  // Fall back to token overlap ONLY for a subject with no path separator, so a
  // plain word ("split") still matches a path target ("lib/split"). Applying it
  // to a path subject would match on a shared generic segment — "lib/tui/theme.js"
  // and "lib/split" both contain "lib" — and classify an unrelated file as
  // direct, which is scope expansion with no causal justification at all.
  if (subj.includes('/')) return null;
  const subjTokens = new Set(tokenizeForFidelity(subject));
  if (subjTokens.size === 0) return null;
  for (const target of targets) {
    const tt = tokenizeForFidelity(target);
    if (tt.some((tok) => subjTokens.has(tok))) return target;
  }
  return null;
}

/**
 * Classify one candidate against the requested targets.
 *
 * @param {object} candidate
 * @param {string} candidate.subject - Path or name the candidate refers to.
 * @param {'causes'|'affected-by'|'related'} [candidate.relation]
 * @param {string[]|string} [candidate.evidence] - Why the relation holds.
 * @param {object} [context]
 * @param {string[]} [context.requestedTarget] - `scope.requested_target`.
 * @returns {{class: string, subject: string, reason: string, matchedTarget: string|null}}
 */
export function classifyBoundary(candidate, context = {}) {
  const subject = typeof candidate?.subject === 'string' ? candidate.subject : '';
  const targets = Array.isArray(context.requestedTarget)
    ? context.requestedTarget.filter((t) => typeof t === 'string')
    : [];

  const matchedTarget = matchesTarget(subject, targets);
  if (matchedTarget !== null) {
    return {
      class: 'direct',
      subject,
      matchedTarget,
      reason: 'subject is (or is inside) a requested target',
    };
  }

  const relation = candidate?.relation;
  if (!CANDIDATE_RELATIONS.includes(relation)) {
    return {
      class: 'unrelated',
      subject,
      matchedTarget: null,
      reason: relation === undefined
        ? 'no relation asserted'
        : `unrecognized relation "${relation}" (fail-closed)`,
    };
  }

  if (relation === 'related') {
    return {
      class: 'adjacent',
      subject,
      matchedTarget: null,
      reason: 'relevant but no causal claim',
    };
  }

  if (!hasEvidence(candidate)) {
    return {
      class: 'adjacent',
      subject,
      matchedTarget: null,
      reason: `relation "${relation}" asserted without evidence — demoted, not promoted`,
    };
  }

  return relation === 'causes'
    ? { class: 'upstream', subject, matchedTarget: null, reason: 'evidenced cause of target behavior' }
    : { class: 'downstream', subject, matchedTarget: null, reason: 'evidenced to regress from the change' };
}

/**
 * Classify a whole candidate list and project it into a contract `scope`.
 *
 * `adjacent` is deliberately NOT written into `scope`: design 09 makes it
 * "optional", and putting it in scope would be scope expansion without causal
 * justification. `unrelated` becomes `scope.excluded`, which records the
 * decision instead of hiding it.
 *
 * @param {object} input
 * @param {string[]} input.requestedTarget
 * @param {object[]} [input.candidates]
 * @returns {{scope: object, classified: Record<string, object[]>}}
 */
export function buildScope(input = {}) {
  const requestedTarget = Array.isArray(input.requestedTarget)
    ? input.requestedTarget.filter((t) => typeof t === 'string' && t.length > 0)
    : [];
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];

  const classified = { direct: [], upstream: [], downstream: [], adjacent: [], unrelated: [] };
  for (const candidate of candidates) {
    const result = classifyBoundary(candidate, { requestedTarget });
    classified[result.class].push(result);
  }

  const scope = {
    requested_target: requestedTarget,
    direct: classified.direct.map((c) => c.subject),
    upstream: classified.upstream.map((c) => c.subject),
    downstream: classified.downstream.map((c) => c.subject),
    excluded: classified.unrelated.map((c) => c.subject),
  };

  return { scope, classified };
}

/**
 * Classify a worker finding into a revision disposition (design §6.1).
 *
 * The rule is ASYMMETRIC on purpose. A finding that only WIDENS
 * scope.upstream/downstream needs a plan revision and the worker keeps going.
 * A finding that narrows, replaces, or deletes an `explicit_requests` entry (or
 * a `success.functional` criterion) requires an intent revision through the
 * planner, and the worker stops. That asymmetry is exactly what Intent Fidelity
 * protects: the failure mode on record is "a more sophisticated reading quietly
 * substitutes the user's stated request".
 *
 * A finding with no evidence is `rejected` — v1.1 04's "implementation becomes
 * inconvenient is not a reason to change intent" is enforced here.
 *
 * @param {object} finding
 * @param {'widen-scope'|'narrow-explicit'|'replace-explicit'|'change-success'} finding.kind
 * @param {string[]|string} [finding.evidence]
 * @param {string} [finding.subject]
 * @param {object} [contract] - Present contract; used only for reporting.
 * @returns {{disposition: string, reason: string, blocksWorker: boolean}}
 */
export function classifyFinding(finding, contract = null) {
  const kind = finding?.kind;
  if (!hasEvidence(finding)) {
    return {
      disposition: 'rejected',
      reason: 'finding carries no evidence; inconvenience is not a revision reason',
      blocksWorker: false,
    };
  }

  if (kind === 'widen-scope') {
    return {
      disposition: 'plan-revision',
      reason: 'widens scope.upstream/downstream only — intent untouched',
      blocksWorker: false,
    };
  }

  if (kind === 'narrow-explicit' || kind === 'replace-explicit' || kind === 'change-success') {
    const count = Array.isArray(contract?.explicit_requests)
      ? contract.explicit_requests.length
      : null;
    return {
      disposition: 'intent-revision',
      reason: `"${kind}" touches the protected list`
        + (count === null ? '' : ` (${count} explicit request(s))`)
        + ' — planner must revise intent; worker stops',
      blocksWorker: true,
    };
  }

  return {
    disposition: 'rejected',
    reason: kind === undefined
      ? 'no finding kind given'
      : `unrecognized finding kind "${kind}" (fail-closed)`,
    blocksWorker: false,
  };
}
