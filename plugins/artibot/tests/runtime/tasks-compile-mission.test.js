/**
 * T-25 — `compileMission()` wiring in the tasks middleware.
 *
 * WHAT THIS GATE DOES NOT SEE
 * ---------------------------
 *  - COMPILE QUALITY. It asserts that a contract reaches the task envelope and
 *    that the mission line (plus, since SH-18, the question-gate line) reaches
 *    the ledger. Whether the contract is a good reading
 *    of the prompt is `tests/mission/compiler.test.js`'s question (T-22), and
 *    nothing here would fail if the compiler's extraction regressed.
 *  - THE REAL HOOK PAYLOAD. Every state here is hand-built. The keys are taken
 *    from `middleware/memory.js#buildQueryContext` and
 *    `observability/decision-events.js#resolveDecisionRunId`,
 *    which is evidence that this pipeline reads those keys, NOT evidence that a
 *    live UserPromptSubmit payload carries a usable `cwd` and `session_id`. If
 *    it carries neither, this wiring degrades to `skipped:*` in production and
 *    every test below still passes. Reach (how often a real prompt actually
 *    produces a ledger line) is UNMEASURED here.
 *  - LEDGER SEMANTICS. The line is parsed back and its envelope inspected, but
 *    the fold projection, dedupe, and rotation are `tests/runtime/ledger.test.js`.
 *  - CONCURRENCY. One process, one prompt at a time. The append primitive's
 *    interleaving guarantee is `tests/firewall/ledger-append-survival.test.js`.
 *  - `.artibot/**` NON-CREATION is asserted for this middleware only, and only
 *    for the paths a Phase 0 prompt could plausibly touch.
 *  - THE DECISION RECORDER'S OWN BEHAVIOR. `recordWorkflowPlanDecision` is
 *    module-mocked here (see the mock's comment), so nothing below would catch
 *    a regression inside it. That path is
 *    `tests/runtime/middleware/decision-events-wiring.test.js`'s. What IS
 *    asserted is that the call still happens and that the real store gains
 *    zero lines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `writeFileSync` is aliased: two pre-existing tests destructure it locally.
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync as writeFile,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * STORE ISOLATION — why a module mock and not a `storeDir` override.
 *
 * The tasks middleware's pre-existing `recordWorkflowPlanDecision` call
 * (inside `lib/runtime/middleware/tasks.js#createTasksMiddleware`) passes no
 * options, and no `storeDir` exists anywhere in the middleware state to thread
 * one from. So although
 * `lib/observability/decision-events.js#getDecisionStoreDir`
 * does accept an override, that override cannot REACH this call site without
 * changing pre-existing wiring that T-25 does not own.
 *
 * Left unmocked, running this suite writes `workflow-planned` lines into the
 * REAL store at `<projectRoot>/.artibot/runtime/decisions/` (`<pluginRoot>/
 * runtime/decisions/` before 2026-09-03), which `/doctor` reads —
 * fixture pollution of a diagnostic store is worse than a missing record.
 * Measured: 159 lines / 61,215 B accumulated there before this mock landed.
 *
 * Only the recorder is replaced. `importOriginal` keeps every other export
 * real, including `resolveDecisionRunId` (which the middleware also calls) and
 * `getDecisionEventsPath` (which the leak assertion below needs to compute the
 * real path). The stubbed function is asserted to have been CALLED, so the
 * mock cannot hide a wiring break by making the path silently disappear.
 */
vi.mock('../../lib/observability/decision-events.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordWorkflowPlanDecision: vi.fn() };
});

/**
 * The ledger append port and the question-gate recorder, wrapped so the SH-18
 * containment tests can make them refuse or throw. Both run their REAL
 * implementation unless a test swaps it, and `afterEach` swaps it back — every
 * other test in this file still writes real lines through the real writer.
 */
vi.mock('../../lib/runtime/ledger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendLedgerEvent: vi.fn(actual.appendLedgerEvent) };
});
vi.mock('../../lib/runtime/question-gate-record.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendQuestionGateEvent: vi.fn(actual.appendQuestionGateEvent) };
});

import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import {
  getDecisionEventsPath,
  recordWorkflowPlanDecision,
} from '../../lib/observability/decision-events.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { appendQuestionGateEvent } from '../../lib/runtime/question-gate-record.js';
import { GATE_CONDITIONS } from '../../lib/planning/question-gate.js';

const realLedger = await vi.importActual('../../lib/runtime/ledger.js');
const realGateRecord = await vi.importActual('../../lib/runtime/question-gate-record.js');

/** The SH-18 event name, spelled out rather than imported from its emitter. */
const GATE_EVENT = 'adr.question_gate_evaluated';

const NOW = 1700000000000;

/**
 * Distinct from the `SID` constant in `tests/runtime/event-writer.test.js`,
 * which used to share the id `sess-abcdefgh-0001`. That file writes only into
 * its own temp project
 * root and never touches the decision store, so the shared id caused no
 * collision — but it did make the polluted file's owner ambiguous during the
 * T-37 investigation, which cost real time. The id now names its owner.
 */
const SESSION = 'sess-t25-compile-0001';

let projectRoot;

/** Line count of the REAL decision store file for SESSION. 0 when absent. */
function realStoreLineCount() {
  const file = getDecisionEventsPath(SESSION);
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).length;
}

let realStoreLinesAtStart;

beforeEach(() => {
  resetSeq();
  vi.clearAllMocks();
  projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-t25-'));
  realStoreLinesAtStart = realStoreLineCount();
});

afterEach(() => {
  vi.mocked(appendLedgerEvent).mockImplementation(realLedger.appendLedgerEvent);
  vi.mocked(appendQuestionGateEvent).mockImplementation(realGateRecord.appendQuestionGateEvent);
  rmSync(projectRoot, { recursive: true, force: true });
  // Every test asserts the invariant, not just the dedicated one below: no
  // test in this file may add a line to the real decision store.
  expect(realStoreLineCount()).toBe(realStoreLinesAtStart);
  vi.restoreAllMocks();
});

/**
 * A middleware state shaped like the one the default pipeline builds.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function makeState(overrides = {}) {
  const { input, context, ...rest } = overrides;
  return {
    input: {
      prompt: '대시보드를 만들어줘',
      hookData: { session_id: SESSION, cwd: projectRoot },
      ...input,
    },
    context: {
      routing: { system: 'system2', score: 0.9 },
      intent: {
        best: 'action:implement',
        commands: ['/implement'],
        agents: ['frontend-developer'],
        ambiguous: false,
      },
      ...context,
    },
    messageParts: [],
    userPrompt: 'test prompt',
    ...rest,
  };
}

/** @returns {string} absolute path of the project's ledger file */
function ledgerPath() {
  return path.join(projectRoot, '.artibot', 'runtime', 'ledger.jsonl');
}

/** @returns {object[]} every JSON line currently in the ledger */
function readLedger() {
  if (!existsSync(ledgerPath())) return [];
  return readFileSync(ledgerPath(), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * @param {object} [overrides] state overrides
 * @returns {Promise<object>} the resulting task envelope
 */
async function runMiddleware(overrides) {
  const mw = createTasksMiddleware({ now: () => NOW });
  const result = await mw(makeState(overrides));
  return result.context.tasks;
}

describe('T-25 — contract on the task envelope', () => {
  it('records a compiled contract for a system2 prompt', async () => {
    const task = await runMiddleware();

    expect(task.mission.ok).toBe(true);
    expect(task.mission.mode).toBe('full');
    expect(task.mission.contract.goal).toBeTypeOf('string');
    expect(task.mission.contract).toHaveProperty('explicit_requests');
    expect(task.mission.contract).toHaveProperty('scope');
  });

  it('gives system1 the REDUCED contract, and still compiles it', async () => {
    const task = await runMiddleware({
      context: { routing: { system: 'system1', score: 0.2 }, intent: {} },
    });

    // The point of §3.5: system1 is NOT skipped. A compiler that skipped it
    // would have no Observe denominator.
    expect(task.mission.ok).toBe(true);
    expect(task.mission.mode).toBe('reduced');
    expect(task.mission.contract).toHaveProperty('goal');
    expect(task.mission.contract).toHaveProperty('explicit_requests');
    // Reduced means reduced — the full-contract keys are absent, not empty.
    expect(task.mission.contract).not.toHaveProperty('scope');
    expect(task.mission.contract).not.toHaveProperty('findings');
    expect(task.mission.contract).not.toHaveProperty('success');
  });

  it('compiles for subAgent mode, so the agentTeam condition is not inherited', async () => {
    const task = await runMiddleware({
      context: { routing: { system: 'system1' }, intent: {} },
    });

    expect(task.mode).toBe('subAgent');
    expect(task.mission.contract).toBeDefined();
    expect(task.meta?.workflowPlan).toBeUndefined();
  });
});

describe('T-25 — ledger append', () => {
  it('writes exactly two lines into the injected project root: the mission event, then the question gate', async () => {
    // RE-PINNED 1 -> 2 by SH-18 (2026-09-23), an intended change: the question
    // gate's verdict is now recorded beside the mission event, from the same
    // `recordMissionCompile` call (decision 7). This prompt defers, so neither
    // line is paired with a store write.
    await runMiddleware();
    const lines = readLedger();

    expect(lines.map((l) => l.event)).toEqual(['mission.candidate_deferred', GATE_EVENT]);
    for (const line of lines) {
      expect(line.session_id).toBe(SESSION);
      expect(line.source).toBe('hook');
      expect(line.ts).toBe(new Date(NOW).toISOString());
    }
    // One mission, one session, one instant — not merely similar values.
    expect(lines[1].mission_id).toBe(lines[0].mission_id);
  });

  it('records the four gate conditions, required and the interpretation marker as booleans, and the status', async () => {
    const task = await runMiddleware();
    const gate = readLedger().find((l) => l.event === GATE_EVENT);

    expect(task.mission.question_gate).toBe('appended');
    // RE-PINNED (intended): CA-15 false -> true; follow-up b adds the string status. Real router: tasks-question-gate-inputs.test.js.
    expect(gate.data).toEqual({
      ...Object.fromEntries(GATE_CONDITIONS.map((key) => [key, expect.any(Boolean)])),
      required: expect.any(Boolean), interpretation_present: true, interpretation_status: 'ok',
    });
  });

  it('puts the gate line after the paired state.updated on a substantive prompt', async () => {
    await runMiddleware({ input: { prompt: '/implement 대시보드를 만들어줘' } });
    const lines = readLedger();

    expect(lines.map((l) => l.event)).toEqual(['mission.created', 'state.updated', GATE_EVENT]);
    expect(lines[2].mission_id).toBe(lines[0].mission_id);
    expect(lines[2].session_id).toBe(lines[0].session_id);
  });

  it('writes mission.created for an S5 prompt (explicit /implement)', async () => {
    const task = await runMiddleware({ input: { prompt: '/implement 대시보드를 만들어줘' } });
    const lines = readLedger();

    expect(task.mission.substantive).toBe(true);
    // Since the state-store wiring (split-5f9fe3) a substantive prompt also
    // appends `state.updated`; this contract owns only the mission.created line.
    const created = lines.filter((l) => l.event === 'mission.created');
    expect(created).toHaveLength(1);
    expect(created[0].data.title).toBeTypeOf('string');
    expect(created[0].data.title.length).toBeLessThanOrEqual(120);
    expect(created[0].data.intent_revision).toBe(1);
  });

  it('writes mission.created for an S3 prompt (two explicit requests)', async () => {
    const task = await runMiddleware({
      input: { prompt: '대시보드를 만들어줘. 그리고 테스트도 추가해줘.' },
    });

    expect(task.mission.signals).toContain('S3');
    expect(readLedger()[0].event).toBe('mission.created');
  });

  it('synthesizes the session fallback mission_id, since no mission was issued', async () => {
    await runMiddleware();

    expect(readLedger()[0].mission_id).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
  });

  it('defers a one-request prompt — S4 and S6 are unreachable from this call site', async () => {
    // Recorded as a REACH limit, not as desired behavior. At `stage: 'prompt'`
    // only S3/S4/S5/S6 are measurable (`mission-id.js#PROMPT_STAGE_SIGNALS`),
    // and this middleware
    // supplies neither `intentConfidence` (S4, T-24's) nor `activeMission` /
    // `followUp` (S6, a state.yaml lookup). So exactly two of the six signals
    // can fire from here in Phase 0, and every other prompt defers.
    const task = await runMiddleware();

    expect(task.mission.substantive).toBe(false);
    expect(readLedger()[0].event).toBe('mission.candidate_deferred');
  });

  it('uses the ALLOWLIST spelling for the deferred event, not the compiler string', async () => {
    // A bare greeting fails the substantive gate, so the compiler returns
    // `mission-candidate-deferred` (`compiler.js#compileMission`) — a name the
    // ledger vocabulary does not register. The registered name is
    // `mission.candidate_deferred`, under the allowlist's `events` map.
    const task = await runMiddleware({ input: { prompt: '안녕' } });
    const lines = readLedger();

    expect(task.mission.substantive).toBe(false);
    // 1 -> 2 since SH-18: the second line is the question gate's.
    expect(lines.map((l) => l.event)).toEqual(['mission.candidate_deferred', GATE_EVENT]);
    expect(lines[0].data.reason).toBeTypeOf('string');
    expect(Array.isArray(lines[0].data.signals)).toBe(true);
    // The unregistered spelling must never reach the file.
    expect(readFileSync(ledgerPath(), 'utf-8')).not.toContain('mission-candidate-deferred');
  });

  it('carries a title on the DEFERRED line too — stage ② has no other source for it', async () => {
    // THE STAGE ② CARRIER (design §3.1 "mission_id 발급 2단계").
    // `scripts/hooks/intent-observe-pre.js` promotes this candidate to
    // `mission.created` at the session's first Write/Edit, by which time the
    // prompt is gone. Without this key the promoted mission can only be named
    // after the file being written, which is a filename, not an intent.
    //
    // The allowlist declares `mission.candidate_deferred` with typed
    // `fields {reason, signals}` and `required: []`, and
    // `event-writer.js#validateDeclaredFields` type-checks only DECLARED keys.
    // So the half of this test that matters is that the WRITER ACCEPTED the
    // line: a refused envelope lands as `ledger.rejected`, never as this event.
    const task = await runMiddleware({ input: { prompt: '대시보드를 만들어줘' } });
    const lines = readLedger();

    expect(task.mission.substantive).toBe(false);
    // 1 -> 2 since SH-18: the second line is the question gate's.
    expect(lines.map((l) => l.event)).toEqual(['mission.candidate_deferred', GATE_EVENT]);
    expect(lines[0].data.title).toBeTypeOf('string');
    expect(lines[0].data.title.length).toBeGreaterThan(0);
    // The pre-existing two keys are untouched — this is additive.
    expect(lines[0].data.reason).toBeTypeOf('string');
    expect(Array.isArray(lines[0].data.signals)).toBe(true);
  });

  it('caps the deferred title at the same 120 chars mission.created uses', async () => {
    // One cap, one expression (`mission-ledger.js#missionTitle`). An uncapped
    // goal on a line the writer must keep under 4 KB is how a required field
    // gets folded away and the whole envelope rejected.
    await runMiddleware({ input: { prompt: '가'.repeat(400) } });
    const lines = readLedger();

    expect(lines[0].event).toBe('mission.candidate_deferred');
    expect(lines[0].data.title).toHaveLength(120);
    expect(Buffer.byteLength(`${JSON.stringify(lines[0])}\n`, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('appends nothing and records why when no project root is knowable', async () => {
    const task = await runMiddleware({
      input: { hookData: { session_id: SESSION } },
    });

    expect(task.mission.ledger).toBe('skipped:no-project-root');
    expect(task.mission.question_gate).toBe('skipped:no-project-root');
    expect(task.mission.contract).toBeDefined();
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('appends nothing and records why when no session id is knowable', async () => {
    const task = await runMiddleware({
      input: { hookData: { cwd: projectRoot } },
    });

    expect(task.mission.ledger).toBe('skipped:no-session-id');
    expect(task.mission.question_gate).toBe('skipped:no-session-id');
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('records a rejection reason rather than a silent pass', async () => {
    // A session id of a shape the envelope cannot build a mission_id from.
    const task = await runMiddleware({
      input: { hookData: { session_id: '  ', cwd: projectRoot } },
    });

    expect(task.mission.ledger).toBe('skipped:no-session-id');
  });
});

describe('T-25 — failure containment', () => {
  it('an append failure leaves the middleware result identical', async () => {
    // A file where the ledger directory must go: mkdirSync then fails, so the
    // append cannot succeed. This exercises the real writer's failure path
    // rather than a mocked one.
    const blocked = mkdtempSync(path.join(tmpdir(), 'artibot-t25-blocked-'));
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(path.join(blocked, '.artibot'), { recursive: true });
    writeFileSync(path.join(blocked, '.artibot', 'runtime'), 'not a directory');

    const mw = createTasksMiddleware({ now: () => NOW });
    const state = makeState({ input: { hookData: { session_id: SESSION, cwd: blocked } } });
    const result = await mw(state);
    const task = result.context.tasks;

    expect(task.mission.ok).toBe(true);
    expect(task.mission.ledger).not.toBe('appended');
    // Everything the middleware promises downstream is untouched.
    expect(task.mode).toBe('agentTeam');
    expect(task.phases).toEqual(['plan', 'execute', 'verify']);
    expect(result.messageParts).toContain('task=agentTeam');
    expect(result.userPrompt).toContain('Execution contract:');

    rmSync(blocked, { recursive: true, force: true });
  });

  it('a compile throw is recorded, and the prompt still goes through', async () => {
    const mw = createTasksMiddleware({ now: () => NOW });
    const state = makeState();
    // A prompt whose String() coercion throws, reaching the compile call.
    state.input.prompt = { toString() { throw new Error('boom'); } };

    const result = await mw(state);

    expect(result.context.tasks.mission.ok).toBe(false);
    expect(result.context.tasks.mission.error).toBe('boom');
    expect(result.context.tasks.mission.ledger).toBe('skipped:compile-failed');
    // No gate line either — see `tasks.js#recordMissionCompile` for why the
    // gate's denominator follows the mission event's.
    expect(result.context.tasks.mission.question_gate).toBe('skipped:compile-failed');
    expect(result.messageParts).toContain('task=agentTeam');
    expect(existsSync(ledgerPath())).toBe(false);
  });
});

describe('SH-18 — a failing question-gate recorder cannot reach its neighbours', () => {
  const SUBSTANTIVE = { input: { prompt: '/implement 대시보드를 만들어줘' } };

  /**
   * Run the substantive prompt in a FRESH project root, so the store starts
   * at state_version 0 in every run and two runs are comparable field by field.
   *
   * @returns {Promise<{result: object, events: string[]}>}
   */
  async function runFresh() {
    const root = mkdtempSync(path.join(tmpdir(), 'artibot-sh18-'));
    try {
      const mw = createTasksMiddleware({ now: () => NOW });
      const result = await mw(makeState({
        input: { ...SUBSTANTIVE.input, hookData: { session_id: SESSION, cwd: root } },
      }));
      const file = path.join(root, '.artibot', 'runtime', 'ledger.jsonl');
      const events = existsSync(file)
        ? readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).event)
        : [];
      return { result, events };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** Everything the middleware returns except the gate status and the random task id. */
  function comparable({ result }) {
    const { question_gate: _gate, ...mission } = result.context.tasks.mission;
    const { id: _id, mission: _m, ...task } = result.context.tasks;
    return { mission, task, messageParts: result.messageParts, userPrompt: result.userPrompt };
  }

  /** Make the ledger port misbehave for the gate line ONLY; every other line is real. */
  function breakGateAppend(behaviour) {
    vi.mocked(appendLedgerEvent).mockImplementation((root, envelope, opts) => (
      envelope?.event === GATE_EVENT
        ? behaviour()
        : realLedger.appendLedgerEvent(root, envelope, opts)
    ));
  }

  it.each([
    ['rejects the line', () => ({ ok: false, reason: 'probe-refusal' }), 'rejected:probe-refusal'],
    ['returns nothing', () => undefined, 'rejected:unknown'],
    ['throws', () => { throw new Error('port-boom'); }, 'error:port-boom'],
  ])('leaves every other field deep-equal when the append port %s', async (_label, behaviour, status) => {
    const baseline = await runFresh();
    expect(baseline.result.context.tasks.mission.question_gate).toBe('appended');
    expect(baseline.events).toEqual(['mission.created', 'state.updated', GATE_EVENT]);

    breakGateAppend(behaviour);
    const broken = await runFresh();

    expect(broken.result.context.tasks.mission.question_gate).toBe(status);
    expect(comparable(broken)).toEqual(comparable(baseline));
    // The store write and the mission event happened exactly as before.
    expect(broken.result.context.tasks.mission.store.status).toBe('written');
    expect(broken.events).toEqual(['mission.created', 'state.updated']);
  });

  it('leaves every other field deep-equal when the recorder itself throws', async () => {
    // `appendQuestionGateEvent` promises not to throw. This is the case where
    // it breaks that promise: without the local catch in
    // `tasks.js#recordQuestionGate`, the throw would reach recordMissionCompile's
    // catch and rewrite the whole mission record as a compile failure.
    const baseline = await runFresh();

    vi.mocked(appendQuestionGateEvent).mockImplementation(() => { throw new Error('recorder-boom'); });
    const broken = await runFresh();

    expect(broken.result.context.tasks.mission.question_gate).toBe('error:recorder-boom');
    expect(broken.result.context.tasks.mission.ok).toBe(true);
    expect(comparable(broken)).toEqual(comparable(baseline));
    expect(broken.events).toEqual(['mission.created', 'state.updated']);
  });

  it('reports a real writer failure on the gate line without touching the mission record', async () => {
    // The unmocked failure path: the ledger directory is a file, so every
    // append refuses, the gate's included.
    const blocked = mkdtempSync(path.join(tmpdir(), 'artibot-sh18-blocked-'));
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(path.join(blocked, '.artibot'), { recursive: true });
      writeFileSync(path.join(blocked, '.artibot', 'runtime'), 'not a directory');
      const mw = createTasksMiddleware({ now: () => NOW });
      const result = await mw(makeState({ input: { hookData: { session_id: SESSION, cwd: blocked } } }));
      const { mission } = result.context.tasks;

      expect(mission.ok).toBe(true);
      expect(mission.question_gate).not.toBe('appended');
      expect(mission.question_gate).toMatch(/^(rejected|error):/);
    } finally {
      rmSync(blocked, { recursive: true, force: true });
    }
  });
});

describe('T-25 — no behavior change', () => {
  /** Every task key that existed before this wiring. */
  const PRE_EXISTING_KEYS = [
    'id', 'mode', 'objective', 'recommendedAgent', 'recommendedCommand',
    'complexity', 'ambiguity', 'phases', 'createdAt',
  ];

  it('adds exactly one key to the task envelope and changes no other', async () => {
    const task = await runMiddleware();
    const keys = Object.keys(task).sort();

    // `meta` appears only via the agentTeam workflowPlan path, which is
    // pre-existing; `mission` is the one key this task adds.
    expect(keys).toEqual([...PRE_EXISTING_KEYS, 'meta', 'mission'].sort());
  });

  it('leaves task.meta byte-identical — the mission record is NOT inside it', async () => {
    const task = await runMiddleware();

    expect(Object.keys(task.meta)).toEqual(['workflowPlan']);
    expect(task.meta.missionContract).toBeUndefined();
    expect(task.meta.missionMode).toBeUndefined();
    expect(task.meta.missionSignals).toBeUndefined();
  });

  it('does not create task.meta when there is nothing else to put in it', async () => {
    // Guards the existing case "omits task.meta entirely when no effort file
    // exists" in `tests/runtime/middleware/tasks.test.js` directly: a system1
    // prompt with no effort file must still leave `meta` undefined.
    const task = await runMiddleware({
      context: { routing: { system: 'system1' }, intent: {} },
    });

    expect(task.meta).toBeUndefined();
    expect(task.mission).toBeDefined();
  });

  it('writes zero lines into the real decision store', async () => {
    // The fixture-pollution gate. `runtime/decisions/` is what `/doctor`
    // reads; a test that seeds it makes the diagnostic lie. The middleware's
    // decision-recorder path must still RUN — asserted via the stub — so this
    // is isolation, not deletion of the code path.
    const before = realStoreLineCount();
    await runMiddleware();

    expect(recordWorkflowPlanDecision).toHaveBeenCalled();
    expect(realStoreLineCount()).toBe(before);
    expect(existsSync(getDecisionEventsPath(SESSION))).toBe(false);
  });

  it('creates nothing under .artibot besides the ledger line', async () => {
    await runMiddleware();

    // intent.md is T-40's, not this task's.
    expect(existsSync(path.join(projectRoot, '.artibot', 'intent.md'))).toBe(false);
    expect(existsSync(path.join(projectRoot, '.artibot', 'missions'))).toBe(false);
    expect(existsSync(ledgerPath())).toBe(true);
  });

  it('returns the same envelope shape whether or not the ledger was written', async () => {
    const withLedger = await runMiddleware();
    const withoutLedger = await runMiddleware({
      input: { hookData: { session_id: SESSION } },
    });

    expect(Object.keys(withoutLedger).sort()).toEqual(Object.keys(withLedger).sort());
    expect(Object.keys(withoutLedger.mission).sort())
      .toEqual(Object.keys(withLedger.mission).sort());
  });
});

/**
 * CA-15 — the question-gate enforcement kill switch
 * (`runtime.questionGate.enforce`, read by `tasks.js#readTeamGateInputs`).
 *
 * OFF must be byte-identical: every OFF variant below is compared as ONE JSON
 * string against the key-absent run. ON adds `task.mission.question_gate_enforcement`
 * on every path and, only when all four recorded conditions hold, appends one
 * advisory directive to `userPrompt` and `question-gate=block` to messageParts.
 *
 * WHAT THIS CANNOT SEE: whether the model obeys the directive. It is advisory
 * text next to the prompt — the pipeline has no halt contract — so this pins
 * the text reaching `userPrompt`, not a question reaching the user.
 */
describe('CA-15 — question-gate enforcement switch', () => {
  /** Carries a cue for all four conditions (question-gate-record.test.js). */
  const ALL_FOUR = 'Which should we pick for the public API contract? It is a '
    + 'product decision with no right answer, and a wrong call is costly rework.';
  const TAG = '[artibot:question-gate required kind=product_decision at=adr_start]';
  const TEAM = {
    enabled: true,
    autoApplyTriggers: { logic: 'OR', minSubtasks: 2, minFiles: 2, minComplexity: 'high' },
  };
  /** The mission keys that existed before CA-15, in emission order. */
  const MISSION_KEYS_OFF = [
    'contract', 'mode', 'signals', 'substantive', 'deferred', 'ledger', 'store', 'question_gate', 'ok',
  ];

  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A temp plugin root whose config carries `runtime.questionGate` only when
   * `questionGate` is given, so "key absent" is a real absence.
   * @param {object} [questionGate]
   * @returns {string}
   */
  function pluginRootWith(questionGate) {
    const dir = mkdtempSync(path.join(tmpdir(), 'artibot-ca15-plugin-'));
    tempDirs.push(dir);
    const cfg = questionGate === undefined ? { team: TEAM } : { team: TEAM, runtime: { questionGate } };
    writeFile(path.join(dir, 'artibot.config.json'), JSON.stringify(cfg));
    return dir;
  }

  /**
   * Run the middleware in a FRESH project root and return everything it
   * produces except the random task id.
   * @param {{prompt?: string, pluginRoot?: string, context?: object, cwd?: boolean}} [opts]
   * @returns {Promise<{userPrompt: string, messageParts: string[], task: object}>}
   */
  async function runCa15({ prompt = ALL_FOUR, pluginRoot, context, cwd = true } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'artibot-ca15-'));
    tempDirs.push(root);
    const hookData = cwd ? { session_id: SESSION, cwd: root } : { session_id: SESSION };
    const mw = createTasksMiddleware({ now: () => NOW });
    const result = await mw(makeState({
      input: { prompt, hookData, ...(pluginRoot ? { pluginRoot } : {}) },
      ...(context ? { context } : {}),
    }));
    const { id: _id, ...task } = result.context.tasks;
    return { userPrompt: result.userPrompt, messageParts: result.messageParts, task };
  }

  /** @param {object} run @returns {string} the run as one comparable string */
  const snap = (run) => JSON.stringify(run);

  const SYSTEM1 = { routing: { system: 'system1', score: 0.2 }, intent: {} };
  const PROMPTS = [ALL_FOUR, '대시보드를 만들어줘', '/implement 대시보드를 만들어줘'];

  describe('OFF — byte-identical to the key-absent run', () => {
    const OFF_VARIANTS = [
      ['enforce:false', { enforce: false }],
      ['an empty questionGate block', {}],
      ["the string 'true'", { enforce: 'true' }],
      ['the number 1', { enforce: 1 }],
    ];

    for (const prompt of PROMPTS) {
      for (const context of [undefined, SYSTEM1]) {
        const label = `${prompt.slice(0, 24)} / ${context ? 'system1' : 'system2'}`;
        it.each(OFF_VARIANTS)(`${label}: %s changes nothing`, async (_name, questionGate) => {
          const baseline = await runCa15({ prompt, context, pluginRoot: pluginRootWith() });
          const variant = await runCa15({ prompt, context, pluginRoot: pluginRootWith(questionGate) });

          expect(snap(variant)).toBe(snap(baseline));
          expect(Object.keys(variant.task.mission)).toEqual(MISSION_KEYS_OFF);
          expect(variant.userPrompt).not.toContain('[artibot:question-gate');
          expect(variant.messageParts).not.toContain('question-gate=block');
        });
      }
    }

    it('adds nothing without a pluginRoot either (the ambient config path)', async () => {
      const run = await runCa15();

      expect(Object.keys(run.task.mission)).toEqual(MISSION_KEYS_OFF);
      expect(run.userPrompt).not.toContain('[artibot:question-gate');
      expect(run.messageParts).not.toContain('question-gate=block');
    });
  });

  describe('ON — all four recorded conditions hold', () => {
    it.each([['system2', undefined], ['system1', SYSTEM1]])(
      'appends the directive and question-gate=block on %s, and changes nothing else',
      async (_name, context) => {
        const off = await runCa15({ context, pluginRoot: pluginRootWith() });
        const on = await runCa15({ context, pluginRoot: pluginRootWith({ enforce: true }) });

        expect(on.task.mission.question_gate_enforcement).toEqual({
          enforce: true,
          block: true,
          kind: 'product_decision',
          at: 'adr_start',
          reason: 'all-conditions',
          inputs_absent: [], // RE-PINNED from ['interpretation'] by CA-15: it is fed
        });
        // The status stays the SAME string — tests above pin it with toBe.
        expect(on.task.mission.question_gate).toBe('appended');
        // Suffix only: everything OFF produced is still there, first.
        expect(on.userPrompt.startsWith(off.userPrompt)).toBe(true);
        expect(on.userPrompt.slice(off.userPrompt.length)).toMatch(
          new RegExp(`^\\n\\n${TAG.replace(/[[\]]/g, '\\$&')}\\n\\S`),
        );
        expect(on.userPrompt.split(TAG)).toHaveLength(2);
        expect(on.messageParts).toEqual([...off.messageParts, 'question-gate=block']);
        const { question_gate_enforcement: _e, ...mission } = on.task.mission;
        expect(snap({ ...on.task, mission })).toBe(snap(off.task));
      },
    );

    it('blocks from the evaluated conditions even when the ledger line is skipped', async () => {
      // No cwd: the append skips, but the four conditions were still evaluated
      // on this prompt. Enforcement follows the verdict, not the disk.
      const on = await runCa15({ cwd: false, pluginRoot: pluginRootWith({ enforce: true }) });

      expect(on.task.mission.question_gate).toBe('skipped:no-project-root');
      expect(on.task.mission.question_gate_enforcement.block).toBe(true);
      expect(on.userPrompt).toContain(TAG);
    });
  });

  describe('ON — fewer than four conditions', () => {
    it.each(['대시보드를 만들어줘', 'fix the typo in the README heading'])(
      'records block:false and leaves userPrompt and messageParts untouched: %s',
      async (prompt) => {
        const off = await runCa15({ prompt, pluginRoot: pluginRootWith() });
        const on = await runCa15({ prompt, pluginRoot: pluginRootWith({ enforce: true }) });

        expect(on.task.mission.question_gate_enforcement).toEqual({
          enforce: true,
          block: false,
          kind: null,
          at: 'adr_start',
          reason: 'conditions-not-met',
          // RE-PINNED by CA-15: the interpretation is fed now; provenance only.
          inputs_absent: [],
        });
        expect(on.userPrompt).toBe(off.userPrompt);
        expect(on.messageParts).toEqual(off.messageParts);
      },
    );

    it('records block:false with no-conditions on a compile failure', async () => {
      const mw = createTasksMiddleware({ now: () => NOW });
      const state = makeState({ input: { pluginRoot: pluginRootWith({ enforce: true }) } });
      state.input.prompt = { toString() { throw new Error('boom'); } };
      const result = await mw(state);
      const { mission } = result.context.tasks;

      expect(mission.ok).toBe(false);
      expect(mission.question_gate).toBe('skipped:compile-failed');
      expect(mission.question_gate_enforcement).toMatchObject({
        enforce: true, block: false, kind: null, reason: 'no-conditions',
      });
      expect(result.userPrompt).not.toContain(TAG);
      expect(result.messageParts).not.toContain('question-gate=block');
    });

    it('keeps one mission key set whether or not the ledger was written', async () => {
      const pluginRoot = pluginRootWith({ enforce: true });
      const withLedger = await runCa15({ prompt: '대시보드를 만들어줘', pluginRoot });
      const withoutLedger = await runCa15({ prompt: '대시보드를 만들어줘', pluginRoot, cwd: false });

      expect(Object.keys(withLedger.task.mission)).toEqual([
        ...MISSION_KEYS_OFF.slice(0, -1), 'question_gate_enforcement', 'ok',
      ]);
      expect(Object.keys(withoutLedger.task.mission)).toEqual(Object.keys(withLedger.task.mission));
    });
  });
});
