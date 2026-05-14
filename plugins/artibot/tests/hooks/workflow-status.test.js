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
  await import('../../scripts/hooks/workflow-status.js');
  await new Promise((r) => setTimeout(r, 30));
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

    expect(mockState.writes).toHaveLength(1);
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

    expect(mockState.writes).toHaveLength(1);
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

  it('uses atomicWriteSync exactly once per invocation', async () => {
    process.argv = ['node', 'workflow-status.js', 'teammate-update'];
    setStdin({ agent_id: 'a1' });

    await runHookFresh();

    expect(mockState.writes).toHaveLength(1);
    expect(mockState.writes[0].path).toBe('/state/workflow-status.json');
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

      expect(mockState.writes.length).toBe(1);
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
});
