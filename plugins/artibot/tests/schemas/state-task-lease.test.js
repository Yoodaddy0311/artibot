/**
 * project-state / task-graph / lease schema contract tests (PRD T-14).
 *
 * What these guard:
 *  (a) the canonical state.yaml example from package-v1.1/06_STATE_YAML_SPEC.md
 *      still validates — the schema extends v1.1 16 and must never invalidate
 *      the design's own example,
 *  (b) every required field and enum value of package-v1.1/16_STATE_SCHEMA.yaml
 *      survives (a silent narrowing of the v1.1 vocabulary is the failure mode),
 *  (c) the 8 task states are exactly the 8 — not the 7 mission states, and not
 *      the 7 plus an accidental extra,
 *  (d) state_version has a floor of 1,
 *  (e) `workers` absorbs the richer vNext/ops keys (window, head, attempt,
 *      checkpointSeq) without loss, which is why that object stays open,
 *  (f) a lease carries all four of owner/acquired_at/expires_at/heartbeat_at.
 *
 * WHAT THESE TESTS DO NOT COVER — read before treating a green run as proof:
 *  - state_version MONOTONICITY. A schema sees one document; the floor of 1 is
 *    all it can check. Lost-update detection is /doctor Check 8's job.
 *  - Task id UNIQUENESS and dangling `dependencies`. Neither is expressible in
 *    draft-07, so both remain StateStore (T-21) obligations.
 *  - Cross-field equality (task.mission_id vs the graph's mission_id).
 *  - Lease EXPIRY behaviour. This is a shape contract; whether a lease is
 *    actually reclaimed, renewed, or ever written is a runtime question and no
 *    passing schema test says anything about it.
 *
 * Structural assertions are pure file reads (zero runtime deps, matching the
 * plugin's policy and the sibling review-output.schema.test.js). Behavioural
 * assertions need a real validator — cross-file `$ref` resolution and the
 * conditional `required` rules cannot be shown by reading text — so the ajv
 * block runs UNCONDITIONALLY. THE ORACLE IS REQUIRED, NOT OPTIONAL: an earlier
 * revision guarded it with `Ajv ? it : it.skip`, and a run measuring no schema
 * behaviour at all reported the same green as one measuring all of it. It now
 * goes RED, surfacing as {@link AJV_MISSING}. Pattern adopted from
 * tests/schemas/receipts.test.js (T-16).
 *
 * The separate v1.1 example-drift block below stays conditional on purpose: it
 * is gated on the GUIDES FILE, not on ajv. A missing guides tree means the
 * plugin was checked out standalone, which is a different fact from a missing
 * oracle and is not fail-open — nothing is being validated there.
 *
 * WHAT THIS FILE CANNOT SEE (write it next to the gate, per repo rule):
 *  - WHICH ajv enforces the behaviour block. ajv reaches this file only as a
 *    TRANSITIVE dependency (eslint -> ajv; package.json declares no `ajv`,
 *    package-lock pins 6.15.0 while the installed tree resolves 6.12.6, both
 *    measured 2026-09-03), so an eslint bump can remove the oracle with nothing
 *    else changing. The fix then is to DECLARE ajv as a devDependency, never to
 *    restore the skip.
 *  - Whether any writer produces these documents. The fixtures are transcribed
 *    from the v1.1 spec, so a green run says the contract is satisfiable, not
 *    that a runtime producer satisfies it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Imported defensively at module scope only so that a missing ajv produces the
// explicit AJV_MISSING failure below instead of an unresolved-import crash
// whose message says nothing about what to do. Absence is still a FAILURE.
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(__dirname, '../../schemas');
const P = (name) => path.join(SCHEMA_DIR, name);

async function load(name) {
  const raw = await readFile(P(name), 'utf-8');
  return { raw, schema: JSON.parse(raw) };
}

/**
 * The canonical example from package-v1.1/06_STATE_YAML_SPEC.md, transcribed
 * to JSON. Transcribed rather than parsed because the plugin declares no YAML
 * dependency; the drift guard further down re-reads the source file so a change
 * to the canonical example cannot pass unnoticed.
 */
const V11_EXAMPLE_STATE = {
  project: 'artibot',
  state_version: 12,
  updated_at: '2026-09-02T13:40:00+09:00',
  active_missions: {
    'M-20260902-001': {
      title: 'adaptive-intelligence-routing',
      intent: { path: 'missions/M-20260902-001/intent.md', revision: 2 },
      plan: { path: 'missions/M-20260902-001/plan.md', revision: 5 },
      status: 'executing',
      owners: { humans: ['user-001'], agents: ['routing-worker', 'context-worker'] },
      topology: { mode: 'split', performance_profile: 'maximum' },
      workers: {
        'routing-worker': {
          status: 'executing',
          owns: ['plugins/artibot/lib/routing/**'],
          heartbeat_at: '2026-09-02T13:39:00+09:00',
        },
        'context-worker': {
          status: 'reviewing',
          owns: ['plugins/artibot/lib/context/**'],
        },
      },
      blocked_by: [],
      review: { required: true, model: 'fable-5.1', status: 'pending' },
    },
  },
};

/** Every mission status the v1.1 16 original declares. */
const V11_MISSION_STATUSES = [
  'queued',
  'planning',
  'executing',
  'blocked',
  'reviewing',
  'completed',
  'failed',
];

/** The 8 canonical task states (design ARTIBOT-5.0-DESIGN.md §3.5 + §7.2 Addendum §7-8). */
const TASK_STATUSES = [
  'queued',
  'claimed',
  'executing',
  'blocked',
  'reviewing',
  'done',
  'failed',
  'cancelled',
];

const LEASE_REQUIRED = ['owner', 'acquired_at', 'expires_at', 'heartbeat_at'];

/**
 * The router's canonical topology.mode output vocabulary. Source of truth is
 * .artibot/guides/v5-design/package/schemas/run-ledger.schema.yaml:17 (design
 * ARTIBOT-5.0-DESIGN.md §3.5), already mirrored at lib/core/config-schema.js:213
 * and tests/firewall/v5-config-firewall.test.js#TOPOLOGY_MODES.
 */
const TOPOLOGY_MODES = [
  'solo',
  'subagent',
  'team',
  'autopilot',
  'autopilot_fast',
  'split',
];

/**
 * The mission id pattern these two schemas must use, spelled byte-for-byte as
 * ledger-envelope.schema.json and review-output.schema.json spell it. Both id
 * forms are load-bearing: the issued form M-YYYYMMDD-NNN with NNN free to
 * exceed three digits, and the session fallback M-YYYYMMDD-S<sid8> written when
 * the substantive-mission gate declines to issue a mission. Rejecting either
 * would break the state-store-to-ledger join.
 *
 * The spelling is pinned, not just the meaning: \d and [0-9] compile to the
 * same language, so a spelling drift cannot change behaviour, but one canonical
 * source text is what keeps a reader from having to prove that equivalence
 * every time they compare two schemas.
 */
const MISSION_ID_PATTERN = '^M-\\d{8}-(?:\\d{3,}|S[0-9A-Za-z]{8})$';

/** Ids every mission-id-bearing schema must accept. */
const MISSION_IDS_VALID = [
  'M-20260902-001',
  'M-20260902-1001',
  'M-20260902-999999',
  'M-20260902-Styc5j4aa',
  'M-20260902-S0A1b2C3d',
];

/** Ids every mission-id-bearing schema must reject. */
const MISSION_IDS_INVALID = [
  'M-20260902-01',
  'M-2026092-001',
  'M-20260902-S1234567',
  'M-20260902-S123456789',
  'M-20260902-s12345678',
  'M-20260902-00A',
  'M-20260902-',
  'not-a-mission',
  '',
];

const VALID_LEASE = {
  owner: 'session-abc',
  acquired_at: '2026-09-02T13:00:00+09:00',
  expires_at: '2026-09-02T13:30:00+09:00',
  heartbeat_at: '2026-09-02T13:20:00+09:00',
};

// ---------------------------------------------------------------------------
// Structural assertions (no runtime deps)
// ---------------------------------------------------------------------------

describe('T-14 schemas — structure', () => {
  it('all three files are valid JSON with a draft-07 $schema and an $id', async () => {
    for (const name of [
      'project-state.schema.json',
      'task-graph.schema.json',
      'lease.schema.json',
    ]) {
      const { schema } = await load(name);
      expect(typeof schema, `${name} should parse to an object`).toBe('object');
      // draft-07 on purpose: ajv 6 is what this repo can resolve, and the
      // sibling review-output.schema.json already uses draft-07.
      expect(schema.$schema, `${name} $schema`).toBe(
        'http://json-schema.org/draft-07/schema#',
      );
      expect(schema.$id, `${name} $id`).toBe(name);
    }
  });

  it('project-state keeps the v1.1 16 required list unchanged', async () => {
    const { schema } = await load('project-state.schema.json');
    expect(schema.required).toEqual(['project', 'state_version', 'active_missions']);
  });

  it('project-state keeps the v1.1 16 mission required list unchanged', async () => {
    const { schema } = await load('project-state.schema.json');
    expect(schema.definitions.mission.required).toEqual(['status', 'intent', 'plan']);
  });

  it('project-state preserves all 7 v1.1 mission statuses and adds none', async () => {
    const { schema } = await load('project-state.schema.json');
    expect(schema.definitions.mission.properties.status.enum).toEqual(
      V11_MISSION_STATUSES,
    );
  });

  it('state_version carries a floor of 1 and stays an integer', async () => {
    const { schema } = await load('project-state.schema.json');
    const sv = schema.properties.state_version;
    expect(sv.type).toBe('integer');
    expect(sv.minimum).toBe(1);
  });

  it('task-graph declares exactly the 8 task states', async () => {
    const { schema } = await load('task-graph.schema.json');
    expect(schema.definitions.task.properties.status.enum).toEqual(TASK_STATUSES);
    expect(schema.definitions.task.properties.status.enum).toHaveLength(8);
  });

  it('worker status uses the same 8 states, since a worker row projects a task', async () => {
    const { schema } = await load('project-state.schema.json');
    expect(schema.definitions.worker.properties.status.enum).toEqual(TASK_STATUSES);
  });

  it('task and mission status vocabularies stay distinct', async () => {
    const { schema: state } = await load('project-state.schema.json');
    const { schema: graph } = await load('task-graph.schema.json');
    const mission = state.definitions.mission.properties.status.enum;
    const task = graph.definitions.task.properties.status.enum;
    expect(mission).not.toEqual(task);
    // The three values that must exist on exactly one side.
    for (const onlyMission of ['planning', 'completed']) {
      expect(mission).toContain(onlyMission);
      expect(task).not.toContain(onlyMission);
    }
    for (const onlyTask of ['claimed', 'done', 'cancelled']) {
      expect(task).toContain(onlyTask);
      expect(mission).not.toContain(onlyTask);
    }
  });

  it('workers and worker entries leave additionalProperties open', async () => {
    const { schema } = await load('project-state.schema.json');
    const workers = schema.definitions.mission.properties.workers;
    // The v1.1 16 original declares `workers` as a bare object; closing it
    // would drop the vNext/ops keys the design requires be absorbable.
    expect(workers.additionalProperties).toBeTruthy();
    expect(schema.definitions.worker.additionalProperties).toBeUndefined();
  });

  it('lease requires exactly the four canonical fields', async () => {
    const { schema } = await load('lease.schema.json');
    expect(schema.required).toEqual(LEASE_REQUIRED);
    expect(schema.additionalProperties).toBe(false);
  });

  it('blocked reason patterns are an allowlist of the four prefixes', async () => {
    const { schema: state } = await load('project-state.schema.json');
    const { schema: graph } = await load('task-graph.schema.json');
    const expected = '^(lane|gate|human|reconcile):.+$';
    // Same vocabulary on both sides; a deny-list here would fail open for any
    // prefix invented later.
    expect(state.definitions.blockerReason.pattern).toBe(expected);
    expect(graph.definitions.blockerReason.pattern).toBe(expected);
  });

  it('every mission id site uses the two-form pattern, at all three sites', async () => {
    const { schema: state } = await load('project-state.schema.json');
    const { schema: graph } = await load('task-graph.schema.json');
    expect(state.properties.active_missions.propertyNames.pattern).toBe(
      MISSION_ID_PATTERN,
    );
    expect(graph.properties.mission_id.pattern).toBe(MISSION_ID_PATTERN);
    expect(graph.definitions.task.properties.mission_id.pattern).toBe(
      MISSION_ID_PATTERN,
    );
    // A three-digit-only group overflows on the 1000th mission of a day and,
    // without the S-alternative, rejects the session fallback outright. Assert
    // the open-ended quantifier positively so a revert in EITHER spelling
    // (\d{3} or [0-9]{3}) is caught, rather than blacklisting one of them.
    for (const p of [
      state.properties.active_missions.propertyNames.pattern,
      graph.properties.mission_id.pattern,
      graph.definitions.task.properties.mission_id.pattern,
    ]) {
      expect(p).toContain('{3,}');
      expect(p).toContain('S[0-9A-Za-z]{8}');
    }
  });

  it('topology.mode uses the run-ledger 6-value enum, same as mission-contract', async () => {
    const { schema } = await load('project-state.schema.json');
    const mode = schema.definitions.mission.properties.topology.properties.mode;
    expect(mode.enum).toEqual(TOPOLOGY_MODES);
    // Cross-schema drift guard: T-13's mission-contract must not diverge from
    // this list, since both project the same router output vocabulary.
    const { schema: contract } = await load('mission-contract.schema.json');
    expect(contract.properties.topology.properties.mode.enum).toEqual(TOPOLOGY_MODES);
  });

  it('keeps performance_profile on state.yaml even though mission-contract drops it', async () => {
    const { schema } = await load('project-state.schema.json');
    const topology = schema.definitions.mission.properties.topology;
    // Deliberate divergence, not drift: the canonical v1.1 state.yaml example
    // carries performance_profile: maximum, and the rename to
    // execution_profile.performance is decision F2 and still open.
    expect(topology.properties.performance_profile).toBeTruthy();
    const { schema: contract } = await load('mission-contract.schema.json');
    expect(contract.properties.topology.properties.performance_profile).toBeUndefined();
  });

  it('controller requires both session_id and a lease', async () => {
    const { schema } = await load('project-state.schema.json');
    const controller = schema.definitions.mission.properties.controller;
    expect(controller.required).toEqual(['session_id', 'lease']);
    expect(controller.properties.lease.$ref).toBe('lease.schema.json');
  });

  it('task conditionals require severity-style status guards, not vacuous ifs', async () => {
    const { schema } = await load('task-graph.schema.json');
    const allOf = schema.definitions.task.allOf;
    expect(Array.isArray(allOf)).toBe(true);
    // Each `if` must also require `status`, or a task missing status would
    // vacuously satisfy the conditional (the draft-07 if/then pitfall the
    // sibling review-output test already guards).
    for (const rule of allOf) {
      expect(rule.if.required).toEqual(['status']);
    }
  });
});

describe('T-14 schemas — v1.1 example drift guard (skipped if guides absent)', () => {
  // The guides tree sits outside the plugin, so a missing file means the
  // plugin was checked out standalone, not that the example changed.
  const SPEC = path.resolve(
    __dirname,
    '../../../../.artibot/guides/v5-design/package-v1.1/06_STATE_YAML_SPEC.md',
  );
  const maybeIt = existsSync(SPEC) ? it : it.skip;

  maybeIt('the transcribed example still matches the canonical source', () => {
    const raw = readFileSync(SPEC, 'utf-8');
    // Literal markers from the example block. If the canonical example is
    // edited, at least one of these stops matching and the transcription
    // above is flagged as stale instead of silently drifting.
    for (const marker of [
      'project: artibot',
      'state_version: 12',
      'M-20260902-001:',
      'title: adaptive-intelligence-routing',
      'revision: 2',
      'revision: 5',
      'status: executing',
      'mode: split',
      'performance_profile: maximum',
      'routing-worker:',
      'context-worker:',
      'heartbeat_at: 2026-09-02T13:39:00+09:00',
      'blocked_by: []',
      'status: pending',
    ]) {
      expect(raw, `06_STATE_YAML_SPEC.md should still contain "${marker}"`).toContain(
        marker,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural assertions (ajv; RED, never skipped, when ajv is unresolvable)
// ---------------------------------------------------------------------------

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so the T-14 state, task-graph and lease schemas cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('T-14 schemas — ajv behaviour (red, never skipped, without ajv)', () => {
  /**
   * ajv 6's bundled meta-schema does not register the draft-07 $id URI, so
   * `$schema` is dropped before compiling (same workaround as the sibling
   * review-output test). The `$id`s are kept, since the cross-file
   * `$ref: lease.schema.json` resolves through them.
   */
  async function compile(target) {
    // Throws rather than returning null: a null validator would turn every
    // assertion below into "validate is not a function", which buries the real
    // cause. Throwing makes each test fail with the fix instruction instead.
    if (Ajv === null) throw new Error(AJV_MISSING);
    const ajv = new Ajv({ allErrors: true });
    for (const name of [
      'lease.schema.json',
      'task-graph.schema.json',
      'project-state.schema.json',
    ]) {
      const { schema } = await load(name);
      const clone = JSON.parse(JSON.stringify(schema));
      delete clone.$schema;
      ajv.addSchema(clone, name);
    }
    return ajv.getSchema(target);
  }

  const validState = () => JSON.parse(JSON.stringify(V11_EXAMPLE_STATE));
  const mission = (s) => s.active_missions['M-20260902-001'];

  it('has a real oracle — present, and able to say NO as well as YES', async () => {
    // The assertion IS the fail-closed statement: when ajv is gone this block
    // goes red and prints the fix, instead of the suite quietly running twenty
    // fewer assertions. The compared value carries the guidance so the failure
    // diff is the instruction.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    // A validator that accepts everything would satisfy every `toBe(true)`
    // below, and one that rejects everything every `toBe(false)`. Demanding
    // both directions is what makes either worth reading.
    const validate = await compile('project-state.schema.json');
    expect(validate(V11_EXAMPLE_STATE)).toBe(true);
    const broken = validState();
    broken.state_version = 'twelve';
    expect(validate(broken)).toBe(false);
  });

  it('accepts the canonical v1.1 state.yaml example unchanged', async () => {
    const validate = await compile('project-state.schema.json');
    const ok = validate(V11_EXAMPLE_STATE);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('accepts all 7 mission statuses and rejects a task-only value', async () => {
    const validate = await compile('project-state.schema.json');
    for (const status of V11_MISSION_STATUSES) {
      const s = validState();
      mission(s).status = status;
      expect(validate(s), `mission status ${status} should be valid`).toBe(true);
    }
    for (const status of ['done', 'claimed', 'cancelled', 'nonsense']) {
      const s = validState();
      mission(s).status = status;
      expect(validate(s), `mission status ${status} should be invalid`).toBe(false);
    }
  });

  it('rejects state_version below 1 and non-integers', async () => {
    const validate = await compile('project-state.schema.json');
    for (const bad of [0, -1, 1.5, '12', null]) {
      const s = validState();
      s.state_version = bad;
      expect(validate(s), `state_version ${JSON.stringify(bad)} should be invalid`).toBe(
        false,
      );
    }
    const s = validState();
    s.state_version = 1;
    expect(validate(s)).toBe(true);
  });

  it('absorbs the richer vNext/ops worker keys without loss', async () => {
    const validate = await compile('project-state.schema.json');
    const s = validState();
    mission(s).workers['routing-worker'] = {
      status: 'executing',
      owns: ['plugins/artibot/lib/routing/**'],
      heartbeat_at: null,
      heartbeat_source: 'last-commit',
      window: 3,
      head: 'abc1234',
      attempt: 2,
      checkpointSeq: 17,
    };
    const ok = validate(s);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('accepts every allowlisted blocked_by prefix and rejects others', async () => {
    const validate = await compile('project-state.schema.json');
    for (const reason of ['lane:a', 'gate:7', 'human:owner-decision', 'reconcile:w1']) {
      const s = validState();
      mission(s).blocked_by = [reason];
      expect(validate(s), `${reason} should be valid`).toBe(true);
    }
    for (const reason of ['lane', 'lane:', 'unknown:x', 'LANE:a', '']) {
      const s = validState();
      mission(s).blocked_by = [reason];
      expect(validate(s), `${JSON.stringify(reason)} should be invalid`).toBe(false);
    }
  });

  it('resolves the cross-file lease $ref from controller', async () => {
    const validate = await compile('project-state.schema.json');
    const s = validState();
    mission(s).controller = { session_id: 'sess-1', lease: { ...VALID_LEASE } };
    expect(validate(s), JSON.stringify(validate.errors)).toBe(true);

    // A controller whose lease is missing a required field must fail through
    // the ref, proving the ref is actually applied and not silently unresolved.
    const bad = validState();
    mission(bad).controller = {
      session_id: 'sess-1',
      lease: { owner: 'x', acquired_at: VALID_LEASE.acquired_at },
    };
    expect(validate(bad)).toBe(false);

    // ...and a controller with no lease at all is rejected.
    const noLease = validState();
    mission(noLease).controller = { session_id: 'sess-1' };
    expect(validate(noLease)).toBe(false);
  });

  it('requires each of the four lease fields individually', async () => {
    const validate = await compile('lease.schema.json');
    expect(validate(VALID_LEASE), JSON.stringify(validate.errors)).toBe(true);
    for (const field of LEASE_REQUIRED) {
      const lease = { ...VALID_LEASE };
      delete lease[field];
      expect(validate(lease), `lease without ${field} should be invalid`).toBe(false);
    }
  });

  it('carries the prior-art lease fields in snake_case only', async () => {
    const validate = await compile('lease.schema.json');
    expect(
      validate({ ...VALID_LEASE, token: 't', pid: 123, host: 'h', session_id: 's' }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    // landing-lock.js spells these acquiredAt/sessionId; the design text and
    // state.yaml are snake_case, so the camelCase spellings must not sneak in.
    expect(validate({ ...VALID_LEASE, sessionId: 's' })).toBe(false);
    expect(validate({ owner: 'x', acquiredAt: 1, expires_at: '', heartbeat_at: '' })).toBe(
      false,
    );
  });

  it('accepts a task graph using each of the 8 states', async () => {
    const validate = await compile('task-graph.schema.json');
    for (const status of TASK_STATUSES) {
      const task = {
        id: 'T-14',
        mission_id: 'M-20260902-001',
        title: 'schemas',
        status,
        retry_count: 0,
        file_ownership: ['plugins/artibot/schemas/**'],
        dependencies: [],
        verification: 'npx vitest run tests/schemas/state-task-lease.test.js',
      };
      // Owner is conditionally required for the three in-flight states, and a
      // blocked task must say why.
      if (['claimed', 'executing', 'reviewing'].includes(status)) task.owner = 'w1';
      if (status === 'blocked') task.blockers = ['gate:3'];
      const graph = { schema_version: 1, mission_id: 'M-20260902-001', tasks: [task] };
      const ok = validate(graph);
      expect(validate.errors ?? [], `${status}: ${JSON.stringify(validate.errors)}`).toEqual(
        [],
      );
      expect(ok, `task status ${status} should be valid`).toBe(true);
    }
  });

  it('rejects a 9th task status', async () => {
    const validate = await compile('task-graph.schema.json');
    const graph = {
      schema_version: 1,
      mission_id: 'M-20260902-001',
      tasks: [{ id: 'T-1', mission_id: 'M-20260902-001', status: 'completed' }],
    };
    expect(validate(graph)).toBe(false);
  });

  it('requires an owner for claimed/executing/reviewing tasks', async () => {
    const validate = await compile('task-graph.schema.json');
    for (const status of ['claimed', 'executing', 'reviewing']) {
      const graph = {
        schema_version: 1,
        mission_id: 'M-20260902-001',
        tasks: [{ id: 'T-1', mission_id: 'M-20260902-001', status }],
      };
      expect(validate(graph), `${status} without owner should be invalid`).toBe(false);
    }
    // queued legitimately has no owner.
    const queued = {
      schema_version: 1,
      mission_id: 'M-20260902-001',
      tasks: [{ id: 'T-1', mission_id: 'M-20260902-001', status: 'queued' }],
    };
    expect(validate(queued), JSON.stringify(validate.errors)).toBe(true);
  });

  it('requires a non-empty blockers list on a blocked task', async () => {
    const validate = await compile('task-graph.schema.json');
    const mk = (task) => ({
      schema_version: 1,
      mission_id: 'M-20260902-001',
      tasks: [{ id: 'T-1', mission_id: 'M-20260902-001', status: 'blocked', ...task }],
    });
    expect(validate(mk({})), 'blocked with no blockers').toBe(false);
    expect(validate(mk({ blockers: [] })), 'blocked with empty blockers').toBe(false);
    expect(validate(mk({ blockers: ['reconcile:w1'] }))).toBe(true);
  });

  it('accepts verification as a bare command string or as a result object', async () => {
    const validate = await compile('task-graph.schema.json');
    const mk = (verification) => ({
      schema_version: 1,
      mission_id: 'M-20260902-001',
      tasks: [{ id: 'T-1', mission_id: 'M-20260902-001', status: 'queued', verification }],
    });
    expect(validate(mk('npx vitest run tests/schemas/state-task-lease.test.js'))).toBe(
      true,
    );
    expect(validate(mk({ command: 'npx vitest run', status: 'unmeasured' }))).toBe(true);
    expect(validate(mk({ command: 'npx vitest run', status: 'passed' }))).toBe(true);
    expect(validate(mk({ status: 'passed' })), 'object without command').toBe(false);
    expect(validate(mk({ command: 'x', status: 'green' })), 'unknown status').toBe(false);
  });

  it('rejects a task graph missing schema_version or a malformed mission id', async () => {
    const validate = await compile('task-graph.schema.json');
    const task = { id: 'T-1', mission_id: 'M-20260902-001', status: 'queued' };
    expect(validate({ mission_id: 'M-20260902-001', tasks: [task] })).toBe(false);
    expect(validate({ schema_version: 1, mission_id: 'M-2026-1', tasks: [task] })).toBe(
      false,
    );
    expect(validate({ schema_version: 0, mission_id: 'M-20260902-001', tasks: [task] })).toBe(
      false,
    );
  });

  it('accepts state.yaml without schema_version but rejects an invalid one', async () => {
    const validate = await compile('project-state.schema.json');
    // Optional on purpose: the canonical v1.1 example carries none.
    expect(validate(validState())).toBe(true);
    const withVersion = validState();
    withVersion.schema_version = 1;
    expect(validate(withVersion)).toBe(true);
    const bad = validState();
    bad.schema_version = 0;
    expect(validate(bad)).toBe(false);
  });

  it('accepts each topology.mode and rejects one outside the 6', async () => {
    const validate = await compile('project-state.schema.json');
    for (const mode of TOPOLOGY_MODES) {
      const s = validState();
      mission(s).topology = { mode, performance_profile: 'maximum' };
      expect(validate(s), `topology.mode ${mode} should be valid`).toBe(true);
    }
    for (const mode of ['swarm', 'Split', '']) {
      const s = validState();
      mission(s).topology = { mode };
      expect(validate(s), `topology.mode ${JSON.stringify(mode)} should be invalid`).toBe(
        false,
      );
    }
  });

  it('keys active_missions by either mission id form', async () => {
    const validate = await compile('project-state.schema.json');
    for (const id of MISSION_IDS_VALID) {
      const s = validState();
      const m = mission(s);
      s.active_missions = { [id]: m };
      expect(validate(s), `${id} should be a valid key: ${JSON.stringify(validate.errors)}`).toBe(
        true,
      );
    }
    for (const id of MISSION_IDS_INVALID) {
      const s = validState();
      const m = mission(s);
      s.active_missions = { [id]: m };
      expect(validate(s), `${JSON.stringify(id)} should be an invalid key`).toBe(false);
    }
  });

  it('accepts either mission id form on the graph and on a task', async () => {
    const validate = await compile('task-graph.schema.json');
    const mk = (id) => ({
      schema_version: 1,
      mission_id: id,
      tasks: [{ id: 'T-1', mission_id: id, status: 'queued' }],
    });
    for (const id of MISSION_IDS_VALID) {
      expect(validate(mk(id)), `${id}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    for (const id of MISSION_IDS_INVALID) {
      expect(validate(mk(id)), `${JSON.stringify(id)} should be invalid`).toBe(false);
    }
    // The graph-level field and the task-level field must move together; a
    // valid graph id must not rescue an invalid task id.
    expect(
      validate({
        schema_version: 1,
        mission_id: 'M-20260902-001',
        tasks: [{ id: 'T-1', mission_id: 'M-20260902-01', status: 'queued' }],
      }),
    ).toBe(false);
  });

  it('agrees with the T-15 ledger envelope on every mission id', async () => {
    // Join integrity: a mission_id the ledger accepts must be storable in the
    // state store and vice versa, or the state-to-ledger join drops rows.
    // NOTE this guard SKIPS when the envelope schema is absent (it belongs to
    // another in-flight task), so a green run here does not by itself prove the
    // join holds — it only proves the two agree when both files exist.
    const envelopePath = P('ledger-envelope.schema.json');
    if (!existsSync(envelopePath)) return;
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf-8'));

    /** Find the mission_id subschema wherever the envelope declares it. */
    const findMissionId = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.properties?.mission_id?.pattern) return node.properties.mission_id;
      for (const value of Object.values(node)) {
        const hit = findMissionId(value);
        if (hit) return hit;
      }
      return null;
    };
    const envelopeMissionId = findMissionId(envelope);
    expect(envelopeMissionId, 'envelope should declare a mission_id pattern').toBeTruthy();

    // Byte comparison first: the ledger envelope is the canonical spelling, so
    // these schemas must carry the same source text, not merely an equivalent
    // regex. Equivalence is then re-checked below on parsed acceptance, which
    // is what actually decides whether the join drops rows.
    expect(
      envelopeMissionId.pattern,
      'state store and ledger envelope must spell the mission id pattern identically',
    ).toBe(MISSION_ID_PATTERN);

    const ajv = new Ajv({ allErrors: true });
    const envelopeValidate = ajv.compile({
      type: 'string',
      pattern: envelopeMissionId.pattern,
    });
    const mineValidate = ajv.compile({ type: 'string', pattern: MISSION_ID_PATTERN });

    // Compare parsed acceptance, not pattern bytes: the envelope spells the
    // digit class \d where these schemas spell [0-9]. Same language, different
    // source text, so a byte comparison would fail on a difference that cannot
    // affect the join.
    for (const id of [...MISSION_IDS_VALID, ...MISSION_IDS_INVALID]) {
      expect(
        mineValidate(id),
        `${JSON.stringify(id)}: state store and ledger envelope disagree`,
      ).toBe(envelopeValidate(id));
    }
  });
});
