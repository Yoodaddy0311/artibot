import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * mark-main-agent-edit.js — PostToolUse marker for the dev-verify-gate.
 *
 * Contract under test:
 *   - On Edit / Write / MultiEdit calls from the main orchestrator agent,
 *     write `runtime/last-main-agent-edit.timestamp`.
 *   - On the same tools but inside a subagent (Task-spawned teammate)
 *     context, do NOT write the marker.
 *   - On non-edit tools (Bash, Read, Grep, etc.), do NOT write the marker.
 *   - On absent / unknown tool name, do NOT write the marker.
 *   - Marker write failures must not throw out of the hook.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  stdin: '',
  atomicWrites: [],
};

// ---------------------------------------------------------------------------
// Mocks (must be hoisted via vi.mock — referencing local state is allowed
// because mockState is module-scoped, not test-scoped).
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(async () => mockState.stdin),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); } catch { return null; }
  }),
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  atomicWriteSync: vi.fn((file, data) => {
    mockState.atomicWrites.push({ file, data });
  }),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => undefined),
  extractToolName: vi.fn((hookData) => hookData?.tool_name ?? null),
}));

const { isSubagentContext, getMarkerPath, main } = await import(
  '../../scripts/hooks/mark-main-agent-edit.js'
);

const utils = await import('../../scripts/utils/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setStdin(payload) {
  mockState.stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function reset() {
  mockState.stdin = '';
  mockState.atomicWrites = [];
  vi.clearAllMocks();
}

// ---------------------------------------------------------------------------
// isSubagentContext
// ---------------------------------------------------------------------------
describe('isSubagentContext', () => {
  it('returns false for plain main-agent hook data', () => {
    expect(isSubagentContext({ tool_name: 'Edit', session_id: 'abc' })).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isSubagentContext({})).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isSubagentContext(null)).toBe(false);
    expect(isSubagentContext(undefined)).toBe(false);
  });

  it('returns false for non-object payloads', () => {
    expect(isSubagentContext('string')).toBe(false);
    expect(isSubagentContext(42)).toBe(false);
  });

  it('returns true when subagent_id is set', () => {
    expect(isSubagentContext({ subagent_id: 'sub-123' })).toBe(true);
  });

  it('returns true when subagent_type is set', () => {
    expect(isSubagentContext({ subagent_type: 'code-reviewer' })).toBe(true);
  });

  it('returns true when parent_session_id is set', () => {
    expect(isSubagentContext({ parent_session_id: 'parent-abc' })).toBe(true);
  });

  it("returns true when role is 'teammate'", () => {
    expect(isSubagentContext({ role: 'teammate' })).toBe(true);
  });

  it("returns false when role is 'orchestrator'", () => {
    expect(isSubagentContext({ role: 'orchestrator' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getMarkerPath
// ---------------------------------------------------------------------------
describe('getMarkerPath', () => {
  it('returns the runtime/ path under the provided plugin root', () => {
    const p = getMarkerPath('/some/root');
    expect(p).toMatch(/runtime[\\/]last-main-agent-edit\.timestamp$/);
    expect(p.startsWith('/some/root') || p.startsWith('\\some\\root')).toBe(true);
  });

  it('falls back to getPluginRoot() when no arg is given', () => {
    const p = getMarkerPath();
    expect(p).toContain('runtime');
    expect(p).toContain('last-main-agent-edit.timestamp');
    expect(utils.getPluginRoot).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// main() — integration through stdin
// ---------------------------------------------------------------------------
describe('main()', () => {
  beforeEach(() => {
    reset();
  });

  it('writes the marker on Edit from main agent', async () => {
    setStdin({ tool_name: 'Edit', tool_input: { file_path: '/x.js' } });
    await main();
    expect(mockState.atomicWrites).toHaveLength(1);
    expect(mockState.atomicWrites[0].file).toMatch(/last-main-agent-edit\.timestamp$/);
    // Body must be a valid ISO 8601 timestamp followed by a newline.
    expect(mockState.atomicWrites[0].data).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/,
    );
  });

  it('writes the marker on Write from main agent', async () => {
    setStdin({ tool_name: 'Write', tool_input: { file_path: '/x.js', content: 'hi' } });
    await main();
    expect(mockState.atomicWrites).toHaveLength(1);
  });

  it('writes the marker on MultiEdit from main agent', async () => {
    setStdin({ tool_name: 'MultiEdit', tool_input: { file_path: '/x.js', edits: [] } });
    await main();
    expect(mockState.atomicWrites).toHaveLength(1);
  });

  it('does NOT write the marker on Edit inside a subagent', async () => {
    setStdin({
      tool_name: 'Edit',
      tool_input: { file_path: '/x.js' },
      subagent_id: 'sub-xyz',
    });
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it("does NOT write the marker when role is 'teammate'", async () => {
    setStdin({
      tool_name: 'Write',
      tool_input: { file_path: '/x.js', content: 'hi' },
      role: 'teammate',
    });
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on Bash', async () => {
    setStdin({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on Read', async () => {
    setStdin({ tool_name: 'Read', tool_input: { file_path: '/x.js' } });
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on missing tool name', async () => {
    setStdin({ tool_input: { file_path: '/x.js' } });
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT write the marker on malformed JSON stdin', async () => {
    setStdin('not-json{{');
    await main();
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('does NOT throw when stdin is empty', async () => {
    setStdin('');
    await expect(main()).resolves.toBeUndefined();
    expect(mockState.atomicWrites).toHaveLength(0);
  });
});
