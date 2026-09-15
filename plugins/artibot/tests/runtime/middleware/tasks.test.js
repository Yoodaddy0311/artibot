import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTasksMiddleware } from '../../../lib/runtime/middleware/tasks.js';
import { sessionFallbackMissionId } from '../../../lib/runtime/event-writer.js';
import { appendLedgerEvent, readLedgerCensus } from '../../../lib/runtime/ledger.js';
import { createStateStore, readJournal } from '../../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../../lib/project-state/git-common-dir.js';
import {
  readDecisionEvents,
  WORKFLOW_PLANNED,
} from '../../../lib/observability/decision-events.js';

function makeState(overrides = {}) {
  return {
    input: { prompt: 'build a dashboard' },
    context: {
      routing: { system: 'system1', score: 0.3 },
      intent: {
        best: 'action:implement',
        commands: ['/implement'],
        agents: ['frontend-developer'],
        ambiguous: false,
      },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test prompt',
    ...overrides,
  };
}

describe('middleware/tasks', () => {
  it('system1 → subAgent 모드 (2 phases)', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.tasks.mode).toBe('subAgent');
    expect(result.context.tasks.phases).toEqual(['execute', 'verify']);
    expect(result.context.tasks.id).toMatch(/^rt-/);
    expect(result.messageParts).toContain('task=subAgent');
  });

  it('system2 → agentTeam 모드 (3 phases)', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        routing: { system: 'system2', score: 0.9 },
        intent: {
          best: 'action:implement',
          commands: ['/implement'],
          agents: ['orchestrator'],
          ambiguous: false,
        },
      },
    });
    const result = await mw(state);

    expect(result.context.tasks.mode).toBe('agentTeam');
    expect(result.context.tasks.phases).toEqual(['plan', 'execute', 'verify']);
    expect(result.messageParts).toContain('task=agentTeam');
  });

  it('agentTeam 모드에서 프롬프트에 Execution contract 추가', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        routing: { system: 'system2' },
        intent: { agents: [], commands: [], ambiguous: false },
      },
    });
    const result = await mw(state);

    expect(result.userPrompt).toContain('Execution contract:');
    expect(result.userPrompt).toContain('Create a plan first');
  });

  it('subAgent 모드에서 프롬프트 변경 없음', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const originalPrompt = state.userPrompt;
    const result = await mw(state);

    expect(result.userPrompt).toBe(originalPrompt);
  });

  it('task에 intent 정보 포함', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.tasks.recommendedAgent).toBe('frontend-developer');
    expect(result.context.tasks.recommendedCommand).toBe('/implement');
    expect(result.context.tasks.complexity).toBe(0.3);
    expect(result.context.tasks.ambiguity).toBe(false);
    expect(result.context.tasks.objective).toBe('build a dashboard');
  });

  it('intent에 agent/command 없을 때 null', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        routing: { system: 'system1' },
        intent: { agents: [], commands: [], ambiguous: false },
      },
    });
    const result = await mw(state);

    expect(result.context.tasks.recommendedAgent).toBeNull();
    expect(result.context.tasks.recommendedCommand).toBeNull();
  });

  it('createdAt ISO 형식', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    expect(result.context.tasks.createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it('routing 없을 때 기본값 system1 사용', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      context: {
        intent: { agents: [], commands: [], ambiguous: false },
      },
    });
    const result = await mw(state);

    expect(result.context.tasks.mode).toBe('subAgent');
  });

  it('deterministic ID (now 주입)', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState();
    const result = await mw(state);

    // ID starts with rt- and contains base36 of timestamp
    expect(result.context.tasks.id).toMatch(/^rt-[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe('middleware/tasks — Score-Aware effort meta propagation', () => {
  let pluginRoot;
  let projectRoot;

  beforeEach(() => {
    pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-tasks-'));
    mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
    // A sandbox project root for the cases that supply a `session_id`. Without a
    // `cwd`, `recordWorkflowPlanDecision` resolves the root from `process.cwd()`
    // and writes `<repo>/.artibot/runtime/decisions/<sid>.events.ndjson` for real
    // — measured: 21 `workflow-planned` lines in the worktree's own store.
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-tasks-proj-'));
    mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeEffortFixture(meta) {
    writeFileSync(
      path.join(pluginRoot, 'runtime', 'current-effort.json'),
      JSON.stringify(meta) + '\n',
    );
  }

  function writeSessionFixture(sessionId, meta) {
    const dir = path.join(pluginRoot, 'runtime', 'effort');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(meta) + '\n');
  }

  it('propagates shift + reason from current-effort.json into task.meta', async () => {
    writeEffortFixture({
      command: 'implement', effort: 'max', baseline: 'xhigh',
      shift: 1, reason: 'score>=0.7 (+1)',
    });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({ input: { prompt: 'x', pluginRoot } });
    const result = await mw(state);

    expect(result.context.tasks.meta).toEqual({
      effort: 'max', command: 'implement', taskBudget: null,
      shift: 1, reason: 'score>=0.7 (+1)',
    });
  });

  it('defaults shift to null and reason to null when fields are absent', async () => {
    writeEffortFixture({ command: 'daily', effort: 'medium' });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({ input: { prompt: 'x', pluginRoot } });
    const result = await mw(state);

    expect(result.context.tasks.meta.shift).toBeNull();
    expect(result.context.tasks.meta.reason).toBeNull();
  });

  it('preserves a negative shift value (does not coerce to null)', async () => {
    writeEffortFixture({
      command: 'daily', effort: 'low', baseline: 'medium',
      shift: -1, reason: 'score<=0.25 (-1)',
    });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({ input: { prompt: 'x', pluginRoot } });
    const result = await mw(state);

    expect(result.context.tasks.meta.shift).toBe(-1);
    expect(result.context.tasks.meta.reason).toBe('score<=0.25 (-1)');
  });

  it('omits task.meta entirely when no effort file exists', async () => {
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({ input: { prompt: 'x', pluginRoot } });
    const result = await mw(state);

    expect(result.context.tasks.meta).toBeUndefined();
  });

  // F05 — the reader passes its own identity to `readEffortRecord`, so a record
  // another session left behind cannot become this task's effort. The fixtures
  // above carry no identity and stay honoured (that is the compatibility pin).
  it('prefers the per-session record when hookData.session_id matches', async () => {
    writeEffortFixture({ command: 'daily', effort: 'low', sessionId: 'sess-B', promptId: 'b1' });
    writeSessionFixture('sess-A', {
      command: 'implement', effort: 'max', shift: 1, reason: 'own-session', sessionId: 'sess-A',
    });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      input: { prompt: 'x', pluginRoot, hookData: { cwd: projectRoot, session_id: 'sess-A' } },
    });
    const result = await mw(state);

    expect(result.context.tasks.meta).toEqual({
      effort: 'max', command: 'implement', taskBudget: null, shift: 1, reason: 'own-session',
    });
  });

  it('ignores a legacy record left by another session when the reader has a session id', async () => {
    writeEffortFixture({ command: 'daily', effort: 'low', sessionId: 'sess-B', promptId: 'b1' });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      input: { prompt: 'x', pluginRoot, hookData: { cwd: projectRoot, session_id: 'sess-A' } },
    });
    const result = await mw(state);

    expect(result.context.tasks.meta).toBeUndefined();
  });

  // The expiry is judged on the middleware's INJECTED clock. Of the two cases
  // below, only the SECOND distinguishes that from wall-clock: the injected
  // 1700000000000 is in 2023, so a record expiring before it is expired on both
  // clocks (measured: the refusal case stays green with the clock thread removed),
  // while a record expiring 60s after it is fresh ONLY on the injected clock
  // (measured: that case goes red with the thread removed).
  it('refuses an expired per-session record under the injected clock', async () => {
    writeSessionFixture('sess-A', {
      command: 'implement', effort: 'max', sessionId: 'sess-A',
      expiresAt: new Date(1700000000000 - 1).toISOString(),
    });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      input: { prompt: 'x', pluginRoot, hookData: { cwd: projectRoot, session_id: 'sess-A' } },
    });
    const result = await mw(state);

    expect(result.context.tasks.meta).toBeUndefined();
  });

  it('honours a per-session record that expires AFTER the injected clock', async () => {
    writeSessionFixture('sess-A', {
      command: 'implement', effort: 'max', shift: 1, reason: 'own-session', sessionId: 'sess-A',
      expiresAt: new Date(1700000000000 + 60_000).toISOString(),
    });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      input: { prompt: 'x', pluginRoot, hookData: { cwd: projectRoot, session_id: 'sess-A' } },
    });
    const result = await mw(state);

    expect(result.context.tasks.meta).toEqual({
      effort: 'max', command: 'implement', taskBudget: null, shift: 1, reason: 'own-session',
    });
  });

  it('still honours a legacy fixture with no identity when the reader has a session id', async () => {
    writeEffortFixture({ command: 'implement', effort: 'high', shift: 0, reason: 'baseline' });
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const state = makeState({
      input: { prompt: 'x', pluginRoot, hookData: { cwd: projectRoot, session_id: 'sess-A' } },
    });
    const result = await mw(state);

    expect(result.context.tasks.meta).toEqual({
      effort: 'high', command: 'implement', taskBudget: null, shift: 0, reason: 'baseline',
    });
  });
});

// ---------------------------------------------------------------------------
// StateStore wiring — `mission.created` also commits one store write.
//
// THE TWO PROMPTS BELOW WERE CHOSEN BY RUNNING `compileMission`, NOT BY
// READING IT. Measured 2026-09-05 with `{nowMs: 1700000000000, system:
// 'system1'}`, which is exactly what `recordMissionCompile` passes:
//
//   '/implement add a retry guard to the ledger writer'
//        -> meta.ledgerEvent 'mission.created',            signals ['S5']
//   'build a dashboard'
//        -> meta.ledgerEvent 'mission-candidate-deferred', signals []
//
// Only S3 (>= 2 explicit requests) and S5 (a slash command in
// `mission-id.js#S5_COMMANDS`) can ever fire from HERE:
// `recordMissionCompile` hands `compileMission` no `completion` (S1/S2), no
// `intentConfidence` (S4) and no `activeMission`/`followUp` (S6). So a prompt
// that merely SOUNDS like work is deferred — 'build a dashboard', the string
// the suites above already use, is the deferred fixture for that reason and
// not by coincidence.
//
// The mission id is COMPUTED here via `sessionFallbackMissionId`, never
// spelled out. A literal would re-derive the writer's rule in the test and
// then agree with itself when the rule changed.
// ---------------------------------------------------------------------------

describe('middleware/tasks — StateStore wiring on mission.created', () => {
  const SESSION_ID = 'sess-e247a22f-test';
  const NOW_MS = 1700000000000;
  /** Substantive by S5. Produces `mission.created`. */
  const SUBSTANTIVE = '/implement add a retry guard to the ledger writer';
  /** Deferred: no signal fires. Produces `mission.candidate_deferred`. */
  const DEFERRED = 'build a dashboard';

  let projectRoot;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-tasks-store-'));
    // A real `.git` DIRECTORY, so `resolveGitCommonDir` resolves for real
    // rather than through a stub that would prove nothing about the resolver.
    mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** A hook payload carrying both keys the wiring needs: cwd and session id. */
  function storeState(prompt, hookOverrides = {}) {
    return {
      input: {
        prompt,
        hookData: { cwd: projectRoot, session_id: SESSION_ID, ...hookOverrides },
      },
      context: {
        routing: { system: 'system1', score: 0.3 },
        intent: { best: 'action:implement', commands: [], agents: [], ambiguous: false },
      },
      messageParts: [],
      userPrompt: prompt,
    };
  }

  const run = (prompt, options = {}) => createTasksMiddleware({
    now: () => NOW_MS, ...options,
  })(storeState(prompt));

  const missionId = () => sessionFallbackMissionId(SESSION_ID, new Date(NOW_MS));
  const storeDir = () => path.join(projectRoot, '.git', 'artibot');
  const yamlPath = () => path.join(projectRoot, '.artibot', 'state.yaml');
  const eventsNamed = (name) => readLedgerCensus(projectRoot)
    .events.filter((e) => e.event === name);

  it('pairs mission.created with one state.updated and writes the store under the git common dir', async () => {
    const result = await run(SUBSTANTIVE);
    const id = missionId();

    const created = eventsNamed('mission.created');
    const updated = eventsNamed('state.updated');
    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(1);
    expect(created[0].mission_id).toBe(id);
    expect(updated[0].mission_id).toBe(id);
    expect(updated[0].data.state_version).toBe(1);

    const store = result.context.tasks.mission.store;
    expect(store.status).toBe('written');
    expect(store.location).toBe('git-common-dir');
    expect(store.state_version).toBe(1);
    expect(store.mission_id).toBe(id);

    expect(existsSync(path.join(storeDir(), 'project-state.jsonl'))).toBe(true);
    expect(existsSync(path.join(storeDir(), 'project-state.json'))).toBe(true);
    expect(existsSync(yamlPath())).toBe(true);
    expect(readFileSync(yamlPath(), 'utf8')).toContain(id);
  });

  it('bumps state_version to 2 on a second prompt while keeping exactly one mission', async () => {
    const mw = createTasksMiddleware({ now: () => NOW_MS });
    const first = await mw(storeState(SUBSTANTIVE));
    const second = await mw(storeState(SUBSTANTIVE));

    expect(eventsNamed('state.updated').map((e) => e.data.state_version)).toEqual([1, 2]);
    expect(first.context.tasks.mission.store.state_version).toBe(1);
    expect(second.context.tasks.mission.store.state_version).toBe(2);

    // Two writes, ONE mission: the fallback id is a function of session + UTC
    // day, so a second prompt must update the same record, not mint another.
    const { records } = readJournal(path.join(storeDir(), 'project-state.jsonl'));
    const ids = [...new Set(records
      .filter((r) => r.kind === 'mission.upsert')
      .map((r) => r.mission_id))];
    expect(ids).toEqual([missionId()]);
  });

  it('skips the store entirely when the prompt is only a deferred candidate', async () => {
    const result = await run(DEFERRED);

    const store = result.context.tasks.mission.store;
    expect(store.status).toBe('skipped');
    expect(store.detail).toBe('no-mission-created');
    expect(eventsNamed('mission.created')).toHaveLength(0);
    expect(eventsNamed('state.updated')).toHaveLength(0);
    // The deferral itself IS recorded, so absence of the store must not be
    // read as "the middleware did nothing".
    expect(eventsNamed('mission.candidate_deferred')).toHaveLength(1);
    // The STORE's own files, not the directory: since ADR-011 the run ledger
    // shares `<git-common-dir>/artibot/`, and the deferral line above put it
    // there, so directory absence no longer means "the store was skipped".
    expect(existsSync(path.join(storeDir(), 'project-state.jsonl'))).toBe(false);
    expect(existsSync(path.join(storeDir(), 'project-state.json'))).toBe(false);
    expect(existsSync(yamlPath())).toBe(false);
  });

  it('leaves a title on the deferred line for stage ② to promote under', async () => {
    // Paired with the store assertion above ON PURPOSE: this is the one case
    // where the ledger records MORE than the store does, and the extra key is
    // what `scripts/hooks/intent-observe-pre.js` reads at the session's first
    // Write/Edit to name the mission it opens (design §3.1 stage ②).
    await run(DEFERRED);

    const deferred = eventsNamed('mission.candidate_deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0].data.title).toBeTypeOf('string');
    expect(deferred[0].data.title.length).toBeGreaterThan(0);
    expect(deferred[0].data.title.length).toBeLessThanOrEqual(120);
    // Still no mission row — a title is not a mission.
    expect(eventsNamed('mission.created')).toHaveLength(0);
  });

  it('skips the store when a substantive prompt carries no session id', async () => {
    const state = storeState(SUBSTANTIVE);
    delete state.input.hookData.session_id;
    const result = await createTasksMiddleware({ now: () => NOW_MS })(state);

    const mission = result.context.tasks.mission;
    expect(mission.ledger).toBe('skipped:no-session-id');
    expect(mission.store.status).toBe('skipped');
    expect(mission.store.detail).toBe('no-mission-created');
    expect(existsSync(storeDir())).toBe(false);
    expect(existsSync(yamlPath())).toBe(false);
  });

  it('leaves the pre-existing return shape untouched for a state with no hook payload', async () => {
    // `makeState()` verbatim — the same builder the suites above use. This is
    // the additive-only claim stated as a test: nothing the wiring added may
    // change what a caller without `hookData` already received.
    const result = await createTasksMiddleware({ now: () => NOW_MS })(makeState());
    const task = result.context.tasks;

    expect(task.mission.store.status).toBe('skipped');
    expect(task.meta).toBeUndefined();
    expect(task.mode).toBe('subAgent');
    expect(task.phases).toEqual(['execute', 'verify']);
    expect(task.objective).toBe('build a dashboard');
    expect(task.recommendedAgent).toBe('frontend-developer');
  });

  it('reports project-root-fallback and writes under .artibot/runtime when the git port yields null', async () => {
    const result = await run(SUBSTANTIVE, { resolveGitCommonDir: () => null });

    const store = result.context.tasks.mission.store;
    expect(store.status).toBe('written');
    expect(store.location).toBe('project-root-fallback');
    expect(existsSync(path.join(projectRoot, '.artibot', 'runtime', 'project-state.jsonl')))
      .toBe(true);
    // The real `.git` is still there — the fallback came from the injected
    // port, so this also proves the port is the only thing consulted. Asserted
    // on the store's own files: the run ledger resolves git for itself (no
    // injection reaches it) and since ADR-011 it creates this same directory.
    expect(existsSync(path.join(storeDir(), 'project-state.jsonl'))).toBe(false);
    expect(existsSync(path.join(storeDir(), 'project-state.json'))).toBe(false);
  });

  it('fails open: a store directory blocked by a file changes no other field', async () => {
    // A FILE where the store directory must be. `ensureDirSync` throws EEXIST
    // on this, and it is a failure that can be injected identically on Windows
    // and POSIX — unlike a chmod, which Windows does not honour.
    //
    // The store is pointed at a DIFFERENT common dir than the real one, and
    // only that one is blocked. Since ADR-011 the run ledger resolves git for
    // itself and lands in `<root>/.git/artibot/`; blocking that directory would
    // break the ledger too, and the claim under test is precisely that a store
    // failure leaves the ledger alone. Blocking the store's own directory is
    // what isolates the two.
    const altCommonDir = path.join(projectRoot, 'alt-common');
    mkdirSync(altCommonDir, { recursive: true });
    writeFileSync(path.join(altCommonDir, 'artibot'), 'not a directory\n');

    const result = await run(SUBSTANTIVE, { resolveGitCommonDir: () => altCommonDir });
    const task = result.context.tasks;

    expect(task.mission.ledger).toBe('appended');
    expect(task.mission.ok).toBe(true);
    expect(task.mission.mode).toBe('reduced');
    expect(task.mode).toBe('subAgent');
    expect(task.phases).toEqual(['execute', 'verify']);
    expect(eventsNamed('mission.created')).toHaveLength(1);

    expect(task.mission.store.status).not.toBe('written');
    expect(['error', 'rejected']).toContain(task.mission.store.status);
  });
});

// ---------------------------------------------------------------------------
// Mission identity under a clock that moves DURING one prompt.
//
// `sessionFallbackMissionId` folds its instant down to a UTC DATE, so two
// independent `now()` reads that straddle midnight mint two different mission
// ids for one prompt. The `mission.created` event then lands on one mission and
// its paired `state.updated` on another: an orphan plus an unrecorded write,
// which is the exact pair `/doctor` Check 8 exists to find and is
// indistinguishable from a lost update.
//
// WHY THIS SWEEPS EVERY FLIP INDEX INSTEAD OF PINNING ONE. Measured against
// bc508f47, the pre-fix implementation read the clock 6 times and split on
// flip index 5 ALONE. A stub that flipped after the first read — the obvious
// spelling — agreed at every one of the other 7 indices and would have passed
// against the live bug. The call order is an implementation detail; "no clock
// read may split the id" is the contract, so the contract is what is asserted.
// ---------------------------------------------------------------------------

describe('middleware/tasks — mission identity under a moving clock', () => {
  const SESSION_ID = 'sess-e247a22f-test';
  const SUBSTANTIVE = '/implement add a retry guard to the ledger writer';
  /** The last instant of 2026-09-04 UTC, and the first of 2026-09-05 UTC. */
  const BEFORE_MIDNIGHT = Date.UTC(2026, 8, 4, 23, 59, 59, 999);
  const AFTER_MIDNIGHT = Date.UTC(2026, 8, 5, 0, 0, 0, 0);
  const NOON = Date.UTC(2026, 8, 5, 12, 0, 0, 0);

  const roots = [];

  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
  });

  function makeRoot() {
    const root = mkdtempSync(path.join(tmpdir(), 'artibot-tasks-clock-'));
    mkdirSync(path.join(root, '.git'), { recursive: true });
    roots.push(root);
    return root;
  }

  function stateFor(root) {
    return {
      input: {
        prompt: SUBSTANTIVE,
        hookData: { cwd: root, session_id: SESSION_ID },
      },
      context: {
        routing: { system: 'system1', score: 0.3 },
        intent: { best: 'action:implement', commands: [], agents: [], ambiguous: false },
      },
      messageParts: [],
      userPrompt: SUBSTANTIVE,
    };
  }

  /**
   * Run one prompt on a fresh repository under the supplied clock and report
   * the three mission ids that must agree.
   *
   * @param {() => number} now - Clock stub.
   * @returns {Promise<{created: string|undefined, updated: string|undefined, store: string|null}>}
   */
  async function idsUnder(now) {
    const root = makeRoot();
    const result = await createTasksMiddleware({ now })(stateFor(root));
    const { events } = readLedgerCensus(root);
    return {
      created: events.find((e) => e.event === 'mission.created')?.mission_id,
      updated: events.find((e) => e.event === 'state.updated')?.mission_id,
      store: result.context.tasks.mission.store.mission_id,
    };
  }

  it('keeps one mission id however a UTC midnight falls between clock reads', async () => {
    // The read count is MEASURED, never assumed: hoisting the identity took it
    // from 6 to 3, and a hard-coded bound would have silently stopped covering
    // the later reads.
    let reads = 0;
    await idsUnder(() => { reads += 1; return BEFORE_MIDNIGHT; });
    expect(reads).toBeGreaterThan(0);

    const split = [];
    for (let flip = 1; flip <= reads + 2; flip += 1) {
      let n = 0;
      const ids = await idsUnder(() => {
        n += 1;
        return n < flip ? BEFORE_MIDNIGHT : AFTER_MIDNIGHT;
      });
      const agree = Boolean(ids.created)
        && ids.created === ids.updated
        && ids.store === ids.created;
      if (!agree) split.push({ flip, ...ids });
    }

    expect(split).toEqual([]);
  });

  it('preserves an executing mission instead of walking it back to queued', async () => {
    const root = makeRoot();
    const missionId = sessionFallbackMissionId(SESSION_ID, new Date(NOON));

    // A SECOND store handle over the same root, opened the way the middleware
    // opens its own: same session, same real git port, same ledger writer. A
    // stub here would seed a mission the middleware could not have found.
    const store = createStateStore({
      projectRoot: root,
      sessionId: SESSION_ID,
      source: 'hook',
      now: () => new Date(NOON),
      appendEvent: (e) => appendLedgerEvent(root, e),
      resolveGitCommonDir: () => resolveGitCommonDir(root),
    });

    const seeded = store.updateMission(missionId, () => ({
      title: 'seeded lane work',
      status: 'executing',
      owners: ['lane-1'],
      intent: { path: `missions/${missionId}/intent.md`, revision: 3 },
      plan: { path: `missions/${missionId}/plan.md`, revision: 7 },
    }), { reason: 'seed' });
    expect(seeded.ok).toBe(true);
    expect(seeded.state_version).toBe(1);

    const result = await createTasksMiddleware({ now: () => NOON })(stateFor(root));

    const after = store.getMission(missionId);
    // Status and owners are the running lane's, not this prompt's to reset.
    expect(after.status).toBe('executing');
    expect(after.owners).toEqual(['lane-1']);
    // `plan` is likewise carried, so a re-prompt cannot rewind a planned mission.
    expect(after.plan).toEqual({ path: `missions/${missionId}/plan.md`, revision: 7 });
    // Only the authored fields move: the title is this prompt's goal.
    expect(after.title).toBe(SUBSTANTIVE);

    expect(result.context.tasks.mission.store).toMatchObject({
      status: 'written',
      state_version: 2,
      mission_id: missionId,
    });

    // The event must carry the PRESERVED status. A `queued` here would tell
    // /doctor the lane stopped running.
    const updates = readLedgerCensus(root).events.filter((e) => e.event === 'state.updated');
    expect(updates.map((e) => e.data.state_version)).toEqual([1, 2]);
    expect(updates[1].data.status).toBe('executing');
  });
});

// ---------------------------------------------------------------------------
// F04(a) — the workflow plan is built and RECORDED on every routing path.
//
// Before this change `buildWorkflowPlan` and `recordWorkflowPlanDecision` ran
// only inside the `mode === 'agentTeam'` branch, so system1 — the majority of
// prompts — produced no `workflow-planned` line at all. One consequence was a
// measurement hole, not a cosmetic one: a line whose `runner` is `team` while
// the caller ran `subAgent` was UNREPRESENTABLE, because the only writer was
// the branch where mode is `agentTeam` by construction.
//
// RECORD ONLY. `task.meta.workflowPlan` still appears for `agentTeam` and only
// for it, because three live readers — `middleware/subagents.js`,
// `runtime-prompt.js#buildTeamDirective`/`#buildRecommendationDirective`, and
// `runtime-prompt.js#recordObserveOnlyDecisions` — read that key and must keep
// seeing `undefined` on system1. The "record-only holds" case below is the
// tripwire for the release that changes that.
//
// STORE ISOLATION: `hookData.cwd` is a temp directory holding a real `.git`,
// so `decision-events.js#getDecisionStoreDir` resolves into the sandbox rather
// than walking up to this repository's live store.
// ---------------------------------------------------------------------------

describe('middleware/tasks — workflow plan recorded on BOTH routing paths (F04a)', () => {
  const PROMPT = 'implement the oauth login, write tests for it, and review the auth flow';

  /** 2 recommendations + minSubtasks 2 → the trigger fires whatever the score. */
  const TEAM_TRIGGER_CONFIG = {
    team: { enabled: true, autoApplyTriggers: { logic: 'OR', minSubtasks: 2, minFiles: 2, minComplexity: 'high' } },
    runtime: { effort: { budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 } } },
  };

  /** Two sub-objectives, the shape `middleware/router.js` writes. */
  const TWO_RECOMMENDATIONS = [
    { intent: 'implement', commands: ['/implement'], agents: ['backend-developer'] },
    { intent: 'test', commands: ['/tdd'], agents: ['tdd-guide'] },
  ];

  let projectRoot;
  let pluginRoot;
  let sessionCounter = 0;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-tasks-f04a-'));
    mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-tasks-f04a-plugin-'));
    mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
    writeConfig(TEAM_TRIGGER_CONFIG);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  function writeConfig(cfg) {
    writeFileSync(path.join(pluginRoot, 'artibot.config.json'), JSON.stringify(cfg));
  }

  function writeEffort(meta) {
    writeFileSync(path.join(pluginRoot, 'runtime', 'current-effort.json'), JSON.stringify(meta));
  }

  /** One session id per run: the store is keyed by it, so sharing would pool lines. */
  function nextSessionId() {
    sessionCounter += 1;
    return `sess-f04a-${sessionCounter}`;
  }

  function planState(system, sessionId, overrides = {}) {
    return {
      input: {
        prompt: PROMPT,
        pluginRoot,
        hookData: { cwd: projectRoot, session_id: sessionId },
      },
      context: {
        routing: { system, score: system === 'system2' ? 0.9 : 0.2 },
        intent: {
          best: 'action:implement',
          commands: ['/implement'],
          agents: ['backend-developer'],
          ambiguous: false,
          ...overrides.intent,
        },
      },
      messageParts: [],
      userPrompt: PROMPT,
    };
  }

  async function runPlan(system, overrides = {}) {
    const sessionId = nextSessionId();
    const mw = createTasksMiddleware({ now: () => 1700000000000 });
    const result = await mw(planState(system, sessionId, overrides));
    const planned = readDecisionEvents(sessionId, { cwd: projectRoot })
      .filter((e) => e.type === WORKFLOW_PLANNED);
    return { task: result.context.tasks, planned };
  }

  it('records one workflow-planned line carrying mode=subAgent for a system1 prompt', async () => {
    const { task, planned } = await runPlan('system1');

    expect(task.mode).toBe('subAgent');
    expect(planned).toHaveLength(1);
    expect(planned[0].data.mode).toBe('subAgent');
    expect(planned[0].phase).toBe('PLAN');
  });

  it('records one workflow-planned line carrying mode=agentTeam for a system2 prompt', async () => {
    const { task, planned } = await runPlan('system2');

    expect(task.mode).toBe('agentTeam');
    expect(planned).toHaveLength(1);
    expect(planned[0].data.mode).toBe('agentTeam');
  });

  it('records on every state with a session id, and attaches meta.workflowPlan only for agentTeam', async () => {
    // The 100% claim, over a table rather than one happy path: the recording
    // must not depend on the effort file, the recommendations, or the score —
    // only on a session id being present. Six states, both systems.
    const TABLE = [
      { name: 'system1 bare', system: 'system1', effort: null, intent: {} },
      { name: 'system1 + effort file', system: 'system1', effort: { command: 'daily', effort: 'medium' }, intent: {} },
      { name: 'system1 + 2 recommendations', system: 'system1', effort: null, intent: { recommendations: TWO_RECOMMENDATIONS } },
      { name: 'system2 bare', system: 'system2', effort: null, intent: {} },
      { name: 'system2 + effort file', system: 'system2', effort: { command: 'implement', effort: 'max', shift: 1, reason: 'score>=0.7 (+1)' }, intent: {} },
      { name: 'system2 + 2 recommendations', system: 'system2', effort: null, intent: { recommendations: TWO_RECOMMENDATIONS } },
    ];

    const report = [];
    for (const row of TABLE) {
      rmSync(path.join(pluginRoot, 'runtime', 'current-effort.json'), { force: true });
      if (row.effort) writeEffort(row.effort);
      const { task, planned } = await runPlan(row.system, { intent: row.intent });
      report.push({
        name: row.name,
        lines: planned.length,
        mode: planned[0]?.data.mode ?? null,
        hasPlan: task.meta?.workflowPlan !== undefined,
      });
    }

    expect(report).toEqual(TABLE.map((row) => ({
      name: row.name,
      lines: 1,
      mode: row.system === 'system2' ? 'agentTeam' : 'subAgent',
      hasPlan: row.system === 'system2',
    })));
  });

  it('skips the store — rather than bucketing — when the prompt carries no session id', async () => {
    // The absence must stay visible as `skipped`, which is what /doctor reads.
    // Asserted here because F04(a) doubles the number of calls that can skip.
    const state = planState('system1', 'sess-f04a-unused');
    delete state.input.hookData.session_id;
    const result = await createTasksMiddleware({ now: () => 1700000000000 })(state);

    expect(result.context.tasks.mode).toBe('subAgent');
    expect(existsSync(path.join(projectRoot, '.artibot', 'runtime', 'decisions')))
      .toBe(false);
  });

  // -------------------------------------------------------------------------
  // F04(b) — `team.followWorkflowPlan`, the consumer. This block replaces the
  // F04(a) tripwire ("stays RECORD-ONLY"), which asserted that the key was set
  // and nothing read it. It is now read, so the same fixture is asserted from
  // BOTH sides of the key: ON follows the plan, OFF/absent is the F04(a)
  // behaviour byte for byte. Deleting the OFF case instead of keeping it would
  // drop the pin on what actually ships — owner decision OD5 ships the key off.
  // -------------------------------------------------------------------------
  describe('F04(b): team.followWorkflowPlan decides whether the plan is followed', () => {
    /** Config whose trigger fires on size alone — 2 recommendations, any score. */
    function configWithKey(followWorkflowPlan, extraTeam = {}) {
      const team = { ...TEAM_TRIGGER_CONFIG.team, ...extraTeam };
      if (followWorkflowPlan !== undefined) team.followWorkflowPlan = followWorkflowPlan;
      return { ...TEAM_TRIGGER_CONFIG, team };
    }

    /**
     * Config whose trigger CANNOT fire on the system2 fixture: AND logic needs
     * both signals, and the size signal needs 5 sub-objectives the fixture does
     * not have. Complexity alone (score 0.9) is one signal, so the plan comes
     * back `inline` while routing still says system2 — the only way to observe
     * the downward direction through the real middleware.
     */
    function inlinePlanConfig(followWorkflowPlan) {
      return {
        ...TEAM_TRIGGER_CONFIG,
        team: {
          ...TEAM_TRIGGER_CONFIG.team,
          autoApplyTriggers: {
            logic: 'AND', minSubtasks: 5, minFiles: 5, minComplexity: 'high',
          },
          ...(followWorkflowPlan === undefined ? {} : { followWorkflowPlan }),
        },
      };
    }

    it('FOLLOWS the plan when the key is true: system1 + runner=team runs a team', async () => {
      // The inversion of the F04(a) tripwire. `routing.system` is system1 —
      // under the old rule that alone decided `subAgent` — and the plan says
      // `team`, so with the key on the plan wins and every downstream surface
      // (phases, attachment, the recorded mode) moves with it.
      writeConfig(configWithKey(true));

      const { task, planned } = await runPlan('system1', { intent: { recommendations: TWO_RECOMMENDATIONS } });

      expect(planned).toHaveLength(1);
      // Negative control, carried over: without it the claim is vacuous — a
      // fixture that stopped electing a team would pass a `subAgent` assertion
      // and would pass this one only by accident.
      expect(planned[0].data.runner).toBe('team');
      expect(planned[0].data.mode).toBe('agentTeam');

      expect(task.mode).toBe('agentTeam');
      expect(task.phases).toEqual(['plan', 'execute', 'verify']);
      expect(task.meta?.workflowPlan?.runner).toBe('team');
    });

    it.each([
      ['absent', undefined],
      ['explicitly false', false],
    ])('stays RECORD-ONLY when the key is %s: the same prompt runs subAgent', async (_label, key) => {
      // What actually ships (OD5). Identical fixture to the case above, so the
      // pair isolates ONE variable: the config key.
      writeConfig(configWithKey(key));

      const { task, planned } = await runPlan('system1', { intent: { recommendations: TWO_RECOMMENDATIONS } });

      expect(planned).toHaveLength(1);
      expect(planned[0].data.runner).toBe('team');
      expect(planned[0].data.mode).toBe('subAgent');

      expect(task.mode).toBe('subAgent');
      expect(task.phases).toEqual(['execute', 'verify']);
      expect(task.meta?.workflowPlan).toBeUndefined();
    });

    it('OFF outranks the key: team.enabled false + key true + system2 still runs subAgent', async () => {
      // OD2 above OD5. Turning the consumer on must not resurrect a team the
      // user switched off, and the record must still name the OFF reason
      // rather than reporting a threshold that was never evaluated.
      writeConfig(configWithKey(true, { enabled: false }));

      const { task, planned } = await runPlan('system2', { intent: { recommendations: TWO_RECOMMENDATIONS } });

      expect(task.mode).toBe('subAgent');
      expect(task.phases).toEqual(['execute', 'verify']);
      expect(task.meta?.workflowPlan).toBeUndefined();
      expect(planned[0].data.mode).toBe('subAgent');
      expect(planned[0].data.runner).toBe('inline');
      expect(planned[0].data.trigger.reasons).toContain('team-disabled');
    });

    it('follows the plan DOWNWARD too: key true + system2 + runner=inline runs subAgent', async () => {
      writeConfig(inlinePlanConfig(true));

      const { task, planned } = await runPlan('system2');

      expect(planned[0].data.runner).toBe('inline');
      expect(task.mode).toBe('subAgent');
      expect(task.phases).toEqual(['execute', 'verify']);
      expect(task.meta?.workflowPlan).toBeUndefined();
      expect(planned[0].data.mode).toBe('subAgent');
    });

    it('CONTROL for the downward case: the same prompt with the key off runs agentTeam', async () => {
      // Without this row the case above proves nothing — a fixture that had
      // stopped routing system2 would satisfy it for the wrong reason.
      writeConfig(inlinePlanConfig(false));

      const { task, planned } = await runPlan('system2');

      expect(planned[0].data.runner).toBe('inline');
      expect(task.mode).toBe('agentTeam');
      expect(planned[0].data.mode).toBe('agentTeam');
    });
  });

  // -------------------------------------------------------------------------
  // OFF GATE. Until 2026-09-15 this middleware read no team enable state at
  // all: `team.enabled:false` and `--no-team` were honoured by
  // `scripts/hooks/auto-team-trigger.js` and by nothing else, so a system2
  // prompt under an explicit opt-out still produced `mode:'agentTeam'`, a
  // three-phase task, an attached plan (which `runtime-prompt.js` turns into
  // `[artibot:team runner=team …]`) and an "Execution contract" telling the
  // model to plan in phases.
  //
  // Every case below is measured against the ON control directly beneath this
  // comment. Without it, "mode is subAgent" would pass just as happily if the
  // fixture had stopped electing a team for an unrelated reason.
  // -------------------------------------------------------------------------
  describe('OFF gate: an opt-out outranks system2 routing', () => {
    /** The state helper, plus a raw host prompt on hookData for the flag surface. */
    function offState(system, sessionId, { hostPrompt } = {}) {
      const state = planState(system, sessionId, { intent: { recommendations: TWO_RECOMMENDATIONS } });
      if (hostPrompt !== undefined) state.input.hookData.prompt = hostPrompt;
      return state;
    }

    async function run(system, { config, hostPrompt } = {}) {
      if (config) writeConfig(config);
      const sessionId = nextSessionId();
      const mw = createTasksMiddleware({ now: () => 1700000000000 });
      const state = offState(system, sessionId, { hostPrompt });
      const result = await mw(state);
      const planned = readDecisionEvents(sessionId, { cwd: projectRoot })
        .filter((e) => e.type === WORKFLOW_PLANNED);
      return { task: result.context.tasks, planned, userPrompt: result.userPrompt };
    }

    it('CONTROL: system2 with the team ON still spawns a team', async () => {
      const { task, planned, userPrompt } = await run('system2');
      expect(task.mode).toBe('agentTeam');
      expect(task.phases).toEqual(['plan', 'execute', 'verify']);
      expect(task.meta?.workflowPlan?.runner).toBe('team');
      expect(userPrompt).toContain('Execution contract');
      expect(planned[0].data.mode).toBe('agentTeam');
      expect(planned[0].data.runner).toBe('team');
    });

    it.each([
      ['team.enabled:false', { enabled: false }, 'team-disabled'],
      ['team.autoApply:false', { autoApply: false }, 'team-disabled'],
    ])('%s drops system2 to subAgent', async (_label, off, reason) => {
      const { task, planned, userPrompt } = await run('system2', {
        config: { ...TEAM_TRIGGER_CONFIG, team: { ...TEAM_TRIGGER_CONFIG.team, ...off } },
      });

      expect(task.mode).toBe('subAgent');
      expect(task.phases).toEqual(['execute', 'verify']);
      expect(task.meta?.workflowPlan).toBeUndefined();
      expect(userPrompt).not.toContain('Execution contract');

      // The record must distinguish OFF from "the trigger did not fire".
      expect(planned).toHaveLength(1);
      expect(planned[0].data.mode).toBe('subAgent');
      expect(planned[0].data.runner).toBe('inline');
      expect(planned[0].data.trigger.reasons).toContain(reason);
    });

    it('--no-team on the host prompt drops system2 to subAgent', async () => {
      const { task, planned, userPrompt } = await run('system2', {
        hostPrompt: `${PROMPT} --no-team`,
      });

      expect(task.mode).toBe('subAgent');
      expect(task.phases).toEqual(['execute', 'verify']);
      expect(task.meta?.workflowPlan).toBeUndefined();
      expect(userPrompt).not.toContain('Execution contract');
      expect(planned[0].data.mode).toBe('subAgent');
      expect(planned[0].data.runner).toBe('inline');
      expect(planned[0].data.trigger.reasons).toContain('no-team-flag');
    });

    it('reads the flag from `user_prompt` too, not just `prompt`', async () => {
      // `extractUserPromptFlagSurface` unions both keys on purpose: an opt-out
      // is a stated intent and must not be erasable by whichever key a given
      // host or rewriter happens to fill.
      const sessionId = nextSessionId();
      const mw = createTasksMiddleware({ now: () => 1700000000000 });
      const state = offState('system2', sessionId);
      state.input.hookData.user_prompt = `${PROMPT} --no-team`;
      const result = await mw(state);
      expect(result.context.tasks.mode).toBe('subAgent');
    });

    it('does not read the flag out of the middle of a word', async () => {
      // `\b` anchoring: `--no-teamwork` is not an opt-out. Pinned because the
      // regex now has ONE definition and a change to it reaches four hooks and
      // this middleware at once.
      const { task } = await run('system2', { hostPrompt: `${PROMPT} --no-teamwork` });
      expect(task.mode).toBe('agentTeam');
    });

    it('leaves system1 alone: OFF changes the record, not the mode', async () => {
      // system1 was already `subAgent`. The reason is what is new, and it is
      // what keeps an OFF session distinguishable in the denominator.
      const { task, planned } = await run('system1', {
        config: { ...TEAM_TRIGGER_CONFIG, team: { ...TEAM_TRIGGER_CONFIG.team, enabled: false } },
      });
      expect(task.mode).toBe('subAgent');
      expect(planned[0].data.trigger.reasons).toContain('team-disabled');
    });
  });
});
