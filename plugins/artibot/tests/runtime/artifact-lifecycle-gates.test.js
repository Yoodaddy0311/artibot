/**
 * `lib/runtime/artifact-lifecycle-gates.js` — the `requiredLayers` half of owner
 * decision C4 ("층별 필수/선택은 config, Observe 는 카운트만").
 *
 * The other half — `unmeasuredBlocksOutcome` — is pinned in
 * `tests/runtime/artifact-lifecycle-dryrun.test.js` (the `unmeasuredBlocksOutcome
 * policy` block) and is NOT re-tested here. This file owns one question: when the
 * caller names which layers are required, which `verify.completed` rows may stop
 * an `outcome.md`.
 *
 * ── WHY THE FIXTURES COME FROM THE WRITER ──────────────────────────────────
 * The blocking rule is only as true as the row shape it reads, and the row shape
 * is not this module's to invent: `lib/verification/verify-writer.js` writes it.
 * Its overall line carries NO `layer` key on purpose (`verifyEventInput` :341 on
 * 2026-09-15 — `if (p.layer !== null) data.layer = p.layer;`, stated at :21-22),
 * so the gate buckets it as {@link LAYER_UNSPECIFIED}. A per-layer rule that let
 * that bucket block would be decorative: the live ledger's overall rows are
 * `unmeasured`, so every mission would still stop at the first gate. The main
 * fixtures are therefore built by calling `buildVerifyCompletedEvents` rather
 * than by hand, so a change to the writer's shape lands here as a failure.
 *
 * ── WHAT THIS FILE CANNOT SEE ──────────────────────────────────────────────
 * Nothing here proves any layer is measured in the live ledger; these are
 * fixtures. As of the parent measurement in the limb brief §1.1 all 112 live
 * `verify.completed` rows are `unmeasured`, so a green run here says the gate
 * would let a PASSing `deterministic` through, not that one exists.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ArtifactKind,
  BlockCode,
  DEFAULT_POLICY,
  LAYER_UNRECOGNISED,
  LAYER_UNSPECIFIED,
  plan,
} from '../../lib/runtime/artifact-lifecycle.js';
import { normaliseRequiredLayers } from '../../lib/runtime/artifact-lifecycle-gates.js';
import { buildVerifyCompletedEvents } from '../../lib/verification/verify-writer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');
const GATES_PATH = path.join(PKG_ROOT, 'lib', 'runtime', 'artifact-lifecycle-gates.js');
const CONFIG_PATH = path.join(PKG_ROOT, 'artibot.config.json');

const MISSION_ID = 'M-20260902-001';
const SESSION_ID = 's-1';
const PROJECT_ROOT = path.join('C:', 'fake-project-root');
const VID = 'v-9f2c1a';

/** `lib/verification/unified-verifier.js:126` exports exactly these, in order. */
const LANDED_LAYERS = ['deterministic', 'behavioral', 'operational'];

function envelope(event, data, seq = 0) {
  return {
    v: 1,
    ts: '2026-09-02T10:00:00Z',
    event,
    mission_id: MISSION_ID,
    session_id: SESSION_ID,
    source: 'hook',
    pid: 100,
    seq,
    data,
  };
}

/**
 * The four envelopes the LANDED writer emits for one verdict: the overall line,
 * then one per `LAYERS` member. Statuses are the writer's UPPERCASE vocabulary
 * (`VERIFY_RESULT_BY_STATUS` :53-57).
 */
function writerRows(statusByLayer, overallStatus) {
  const built = buildVerifyCompletedEvents(
    {
      verification_id: VID,
      status: overallStatus,
      evidence: ['E-001'],
      layers: LANDED_LAYERS.map((layer) => ({
        layer,
        status: statusByLayer[layer],
        evidence: ['E-001'],
      })),
    },
    { sessionId: SESSION_ID, missionId: MISSION_ID },
  );
  if (!built.ok) throw new Error(`fixture diverged from the writer: ${built.reason}`);
  return built.inputs.map((input, i) => ({ v: 1, ts: '2026-09-02T10:00:00Z', pid: 100, seq: i, ...input }));
}

/**
 * One hand-built `verify.completed`, for the shapes the writer cannot produce —
 * it always emits all three `LAYERS` rows, so "this layer was never measured"
 * has no writer spelling. Data shape copied from `verifyEventInput` :340-344.
 */
function verifyRow(result, layer) {
  const data = {};
  if (layer !== undefined) data.layer = layer;
  data.result = result;
  data.evidence = ['E-001'];
  data.verification_id = VID;
  return envelope('verify.completed', data);
}

/** The completion sequence, with the caller's verify rows spliced in. */
function missionEvents(rows) {
  return [
    envelope('mission.created', { title: 'x', intent_revision: 2 }),
    envelope('plan.revised', { revision: 5, mode: 'plan' }),
    ...rows,
    envelope('review.completed', { verdict: 'PASS', findings_ref: 'E-001', verification_id: VID }),
    envelope('mission.completed', {
      accepted: null,
      evidence_refs: ['E-001'],
      verification_id: VID,
    }),
  ];
}

function healthyState() {
  return {
    missionId: MISSION_ID,
    intentRevision: 2,
    planRevision: 5,
    reviewRevision: 1,
    artifacts: {
      plan: { based_on: { intent_revision: 2 } },
      review: { based_on: { intent_revision: 2, plan_revision: 5 } },
    },
  };
}

function runPlan(events, extra = {}) {
  return plan({ events, missionState: healthyState(), projectRoot: PROJECT_ROOT, ...extra });
}

/** `planOneWrite` sets `write.blocked` only when a gate fired (:434-435). */
function outcomeBlock(events, policy) {
  const result = runPlan(events, policy === undefined ? {} : { policy });
  return result.writes.find((w) => w.kind === ArtifactKind.OUTCOME).blocked;
}

/** The live-shaped mixed verdict: only `deterministic` passed. */
const MIXED = () =>
  writerRows(
    { deterministic: 'PASS', behavioral: 'UNMEASURED', operational: 'UNMEASURED' },
    'UNMEASURED',
  );

// ---------------------------------------------------------------------------
// 1. The row shape the rule reads
// ---------------------------------------------------------------------------

describe('the overall verify.completed row, as the landed writer writes it', () => {
  it('omits the layer key entirely on the overall line', () => {
    const rows = MIXED();
    expect(rows).toHaveLength(4);
    expect(Object.hasOwn(rows[0].data, 'layer')).toBe(false);
    expect(rows.slice(1).map((r) => r.data.layer)).toEqual(LANDED_LAYERS);
  });

  it('keeps the writer source honest about that omission', () => {
    const src = readFileSync(path.join(PKG_ROOT, 'lib', 'verification', 'verify-writer.js'), 'utf8');
    expect(src).toContain('if (p.layer !== null) data.layer = p.layer;');
  });

  it('lands the overall line in the unspecified bucket, ahead of the three layers', () => {
    const { findings } = runPlan(missionEvents(MIXED()));
    expect(findings.map((f) => f.layer)).toEqual([LAYER_UNSPECIFIED, ...LANDED_LAYERS]);
    expect(findings[0].counts.unmeasured).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. requiredLayers — the blocking rule
// ---------------------------------------------------------------------------

describe('requiredLayers (owner decision C4 (i))', () => {
  it('does not block when every required layer passed, though optional ones did not', () => {
    expect(outcomeBlock(missionEvents(MIXED()), { requiredLayers: ['deterministic'] }))
      .toBeUndefined();
  });

  it('blocks when a required layer is unmeasured', () => {
    expect(outcomeBlock(missionEvents(MIXED()), { requiredLayers: ['deterministic', 'behavioral'] }))
      .toBe(BlockCode.UNMEASURED_VERIFICATION);
  });

  it('blocks when the required layer itself is unmeasured', () => {
    const rows = writerRows(
      { deterministic: 'UNMEASURED', behavioral: 'PASS', operational: 'PASS' },
      'UNMEASURED',
    );
    expect(outcomeBlock(missionEvents(rows), { requiredLayers: ['deterministic'] }))
      .toBe(BlockCode.UNMEASURED_VERIFICATION);
  });

  it('blocks when the required layer has no row at all — required and never measured', () => {
    const rows = [verifyRow('pass', 'behavioral'), verifyRow('pass', 'operational')];
    expect(outcomeBlock(missionEvents(rows), { requiredLayers: ['deterministic'] }))
      .toBe(BlockCode.UNMEASURED_VERIFICATION);
  });

  it('blocks when no verify.completed arrived at all', () => {
    expect(outcomeBlock(missionEvents([]), { requiredLayers: ['deterministic'] }))
      .toBe(BlockCode.UNMEASURED_VERIFICATION);
  });

  it('does not block when every required layer passed and nothing is unmeasured', () => {
    const rows = writerRows(
      { deterministic: 'PASS', behavioral: 'PASS', operational: 'PASS' },
      'PASS',
    );
    expect(outcomeBlock(missionEvents(rows), { requiredLayers: LANDED_LAYERS })).toBeUndefined();
  });

  it('ignores a required layer that failed — FAIL is measured, and not this gate', () => {
    const rows = writerRows(
      { deterministic: 'FAIL', behavioral: 'PASS', operational: 'PASS' },
      'FAIL',
    );
    expect(outcomeBlock(missionEvents(rows), { requiredLayers: ['deterministic'] })).toBeUndefined();
  });

  it('never blocks on the unspecified bucket, which is where the overall line lands', () => {
    const rows = [verifyRow('unmeasured'), verifyRow('pass', 'deterministic')];
    expect(outcomeBlock(missionEvents(rows), { requiredLayers: ['deterministic'] })).toBeUndefined();
  });

  it('never blocks on the unrecognised bucket either', () => {
    const rows = [verifyRow('unmeasured', 'Behavioral Layer <script>'), verifyRow('pass', 'deterministic')];
    const { findings } = runPlan(missionEvents(rows), { policy: { requiredLayers: ['deterministic'] } });
    expect(findings.some((f) => f.layer === LAYER_UNRECOGNISED)).toBe(true);
    expect(outcomeBlock(missionEvents(rows), { requiredLayers: ['deterministic'] })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Every non-list value falls back to today's behaviour (fail-closed)
// ---------------------------------------------------------------------------

describe('requiredLayers fallback — a value this module cannot read blocks on any layer', () => {
  const cases = [
    ['null', null],
    ['omitted', undefined],
    ['an empty array', []],
    ['a bare string', 'deterministic'],
    ['a name outside LAYER_NAME_PATTERN', ['Bad Name!']],
    ['one good name and one bad', ['deterministic', 'Bad Name!']],
    ['a non-string member', ['deterministic', 7]],
    ['an object', { deterministic: true }],
    ['the unspecified sentinel', [LAYER_UNSPECIFIED]],
    ['the unrecognised sentinel', [LAYER_UNRECOGNISED]],
  ];

  for (const [label, value] of cases) {
    it(`blocks on any unmeasured layer when requiredLayers is ${label}`, () => {
      const policy = value === undefined ? {} : { requiredLayers: value };
      expect(outcomeBlock(missionEvents(MIXED()), policy)).toBe(BlockCode.UNMEASURED_VERIFICATION);
    });
  }

  it('normalises the same way as a pure function', () => {
    expect(normaliseRequiredLayers(['deterministic'])).toEqual(['deterministic']);
    expect(normaliseRequiredLayers(LANDED_LAYERS)).toEqual(LANDED_LAYERS);
    for (const [, value] of cases) expect(normaliseRequiredLayers(value)).toBeNull();
  });

  it('returns a copy, so the caller cannot mutate the policy through it', () => {
    const input = ['deterministic'];
    const out = normaliseRequiredLayers(input);
    expect(out).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 4. Precedence, echo, and the gates requiredLayers must not open
// ---------------------------------------------------------------------------

describe('requiredLayers interaction with the rest of the policy', () => {
  it('keeps unmeasuredBlocksOutcome: false in charge of the whole gate', () => {
    expect(
      outcomeBlock(missionEvents(MIXED()), {
        unmeasuredBlocksOutcome: false,
        requiredLayers: ['deterministic', 'behavioral'],
      }),
    ).toBeUndefined();
  });

  it('defaults to null, which is today behaviour byte for byte', () => {
    expect(DEFAULT_POLICY.requiredLayers).toBeNull();
    expect(DEFAULT_POLICY.unmeasuredBlocksOutcome).toBe(true);
    expect(Object.isFrozen(DEFAULT_POLICY)).toBe(true);
    expect(Object.keys(DEFAULT_POLICY).sort()).toEqual(['requiredLayers', 'unmeasuredBlocksOutcome']);
  });

  it('echoes the injected value so a reader can tell which rule applied', () => {
    expect(runPlan(missionEvents(MIXED())).policy.requiredLayers).toBeNull();
    expect(
      runPlan(missionEvents(MIXED()), { policy: { requiredLayers: ['deterministic'] } })
        .policy.requiredLayers,
    ).toEqual(['deterministic']);
  });

  it('does not open the other outcome gates', () => {
    const events = [
      envelope('mission.created', { title: 'x', intent_revision: 2 }),
      envelope('plan.revised', { revision: 5, mode: 'plan' }),
      ...MIXED(),
      envelope('review.completed', { verdict: 'BLOCK', findings_ref: 'E-001', verification_id: VID }),
      envelope('mission.completed', {
        accepted: null,
        evidence_refs: ['E-001'],
        verification_id: VID,
      }),
    ];
    expect(outcomeBlock(events, { requiredLayers: ['deterministic'] }))
      .toBe(BlockCode.REVIEW_VERDICT_NOT_PASS);
  });

  it('counts every layer in findings regardless of which are required', () => {
    const open = runPlan(missionEvents(MIXED()), { policy: { requiredLayers: ['deterministic'] } });
    const closed = runPlan(missionEvents(MIXED()));
    expect(open.findings).toEqual(closed.findings);
    expect(open.findings.map((f) => f.layer)).toEqual([LAYER_UNSPECIFIED, ...LANDED_LAYERS]);
  });
});

// ---------------------------------------------------------------------------
// 5. The config half of C4, and the docblock that used to deny it
// ---------------------------------------------------------------------------

describe('config compatibility (the hook injects, this module never reads)', () => {
  it('accepts the value artibot.config.json already records', () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const declared = config.review.verify.requiredLayers;
    expect(declared).toEqual(['deterministic']);
    expect(normaliseRequiredLayers(declared)).toEqual(declared);
    expect(config.review.verify.unmeasuredBlocksOutcome).toBe(DEFAULT_POLICY.unmeasuredBlocksOutcome);
  });

  it('still imports nothing and reads nothing — the config arrives as an argument', () => {
    const src = readFileSync(GATES_PATH, 'utf8');
    // The docblock NAMES the config path on purpose (a reader has to find the
    // other half of C4); what must stay absent is any way to reach it.
    expect(src).not.toMatch(/^import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/readFileSync|loadConfig|process\.env/);
  });

  it('no longer claims the per-layer map is unimplemented', () => {
    const src = readFileSync(GATES_PATH, 'utf8');
    expect(src).not.toMatch(/not been made|has not been|placeholder/);
    expect(src).toContain('requiredLayers');
  });
});
