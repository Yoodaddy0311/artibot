/**
 * T-40 — `lib/runtime/artifact-lifecycle.js` dry-run contract.
 *
 * What each block fixes:
 *
 *   1. handler table — the four Hardening §6 mappings, and the fact that they
 *      are an allowlist (an unlisted event creates nothing).
 *   2. schema drift — the two vocabularies copied into the module
 *      (`MISSION_ID_PATTERN`, `REQUIRED_EVENT_DATA`) are compared against the
 *      landed schemas on disk, so a copy cannot silently diverge.
 *   3. refusal conditions — each of the four outcome.md gates in isolation.
 *   4. idempotency — Hardening §11, replay produces zero extra writes.
 *   5. staleness — Hardening §5 propagation, as a pure function and through
 *      the outcome gate.
 *   6. **zero filesystem writes** — proved twice: statically (the module source
 *      contains no `fs` import) and dynamically (spies on every `node:fs` and
 *      `node:fs/promises` write entry point record 0 calls).
 *   7. `apply()` fail-closed — each gate refused independently.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apply,
  APPLY_GATE_PATH,
  ARTIFACT_BASENAME,
  ArtifactKind,
  BlockCode,
  classifyStaleness,
  computeIdempotencyKey,
  DEFAULT_POLICY,
  EVENT_TO_ARTIFACT,
  FindingCode,
  GATE_EVENTS,
  LAYER_NAME_PATTERN,
  LAYER_UNRECOGNISED,
  LAYER_UNSPECIFIED,
  MISSION_ID_PATTERN,
  plan,
  RefusalCode,
  REQUIRED_EVENT_DATA,
  StaleState,
  VERIFY_RESULT_UNMEASURED,
} from '../../lib/runtime/artifact-lifecycle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');
const MODULE_PATH = path.join(PKG_ROOT, 'lib', 'runtime', 'artifact-lifecycle.js');
const GATES_PATH = path.join(PKG_ROOT, 'lib', 'runtime', 'artifact-lifecycle-gates.js');

const MISSION_ID = 'M-20260902-001';
const PROJECT_ROOT = path.join('C:', 'fake-project-root');
const VID = 'v-9f2c1a';

/** Minimal valid envelope. `data` is merged over the per-event required fields. */
function envelope(event, data = {}, overrides = {}) {
  return {
    v: 1,
    ts: '2026-09-02T10:00:00Z',
    event,
    mission_id: MISSION_ID,
    session_id: 's-1',
    source: 'hook',
    pid: 100,
    seq: 0,
    data,
    ...overrides,
  };
}

const ev = {
  missionCreated: (intentRevision = 1) =>
    envelope('mission.created', { title: 'x', intent_revision: intentRevision }),
  planRevised: (revision = 1) => envelope('plan.revised', { revision, mode: 'plan' }),
  reviewCompleted: (verdict = 'PASS', extra = {}) =>
    envelope('review.completed', {
      verdict,
      findings_ref: 'E-001',
      verification_id: VID,
      ...extra,
    }),
  missionCompleted: (extra = {}) =>
    envelope('mission.completed', {
      accepted: null,
      evidence_refs: ['E-001'],
      verification_id: VID,
      ...extra,
    }),
  verifyCompleted: (result = 'pass', extra = {}) =>
    envelope('verify.completed', {
      result,
      evidence: ['E-001'],
      verification_id: VID,
      ...extra,
    }),
  humanAsked: (questionId) => envelope('human.asked', { question_id: questionId }),
  humanResolved: (questionId) =>
    envelope('human.resolved', {
      decision: 'yes',
      ...(questionId ? { question_id: questionId } : {}),
    }),
};

/** A mission state whose dependency edges are all current. */
function healthyState(overrides = {}) {
  return {
    missionId: MISSION_ID,
    intentRevision: 2,
    planRevision: 5,
    reviewRevision: 1,
    artifacts: {
      plan: { based_on: { intent_revision: 2 } },
      review: { based_on: { intent_revision: 2, plan_revision: 5 } },
    },
    ...overrides,
  };
}

/** The full happy-path event sequence that lets outcome.md through. */
function completionEvents() {
  return [
    ev.missionCreated(2),
    ev.planRevised(5),
    ev.verifyCompleted('pass'),
    ev.reviewCompleted('PASS'),
    ev.missionCompleted(),
  ];
}

function runPlan(events, missionState = healthyState(), extra = {}) {
  return plan({ events, missionState, projectRoot: PROJECT_ROOT, ...extra });
}

function writeOf(result, kind) {
  return result.writes.find((w) => w.kind === kind);
}

// ---------------------------------------------------------------------------
// 1. Handler table
// ---------------------------------------------------------------------------

describe('handler table (Hardening §6)', () => {
  it('maps exactly four events to the four canonical artifacts', () => {
    expect(EVENT_TO_ARTIFACT).toEqual({
      'mission.created': ArtifactKind.INTENT,
      'plan.revised': ArtifactKind.PLAN,
      'review.completed': ArtifactKind.REVIEW,
      'mission.completed': ArtifactKind.OUTCOME,
    });
    expect(Object.keys(EVENT_TO_ARTIFACT)).toHaveLength(4);
  });

  it('plans one write per handler at the canonical mission path', () => {
    const result = runPlan(completionEvents());
    expect(result.dryRun).toBe(true);
    expect(result.writes.map((w) => w.kind)).toEqual([
      ArtifactKind.INTENT,
      ArtifactKind.PLAN,
      ArtifactKind.REVIEW,
      ArtifactKind.OUTCOME,
    ]);
    for (const write of result.writes) {
      expect(write.relPath).toBe(
        `.artibot/missions/${MISSION_ID}/${ARTIFACT_BASENAME[write.kind]}`,
      );
      expect(write.path.startsWith(PROJECT_ROOT)).toBe(true);
    }
  });

  it('lets no write through blocked on the happy path', () => {
    const result = runPlan(completionEvents());
    expect(result.writes.filter((w) => w.blocked)).toEqual([]);
    expect(result.refused.filter((r) => r.severity === 'error')).toEqual([]);
  });

  it('refuses plan.accepted — the name Hardening §6 uses does not exist', () => {
    const result = runPlan([envelope('plan.accepted', { revision: 1, mode: 'plan' })]);
    expect(result.writes).toEqual([]);
    expect(result.refused[0].code).toBe(RefusalCode.EVENT_UNKNOWN);
  });

  it('creates nothing for gate events, and says so without calling it an error', () => {
    const result = runPlan([ev.verifyCompleted('pass'), ev.humanAsked('q1')]);
    expect(result.writes).toEqual([]);
    expect(result.refused.map((r) => r.code)).toEqual([
      RefusalCode.EVENT_NOT_HANDLED,
      RefusalCode.EVENT_NOT_HANDLED,
    ]);
    expect(result.refused.every((r) => r.severity === 'skip')).toBe(true);
  });

  it('refuses a foreign mission_id rather than writing into another mission', () => {
    const foreign = { ...ev.missionCreated(1), mission_id: 'M-20260902-999' };
    const result = runPlan([foreign]);
    expect(result.writes).toEqual([]);
    expect(result.refused[0].code).toBe(RefusalCode.MISSION_ID_MISMATCH);
  });

  it('refuses an event missing an allowlist-required field', () => {
    const result = runPlan([envelope('mission.created', { title: 'x' })]);
    expect(result.writes).toEqual([]);
    expect(result.refused[0].code).toBe(RefusalCode.MISSING_REQUIRED_DATA);
  });
});

// ---------------------------------------------------------------------------
// 2. Drift gates against the landed schemas
// ---------------------------------------------------------------------------

describe('schema drift gates', () => {
  const allowlist = JSON.parse(
    readFileSync(path.join(PKG_ROOT, 'schemas', 'ledger-events.allowlist.json'), 'utf8'),
  );
  const envelopeSchema = JSON.parse(
    readFileSync(path.join(PKG_ROOT, 'schemas', 'ledger-envelope.schema.json'), 'utf8'),
  );
  const commonMeta = JSON.parse(
    readFileSync(path.join(PKG_ROOT, 'schemas', 'common-meta.schema.json'), 'utf8'),
  );

  it('MISSION_ID_PATTERN is byte-identical to the envelope schema pattern', () => {
    expect(MISSION_ID_PATTERN.source).toBe(envelopeSchema.properties.mission_id.pattern);
  });

  it('every event the module names exists in the T-15 allowlist', () => {
    for (const name of [...Object.keys(EVENT_TO_ARTIFACT), ...GATE_EVENTS]) {
      expect(Object.keys(allowlist.events)).toContain(name);
    }
  });

  it('REQUIRED_EVENT_DATA matches the allowlist required arrays', () => {
    for (const [name, fields] of Object.entries(REQUIRED_EVENT_DATA)) {
      expect([name, [...fields]]).toEqual([name, allowlist.events[name].required]);
    }
  });

  it('covers required fields for every event it reads, and no others', () => {
    expect(Object.keys(REQUIRED_EVENT_DATA).sort()).toEqual(
      [...Object.keys(EVENT_TO_ARTIFACT), ...GATE_EVENTS].sort(),
    );
  });

  it('PASS and unmeasured are members of the allowlist enums', () => {
    expect(allowlist.enums.review_verdict).toContain('PASS');
    expect(allowlist.enums.verify_result).toContain('unmeasured');
  });

  it('every idempotency key it computes satisfies the T-19 pattern', () => {
    const pattern = new RegExp(commonMeta.$defs.idempotency_key.pattern);
    const keys = runPlan(completionEvents()).writes.map((w) => w.idempotencyKey);
    expect(keys).toHaveLength(4);
    for (const key of keys) expect(key).toMatch(pattern);
  });

  it('reproduces the Hardening §11 literal shape', () => {
    expect(
      computeIdempotencyKey({ missionId: MISSION_ID, kind: ArtifactKind.REVIEW, revision: 2 }),
    ).toBe(`mission:${MISSION_ID}:review:rev-2`);
    expect(
      computeIdempotencyKey({
        missionId: MISSION_ID,
        kind: ArtifactKind.OUTCOME,
        revision: [2, 5, 1],
      }),
    ).toBe(`mission:${MISSION_ID}:outcome:rev-2.5.1`);
  });
});

// ---------------------------------------------------------------------------
// 3. The four outcome.md refusal conditions, each in isolation
// ---------------------------------------------------------------------------

describe('outcome.md refusal conditions (design §3.4)', () => {
  it('blocks on a surviving UNMEASURED verification layer', () => {
    const events = [
      ev.missionCreated(2),
      ev.planRevised(5),
      ev.verifyCompleted('pass'),
      ev.verifyCompleted('unmeasured'),
      ev.reviewCompleted('PASS'),
      ev.missionCompleted(),
    ];
    const outcome = writeOf(runPlan(events), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.UNMEASURED_VERIFICATION);
  });

  it.each(['REPAIR_REQUIRED', 'REPLAN_REQUIRED', 'INTENT_REVIEW_REQUIRED', 'BLOCK'])(
    'blocks when the review verdict is %s',
    (verdict) => {
      const events = [
        ev.missionCreated(2),
        ev.planRevised(5),
        ev.verifyCompleted('pass'),
        ev.reviewCompleted(verdict),
        ev.missionCompleted(),
      ];
      const outcome = writeOf(runPlan(events), ArtifactKind.OUTCOME);
      expect(outcome.blocked).toBe(BlockCode.REVIEW_VERDICT_NOT_PASS);
    },
  );

  it('blocks on human.asked with no matching human.resolved', () => {
    const events = [...completionEvents(), ev.humanAsked('q1')];
    const outcome = writeOf(runPlan(events), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.HUMAN_QUESTION_UNRESOLVED);
  });

  it('unblocks once the matching human.resolved arrives', () => {
    const events = [...completionEvents(), ev.humanAsked('q1'), ev.humanResolved('q1')];
    expect(writeOf(runPlan(events), ArtifactKind.OUTCOME).blocked).toBeUndefined();
  });

  it('still blocks when resolves are fewer than asks', () => {
    const events = [
      ...completionEvents(),
      ev.humanAsked('q1'),
      ev.humanAsked('q2'),
      ev.humanResolved('q1'),
    ];
    const outcome = writeOf(runPlan(events), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.HUMAN_QUESTION_UNRESOLVED);
  });

  it('accepts an id-less human.resolved against the oldest open ask', () => {
    // `human.resolved` requires only `decision` in the landed allowlist, so a
    // resolve with no question_id has to close something or nothing ever closes.
    const events = [...completionEvents(), ev.humanAsked('q1'), ev.humanResolved()];
    expect(writeOf(runPlan(events), ArtifactKind.OUTCOME).blocked).toBeUndefined();
  });

  it('blocks when verification_id disagrees across the three carriers', () => {
    const events = [
      ev.missionCreated(2),
      ev.planRevised(5),
      ev.verifyCompleted('pass'),
      ev.reviewCompleted('PASS', { verification_id: 'v-different' }),
      ev.missionCompleted(),
    ];
    const outcome = writeOf(runPlan(events), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.VERIFICATION_ID_MISMATCH);
  });

  it('blocks when a carrier omits verification_id entirely', () => {
    const events = [
      ev.missionCreated(2),
      ev.planRevised(5),
      ev.verifyCompleted('pass'),
      ev.reviewCompleted('PASS'),
      envelope('mission.completed', { accepted: null, evidence_refs: ['E-001'] }),
    ];
    const outcome = writeOf(runPlan(events), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.VERIFICATION_ID_MISSING);
  });

  it('does not block intent.md or plan.md when the outcome is blocked', () => {
    const events = [...completionEvents(), ev.humanAsked('q1')];
    const result = runPlan(events);
    expect(writeOf(result, ArtifactKind.INTENT).blocked).toBeUndefined();
    expect(writeOf(result, ArtifactKind.PLAN).blocked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3b. C4 policy seam + per-layer counting (T-51 repair #5)
// ---------------------------------------------------------------------------

describe('unmeasuredBlocksOutcome policy (owner decision C4 ruled 2026-09-03: value stays true)', () => {
  const withUnmeasured = () => [
    ev.missionCreated(2),
    ev.planRevised(5),
    ev.verifyCompleted('pass'),
    ev.verifyCompleted('unmeasured'),
    ev.reviewCompleted('PASS'),
    ev.missionCompleted(),
  ];

  it('defaults to fail-closed', () => {
    expect(DEFAULT_POLICY.unmeasuredBlocksOutcome).toBe(true);
    const outcome = writeOf(runPlan(withUnmeasured()), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.UNMEASURED_VERIFICATION);
  });

  it('does not block when the policy is false', () => {
    const result = runPlan(withUnmeasured(), healthyState(), {
      policy: { unmeasuredBlocksOutcome: false },
    });
    expect(writeOf(result, ArtifactKind.OUTCOME).blocked).toBeUndefined();
  });

  it('still records the count when the policy is false', () => {
    const result = runPlan(withUnmeasured(), healthyState(), {
      policy: { unmeasuredBlocksOutcome: false },
    });
    const finding = result.findings.find((f) => f.layer === LAYER_UNSPECIFIED);
    expect(finding.code).toBe(FindingCode.VERIFICATION_LAYER);
    expect(finding.counts).toEqual({ pass: 1, fail: 0, unmeasured: 1, other: 0 });
    expect(finding.total).toBe(2);
  });

  it('records the same count whether or not the policy blocks', () => {
    const blocked = runPlan(withUnmeasured());
    const open = runPlan(withUnmeasured(), healthyState(), {
      policy: { unmeasuredBlocksOutcome: false },
    });
    expect(open.findings).toEqual(blocked.findings);
  });

  it('keeps the fail-closed default when an unrelated knob is passed', () => {
    const result = runPlan(withUnmeasured(), healthyState(), { policy: { somethingElse: 1 } });
    expect(writeOf(result, ArtifactKind.OUTCOME).blocked).toBe(
      BlockCode.UNMEASURED_VERIFICATION,
    );
  });

  it('echoes the resolved policy so a reader can tell which rule applied', () => {
    expect(runPlan(withUnmeasured()).policy.unmeasuredBlocksOutcome).toBe(true);
    expect(
      runPlan(withUnmeasured(), healthyState(), {
        policy: { unmeasuredBlocksOutcome: false },
      }).policy.unmeasuredBlocksOutcome,
    ).toBe(false);
  });

  it('leaves the other outcome gates untouched by the policy', () => {
    // Verdict is not PASS: the policy must not open this gate too.
    const events = [
      ev.missionCreated(2),
      ev.planRevised(5),
      ev.verifyCompleted('unmeasured'),
      ev.reviewCompleted('BLOCK'),
      ev.missionCompleted(),
    ];
    const outcome = writeOf(
      runPlan(events, healthyState(), { policy: { unmeasuredBlocksOutcome: false } }),
      ArtifactKind.OUTCOME,
    );
    expect(outcome.blocked).toBe(BlockCode.REVIEW_VERDICT_NOT_PASS);
  });
});

describe('per-layer verify.completed counts (Observe counts only)', () => {
  // The landed vocabulary, copied not imported: `lib/verification/unified-verifier.js:109`
  // exports `LAYERS = ['deterministic', 'behavioral', 'operational']`. The test
  // reads that file to prove the copy is faithful; the module under test stays
  // import-free.
  const LANDED_LAYERS = ['deterministic', 'behavioral', 'operational'];

  it('matches the layer vocabulary unified-verifier actually exports', () => {
    const verifier = readFileSync(
      path.join(PKG_ROOT, 'lib', 'verification', 'unified-verifier.js'),
      'utf8',
    );
    const match = verifier.match(/export const LAYERS = Object\.freeze\(\[([^\]]+)\]\)/);
    expect(match).not.toBeNull();
    const declared = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(declared).toEqual(LANDED_LAYERS);
  });

  it('echoes every landed layer name rather than bucketing it as unrecognised', () => {
    const { findings } = runPlan(LANDED_LAYERS.map((l) => ev.verifyCompleted('pass', { layer: l })));
    expect(findings.map((f) => f.layer)).toEqual(LANDED_LAYERS);
    for (const layer of LANDED_LAYERS) expect(layer).toMatch(LAYER_NAME_PATTERN);
  });

  it('buckets by data.layer when T-15 has declared it', () => {
    const events = [
      ev.verifyCompleted('pass', { layer: 'deterministic' }),
      ev.verifyCompleted('unmeasured', { layer: 'behavioral' }),
      ev.verifyCompleted('fail', { layer: 'behavioral' }),
    ];
    const { findings } = runPlan(events);
    expect(findings.map((f) => f.layer)).toEqual(['deterministic', 'behavioral']);
    expect(findings[1].counts).toEqual({ pass: 0, fail: 1, unmeasured: 1, other: 0 });
    expect(findings[1].total).toBe(2);
  });

  it('buckets a layer-less line under the unspecified sentinel', () => {
    const { findings } = runPlan([ev.verifyCompleted('pass')]);
    expect(findings).toHaveLength(1);
    expect(findings[0].layer).toBe(LAYER_UNSPECIFIED);
  });

  it('names the unspecified bucket distinctly from the unmeasured result', () => {
    // They are different axes: "nobody said which layer" vs "this layer's
    // result was unmeasured". Sharing one string made a finding unreadable.
    expect(LAYER_UNSPECIFIED).toBe('unspecified');
    expect(LAYER_UNSPECIFIED).not.toBe(VERIFY_RESULT_UNMEASURED);
    const { findings } = runPlan([ev.verifyCompleted('pass')]);
    expect(findings[0].layer).toBe('unspecified');
    expect(findings[0].counts.unmeasured).toBe(0);
    expect(findings[0].counts.pass).toBe(1);
  });

  it('does not echo a layer name that is not a plain identifier', () => {
    const { findings } = runPlan([
      ev.verifyCompleted('pass', { layer: 'Behavioral Layer <script>' }),
    ]);
    expect(findings[0].layer).toBe(LAYER_UNRECOGNISED);
  });

  it('counts a result outside the enum as other, never as a pass', () => {
    const { findings } = runPlan([ev.verifyCompleted('PASSED', { layer: 'static' })]);
    expect(findings[0].counts).toEqual({ pass: 0, fail: 0, unmeasured: 0, other: 1 });
  });

  it('counts nothing when no verify.completed arrived', () => {
    expect(runPlan([ev.missionCreated(2)]).findings).toEqual([]);
  });

  it('counts without blocking — findings never gate a write', () => {
    const events = [...completionEvents(), ev.verifyCompleted('pass', { layer: 'operational' })];
    const result = runPlan(events);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.writes.filter((w) => w.blocked)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency (Hardening §11)
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('produces zero duplicate writes when the same events replay in one batch', () => {
    const once = runPlan(completionEvents());
    const twice = runPlan([...completionEvents(), ...completionEvents()]);
    expect(twice.writes).toHaveLength(once.writes.length);
    expect(twice.writes.map((w) => w.idempotencyKey)).toEqual(
      once.writes.map((w) => w.idempotencyKey),
    );
    expect(twice.refused.filter((r) => r.code === RefusalCode.IDEMPOTENT_REPLAY)).toHaveLength(
      once.writes.length,
    );
  });

  it('marks a replay as a skip, not an error', () => {
    const twice = runPlan([...completionEvents(), ...completionEvents()]);
    const replays = twice.refused.filter((r) => r.code === RefusalCode.IDEMPOTENT_REPLAY);
    expect(replays.every((r) => r.severity === 'skip')).toBe(true);
  });

  it('produces zero writes when every key was already applied in an earlier run', () => {
    const first = runPlan(completionEvents());
    const second = runPlan(
      completionEvents(),
      healthyState({ appliedIdempotencyKeys: first.writes.map((w) => w.idempotencyKey) }),
    );
    expect(second.writes).toEqual([]);
  });

  it('gives a new key once a revision moves', () => {
    const a = runPlan([ev.planRevised(5)], healthyState({ planRevision: 5 }));
    const b = runPlan([ev.planRevised(6)], healthyState({ planRevision: 6 }));
    expect(a.writes[0].idempotencyKey).not.toBe(b.writes[0].idempotencyKey);
  });
});

// ---------------------------------------------------------------------------
// 5. Staleness (Hardening §5)
// ---------------------------------------------------------------------------

describe('classifyStaleness', () => {
  const current = { intentRevision: 3, planRevision: 5, reviewRevision: 1 };

  it('treats intent as a root that can never be stale', () => {
    expect(classifyStaleness({ kind: ArtifactKind.INTENT, current }).state).toBe(
      StaleState.CURRENT,
    );
  });

  it('propagates intent 2 -> 3 as STALE / INVALID / NOT_ACCEPTABLE', () => {
    expect(
      classifyStaleness({
        kind: ArtifactKind.PLAN,
        basedOn: { intent_revision: 2 },
        current,
      }).state,
    ).toBe(StaleState.STALE);
    expect(
      classifyStaleness({
        kind: ArtifactKind.REVIEW,
        basedOn: { intent_revision: 2, plan_revision: 5 },
        current,
      }).state,
    ).toBe(StaleState.INVALID);
    expect(
      classifyStaleness({
        kind: ArtifactKind.OUTCOME,
        basedOn: { intent_revision: 2, plan_revision: 5, review_revision: 1 },
        current,
      }).state,
    ).toBe(StaleState.NOT_ACCEPTABLE);
  });

  it('is CURRENT when every declared revision equals the live one', () => {
    expect(
      classifyStaleness({
        kind: ArtifactKind.OUTCOME,
        basedOn: { intent_revision: 3, plan_revision: 5, review_revision: 1 },
        current,
      }).state,
    ).toBe(StaleState.CURRENT);
  });

  it('reports which members went stale', () => {
    expect(
      classifyStaleness({
        kind: ArtifactKind.REVIEW,
        basedOn: { intent_revision: 2, plan_revision: 4 },
        current,
      }).staleMembers,
    ).toEqual(['intent_revision', 'plan_revision']);
  });

  it('is BROKEN, not CURRENT, when based_on is absent', () => {
    expect(classifyStaleness({ kind: ArtifactKind.PLAN, current }).state).toBe(StaleState.BROKEN);
  });

  it('is BROKEN when an artifact claims a revision the mission never reached', () => {
    expect(
      classifyStaleness({
        kind: ArtifactKind.PLAN,
        basedOn: { intent_revision: 9 },
        current,
      }).state,
    ).toBe(StaleState.BROKEN);
  });
});

describe('staleness propagation through plan()', () => {
  it('blocks outcome.md when the latest plan is stale (Hardening §33)', () => {
    const state = healthyState({
      intentRevision: 3,
      artifacts: {
        plan: { based_on: { intent_revision: 2 } },
        review: { based_on: { intent_revision: 3, plan_revision: 5 } },
      },
    });
    const outcome = writeOf(runPlan(completionEvents(), state), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.PLAN_STALE);
  });

  it('blocks review.md and outcome.md when the intent moved under the review', () => {
    const state = healthyState({
      intentRevision: 3,
      artifacts: {
        plan: { based_on: { intent_revision: 3 } },
        review: { based_on: { intent_revision: 2, plan_revision: 5 } },
      },
    });
    const result = runPlan(completionEvents(), state);
    expect(writeOf(result, ArtifactKind.REVIEW).blocked).toBe(BlockCode.REVIEW_INVALID);
    expect(writeOf(result, ArtifactKind.OUTCOME).blocked).toBe(BlockCode.REVIEW_INVALID);
    expect(result.staleness.review.state).toBe(StaleState.INVALID);
  });

  it('blocks outcome.md when a dependency edge is missing entirely', () => {
    const state = healthyState({ artifacts: {} });
    const outcome = writeOf(runPlan(completionEvents(), state), ArtifactKind.OUTCOME);
    expect(outcome.blocked).toBe(BlockCode.BASED_ON_BROKEN);
  });
});

// ---------------------------------------------------------------------------
// 6. Zero filesystem writes
// ---------------------------------------------------------------------------

describe('writes zero files', () => {
  it.each([
    ['artifact-lifecycle.js', MODULE_PATH],
    ['artifact-lifecycle-gates.js', GATES_PATH],
  ])('%s imports no filesystem module at all (static proof)', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/\bfrom\s+'node:fs(\/promises)?'/);
    expect(source).not.toMatch(/\brequire\s*\(\s*['"]fs['"]\s*\)/);
  });

  it('keeps the parent on exactly one sibling import, and the gates on none', () => {
    // The split must not become a licence to pull more of the runtime in. The
    // gates module imports nothing at all, which is what makes it safe for the
    // parent to depend on it without a cycle.
    const parentEdges = [
      ...readFileSync(MODULE_PATH, 'utf8').matchAll(/^(?:import|export)[^;]*from\s+'([^']+)'/gm),
    ].map((m) => m[1]);
    expect([...new Set(parentEdges)].sort()).toEqual([
      './artifact-lifecycle-gates.js',
      'node:path',
    ]);

    const gatesEdges = [
      ...readFileSync(GATES_PATH, 'utf8').matchAll(/^(?:import|export)[^;]*from\s+'([^']+)'/gm),
    ].map((m) => m[1]);
    expect(gatesEdges).toEqual([]);
  });

  it('calls no fs write entry point during plan() or apply() (dynamic proof)', () => {
    const syncTargets = [
      'writeFileSync',
      'appendFileSync',
      'mkdirSync',
      'rmSync',
      'renameSync',
      'copyFileSync',
      'openSync',
      'createWriteStream',
    ];
    const asyncTargets = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'open'];
    const spies = [
      ...syncTargets.map((name) => vi.spyOn(fs, name)),
      ...asyncTargets.map((name) => vi.spyOn(fsPromises, name)),
    ];

    try {
      const result = runPlan([...completionEvents(), ...completionEvents(), ev.humanAsked('q')]);
      expect(result.writes.length).toBeGreaterThan(0);
      expect(() => apply(result, { dryRun: true })).toThrow();
      expect(
        apply(result, {
          dryRun: true,
          config: { runtime: { artifactLifecycle: { enabled: true } } },
        }).written,
      ).toEqual([]);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. apply() is fail-closed
// ---------------------------------------------------------------------------

describe('apply() fail-closed', () => {
  const enabledConfig = { runtime: { artifactLifecycle: { enabled: true } } };

  it('throws with no options at all', () => {
    expect(() => apply(runPlan(completionEvents()))).toThrow(/dry-run only/);
  });

  it('throws when dryRun is false even with the config gate open', () => {
    expect(() =>
      apply(runPlan(completionEvents()), { dryRun: false, config: enabledConfig }),
    ).toThrow(/dry-run only/);
  });

  it('rejects a truthy non-true dryRun', () => {
    expect(() =>
      apply(runPlan(completionEvents()), { dryRun: 'yes', config: enabledConfig }),
    ).toThrow(/dry-run only/);
  });

  it('throws when the config gate is absent', () => {
    expect(() => apply(runPlan(completionEvents()), { dryRun: true })).toThrow(
      new RegExp(APPLY_GATE_PATH.replace(/\./g, '\\.')),
    );
  });

  it('throws when the config gate is present but false', () => {
    expect(() =>
      apply(runPlan(completionEvents()), {
        dryRun: true,
        config: { runtime: { artifactLifecycle: { enabled: false } } },
      }),
    ).toThrow(/requires config/);
  });

  it('is refused by the live artibot.config.json, which has no gate key', () => {
    const config = JSON.parse(readFileSync(path.join(PKG_ROOT, 'artibot.config.json'), 'utf8'));
    expect(config.runtime?.artifactLifecycle).toBeUndefined();
    expect(() => apply(runPlan(completionEvents()), { dryRun: true, config })).toThrow();
  });

  it('separates would-write from blocked, and writes neither', () => {
    const result = runPlan([...completionEvents(), ev.humanAsked('q1')]);
    const report = apply(result, { dryRun: true, config: enabledConfig });
    expect(report.written).toEqual([]);
    expect(report.blocked.map((w) => w.kind)).toEqual([ArtifactKind.OUTCOME]);
    expect(report.wouldWrite.map((w) => w.kind)).toEqual([
      ArtifactKind.INTENT,
      ArtifactKind.PLAN,
      ArtifactKind.REVIEW,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. Redaction port + closed vocabulary (Hardening §25)
// ---------------------------------------------------------------------------

describe('redaction (Hardening §25)', () => {
  // Assembled at runtime so this file does not itself contain a token-shaped
  // literal: the repo's own write-side secret guard blocks such a literal.
  const TOKEN_PREFIX = ['sk', 'ant'].join('-');
  const FAKE_TOKEN = `${TOKEN_PREFIX}-${'A'.repeat(26)}`;

  it('copies no event payload into the plan, so a secret cannot leak', () => {
    const events = [
      envelope('mission.created', { title: FAKE_TOKEN, intent_revision: 2 }),
      envelope('plan.revised', { revision: 5, mode: 'plan', note: FAKE_TOKEN }),
    ];
    const serialised = JSON.stringify(runPlan(events));
    expect(serialised).not.toContain(TOKEN_PREFIX);
    expect(serialised).not.toContain(FAKE_TOKEN);
  });

  it('normalises a secret-bearing layer name instead of echoing it', () => {
    // `data.layer` is the ONE payload field that reaches the output, so the
    // closed-vocabulary guarantee has to be re-proved on this axis.
    const events = [ev.verifyCompleted('pass', { layer: FAKE_TOKEN })];
    const result = runPlan(events);
    expect(result.findings[0].layer).toBe(LAYER_UNRECOGNISED);
    expect(JSON.stringify(result)).not.toContain(TOKEN_PREFIX);
  });

  it('routes an accepted layer name through the redaction port', () => {
    const result = runPlan([ev.verifyCompleted('pass', { layer: 'behavioral' })], healthyState(), {
      ports: { redact: (s) => s.replace('behavioral', 'L-REDACTED') },
    });
    expect(result.findings[0].layer).toBe('L-REDACTED');
  });

  it('routes every emitted string through the injected port', () => {
    const seen = [];
    const result = runPlan(completionEvents(), healthyState(), {
      ports: {
        redact: (s) => {
          seen.push(s);
          return s.replace(MISSION_ID, 'M-REDACTED');
        },
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const write of result.writes) {
      expect(write.path).not.toContain(MISSION_ID);
      expect(write.relPath).not.toContain(MISSION_ID);
      expect(write.idempotencyKey).not.toContain(MISSION_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Required-argument guards
// ---------------------------------------------------------------------------

describe('required arguments', () => {
  it('refuses to build a path without an injected projectRoot', () => {
    expect(() => plan({ events: [], missionState: healthyState() })).toThrow(/projectRoot/);
  });

  it('refuses a missionId that is not a mission id', () => {
    expect(() =>
      plan({ events: [], missionState: { missionId: 'nope' }, projectRoot: PROJECT_ROOT }),
    ).toThrow(/is not a mission id/);
  });

  it('refuses a malformed envelope without throwing', () => {
    const result = runPlan([null, 'x', { event: 'mission.created' }]);
    expect(result.writes).toEqual([]);
    expect(result.refused.map((r) => r.code)).toEqual([
      RefusalCode.MALFORMED_ENVELOPE,
      RefusalCode.MALFORMED_ENVELOPE,
      RefusalCode.MALFORMED_ENVELOPE,
    ]);
  });
});
