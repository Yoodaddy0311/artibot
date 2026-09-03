/**
 * Completion gates for `artifact-lifecycle.js` (PRD 부록 A T-40, split per
 * T-51 review). **Pure. No I/O, no filesystem, no imports.**
 *
 * ## Why this is a separate file
 *
 * Two different jobs live in the lifecycle handler. One is *routing* — which
 * event makes which artifact, at which path, under which idempotency key. The
 * other is *judgment* — may this artifact be written at all, given the
 * verification result, the review verdict, the unanswered questions, and the
 * dependency edges. The second job is where the design's contested decisions sit
 * (§3.4's completion conditions, §5's staleness propagation, owner decision C4),
 * and it grows every time one of them is settled. Keeping it here means the
 * routing file does not grow with it, and a reviewer looking for "what can stop
 * an outcome.md" has one place to look.
 *
 * The dependency runs one way: this module imports nothing, and
 * `artifact-lifecycle.js` imports it. Anything both files need — the artifact
 * vocabulary, the small predicates — lives here, because the alternative is a
 * cycle. Nothing here knows about paths, events-to-artifacts mapping, or
 * writing; those stay in the parent.
 *
 * ## What "gate" means here
 *
 * A gate returns a {@link BlockCode} or `undefined`. It never throws, never
 * writes, and never decides *whether an artifact was requested* — only whether a
 * requested one may proceed. Refusals (unknown event, malformed envelope) are
 * the parent's business; blocks are this module's.
 *
 * @module lib/runtime/artifact-lifecycle-gates
 */

/** The four canonical mission artifacts (governance 08). */
export const ArtifactKind = Object.freeze({
  INTENT: 'intent',
  PLAN: 'plan',
  REVIEW: 'review',
  OUTCOME: 'outcome',
});

/** Why a planned write is blocked. Closed vocabulary. */
export const BlockCode = Object.freeze({
  /** design §3.4 ①: a layer that was not measured is not a PASS. */
  UNMEASURED_VERIFICATION: 'UNMEASURED_VERIFICATION',
  /** design §3.4 ①: `## Review` verdict must be PASS. */
  REVIEW_VERDICT_NOT_PASS: 'REVIEW_VERDICT_NOT_PASS',
  /** design §3.4 OD-5: `human.asked` with no matching `human.resolved`. */
  HUMAN_QUESTION_UNRESOLVED: 'HUMAN_QUESTION_UNRESOLVED',
  /** design §3.4 §5.5: the join key disagrees across its three carriers. */
  VERIFICATION_ID_MISMATCH: 'VERIFICATION_ID_MISMATCH',
  /** design §3.4 §5.5, fail-closed companion: no id to join on at all. */
  VERIFICATION_ID_MISSING: 'VERIFICATION_ID_MISSING',
  /** Hardening §5 + §33 "Latest Plan not stale". */
  PLAN_STALE: 'PLAN_STALE',
  /** Hardening §5: intent moved, so the review no longer reviewed this intent. */
  REVIEW_INVALID: 'REVIEW_INVALID',
  /** Hardening §5 / `/doctor` Check 9: `based_on` absent or impossible. */
  BASED_ON_BROKEN: 'BASED_ON_BROKEN',
});

/**
 * Staleness classification (Hardening §5).
 *
 * The three downstream values are §5's propagation table verbatim; `CURRENT` and
 * `BROKEN` are the two states §5 leaves implicit. `BROKEN` is the fail-closed
 * answer for "cannot tell": `based_on` missing, or claiming a revision the
 * mission has never reached.
 */
export const StaleState = Object.freeze({
  CURRENT: 'CURRENT',
  STALE: 'STALE',
  INVALID: 'INVALID',
  NOT_ACCEPTABLE: 'NOT_ACCEPTABLE',
  BROKEN: 'BROKEN',
});

/** design §3.4 verdict v2, five values. Only `PASS` opens the completion gate. */
export const REVIEW_VERDICT_PASS = 'PASS';

/** `verify_result` enum value design §3.4 refuses to read as a PASS. */
export const VERIFY_RESULT_UNMEASURED = 'unmeasured';

/** `verify_result` members, so per-layer counts stay a closed vocabulary. */
const VERIFY_RESULTS = Object.freeze(['pass', 'fail', VERIFY_RESULT_UNMEASURED]);

/**
 * Policy knobs, and the only one that exists today.
 *
 * `unmeasuredBlocksOutcome` is a **C4 placeholder**. Owner decision C4 ("층별
 * 필수/선택 config, Observe 는 카운트만") is open, and hard-coding the block
 * would settle it in the blocking direction before the owner ruled. So the
 * judgment is a parameter with a fail-closed default: `true` keeps today's
 * behaviour, `false` counts without blocking. **When C4 is decided this moves to
 * `artibot.config.json` and a per-layer required/optional map replaces the
 * boolean** — this constant is the seam, not the answer.
 */
export const DEFAULT_POLICY = Object.freeze({ unmeasuredBlocksOutcome: true });

/**
 * Layer bucket for a `verify.completed` that names no layer.
 *
 * Deliberately **not** the string `unmeasured`: that is a `verify_result` value,
 * and reusing it would conflate two different axes — "nobody recorded which
 * layer this measured" versus "this layer's result was unmeasured". A finding of
 * `{layer: 'unspecified', counts: {pass: 3}}` is three PASSes whose layer went
 * unrecorded, which the old name made unreadable.
 */
export const LAYER_UNSPECIFIED = 'unspecified';

/**
 * Bucket for a `layer` present but not a plain identifier. Layer names are the
 * one place event payload reaches the plan output, so anything outside
 * {@link LAYER_NAME_PATTERN} is counted here instead of echoed — that is what
 * keeps §25's closed-vocabulary property intact on a caller-supplied axis.
 */
export const LAYER_UNRECOGNISED = 'unrecognised';

/**
 * Shape a `data.layer` must match to be echoed as itself.
 *
 * Wide enough for the landed vocabulary — `unified-verifier.js:109` exports
 * `LAYERS = ['deterministic', 'behavioral', 'operational']` — without importing
 * it. The import is deliberately not taken: L5 to L2 would be a legal direction,
 * but this module's contract is zero imports, and pinning the pattern to a
 * snapshot of another module's enum would make a new layer name a silent
 * `LAYER_UNRECOGNISED` instead of a counted one. The pattern accepts any plain
 * lowercase identifier, so a fourth layer needs no change here.
 */
export const LAYER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Non-blocking observations. Observe counts; it does not act. */
export const FindingCode = Object.freeze({
  /** Per-layer `verify.completed` tally (design §3.4 3층, owner decision C4). */
  VERIFICATION_LAYER: 'VERIFICATION_LAYER',
});

/**
 * The staleness verdict a downstream artifact receives when intent moves.
 *
 * Hardening §5: `Plan → STALE`, `Review → INVALID`, `Outcome → NOT ACCEPTABLE`.
 * Intent is the root and never has a `based_on` (§5 shows `based_on` only from
 * plan downward), so it is absent from this table by design.
 */
const STALE_VERDICT_BY_KIND = Object.freeze({
  [ArtifactKind.PLAN]: StaleState.STALE,
  [ArtifactKind.REVIEW]: StaleState.INVALID,
  [ArtifactKind.OUTCOME]: StaleState.NOT_ACCEPTABLE,
});

/** Which `based_on` members each kind is expected to carry (Hardening §5). */
const BASED_ON_MEMBERS_BY_KIND = Object.freeze({
  [ArtifactKind.PLAN]: Object.freeze(['intent_revision']),
  [ArtifactKind.REVIEW]: Object.freeze(['intent_revision', 'plan_revision']),
  [ArtifactKind.OUTCOME]: Object.freeze([
    'intent_revision',
    'plan_revision',
    'review_revision',
  ]),
});

/** `based_on` member ↔ the live revision it is compared against. */
const CURRENT_KEY_BY_MEMBER = Object.freeze({
  intent_revision: 'intentRevision',
  plan_revision: 'planRevision',
  review_revision: 'reviewRevision',
});

/** Shared predicate. Lives here because both files need it and cycles are worse. */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A revision is a non-negative integer; anything else is unusable, not zero. */
export function isRevision(v) {
  return Number.isInteger(v) && v >= 0;
}

/**
 * Classify one artifact against the mission's live revisions. Pure.
 *
 * Hardening §5 requires the **runtime**, not the agent, to decide this. The
 * comparison is per `based_on` member: any member behind its live counterpart
 * makes the artifact stale in that kind's vocabulary. A member ahead of the live
 * revision is `BROKEN` rather than current — claiming a revision the mission
 * never reached is a broken dependency edge (`/doctor` Check 9), not a fresh one.
 *
 * @param {{kind: string, basedOn?: object|null, current?: object}} input
 * @returns {{state: string, kind: string, staleMembers: string[]}}
 */
export function classifyStaleness(input) {
  const { kind, basedOn, current } = input ?? {};
  if (!Object.values(ArtifactKind).includes(kind)) {
    throw new TypeError(`artifact-lifecycle: unknown artifact kind "${kind}"`);
  }
  // Intent is the root: no `based_on`, so nothing can make it stale.
  if (kind === ArtifactKind.INTENT) {
    return { state: StaleState.CURRENT, kind, staleMembers: [] };
  }

  const expected = BASED_ON_MEMBERS_BY_KIND[kind];
  if (!isPlainObject(basedOn)) {
    return { state: StaleState.BROKEN, kind, staleMembers: [...expected] };
  }

  const live = isPlainObject(current) ? current : {};
  const staleMembers = [];
  const brokenMembers = [];

  for (const member of expected) {
    const declared = basedOn[member];
    const liveValue = live[CURRENT_KEY_BY_MEMBER[member]];
    if (!isRevision(declared) || !isRevision(liveValue)) {
      // Either side unreadable => cannot assert freshness => fail closed.
      brokenMembers.push(member);
    } else if (declared > liveValue) {
      brokenMembers.push(member);
    } else if (declared < liveValue) {
      staleMembers.push(member);
    }
  }

  if (brokenMembers.length > 0) {
    return { state: StaleState.BROKEN, kind, staleMembers: brokenMembers };
  }
  if (staleMembers.length > 0) {
    return { state: STALE_VERDICT_BY_KIND[kind], kind, staleMembers };
  }
  return { state: StaleState.CURRENT, kind, staleMembers: [] };
}

/**
 * Classify the mission's existing plan and review edges (Hardening §5).
 *
 * These two, and not the outcome, because they are the edges the completion gate
 * reads: an outcome that does not exist yet has no `based_on` to judge.
 */
export function buildStaleness(missionState, current) {
  const artifacts = isPlainObject(missionState.artifacts) ? missionState.artifacts : {};
  return {
    plan: classifyStaleness({
      kind: ArtifactKind.PLAN,
      basedOn: artifacts.plan?.based_on,
      current,
    }),
    review: classifyStaleness({
      kind: ArtifactKind.REVIEW,
      basedOn: artifacts.review?.based_on,
      current,
    }),
  };
}

/**
 * Bucket one `verify.completed` into its layer tally. Counting only — never
 * blocking, which is the whole point of doing this in Observe (decision C4).
 */
function tallyLayer(layers, data) {
  const raw = data.layer;
  let layer;
  if (typeof raw !== 'string' || raw.length === 0) layer = LAYER_UNSPECIFIED;
  else if (!LAYER_NAME_PATTERN.test(raw)) layer = LAYER_UNRECOGNISED;
  else layer = raw;

  if (!layers.has(layer)) {
    layers.set(layer, { pass: 0, fail: 0, [VERIFY_RESULT_UNMEASURED]: 0, other: 0 });
  }
  const counts = layers.get(layer);
  const result = VERIFY_RESULTS.includes(data.result) ? data.result : 'other';
  counts[result] += 1;
}

/** Render the layer tally as `findings[]`. Non-blocking observations only. */
export function buildFindings(gate, redact) {
  const findings = [];
  for (const [layer, counts] of gate.layers) {
    findings.push({
      code: FindingCode.VERIFICATION_LAYER,
      layer: redact(layer),
      counts: { ...counts },
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    });
  }
  return findings;
}

/** Fold the events this module cares about into one gate-input snapshot. */
export function foldGateState(events) {
  const gate = {
    askedOrder: [],
    resolvedIds: [],
    unkeyedResolves: 0,
    lastVerdict: undefined,
    lastAccepted: undefined,
    reviewVerificationId: undefined,
    missionVerificationId: undefined,
    verifierVerificationId: undefined,
    sawUnmeasured: false,
    // Insertion-ordered so `findings` comes out in ledger order, not hash order.
    layers: new Map(),
  };

  for (const { event, data } of events) {
    if (event === 'review.completed') {
      gate.lastVerdict = data.verdict;
      if (typeof data.verification_id === 'string') {
        gate.reviewVerificationId = data.verification_id;
      }
    } else if (event === 'mission.completed') {
      // The allowlist makes `accepted` three-valued and append-only: a later
      // line supersedes an earlier one, and the reader takes the last value.
      gate.lastAccepted = data.accepted;
      if (typeof data.verification_id === 'string') {
        gate.missionVerificationId = data.verification_id;
      }
    } else if (event === 'verify.completed') {
      if (typeof data.verification_id === 'string') {
        gate.verifierVerificationId = data.verification_id;
      }
      if (data.result === VERIFY_RESULT_UNMEASURED) gate.sawUnmeasured = true;
      tallyLayer(gate.layers, data);
    } else if (event === 'human.asked') {
      gate.askedOrder.push(data.question_id);
    } else if (event === 'human.resolved') {
      const qid = data.question_id;
      if (typeof qid === 'string' && qid.length > 0) gate.resolvedIds.push(qid);
      else gate.unkeyedResolves += 1;
    }
  }

  return gate;
}

/**
 * Unanswered-question count (design §3.4 OD-5).
 *
 * Matching is two-tier because the landed vocabulary makes it necessary:
 * `human.asked` requires `question_id`, but `human.resolved` requires only
 * `decision` and declares no `question_id`
 * (`schemas/ledger-events.allowlist.json`). So a resolve carrying a
 * `question_id` closes that specific ask, and a resolve without one closes the
 * oldest still-open ask in ledger order. Requiring the id on both sides would
 * make every question permanently unanswerable under today's schema, while FIFO
 * consumption keeps the count honest (more asks than resolves still blocks)
 * without inventing a field.
 */
function countUnresolvedQuestions(gate) {
  const open = new Set(gate.askedOrder);
  for (const qid of gate.resolvedIds) open.delete(qid);
  let budget = gate.unkeyedResolves;
  for (const qid of gate.askedOrder) {
    if (budget === 0) break;
    if (open.delete(qid)) budget -= 1;
  }
  return open.size;
}

/** All non-empty verification ids seen across the three carriers. */
function verificationIdCarriers(gate) {
  return [
    gate.verifierVerificationId,
    gate.reviewVerificationId,
    gate.missionVerificationId,
  ].filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Gates that stand between `mission.completed` and `outcome.md`.
 *
 * The UNMEASURED gate is the one that answers to policy, because owner decision
 * C4 is still open — see {@link DEFAULT_POLICY}. With
 * `unmeasuredBlocksOutcome: false` the layer counts are still recorded in
 * `findings`; only the block is withheld. Every other gate here rests on a
 * settled decision and takes no parameter.
 */
function outcomeBlockCode(gate, staleness, policy) {
  // design §3.4 ①: UNMEASURED first — "재지 못한 것을 PASS 라 부르지 않는다".
  if (gate.sawUnmeasured && policy.unmeasuredBlocksOutcome) {
    return BlockCode.UNMEASURED_VERIFICATION;
  }
  if (gate.lastVerdict !== REVIEW_VERDICT_PASS) return BlockCode.REVIEW_VERDICT_NOT_PASS;
  if (countUnresolvedQuestions(gate) > 0) return BlockCode.HUMAN_QUESTION_UNRESOLVED;

  const carriers = verificationIdCarriers(gate);
  if (new Set(carriers).size > 1) return BlockCode.VERIFICATION_ID_MISMATCH;
  // design §3.4 §5.5 wants the same id in all three places. A silent carrier
  // cannot be joined either, so a missing one blocks rather than passes.
  if (carriers.length < 3) return BlockCode.VERIFICATION_ID_MISSING;

  if (staleness.plan.state === StaleState.BROKEN) return BlockCode.BASED_ON_BROKEN;
  if (staleness.review.state === StaleState.BROKEN) return BlockCode.BASED_ON_BROKEN;
  // Hardening §33 completion gate: "Latest Plan not stale".
  if (staleness.plan.state === StaleState.STALE) return BlockCode.PLAN_STALE;
  if (staleness.review.state === StaleState.INVALID) return BlockCode.REVIEW_INVALID;
  return undefined;
}

/**
 * Which gate, if any, blocks this kind.
 *
 * `intent.md` and `plan.md` are never blocked: they *record* a revision, so
 * blocking them would lose the very fact that moved the mission. `review.md` is
 * blocked when the intent moved out from under it — design §5.2's
 * `assertIntentBinding` ("검수 완료 시점 intent_revision 을 재확인, 다르면 그
 * 검수는 무효"). `outcome.md` carries the full completion gate. A `BROKEN`
 * review edge does not block the review write itself (it is being created now,
 * against the live revisions), but it does block the outcome, where the edge
 * must already exist.
 */
export function blockCodeFor(kind, gate, staleness, policy) {
  if (kind === ArtifactKind.OUTCOME) return outcomeBlockCode(gate, staleness, policy);
  if (kind === ArtifactKind.REVIEW && staleness.review.state === StaleState.INVALID) {
    return BlockCode.REVIEW_INVALID;
  }
  return undefined;
}
