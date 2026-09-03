/**
 * State precedence — the 8-tier conflict order of v1.1 §02.
 *
 * When two sources disagree about what is true, this module says which one
 * wins and why. The order is quoted verbatim from
 * `.artibot/guides/v5-design/package-v1.1/02_CANONICAL_PROJECT_STATE.md`
 * ("State precedence"), which closes with "This precedence should be encoded
 * in runtime policy" — this file is that encoding.
 *
 * ── The trap the design names (ARTIBOT-5.0-DESIGN.md §3.1) ───────────────────
 * Tier 1 is *verified* repository state, NOT "a file exists". A candidate
 * that carries no `verifiedBy` is therefore SKIPPED, not merely demoted. That
 * is deliberately fail-closed: demoting an unverified tier-1 claim to tier 2
 * would let "I looked and the file was there" outrank the state store, which
 * is exactly the substitution verification-discipline §2 forbids.
 *
 * The rule applies to every tier, not only tier 1. A skipped source is
 * reported in `skipped[]`; it never silently disappears.
 *
 * ── Why a lower source winning is a warning ────────────────────────────────
 * If the winner is not tier 1, some higher tier was empty or unverified. That
 * is information the caller needs: design §3.1 reads it as "정보구조 결함 신호"
 * — a signal that the upper slot is empty, not merely that the lower one is
 * right. So `resolveConflict` still returns a winner and additionally warns.
 *
 * ── Two conflict directions ────────────────────────────────────────────────
 * design §3.1 fixes both, and they are not symmetric:
 *   - verified repo state beats `intent.md` -> do NOT edit the intent. The
 *     repo being ahead of the intent is a COMPLETION judgement.
 *   - `plan.md` disagrees with `intent.md` -> the intent wins and the PLAN is
 *     revised.
 * `conflictAction()` returns those, and `null` for any pair the design does
 * not rule on, rather than guessing a third policy.
 *
 * Pure: no clock, no filesystem, no I/O. Consumers (compile-time prior
 * context lookup, substantive S6 judgement, conflict resolution) live in
 * other modules; this one has zero call sites in the Observe phase by design.
 *
 * @module lib/project-state/precedence
 */

/**
 * The 8 tiers, highest authority first. Index + 1 is the tier number.
 *
 * The ids are this module's vocabulary; the prose each one maps to is in the
 * `PRECEDENCE_LABELS` table below so a caller can render a warning without
 * re-deriving the mapping from the design document.
 */
export const PRECEDENCE_ORDER = Object.freeze([
  'verified-repo-state',
  'state-yaml',
  'intent-md',
  'plan-md',
  'adr',
  'historical-outcome',
  'memory',
  'old-runtime-logs',
]);

/** Human-readable label per source id, matching the v1.1 §02 wording. */
export const PRECEDENCE_LABELS = Object.freeze({
  'verified-repo-state': 'current verified repository/environment state',
  'state-yaml': 'state.yaml',
  'intent-md': 'active mission intent.md',
  'plan-md': 'active mission plan.md',
  adr: 'ADR',
  'historical-outcome': 'historical outcome',
  memory: 'memory',
  'old-runtime-logs': 'old runtime logs',
});

/** Frozen id -> tier number (1..8) map. */
export const PRECEDENCE_RANK = Object.freeze(
  Object.fromEntries(PRECEDENCE_ORDER.map((id, i) => [id, i + 1])),
);

/**
 * Tier number of a source id.
 *
 * @param {string} source - A `PRECEDENCE_ORDER` id.
 * @returns {number|null} 1..8, or null when the id is not in the table.
 */
export function precedenceRank(source) {
  return Object.hasOwn(PRECEDENCE_RANK, source) ? PRECEDENCE_RANK[source] : null;
}

/**
 * Compare two source ids by authority.
 *
 * @param {string} a - First source id.
 * @param {string} b - Second source id.
 * @returns {number} Negative when `a` outranks `b`, positive when `b` does, 0 when equal.
 * @throws {TypeError} When either id is unknown — an unknown id has no defined
 *   authority, and treating it as "lowest" would be a fail-open guess.
 */
export function comparePrecedence(a, b) {
  const ra = precedenceRank(a);
  const rb = precedenceRank(b);
  if (ra === null) throw new TypeError(`precedence: unknown source '${a}'`);
  if (rb === null) throw new TypeError(`precedence: unknown source '${b}'`);
  return ra - rb;
}

/**
 * Whether a candidate carries acceptable verification evidence.
 *
 * Accepts a non-empty string or a non-empty array of non-empty strings. An
 * empty array is NOT evidence: it is the shape of "I meant to fill this in".
 *
 * @param {unknown} verifiedBy - The candidate's `verifiedBy` field.
 * @returns {boolean} True when the evidence is usable.
 */
export function hasVerification(verifiedBy) {
  if (typeof verifiedBy === 'string') return verifiedBy.trim() !== '';
  if (Array.isArray(verifiedBy)) {
    return verifiedBy.length > 0 && verifiedBy.every((v) => typeof v === 'string' && v.trim() !== '');
  }
  return false;
}

/**
 * @typedef {object} PrecedenceCandidate
 * @property {string} source - A `PRECEDENCE_ORDER` id.
 * @property {unknown} [value] - Whatever the source asserts.
 * @property {string|string[]} [verifiedBy] - Evidence that the assertion was
 *   measured, e.g. a command that was run or a `file:line` citation. Absent or
 *   empty means the candidate is skipped.
 */

/**
 * @typedef {object} PrecedenceWarning
 * @property {string} code - One of `unverified-source-skipped`,
 *   `unknown-source-skipped`, `duplicate-source`, `lower-source-won`,
 *   `no-verified-candidate`.
 * @property {string} message - Human-readable explanation.
 * @property {string} [source] - The source the warning is about.
 */

/**
 * Partition candidates into verified entries and skip warnings.
 *
 * @param {PrecedenceCandidate[]} candidates - Candidates to partition.
 * @returns {{kept: PrecedenceCandidate[], skipped: object[], warnings: PrecedenceWarning[]}}
 *   Kept candidates, skip records, and the warnings describing them.
 */
function partitionCandidates(candidates) {
  const kept = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const source = candidate?.source;
    if (precedenceRank(source) === null) {
      skipped.push({ source, reason: 'unknown-source' });
      warnings.push({
        code: 'unknown-source-skipped',
        source,
        message: `precedence: '${String(source)}' is not one of the 8 tiers — skipped rather than ranked last`,
      });
      continue;
    }
    if (!hasVerification(candidate.verifiedBy)) {
      skipped.push({ source, reason: 'unverified' });
      warnings.push({
        code: 'unverified-source-skipped',
        source,
        message: `precedence: '${source}' has no verifiedBy — skipped (fail-closed; existence is not verification)`,
      });
      continue;
    }
    if (seen.has(source)) {
      warnings.push({
        code: 'duplicate-source',
        source,
        message: `precedence: '${source}' appears more than once — first occurrence kept, later ones ignored`,
      });
      continue;
    }
    seen.add(source);
    kept.push(candidate);
  }
  return { kept, skipped, warnings };
}

/**
 * Resolve a conflict between sources.
 *
 * @param {PrecedenceCandidate[]} candidates - Competing assertions.
 * @returns {{resolved: boolean, winner: PrecedenceCandidate|null, rank: number|null,
 *   losers: PrecedenceCandidate[], skipped: object[], warnings: PrecedenceWarning[]}}
 *   `resolved` is false only when nothing survived the verification filter.
 * @throws {TypeError} When `candidates` is not an array.
 * @example
 * resolveConflict([
 *   { source: 'plan-md', value: 'A' },
 *   { source: 'intent-md', value: 'B', verifiedBy: 'read intent.md:12' },
 * ]);
 * // winner.source === 'intent-md'; plan-md skipped (no verifiedBy);
 * // warnings include lower-source-won, because tiers 1-2 were empty.
 */
export function resolveConflict(candidates) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('precedence: candidates must be an array');
  }
  const { kept, skipped, warnings } = partitionCandidates(candidates);

  if (kept.length === 0) {
    warnings.push({
      code: 'no-verified-candidate',
      message:
        'precedence: no candidate carried verifiedBy — nothing is resolved. '
        + 'Measure a source rather than falling back to the least-unverified one.',
    });
    return { resolved: false, winner: null, rank: null, losers: [], skipped, warnings };
  }

  const ordered = [...kept].sort((a, b) => comparePrecedence(a.source, b.source));
  const winner = ordered[0];
  const rank = precedenceRank(winner.source);

  if (rank > 1) {
    warnings.push({
      code: 'lower-source-won',
      source: winner.source,
      message:
        `precedence: tier ${rank} ('${PRECEDENCE_LABELS[winner.source]}') won because tiers 1-${rank - 1} `
        + 'were absent or unverified — treat the empty upper slot as an information-structure defect, not as agreement',
    });
  }

  return { resolved: true, winner, rank, losers: ordered.slice(1), skipped, warnings };
}

/**
 * What to DO about a resolved conflict, for the two directions the design
 * rules on (ARTIBOT-5.0-DESIGN.md §3.1).
 *
 * @param {string} winnerSource - Source id that won.
 * @param {string} loserSource - Source id that lost.
 * @returns {{action: string, rationale: string}|null} The prescribed action, or
 *   null when the design does not rule on this pair.
 * @example
 * conflictAction('verified-repo-state', 'intent-md').action; // 'record-completion'
 * conflictAction('intent-md', 'plan-md').action;             // 'revise-plan'
 */
export function conflictAction(winnerSource, loserSource) {
  if (winnerSource === 'verified-repo-state' && loserSource === 'intent-md') {
    return {
      action: 'record-completion',
      rationale:
        'A verified repo ahead of the intent is evidence the work is DONE. '
        + 'Record a completion judgement; do not edit intent.md to match the repo.',
    };
  }
  if (winnerSource === 'intent-md' && loserSource === 'plan-md') {
    return {
      action: 'revise-plan',
      rationale:
        'The intent outranks the plan, so the plan is revised in place '
        + '(a numbered revision in one file, never plan-v2.md).',
    };
  }
  return null;
}
