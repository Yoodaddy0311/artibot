import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  atomicWriteSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    existsSync: vi.fn(() => false),
  };
});

// Bypass file lock in tests — pass-through to the callback directly
vi.mock('../../lib/core/file-lock.js', () => ({
  withFileLock: vi.fn((_path, fn) => fn()),
}));

const { readStdin, writeStdout, atomicWriteSync } = await import('../../scripts/utils/index.js');
const { readFileSync, existsSync } = await import('node:fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHookData(data) {
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('subagent-handler hook', () => {
  let stderrSpy;
  let exitSpy;
  let originalArgv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalArgv = process.argv;
    // Default: no state file exists
    existsSync.mockReturnValue(false);
    readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('start action', () => {
    it('registers an agent with agent_id and role', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({
        agent_id: 'builder-01',
        role: 'builder',
      }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(atomicWriteSync).toHaveBeenCalledTimes(1);
      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents['builder-01']).toBeDefined();
      expect(savedState.agents['builder-01'].role).toBe('builder');
      expect(savedState.agents['builder-01'].active).toBe(true);
      expect(savedState.agents['builder-01'].startedAt).toBeDefined();

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('builder-01'),
        }),
      );
      expect(writeStdout.mock.calls[0][0].message).toContain('registered');
    });

    it('uses subagent_id when agent_id is absent', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({
        subagent_id: 'qa-agent',
        agent_type: 'qa',
      }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents['qa-agent']).toBeDefined();
      expect(savedState.agents['qa-agent'].role).toBe('qa');
    });

    it('uses name field as fallback for agent identification', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({
        name: 'architect-agent',
      }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents['architect-agent']).toBeDefined();
      expect(savedState.agents['architect-agent'].role).toBe('teammate');
    });

    it('defaults to "unknown" agent id and "teammate" role', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({}));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents['unknown']).toBeDefined();
      expect(savedState.agents['unknown'].role).toBe('teammate');
    });

    it('preserves existing agents in state when registering new one', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({
        agents: { 'existing-agent': { role: 'manager', active: true } },
      }));
      readStdin.mockResolvedValue(makeHookData({
        agent_id: 'new-agent',
        role: 'builder',
      }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents['existing-agent']).toBeDefined();
      expect(savedState.agents['new-agent']).toBeDefined();
    });
  });

  describe('team-context initialization (Area 2 fix)', () => {
    it('initializes top-level teamId/domain/startedAt on first start', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({
        agent_id: 'builder-01',
        role: 'builder',
        session_id: 'sess-abc',
      }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.teamId).toBe('team-sess-abc');
      expect(savedState.domain).toBe('builder');
      expect(typeof savedState.startedAt).toBe('number');
    });

    it('derives domain from explicit hookData.domain when present', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({
        agent_id: 'fe-01',
        role: 'frontend-developer',
        domain: 'frontend',
        session_id: 'sess-1',
      }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(atomicWriteSync.mock.calls[0][1].domain).toBe('frontend');
    });

    it('falls back to agent_type then role then "general" for domain', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'x', agent_type: 'qa' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(atomicWriteSync.mock.calls[0][1].domain).toBe('qa');
    });

    it('does not overwrite existing teamId/domain on subsequent starts', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({
        teamId: 'team-existing',
        domain: 'backend',
        startedAt: 1700000000000,
        agents: { 'a': { role: 'r', active: true } },
      }));
      readStdin.mockResolvedValue(makeHookData({
        agent_id: 'b',
        role: 'frontend',
        session_id: 'sess-new',
      }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.teamId).toBe('team-existing');
      expect(savedState.domain).toBe('backend');
      expect(savedState.startedAt).toBe(1700000000000);
    });

    it('rewrites non-numeric startedAt left over from prior session-end snapshot', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      existsSync.mockReturnValue(true);
      // session-end.js writes startedAt as ISO string or null — both
      // unusable for `Date.now() - startedAt`. New start must replace.
      readFileSync.mockReturnValue(JSON.stringify({
        startedAt: '2026-05-01T00:00:00Z',
        agents: {},
      }));
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'x', role: 'r' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(typeof savedState.startedAt).toBe('number');
    });
  });

  describe('stop action', () => {
    it('deregisters a known agent (sets active to false)', async () => {
      process.argv = ['node', 'subagent-handler.js', 'stop'];
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue(JSON.stringify({
        agents: {
          'builder-01': { role: 'builder', active: true, startedAt: '2026-01-01T00:00:00Z' },
        },
      }));
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'builder-01' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents['builder-01'].active).toBe(false);
      expect(savedState.agents['builder-01'].stoppedAt).toBeDefined();
      expect(savedState.agents['builder-01'].role).toBe('builder');

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('deregistered'),
        }),
      );
    });

    it('handles stop for unknown agent gracefully', async () => {
      process.argv = ['node', 'subagent-handler.js', 'stop'];
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'nonexistent' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      // Should still save state and write output
      expect(atomicWriteSync).toHaveBeenCalledTimes(1);
      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('deregistered'),
        }),
      );
    });
  });

  describe('state management', () => {
    it('creates fresh state when state file does not exist', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      existsSync.mockReturnValue(false);
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'agent-1' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents).toBeDefined();
      expect(savedState.agents['agent-1']).toBeDefined();
    });

    it('handles corrupted state file gracefully', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      existsSync.mockReturnValue(true);
      readFileSync.mockReturnValue('not valid json{{{');
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'agent-1' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      // Falls back to default state
      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents).toBeDefined();
      expect(savedState.agents['agent-1']).toBeDefined();
    });

    it('writes state file path based on HOME env variable', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'agent-1' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      const statePath = atomicWriteSync.mock.calls[0][0];
      expect(statePath).toContain('artibot-state.json');
    });
  });

  describe('no action specified', () => {
    it('does nothing when no action argument is provided', async () => {
      process.argv = ['node', 'subagent-handler.js'];
      readStdin.mockResolvedValue(makeHookData({ agent_id: 'agent-1' }));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      // Neither start nor stop branch executes
      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('exits gracefully when readStdin rejects', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockRejectedValue(new Error('stdin failed'));

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(exitSpy).toHaveBeenCalledWith(0);
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:subagent-handler]');
    });

    it('handles null hookData when parseJSON fails', async () => {
      process.argv = ['node', 'subagent-handler.js', 'start'];
      readStdin.mockResolvedValue('<<<invalid>>>');

      await import('../../scripts/hooks/subagent-handler.js');
      await new Promise((r) => setTimeout(r, 50));

      // Should still work with defaults (unknown agent)
      const savedState = atomicWriteSync.mock.calls[0][1];
      expect(savedState.agents['unknown']).toBeDefined();
    });
  });
});
