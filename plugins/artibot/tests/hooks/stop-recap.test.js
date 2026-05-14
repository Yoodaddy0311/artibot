import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for scripts/hooks/stop-recap.js.
 *
 * Critical safety invariants under test (see hook header):
 *   - Loop guard: payload.stop_hook_active=true → silent bail
 *   - Schema guard: missing transcript_path → silent bail
 *   - Bounded scan: transcripts >4MB are tail-clipped
 *   - Malformed JSONL lines are skipped, not fatal
 *   - Empty turns (no tool_use blocks) produce no stderr output
 *   - Tool category counts: edits / cmds / reads / agents
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  execSyncImpl: () => '',
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
        if (String(p).includes(key)) return val;
      }
      return false;
    }),
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn((...args) => mockState.execSyncImpl(...args)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.execSyncImpl = () => '';
}

function jsonl(lines) {
  return lines.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function userMsg(text = 'hi') {
  return { message: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistantToolUse(name) {
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, id: 'x' }],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('stop-recap', () => {
  let stderrSpy;

  beforeEach(() => {
    vi.resetModules();
    resetState();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('bails silently when stop_hook_active=true (loop guard)', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      stop_hook_active: true,
      transcript_path: '/tmp/t.jsonl',
    }));
    mockState.existsSyncResults = { 't.jsonl': true };
    mockState.readFileSyncImpl = () => jsonl([userMsg(), assistantToolUse('Edit')]);

    await import('../../scripts/hooks/stop-recap.js');
    await new Promise((r) => setTimeout(r, 30));

    const recapLines = stderrSpy.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('[artibot:recap]'));
    expect(recapLines).toHaveLength(0);
  });

  it('bails when transcript_path is missing', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    await import('../../scripts/hooks/stop-recap.js');
    await new Promise((r) => setTimeout(r, 30));

    const recapLines = stderrSpy.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('[artibot:recap]'));
    expect(recapLines).toHaveLength(0);
  });

  it('counts edits / cmds / reads / agents in one turn', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      transcript_path: '/tmp/t.jsonl',
    }));
    mockState.existsSyncResults = { 't.jsonl': true };
    mockState.readFileSyncImpl = () => jsonl([
      userMsg(),
      assistantToolUse('Edit'),
      assistantToolUse('Write'),
      assistantToolUse('Bash'),
      assistantToolUse('PowerShell'),
      assistantToolUse('Read'),
      assistantToolUse('Grep'),
      assistantToolUse('Task'),
    ]);

    await import('../../scripts/hooks/stop-recap.js');
    await new Promise((r) => setTimeout(r, 30));

    const out = stderrSpy.mock.calls
      .map(([m]) => String(m))
      .find((m) => m.includes('[artibot:recap]')) || '';
    expect(out).toContain('2 files');  // Edit + Write
    expect(out).toContain('2 cmds');   // Bash + PowerShell
    expect(out).toContain('2 reads');  // Read + Grep
    expect(out).toContain('1 agent');  // Task
  });

  it('caps transcript reads at 4 MB (tail-only scan)', async () => {
    // Build a transcript whose head is >4MB of pre-user-message tool_use
    // blocks; only the tail (last user + a single edit) should be counted.
    const head = jsonl(Array.from({ length: 60000 }, () => assistantToolUse('Edit')));
    expect(head.length).toBeGreaterThan(4 * 1024 * 1024);
    const tail = jsonl([userMsg(), assistantToolUse('Edit')]);

    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      transcript_path: '/tmp/t.jsonl',
    }));
    mockState.existsSyncResults = { 't.jsonl': true };
    mockState.readFileSyncImpl = () => head + tail;

    await import('../../scripts/hooks/stop-recap.js');
    await new Promise((r) => setTimeout(r, 30));

    const out = stderrSpy.mock.calls
      .map(([m]) => String(m))
      .find((m) => m.includes('[artibot:recap]')) || '';
    // If the cap failed we would see 20001 files — assert we see the small count.
    expect(out).toContain('1 file');
    expect(out).not.toMatch(/\d{4,} files/);
  });

  it('emits nothing for an empty turn (no tool_use, clean workspace)', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      transcript_path: '/tmp/t.jsonl',
    }));
    mockState.existsSyncResults = { 't.jsonl': true };
    mockState.readFileSyncImpl = () => jsonl([
      userMsg(),
      { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    mockState.execSyncImpl = () => ''; // clean git status

    await import('../../scripts/hooks/stop-recap.js');
    await new Promise((r) => setTimeout(r, 30));

    const recapLines = stderrSpy.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('[artibot:recap]'));
    expect(recapLines).toHaveLength(0);
  });

  it('skips malformed JSONL lines without throwing', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({
      transcript_path: '/tmp/t.jsonl',
    }));
    mockState.existsSyncResults = { 't.jsonl': true };
    mockState.readFileSyncImpl = () =>
      jsonl([userMsg()])
      + '{ this is not valid json\n'
      + jsonl([assistantToolUse('Bash')]);

    await import('../../scripts/hooks/stop-recap.js');
    await new Promise((r) => setTimeout(r, 30));

    // No crash; legal line still counted.
    const out = stderrSpy.mock.calls
      .map(([m]) => String(m))
      .find((m) => m.includes('[artibot:recap]')) || '';
    expect(out).toContain('1 cmd');
  });
});
