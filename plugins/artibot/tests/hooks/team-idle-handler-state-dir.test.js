import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared team-state file follows the state-dir resolver (child process).
 *
 * `lib/core/hook-utils.js#getStatePath` used to answer `~/.claude/artibot-state.json`
 * whatever `ARTIBOT_STATE_DIR` said, so a hooked, non-interactive session that was
 * handed an override still read-modify-wrote the REAL file (owner's promptfoo PoC,
 * 2026-10-19: the top-level `sessionId`/`cwd` and one `agents` row were overwritten).
 * `tests/core/hook-utils-state-path.test.js` pins the function; this file runs one of
 * the seven hooks that call it the way the host runs it — `node team-idle-handler.js`,
 * payload on stdin, the PoC's environment — because a unit test of the path says nothing
 * about the lock, the temp file and the parent directory that come with it.
 *
 * `team-idle-handler` is the lightest hook that read-modify-writes the file: it reads
 * the pending tasks out of it and writes the file back with the payload's key names.
 *
 * Every case uses a throwaway home; the real one is never touched.
 *
 * WHAT THIS FILE CANNOT SEE: the other six hooks. They share `getStatePath()`, so the
 * answer cannot differ between them; their own behaviour is pinned elsewhere.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'team-idle-handler.js');

const SID = 'sess-state-dir';
const WITH_ID = {
  hook_event_name: 'TeammateIdle', session_id: SID, agent_id: 'agent-sd', agent_type: 'builder', cwd: os.tmpdir(),
};
const WITHOUT_ID = {
  hook_event_name: 'TeammateIdle', session_id: SID, teammate_name: 'mate-sd', team_name: 'team-sd', cwd: os.tmpdir(),
};

const pending = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, status: 'pending' }));

describe('team-idle-handler — the shared state file follows ARTIBOT_STATE_DIR', () => {
  let tmp;
  let home;
  let stateDir;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-idle-sd-')));
    home = path.join(tmp, 'home');
    stateDir = path.join(tmp, 'state');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const homeFile = () => path.join(home, '.claude', 'artibot-state.json');
  const stateFile = () => path.join(stateDir, 'artibot-state.json');

  /** One firing; `override` is `undefined` for none, or the `{ dir, mintedFor }` pair. */
  function fire(payload, override) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ARTIBOT_HOOK_FIRED_DIRECT: 'off' };
    // The host session ids and the state-dir seam must not leak into the child unless a case sets them.
    for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME']) {
      delete env[key];
    }
    if (override) {
      env.ARTIBOT_STATE_DIR = override.dir;
      env.ARTIBOT_STATE_DIR_HOME = override.mintedFor;
    }
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env,
      cwd: tmp,
      windowsHide: true,
      timeout: 30000,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  const leftovers = (dir) => (existsSync(dir)
    ? readdirSync(dir).filter((name) => name.includes('.tmp.') || name.endsWith('.lock'))
    : []);

  it('writes the file inside the override and leaves ~/.claude/artibot-state.json alone', () => {
    const out = fire(WITHOUT_ID, { dir: stateDir, mintedFor: home });

    expect(out.status).toBe(0);
    expect(existsSync(stateFile())).toBe(true);
    expect(JSON.parse(readFileSync(stateFile(), 'utf-8')).idlePayloadWithoutAgentId.keys)
      .toEqual(Object.keys(WITHOUT_ID).sort());
    expect(existsSync(homeFile())).toBe(false);
    expect(leftovers(stateDir)).toEqual([]);
    expect(leftovers(path.dirname(homeFile()))).toEqual([]);
  });

  it('reads the override too: pending tasks come from it, a decoy at the home path is untouched', () => {
    // The old location holds 3 pending tasks the hook must not see or rewrite...
    const decoy = JSON.stringify({ agents: {}, tasks: pending(3), marker: 'home-decoy' });
    writeFileSync(homeFile(), decoy, 'utf-8');
    // ...and the override holds 1.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ agents: {}, tasks: pending(1) }), 'utf-8');

    const out = fire(WITH_ID, { dir: stateDir, mintedFor: home });

    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).message)
      .toBe('[team] Teammate idle: agent-sd (builder) | 1 pending task(s) available for assignment.');
    expect(readFileSync(homeFile(), 'utf-8')).toBe(decoy);
  });

  it('keeps writing ~/.claude/artibot-state.json when no override is set (production invariance)', () => {
    const out = fire(WITHOUT_ID);

    expect(out.status).toBe(0);
    expect(JSON.parse(readFileSync(homeFile(), 'utf-8')).idlePayloadWithoutAgentId.keys)
      .toEqual(Object.keys(WITHOUT_ID).sort());
    expect(existsSync(stateDir)).toBe(false);
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    const out = fire(WITHOUT_ID, { dir: stateDir, mintedFor: path.join(tmp, 'some-other-home') });

    expect(out.status).toBe(0);
    expect(existsSync(homeFile())).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
  });
});
