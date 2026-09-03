/**
 * T-25 — `compileMission()` wiring in the tasks middleware.
 *
 * WHAT THIS GATE DOES NOT SEE
 * ---------------------------
 *  - COMPILE QUALITY. It asserts that a contract reaches the task envelope and
 *    that one line reaches the ledger. Whether the contract is a good reading
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
 * REAL store at `<pluginRoot>/runtime/decisions/`, which `/doctor` reads —
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

import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import {
  getDecisionEventsPath,
  recordWorkflowPlanDecision,
} from '../../lib/observability/decision-events.js';

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
  it('writes exactly one line into the injected project root', async () => {
    await runMiddleware();
    const lines = readLedger();

    expect(lines).toHaveLength(1);
    expect(lines[0].session_id).toBe(SESSION);
    expect(lines[0].source).toBe('hook');
    expect(lines[0].ts).toBe(new Date(NOW).toISOString());
  });

  it('writes mission.created for an S5 prompt (explicit /implement)', async () => {
    const task = await runMiddleware({ input: { prompt: '/implement 대시보드를 만들어줘' } });
    const lines = readLedger();

    expect(task.mission.substantive).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('mission.created');
    expect(lines[0].data.title).toBeTypeOf('string');
    expect(lines[0].data.title.length).toBeLessThanOrEqual(120);
    expect(lines[0].data.intent_revision).toBe(1);
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
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('mission.candidate_deferred');
    expect(lines[0].data.reason).toBeTypeOf('string');
    expect(Array.isArray(lines[0].data.signals)).toBe(true);
    // The unregistered spelling must never reach the file.
    expect(readFileSync(ledgerPath(), 'utf-8')).not.toContain('mission-candidate-deferred');
  });

  it('appends nothing and records why when no project root is knowable', async () => {
    const task = await runMiddleware({
      input: { hookData: { session_id: SESSION } },
    });

    expect(task.mission.ledger).toBe('skipped:no-project-root');
    expect(task.mission.contract).toBeDefined();
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('appends nothing and records why when no session id is knowable', async () => {
    const task = await runMiddleware({
      input: { hookData: { cwd: projectRoot } },
    });

    expect(task.mission.ledger).toBe('skipped:no-session-id');
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
    expect(result.messageParts).toContain('task=agentTeam');
    expect(existsSync(ledgerPath())).toBe(false);
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
