import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { saveSessionState } from '../../scripts/hooks/session-end.js';

/**
 * The state snapshot SessionEnd writes into `~/.claude/artibot-state.json`.
 *
 * That file is shared by every live session on the machine (agents, events, idle
 * bookkeeping), and `saveSessionState` used to replace the WHOLE file with a five-key
 * snapshot, so one session ending wiped what the others had recorded. These tests run
 * against a real filesystem under a throwaway HOME and the real lock (no mocks); the unit
 * contract of the merge itself is in `_team-state.test.js`. This file pins what only the
 * hook can show: which snapshot it builds, and that main() writes it before any later stage.
 *
 * What this file cannot see: a real SessionEnd payload (the ones here are synthesized), and
 * real contention between two processes on the lock (that is `tests/core/file-lock*.test.js`).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_END = path.join(HERE, '..', '..', 'scripts', 'hooks', 'session-end.js');

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

/** What the file looks like mid-run: another session's agents, events and idle records. */
function liveState() {
  return {
    sessionId: 'sess-OLD',
    endedAt: iso(3 * 3_600_000),
    startedAt: 1791780234051,
    cwd: 'C:\\old\\project',
    metadata: { platform: 'win32', nodeVersion: 'v0.0.0' },
    teamId: 'team-sess-LIVE',
    domain: 'general-purpose',
    agents: {
      'live-registered': {
        role: 'builder', agentType: 'builder', active: true, startedAt: iso(600_000),
        updatedAt: iso(60_000), sessionId: 'sess-LIVE', canonicalModel: 'opus',
      },
      'live-finished': {
        role: 'tdd-guide', active: false, startedAt: iso(900_000), stoppedAt: iso(300_000),
        updatedAt: iso(300_000), sessionId: 'sess-LIVE',
      },
    },
    events: [{ timestamp: iso(60_000), type: 'info', agent: 'live-registered', message: 'Agent updated' }],
    tasks: [{ id: '1', status: 'pending' }],
    workflow: { playbook: 'feature', currentPhase: 0, completed: 0, total: 1, derived: true, updatedAt: iso(60_000) },
    idleCounts: { 'live-registered': 2 },
    idlePayloadWithoutAgentId: { keys: ['hook_event_name', 'session_id', 'teammate_name'], at: iso(120_000) },
  };
}

describe('session-end state snapshot', () => {
  let tmp;
  let statePath;
  let savedEnv;
  let stderr;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-session-end-state-')));
    savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    statePath = path.join(tmp, '.claude', 'artibot-state.json');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const stderrText = () => stderr.mock.calls.map((c) => String(c[0])).join('');
  const readState = () => JSON.parse(readFileSync(statePath, 'utf-8'));
  const seed = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');

  it('never points at the real state file (the HOME sandbox took effect)', () => {
    saveSessionState({ session_id: 'sess-END' });
    expect(existsSync(statePath)).toBe(true);
    expect(statePath.startsWith(tmp)).toBe(true);
  });

  describe('the snapshot it writes', () => {
    it('records the session id, start time, cwd and platform from the payload and process', () => {
      saveSessionState({ session_id: 'sess-END', started_at: '2026-10-12T00:00:00.000Z' });

      const state = readState();
      expect(state.sessionId).toBe('sess-END');
      expect(state.startedAt).toBe('2026-10-12T00:00:00.000Z');
      expect(state.cwd).toBe(process.cwd());
      expect(state.metadata).toEqual({ platform: process.platform, nodeVersion: process.version });
      expect(Date.now() - Date.parse(state.endedAt)).toBeLessThan(60_000);
    });

    it('records nulls for what the payload lacks, and for a payload that did not parse', () => {
      saveSessionState({});
      expect(readState()).toMatchObject({ sessionId: null, startedAt: null });

      saveSessionState(null);
      expect(readState()).toMatchObject({ sessionId: null, startedAt: null });
    });
  });

  describe('what it leaves alone', () => {
    it('keeps the agents, events and idle records the other live sessions wrote', () => {
      const before = liveState();
      seed(before);

      saveSessionState({ session_id: 'sess-END' });

      const after = readState();
      expect(after.agents).toEqual(before.agents);
      expect(after.events).toEqual(before.events);
      expect(after.idleCounts).toEqual(before.idleCounts);
      expect(after.idlePayloadWithoutAgentId).toEqual(before.idlePayloadWithoutAgentId);
    });

    it('replaces the snapshot keys: this session is now the last one that ended', () => {
      seed(liveState());

      saveSessionState({ session_id: 'sess-END', started_at: '2026-10-12T00:00:00.000Z' });

      const after = readState();
      expect(after.sessionId).toBe('sess-END');
      expect(after.startedAt).toBe('2026-10-12T00:00:00.000Z');
      expect(after.cwd).toBe(process.cwd());
      expect(after.endedAt > liveState().endedAt).toBe(true);
    });

    it('keeps a key it has never heard of: only the named ones are ever dropped', () => {
      seed({ ...liveState(), someFutureKey: { kept: true } });

      saveSessionState({ session_id: 'sess-END' });

      expect(readState().someFutureKey).toEqual({ kept: true });
    });

    it('drops the progress mirror of the team that just finished, as the whole-file overwrite did', () => {
      seed(liveState());

      saveSessionState({ session_id: 'sess-END' });

      // tasks/workflow are derived from the finished team's task list, ids restart at 1 in
      // the next session, and nothing else ever clears them. teamId/domain are per session.
      const after = readState();
      for (const key of ['tasks', 'workflow', 'teamId', 'domain']) expect(after, key).not.toHaveProperty(key);
    });

    it('drops the rows that have outlived the retention window while it is writing', () => {
      const before = liveState();
      before.agents['long-gone'] = {
        role: 'teammate', active: false, startedAt: iso(9 * 24 * 3_600_000),
        stoppedAt: iso(8 * 24 * 3_600_000), updatedAt: iso(8 * 24 * 3_600_000),
      };
      seed(before);

      saveSessionState({ session_id: 'sess-END' });

      expect(Object.keys(readState().agents).sort()).toEqual(['live-finished', 'live-registered']);
    });
  });

  describe('when the file cannot be merged', () => {
    it('writes the snapshot alone over an unparseable file, and says so', () => {
      writeFileSync(statePath, '{ not valid json', 'utf-8');

      saveSessionState({ session_id: 'sess-END' });

      expect(Object.keys(readState()).sort()).toEqual(['cwd', 'endedAt', 'metadata', 'sessionId', 'startedAt']);
      expect(stderrText()).toContain('[artibot:session-end] ');
      expect(stderrText()).toContain('replaced by the session snapshot');
    });

    it('does the same for valid JSON that is not an object', () => {
      for (const text of ['[1,2]', 'null', '7', '"x"']) {
        writeFileSync(statePath, text, 'utf-8');
        saveSessionState({ session_id: 'sess-END' });
        expect(readState().sessionId, text).toBe('sess-END');
      }
    });

    it('says nothing when there is simply no file yet', () => {
      saveSessionState({ session_id: 'sess-END' });
      expect(stderrText()).toBe('');
    });

    it('leaves a file it cannot read alone instead of overwriting what it could not see', () => {
      // A directory where the file should be: readFileSync throws EISDIR, not ENOENT.
      mkdirSync(statePath);

      expect(() => saveSessionState({ session_id: 'sess-END' })).not.toThrow();

      expect(existsSync(statePath)).toBe(true);
      expect(stderrText()).toContain('[artibot:session-end] ');
    });
  });

  // ---------------------------------------------------------------------------
  // main() order. The hook has a 10s budget (hooks/dispatch-table.json) and the stages
  // after the snapshot — receipts, learning, evolution — can use all of it, so the
  // snapshot is the first thing done once stdin is read. This runs the real script as the
  // dispatcher does, against a plugin root whose FIRST later stage records what the state
  // file held at that moment and then throws.
  // ---------------------------------------------------------------------------
  describe('main() writes the snapshot before any later stage', () => {
    function runHook(payload, probeOut) {
      const pluginRoot = path.join(tmp, 'stub-plugin-root');
      const stage = path.join(pluginRoot, 'lib', 'economics', 'usage-receipt.js');
      mkdirSync(path.dirname(stage), { recursive: true });
      writeFileSync(stage, [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.PROBE_OUT, readFileSync(process.env.PROBE_STATE, 'utf8'));",
        "throw new Error('probe: first later stage reached');",
        '',
      ].join('\n'), 'utf-8');

      const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR'];
      const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
      Object.assign(env, {
        HOME: tmp, USERPROFILE: tmp, CLAUDE_PLUGIN_ROOT: pluginRoot, PROBE_STATE: statePath, PROBE_OUT: probeOut,
      });
      return spawnSync(process.execPath, [SESSION_END], {
        // Under the 30s test timeout, so a hung child fails this test instead of outliving it.
        input: JSON.stringify(payload), env, cwd: tmp, encoding: 'utf8', timeout: 25_000,
      });
    }

    it('had already merged the snapshot into the shared state when the first later stage ran', () => {
      const before = liveState();
      seed(before);
      const probeOut = path.join(tmp, 'state-at-first-later-stage.json');
      const payload = {
        session_id: 'sess-END', transcript_path: path.join(tmp, 'transcript.jsonl'), cwd: tmp, hook_event_name: 'SessionEnd',
      };

      const run = runHook(payload, probeOut);

      expect(run.status, `stderr: ${run.stderr.slice(0, 600)}`).toBe(0);
      expect(existsSync(probeOut), 'the first later stage never ran, so this proves nothing').toBe(true);
      const atStage = JSON.parse(readFileSync(probeOut, 'utf-8'));
      expect(atStage.sessionId).toBe('sess-END');
      expect(atStage.endedAt > before.endedAt).toBe(true);
      expect(atStage.agents).toEqual(before.agents);
      expect(atStage.idlePayloadWithoutAgentId).toEqual(before.idlePayloadWithoutAgentId);
    });

    it('leaves no lock behind and the merged file in place when the hook is done', () => {
      const before = liveState();
      seed(before);
      const payload = {
        session_id: 'sess-END', transcript_path: path.join(tmp, 'transcript.jsonl'), cwd: tmp, hook_event_name: 'SessionEnd',
      };

      const run = runHook(payload, path.join(tmp, 'probe.json'));

      expect(run.status).toBe(0);
      expect(existsSync(`${statePath}.lock`)).toBe(false);
      expect(readState().agents).toEqual(before.agents);
      expect(readState().sessionId).toBe('sess-END');
    });
  });
});
