import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for scripts/hooks/workflow-status.js.
 *
 * Covers:
 *   - Missing state file → returns fresh skeleton (no crash)
 *   - Corrupted state JSON → falls back to skeleton (no propagation)
 *   - mapAgentStatus shape for the 4 supported hook events
 *   - atomicWriteSync is invoked exactly once per call (write-through cache)
 *   - All 4 events (teammate-update / task-complete / task-error /
 *     workflow-advance) flow through the state machine without error
 *   - Concurrent invocations are serialized via withFileLock (no interleaved
 *     writes — the read-modify-write block runs to completion)
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  statePathResult: '/state/workflow-status.json',
  fileExists: false,
  fileContent: '',
  writes: [],
  lockCallCount: 0,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  atomicWriteSync: vi.fn((p, data) => { mockState.writes.push({ path: p, data }); }),
  writeStdout: vi.fn(),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => (err) => {
    process.stderr.write(`[test-error] ${err?.message || err}\n`);
  }),
  extractAgentId: vi.fn((d) => d?.agent_id || d?.agentId || 'unknown'),
  extractAgentRole: vi.fn((d, def) => d?.role || d?.agent_role || def),
  getStatePath: vi.fn(() => mockState.statePathResult),
  cleanupStaleStateTmpFiles: vi.fn(),
}));

vi.mock('../../lib/core/file-lock.js', () => ({
  withFileLock: vi.fn((path, fn) => {
    mockState.lockCallCount++;
    return fn();
  }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => mockState.fileExists),
    readFileSync: vi.fn(() => mockState.fileContent),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.statePathResult = '/state/workflow-status.json';
  mockState.fileExists = false;
  mockState.fileContent = '';
  mockState.writes = [];
  mockState.lockCallCount = 0;
}

function setStdin(payload) {
  mockState.readStdinResult = Promise.resolve(JSON.stringify(payload));
}

function setExistingState(stateObj) {
  mockState.fileExists = true;
  mockState.fileContent = JSON.stringify(stateObj);
}

async function runHookFresh() {
  vi.resetModules();
  await runHook();
  await new Promise((r) => setTimeout(r, 30));
}

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/workflow-status.js');
  await mod.main();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('workflow-status', () => {
  let argvBackup;
  let stderrSpy;

  beforeEach(() => {
    vi.resetModules();
    resetState();
    argvBackup = process.argv;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = argvBackup;
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('handles a missing state file by starting from a fresh skeleton', async () => {
    process.argv = ['node', 'workflow-status.js', 'teammate-update'];
    mockState.fileExists = false;
    setStdin({ agent_id: 'a1', role: 'planner' });

    await runHookFresh();

    expect(mockState.writes.filter((w) => w.path === '/state/workflow-status.json')).toHaveLength(1);
    const written = mockState.writes[0].data;
    expect(written.agents.a1).toBeDefined();
    expect(written.agents.a1.role).toBe('planner');
  });

  it('falls back to skeleton when state JSON is corrupted', async () => {
    process.argv = ['node', 'workflow-status.js', 'teammate-update'];
    mockState.fileExists = true;
    mockState.fileContent = '{ not valid json';
    setStdin({ agent_id: 'a1' });

    await runHookFresh();

    expect(mockState.writes.filter((w) => w.path === '/state/workflow-status.json')).toHaveLength(1);
    expect(mockState.writes[0].data.agents.a1).toBeDefined();
  });

  it('maps a teammate-update with currentTask to in_progress status', async () => {
    process.argv = ['node', 'workflow-status.js', 'teammate-update'];
    setStdin({ agent_id: 'a1', role: 'backend', current_task: 'wire endpoints' });

    await runHookFresh();

    const written = mockState.writes[0].data;
    expect(written.agents.a1.currentTask).toBe('wire endpoints');
    // active=true (default), currentTask set → in_progress
    expect(written.agents.a1.active).toBe(true);
  });

  it('writes the workflow state exactly once per invocation', async () => {
    process.argv = ['node', 'workflow-status.js', 'teammate-update'];
    setStdin({ agent_id: 'a1' });

    await runHookFresh();

    expect(mockState.writes.filter((w) => w.path === '/state/workflow-status.json')).toHaveLength(1);
    expect(mockState.writes[0].path).toBe('/state/workflow-status.json');
  });

  it('persists the non-idle teammate roster to runtime/current-teammates.json', async () => {
    process.argv = ['node', 'workflow-status.js', 'teammate-update'];
    setExistingState({
      agents: {
        a1: { role: 'planner', active: true, currentTask: 'plan' }, // in_progress
        old: { role: 'tester', active: false },                     // idle → excluded
      },
      tasks: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'pending' }],
    });
    setStdin({ agent_id: 'a1', current_task: 'plan' });

    await runHookFresh();

    const teamWrite = mockState.writes.find((w) => /current-teammates\.json$/.test(w.path));
    expect(teamWrite).toBeDefined();
    expect(Array.isArray(teamWrite.data.teammates)).toBe(true);
    const names = teamWrite.data.teammates.map((t) => t.name);
    expect(names).toContain('a1');
    expect(names).not.toContain('old'); // idle agent excluded → segment self-clears on disband
    const a1 = teamWrite.data.teammates.find((t) => t.name === 'a1');
    expect(a1.tasksTotal).toBe(2);
    expect(a1.tasksCompleted).toBe(1);
  });

  it('routes through all 4 hook event types without throwing', async () => {
    setExistingState({
      agents: { a1: { role: 'planner', tasksCompleted: 0 } },
      tasks: [{ id: '7', status: 'in_progress' }],
      events: [],
    });

    for (const event of ['teammate-update', 'task-complete', 'task-error', 'workflow-advance']) {
      vi.resetModules();
      mockState.writes = [];
      process.argv = ['node', 'workflow-status.js', event];
      setStdin({
        agent_id: 'a1',
        role: 'planner',
        task_id: '7',
        subject: 'demo',
        error: 'sample',
        phase: 2,
        playbook: 'feature',
      });

      await runHookFresh();

      expect(mockState.writes.filter((w) => w.path === '/state/workflow-status.json').length).toBe(1);
      const ev = mockState.writes[0].data.events;
      expect(Array.isArray(ev)).toBe(true);
      expect(ev.length).toBeGreaterThan(0);
    }
  });

  it('serializes concurrent invocations via withFileLock', async () => {
    process.argv = ['node', 'workflow-status.js', 'teammate-update'];
    setStdin({ agent_id: 'a1' });

    // Two back-to-back invocations of the same module (reset between).
    // withFileLock is the only path that mutates state, so its call count
    // must equal the number of invocations — no bypass path exists.
    await runHookFresh();
    const lockAfterFirst = mockState.lockCallCount;
    await runHookFresh();
    const lockAfterSecond = mockState.lockCallCount;

    expect(lockAfterFirst).toBe(1);
    expect(lockAfterSecond).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Opt-B: aggregate task counts surfaced on the teammate record
  // -------------------------------------------------------------------------
  describe('teammate task counts (Opt-B)', () => {
    it('injects tasksTotal/tasksCompleted on teammate-update from state.tasks', async () => {
      process.argv = ['node', 'workflow-status.js', 'teammate-update'];
      setExistingState({
        agents: {},
        tasks: [
          { id: '1', status: 'completed' },
          { id: '2', status: 'completed' },
          { id: '3', status: 'in_progress' },
          { id: '4', status: 'pending' },
        ],
        events: [],
        workflow: null,
      });
      setStdin({ agent_id: 'a1', role: 'backend' });

      await runHookFresh();

      const agent = mockState.writes[0].data.agents.a1;
      expect(agent.tasksTotal).toBe(4);
      expect(agent.tasksCompleted).toBe(2);
    });

    it('reconciles tasks from the hook payload (tasks + completed_tasks)', async () => {
      process.argv = ['node', 'workflow-status.js', 'teammate-update'];
      mockState.fileExists = false;
      setStdin({
        agent_id: 'a1',
        tasks: [
          { id: '1', status: 'pending' },
          { id: '2', status: 'in_progress' },
        ],
        completed_tasks: [{ id: '1' }],
      });

      await runHookFresh();

      const tasks = mockState.writes[0].data.tasks;
      expect(tasks).toHaveLength(2);
      expect(tasks.find((t) => t.id === '1').status).toBe('completed');
      expect(tasks.find((t) => t.id === '2').status).toBe('in_progress');
    });

    it('synthesizes placeholder rows from an explicit tasks_total', async () => {
      process.argv = ['node', 'workflow-status.js', 'teammate-update'];
      mockState.fileExists = false;
      setStdin({ agent_id: 'a1', tasks_total: 3 });

      await runHookFresh();

      const agent = mockState.writes[0].data.agents.a1;
      expect(agent.tasksTotal).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Opt-A: workflow phase derived from task-completion ratio
  // -------------------------------------------------------------------------
  describe('derived workflow phase (Opt-A)', () => {
    it('leaves workflow null when there is no task data', async () => {
      process.argv = ['node', 'workflow-status.js', 'teammate-update'];
      mockState.fileExists = false;
      setStdin({ agent_id: 'a1' });

      await runHookFresh();

      expect(mockState.writes[0].data.workflow).toBeNull();
    });

    it('derives an early phase when few tasks are complete', async () => {
      process.argv = ['node', 'workflow-status.js', 'teammate-update'];
      // 1/6 complete → ratio 0.167 → floor(0.167 * 5) = 0 (Plan)
      setExistingState({
        agents: {},
        tasks: [
          { id: '1', status: 'completed' },
          { id: '2', status: 'pending' },
          { id: '3', status: 'pending' },
          { id: '4', status: 'pending' },
          { id: '5', status: 'pending' },
          { id: '6', status: 'pending' },
        ],
        events: [],
        workflow: null,
      });
      setStdin({ agent_id: 'a1' });

      await runHookFresh();

      const wf = mockState.writes[0].data.workflow;
      expect(wf).not.toBeNull();
      expect(wf.playbook).toBe('feature');
      expect(wf.currentPhase).toBe(0);
      expect(wf.derived).toBe(true);
    });

    it('reaches the final phase only when all tasks are complete', async () => {
      process.argv = ['node', 'workflow-status.js', 'task-complete'];
      // 3/3 complete after the event → ratio 1 → last phase index (5, Merge)
      setExistingState({
        agents: { a1: { role: 'backend', tasksCompleted: 0 } },
        tasks: [
          { id: '1', status: 'completed' },
          { id: '2', status: 'completed' },
          { id: '3', status: 'in_progress' },
        ],
        events: [],
        workflow: { playbook: 'feature', currentPhase: 2 },
      });
      setStdin({ agent_id: 'a1', task_id: '3', subject: 'final' });

      await runHookFresh();

      const wf = mockState.writes[0].data.workflow;
      expect(wf.currentPhase).toBe(5); // Merge
    });
  });
});
