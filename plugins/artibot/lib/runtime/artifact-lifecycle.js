/**
 * Event → artifact handler skeleton (PRD 부록 A T-40). **Dry-run only.**
 *
 * Hardening §6 inverts who owns mission documentation:
 *
 * > **Documentation is a Runtime Side Effect.**
 *
 * An agent told to "update intent.md, update plan.md, update state, append to
 * the ledger" will eventually skip one. So the runtime makes the documents and
 * commands/agents emit **events only** — design §7.2 §6, which routes every
 * writer in design §3.3's migration table through this one handler.
 *
 * **Writes zero files.** Design §7.3 places artifact-lifecycle (§48 #10) in
 * Shadow, behind Observe — "기록만, 행동 변화 0, **산출물 파일 생성 0**". So
 * {@link plan} returns the writes it *would* make and {@link apply} exists only
 * to be fail-closed. There is deliberately no `fs` import: its absence is a
 * stronger proof than a spy, and the test asserts both.
 *
 * **L5. One sibling import, by design** (design §1-8): only
 * `./artifact-lifecycle-gates.js`, which this file layers on top of and which
 * imports nothing itself. `lib/runtime/{event-writer,ledger}.js` (T-20) are
 * **not** imported — events arrive as an argument and redaction as a port, so
 * nothing here depends on a sibling still in flight.
 *
 * **The four handlers** are {@link EVENT_TO_ARTIFACT}; the gates that can stop
 * one are {@link BlockCode}, and events that produce nothing are
 * {@link RefusalCode}. Blocked writes stay in `writes[]` rather than moving to
 * `refused[]` because "what would have been blocked" is the Shadow metric
 * (design §3.4: "outcome.md 조건을 적용했다면 막혔을 건수 / 완료 선언 총수").
 *
 * **`plan.revised`, not `plan.accepted`.** Hardening §6 (line 296) names
 * `plan.accepted`, which does not exist in the landed T-15 vocabulary
 * (`schemas/ledger-events.allowlist.json`, 36 events). The leader ruled the
 * allowlist canon and logged the §6 wording as a defect in the design §0-2
 * correction table — an event nothing can emit cannot trigger a handler.
 * §6 also lists `adr.accepted`; no `adr.*` event exists either, so ADR is
 * deliberately not implemented (decision B2 open) rather than invented.
 *
 * **Closed vocabulary, not trusted redaction.** §25 forbids secrets reaching
 * artifacts and the ledger; design §7.2 §25 resolves it as reuse with no new
 * patterns, but `lib/core/guard-registry.js` does not export its patterns and
 * copying them would fork the vocabulary. So redaction is a port
 * ({@link plan}'s `ports.redact`) — defence in depth, not the control. The
 * control is that every emitted string comes from a closed vocabulary: paths
 * from a `mission_id` matching {@link MISSION_ID_PATTERN}, `kind` from four
 * constants, codes from {@link WriteReason} / {@link BlockCode}. The one
 * caller-supplied axis is a finding's `layer`, normalised by
 * {@link LAYER_NAME_PATTERN} before it can be echoed.
 *
 * @module lib/runtime/artifact-lifecycle
 */

import {
  ArtifactKind,
  blockCodeFor,
  buildFindings,
  buildStaleness,
  DEFAULT_POLICY,
  foldGateState,
  isPlainObject,
  isRevision,
} from './artifact-lifecycle-gates.js';
import path from 'node:path';

// The completion gates and the staleness vocabulary live in the sibling module
// (T-51 review): this file routes events to paths, that one judges whether a
// routed artifact may be written. They are re-exported here so the public
// surface stays one import for callers, and so a consumer never has to know
// which half a symbol came from.
export {
  ArtifactKind,
  BlockCode,
  DEFAULT_POLICY,
  FindingCode,
  LAYER_NAME_PATTERN,
  LAYER_UNRECOGNISED,
  LAYER_UNSPECIFIED,
  REVIEW_VERDICT_PASS,
  StaleState,
  VERIFY_RESULT_UNMEASURED,
  classifyStaleness,
} from './artifact-lifecycle-gates.js';

/**
 * Canonical mission directory, relative to the project root.
 *
 * `.artibot/missions/<mission_id>/` — fixed by
 * `schemas/mission-contract.schema.json:4` and `schemas/intent-md.template.md:103`.
 */
export const MISSIONS_DIR = Object.freeze(['.artibot', 'missions']);

/**
 * Mission id shape.
 *
 * Byte-identical to `schemas/ledger-envelope.schema.json#/properties/mission_id`.
 * Duplicated because this file must not read from disk; a test loads the schema
 * and compares the two, so a change to either side turns the suite red rather
 * than letting the copies diverge. Two forms: issued `M-YYYYMMDD-NNN` (NNN may
 * exceed three digits) and the session fallback `M-YYYYMMDD-S<sid8>`.
 */
export const MISSION_ID_PATTERN = /^M-\d{8}-(?:\d{3,}|S[0-9A-Za-z]{8})$/;

/** `kind` → on-disk basename. Derived-file names are structurally unreachable. */
export const ARTIFACT_BASENAME = Object.freeze({
  [ArtifactKind.INTENT]: 'intent.md',
  [ArtifactKind.PLAN]: 'plan.md',
  [ArtifactKind.REVIEW]: 'review.md',
  [ArtifactKind.OUTCOME]: 'outcome.md',
});

/**
 * The handler table — Hardening §6, bound to the landed T-15 vocabulary.
 *
 * This is an ALLOWLIST. An event absent from it produces no write, which is the
 * fail-closed direction: a future event name cannot silently acquire the power
 * to create a mission artifact.
 */
export const EVENT_TO_ARTIFACT = Object.freeze({
  'mission.created': ArtifactKind.INTENT,
  'plan.revised': ArtifactKind.PLAN,
  'review.completed': ArtifactKind.REVIEW,
  'mission.completed': ArtifactKind.OUTCOME,
});

/**
 * Events this module reads but never turns into an artifact.
 *
 * They feed the completion gates: `verify.completed` issues the
 * `verification_id` and carries the result, `human.asked` / `human.resolved` are
 * the unanswered-question pair (design §3.4 OD-5). Listing them keeps
 * {@link RefusalCode.EVENT_UNKNOWN} meaningful — an allowlisted non-trigger is
 * `EVENT_NOT_HANDLED` (severity `skip`), not an error.
 */
export const GATE_EVENTS = Object.freeze([
  'verify.completed',
  'human.asked',
  'human.resolved',
]);

/**
 * Required `data` fields per event, mirroring
 * `schemas/ledger-events.allowlist.json#/events/<name>/required`.
 *
 * Duplicated for the same reason as {@link MISSION_ID_PATTERN}, and closed by
 * the same kind of drift test: the suite loads the allowlist and asserts these
 * entries equal the schema's `required` arrays for every event named here.
 */
export const REQUIRED_EVENT_DATA = Object.freeze({
  'mission.created': Object.freeze(['title', 'intent_revision']),
  'plan.revised': Object.freeze(['revision', 'mode']),
  'review.completed': Object.freeze(['verdict', 'findings_ref']),
  'mission.completed': Object.freeze(['accepted', 'evidence_refs']),
  'verify.completed': Object.freeze(['result', 'evidence']),
  'human.asked': Object.freeze(['question_id']),
  'human.resolved': Object.freeze(['decision']),
});

/** Why a write is planned. A closed vocabulary — never event payload text. */
export const WriteReason = Object.freeze({
  MISSION_CREATED: 'mission.created->intent.md',
  PLAN_REVISED: 'plan.revised->plan.md',
  REVIEW_COMPLETED: 'review.completed->review.md',
  MISSION_COMPLETED: 'mission.completed->outcome.md',
});

/** Why an event produced no candidate write. */
export const RefusalCode = Object.freeze({
  /** Not an envelope, or `event` / `mission_id` unusable. */
  MALFORMED_ENVELOPE: 'MALFORMED_ENVELOPE',
  /** Belongs to a different mission than the one being planned. */
  MISSION_ID_MISMATCH: 'MISSION_ID_MISMATCH',
  /** Not in {@link EVENT_TO_ARTIFACT} nor {@link GATE_EVENTS}. */
  EVENT_UNKNOWN: 'EVENT_UNKNOWN',
  /** Known to the runtime, but not an artifact trigger. Not a defect. */
  EVENT_NOT_HANDLED: 'EVENT_NOT_HANDLED',
  /** An allowlist `required` field is absent from `data`. */
  MISSING_REQUIRED_DATA: 'MISSING_REQUIRED_DATA',
  /** Hardening §11: this idempotency key already produced a write. */
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY',
});

/** Config path whose truthiness {@link apply} demands. */
export const APPLY_GATE_PATH = 'runtime.artifactLifecycle.enabled';

/** `kind` → the {@link WriteReason} constant. */
const WRITE_REASON_BY_KIND = Object.freeze({
  [ArtifactKind.INTENT]: WriteReason.MISSION_CREATED,
  [ArtifactKind.PLAN]: WriteReason.PLAN_REVISED,
  [ArtifactKind.REVIEW]: WriteReason.REVIEW_COMPLETED,
  [ArtifactKind.OUTCOME]: WriteReason.MISSION_COMPLETED,
});

/** Identity redaction. Replaced by `ports.redact` when the caller supplies one. */
function identity(s) {
  return s;
}

/**
 * Idempotency key for a mission artifact (Hardening §11).
 *
 * §11's only literal is `mission:M-001:review:rev-2`, and this produces exactly
 * that shape, satisfying `schemas/common-meta.schema.json#/$defs/idempotency_key`.
 *
 * `outcome` takes an array revision — the `[intent, plan, review]` triple its
 * `based_on` records (Hardening §5) — rendered as `rev-2.5.1`. An outcome has no
 * revision of its own to be keyed by, and the triple is the honest identity: a
 * retry of the same completion produces the same key (no duplicate), while a
 * completion after any upstream revision bump is a genuinely different outcome
 * and gets a different key. The dots are inside the schema's segment character
 * class, so the pattern still matches.
 *
 * @param {{missionId: string, kind: string, revision: number|number[]}} spec
 * @returns {string}
 */
export function computeIdempotencyKey(spec) {
  const { missionId, kind, revision } = spec ?? {};
  if (typeof missionId !== 'string' || !MISSION_ID_PATTERN.test(missionId)) {
    throw new TypeError(
      'artifact-lifecycle: computeIdempotencyKey needs a mission_id matching '
        + String(MISSION_ID_PATTERN),
    );
  }
  if (!Object.values(ArtifactKind).includes(kind)) {
    throw new TypeError(`artifact-lifecycle: unknown artifact kind "${kind}"`);
  }
  const parts = Array.isArray(revision) ? revision : [revision];
  if (parts.length === 0 || !parts.every(isRevision)) {
    throw new TypeError(
      'artifact-lifecycle: computeIdempotencyKey needs non-negative integer revision(s)',
    );
  }
  return `mission:${missionId}:${kind}:rev-${parts.join('.')}`;
}

/** Live revisions: StateStore wins (Hardening §1.1), ledger fold fills gaps. */
function resolveCurrentRevisions(missionState, events) {
  const current = {
    intentRevision: missionState.intentRevision,
    planRevision: missionState.planRevision,
    reviewRevision: missionState.reviewRevision,
  };
  for (const { event, data } of events) {
    if (event === 'mission.created') {
      if (!isRevision(missionState.intentRevision) && isRevision(data.intent_revision)) {
        current.intentRevision = data.intent_revision;
      }
    } else if (event === 'plan.revised') {
      // The ledger fold takes the maximum revision (allowlist spec note).
      if (!isRevision(missionState.planRevision) && isRevision(data.revision)) {
        current.planRevision = isRevision(current.planRevision)
          ? Math.max(current.planRevision, data.revision)
          : data.revision;
      }
    }
  }
  return current;
}

/** Normalise + validate one envelope. Returns either `entry` or `refusal`. */
function readEnvelope(raw, index, missionId) {
  if (!isPlainObject(raw) || typeof raw.event !== 'string' || raw.event.length === 0) {
    return { refusal: { index, code: RefusalCode.MALFORMED_ENVELOPE, severity: 'error' } };
  }
  const event = raw.event;
  const seq = Number.isInteger(raw.seq) ? raw.seq : index;
  if (typeof raw.mission_id !== 'string' || !MISSION_ID_PATTERN.test(raw.mission_id)) {
    return {
      refusal: { event, index, seq, code: RefusalCode.MALFORMED_ENVELOPE, severity: 'error' },
    };
  }
  if (raw.mission_id !== missionId) {
    return {
      refusal: { event, index, seq, code: RefusalCode.MISSION_ID_MISMATCH, severity: 'error' },
    };
  }

  const isArtifactEvent = Object.hasOwn(EVENT_TO_ARTIFACT, event);
  if (!isArtifactEvent && !GATE_EVENTS.includes(event)) {
    return { refusal: { event, index, seq, code: RefusalCode.EVENT_UNKNOWN, severity: 'error' } };
  }

  const data = isPlainObject(raw.data) ? raw.data : {};
  for (const field of REQUIRED_EVENT_DATA[event]) {
    if (!Object.hasOwn(data, field) || data[field] === undefined) {
      return {
        refusal: { event, index, seq, code: RefusalCode.MISSING_REQUIRED_DATA, severity: 'error' },
      };
    }
  }
  return { entry: { event, seq, index, data, isArtifactEvent } };
}

/** Revision that keys this artifact's idempotency key. */
function keyRevisionFor(kind, data, current) {
  if (kind === ArtifactKind.INTENT) return data.intent_revision;
  if (kind === ArtifactKind.PLAN) return data.revision;
  if (kind === ArtifactKind.REVIEW) {
    return isRevision(data.revision) ? data.revision : current.reviewRevision;
  }
  return [current.intentRevision, current.planRevision, current.reviewRevision];
}

/** Final Hardening §25 pass over every string the caller will see. */
function redactWrite(write, redact) {
  const out = {};
  for (const [k, v] of Object.entries(write)) {
    out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}

/**
 * Validate {@link plan}'s inputs. Throws rather than returning a refusal.
 *
 * These are caller bugs, not bad data: a missing `projectRoot` or a `missionId`
 * that is not a mission id means the caller cannot say which repository or which
 * mission it is planning for, and neither has a safe default. Bad *events*, by
 * contrast, are expected and are refused per line.
 */
function readPlanInput(input) {
  const { events, missionState, projectRoot, ports, policy } = input ?? {};
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('artifact-lifecycle: plan() requires an injected projectRoot');
  }
  if (!Array.isArray(events)) {
    throw new TypeError('artifact-lifecycle: plan() requires events[]');
  }
  if (!isPlainObject(missionState) || typeof missionState.missionId !== 'string') {
    throw new TypeError('artifact-lifecycle: plan() requires missionState.missionId');
  }
  if (!MISSION_ID_PATTERN.test(missionState.missionId)) {
    throw new TypeError(
      `artifact-lifecycle: missionState.missionId "${missionState.missionId}" is not a mission id`,
    );
  }
  return {
    missionState,
    projectRoot,
    missionId: missionState.missionId,
    redact: typeof ports?.redact === 'function' ? ports.redact : identity,
    // Spread over the defaults, so omitting a knob keeps the fail-closed value
    // rather than turning the gate off by leaving the field out.
    policy: { ...DEFAULT_POLICY, ...(isPlainObject(policy) ? policy : {}) },
  };
}

/** Split raw envelopes into usable entries and refusals, preserving order. */
function partitionEnvelopes(events, missionId) {
  const accepted = [];
  const refused = [];
  for (const [index, raw] of events.entries()) {
    const { entry, refusal } = readEnvelope(raw, index, missionId);
    if (refusal) refused.push(refusal);
    else accepted.push(entry);
  }
  return { accepted, refused };
}

/**
 * Plan the write one artifact event would cause, or say why it produced none.
 *
 * `ctx.seenKeys` is the one mutable accumulator: it carries the keys already
 * spent in this batch and in earlier runs, which is what makes Hardening §11
 * hold for a retry as well as for a duplicated line.
 */
function planOneWrite(entry, ctx) {
  const kind = EVENT_TO_ARTIFACT[entry.event];
  const stub = { event: entry.event, index: entry.index, seq: entry.seq };

  let idempotencyKey;
  try {
    idempotencyKey = computeIdempotencyKey({
      missionId: ctx.missionId,
      kind,
      revision: keyRevisionFor(kind, entry.data, ctx.current),
    });
  } catch {
    // A revision the fold could not resolve is missing data, not a crash.
    return { refusal: { ...stub, code: RefusalCode.MISSING_REQUIRED_DATA, severity: 'error' } };
  }

  // Hardening §11: the same key never produces a second artifact.
  if (ctx.seenKeys.has(idempotencyKey)) {
    return {
      refusal: {
        ...stub,
        code: RefusalCode.IDEMPOTENT_REPLAY,
        severity: 'skip',
        idempotencyKey: ctx.redact(idempotencyKey),
      },
    };
  }
  ctx.seenKeys.add(idempotencyKey);

  const write = {
    path: path.join(ctx.projectRoot, ...MISSIONS_DIR, ctx.missionId, ARTIFACT_BASENAME[kind]),
    relPath: [...MISSIONS_DIR, ctx.missionId, ARTIFACT_BASENAME[kind]].join('/'),
    kind,
    event: entry.event,
    seq: entry.seq,
    reason: WRITE_REASON_BY_KIND[kind],
    idempotencyKey,
  };

  const blocked = blockCodeFor(kind, ctx.gate, ctx.staleness, ctx.policy);
  if (blocked) write.blocked = blocked;

  return { write: redactWrite(write, ctx.redact) };
}

/**
 * Plan the artifact writes a batch of events would cause. **Writes nothing.**
 *
 * @param {object} input
 * @param {object[]} input.events Ledger envelopes, in append order.
 * @param {object} input.missionState Live mission truth (StateStore projection):
 *   `{missionId, intentRevision, planRevision, reviewRevision, artifacts?,
 *   appliedIdempotencyKeys?}`. `artifacts.plan.based_on` and
 *   `artifacts.review.based_on` carry the dependency edges Hardening §5 needs;
 *   absent ones classify as `BROKEN`, which blocks `outcome.md`.
 *   `appliedIdempotencyKeys` are keys that already produced an artifact in an
 *   earlier run, so a retry after a crash does not duplicate one (Hardening §11).
 * @param {string} input.projectRoot Absolute project root. Required — every
 *   writer takes an injected `projectRoot` (design §3.3), and a path built from
 *   `process.cwd()` is how a worktree writes into the wrong repository.
 * @param {{redact?: (s: string) => string}} [input.ports] Hardening §25 port.
 * @param {{unmeasuredBlocksOutcome?: boolean}} [input.policy] Overrides merged
 *   over {@link DEFAULT_POLICY}. Present because owner decision C4 is open; an
 *   omitted knob keeps the fail-closed default rather than switching the gate off.
 * @returns {{missionId: string, dryRun: true, writes: object[], refused: object[],
 *   staleness: object, policy: object, findings: object[]}} `findings` are
 *   non-blocking counts — today, one per-layer `verify.completed` tally.
 */
export function plan(input) {
  const { missionState, missionId, redact, projectRoot, policy } = readPlanInput(input);
  const { accepted, refused } = partitionEnvelopes(input.events, missionId);

  const current = resolveCurrentRevisions(missionState, accepted);
  const staleness = buildStaleness(missionState, current);
  const ctx = {
    missionId,
    projectRoot,
    redact,
    current,
    staleness,
    policy,
    gate: foldGateState(accepted),
    seenKeys: new Set(
      Array.isArray(missionState.appliedIdempotencyKeys)
        ? missionState.appliedIdempotencyKeys
        : [],
    ),
  };

  const writes = [];
  for (const entry of accepted) {
    if (!entry.isArtifactEvent) {
      refused.push({
        event: entry.event,
        index: entry.index,
        seq: entry.seq,
        code: RefusalCode.EVENT_NOT_HANDLED,
        severity: 'skip',
      });
      continue;
    }
    const { write, refusal } = planOneWrite(entry, ctx);
    if (refusal) refused.push(refusal);
    else writes.push(write);
  }

  return {
    missionId,
    dryRun: true,
    writes,
    refused,
    staleness,
    policy,
    findings: buildFindings(ctx.gate, redact),
  };
}

/**
 * Fail-closed placeholder for the Shadow-stage writer. **Writes nothing.**
 *
 * Two independent gates, neither satisfiable by accident. First,
 * `options.dryRun === true` — not "truthy", not defaulted, because Phase 0 and
 * Observe forbid artifact file creation outright (design §7.3). Second,
 * `options.config` must carry {@link APPLY_GATE_PATH} set to `true`; that key
 * does not exist in `artibot.config.json` (measured 2026-09-02) and this task
 * does not add it, so today every call throws. That is the intended state, not
 * an oversight — the gate lands with the Shadow writer.
 *
 * Even with both gates open this returns `written: []`. Nothing here can write.
 *
 * @param {object} planResult Output of {@link plan}.
 * @param {{dryRun?: boolean, config?: object}} [options]
 * @returns {{dryRun: true, written: object[], wouldWrite: object[], blocked: object[]}}
 */
export function apply(planResult, options = {}) {
  if (options.dryRun !== true) {
    throw new Error(
      'artifact-lifecycle: apply() is dry-run only — pass { dryRun: true }. '
        + 'Artifact file creation is Shadow-stage work (design §7.3 §48 #10); '
        + 'Phase 0 and Observe create zero artifact files.',
    );
  }
  if (options.config?.runtime?.artifactLifecycle?.enabled !== true) {
    throw new Error(
      `artifact-lifecycle: apply() requires config ${APPLY_GATE_PATH} === true. `
        + 'The key is absent from artibot.config.json by design; it lands with '
        + 'the Shadow-stage writer.',
    );
  }
  if (!isPlainObject(planResult) || !Array.isArray(planResult.writes)) {
    throw new TypeError('artifact-lifecycle: apply() needs a plan() result');
  }
  return {
    dryRun: true,
    written: [],
    wouldWrite: planResult.writes.filter((w) => !w.blocked),
    blocked: planResult.writes.filter((w) => Boolean(w.blocked)),
  };
}
