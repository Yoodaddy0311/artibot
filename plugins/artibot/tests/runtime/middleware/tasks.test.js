import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTasksMiddleware } from '../../../lib/runtime/middleware/tasks.js';
import { sessionFallbackMissionId } from '../../../lib/runtime/event-writer.js';
import { appendLedgerEvent, readLedgerCensus } from '../../../lib/runtime/ledger.js';
import { createStateStore, readJournal } from '../../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../../lib/project-state/git-common-dir.js';

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

  beforeEach(() => {
    pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-tasks-'));
    mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  function writeEffortFixture(meta) {
    writeFileSync(
      path.join(pluginRoot, 'runtime', 'current-effort.json'),
      JSON.stringify(meta) + '\n',
    );
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
    expect(existsSync(storeDir())).toBe(false);
    expect(existsSync(yamlPath())).toBe(false);
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
    // port, so this also proves the port is the only thing consulted.
    expect(existsSync(storeDir())).toBe(false);
  });

  it('fails open: a store directory blocked by a file changes no other field', async () => {
    // A FILE where the store directory must be. `ensureDirSync` throws EEXIST
    // on this, and it is a failure that can be injected identically on Windows
    // and POSIX — unlike a chmod, which Windows does not honour.
    writeFileSync(storeDir(), 'not a directory\n');

    const result = await run(SUBSTANTIVE);
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
