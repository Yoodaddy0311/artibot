/**
 * A SubagentStart / SubagentStop must not write over a team-state file it could not read.
 *
 * `~/.claude/artibot-state.json` is shared by every live session. The START and STOP
 * handlers used to read it with `loadState` (since retired), which answered `{ agents: {} }` for a
 * file that was unreadable AND for one that was not JSON, and then wrote that back: one failed read
 * replaced every other agent's row with a single one. They now read through
 * `readStateForUpdate` (`lib/runtime/subagent-state-guard.js`) and write nothing when it
 * answers null.
 *
 * WHAT IS PINNED
 *   - the reader's answer for each kind of file (unit level, real files), and for a read that
 *     fails with each errno (a patched `readFileSync` throws it for one path): only the read's
 *     own ENOENT is a missing file, a code-less failure is not;
 *   - the lookup that precedes the bind (`readAgentEntry`): own keys only, silent, and "not
 *     known" for a file that cannot be read whole (what the resume-binds-nothing rule in
 *     subagent-handler-resume.test.js relies on);
 *   - the `hook` option: a refusal on stderr carries the label of the hook that asked, for
 *     every kind of refusal (default `subagent-handler`; an empty or non-string label falls
 *     back to it), and `quiet` still wins;
 *   - the two other hooks that read through the guard, as child processes on a corrupt file:
 *     workflow-status.js and team-idle-handler.js each say their own name, once;
 *   - the hook as a child process on real files: a corrupt file, and a healthy file whose
 *     read fails with EBUSY (a preload makes `fs.readFileSync` throw for that one path),
 *     stay byte for byte as they were across START and STOP; the spawn rows and the stdout
 *     message still land; the next healthy event writes normally.
 *   - POSITIVE CONTROLS: the same hook on a healthy file adds and closes its row and keeps
 *     the other session's row, and with the preload aimed at another path it still writes,
 *     so "unchanged" is not an artefact of a hook that never writes.
 *
 * WHAT GREEN HERE DOES NOT PROVE
 *   - That a real scanner's sharing violation surfaces as EBUSY from `readFileSync`. libuv
 *     maps ERROR_SHARING_VIOLATION to EBUSY, but the fault here is injected, not measured.
 *   - That a corrupt file is replaced later: that is SessionEnd's merge
 *     (`_team-state.js#mergeSessionSnapshot`, its own suite), not exercised here.
 *   - The handler-level in-process variants (mocked fs, no child process) live in
 *     subagent-handler.test.js.
 *   - That every caller passes a label. A hook that passes none is attributed to
 *     `subagent-handler`; only the two call sites above are exercised, and what those two hooks
 *     do with a refusal (write nothing) is pinned in their own suites, not here.
 *
 * @module tests/hooks/subagent-state-guard
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readSpawns } from '../../lib/learning/ledger/spawn-ledger.js';
import { readAgentEntry, readStateForUpdate } from '../../lib/runtime/subagent-state-guard.js';

// Failures injected into `readFileSync` by path: file -> errno code (null: an error with no code).
// Every other read goes through, so the guard and this file see the same patched function.
const { failures } = vi.hoisted(() => ({ failures: new Map() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: (file, ...rest) => {
      if (failures.has(String(file))) {
        const code = failures.get(String(file));
        throw Object.assign(new Error(`${code ?? 'read failed'}: injected`), code === null ? {} : { code });
      }
      return actual.readFileSync(file, ...rest);
    },
  };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');

// ---------------------------------------------------------------------------
// readStateForUpdate - the rule, unit level
// ---------------------------------------------------------------------------

describe('readStateForUpdate', () => {
  let tmp;
  let file;
  let stderr;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-state-guard-unit-')));
    file = path.join(tmp, 'artibot-state.json');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    failures.clear();
    stderr.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });
  const said = () => stderr.mock.calls.map((c) => String(c[0])).join('');

  it('POSITIVE CONTROL: a readable state object comes back as parsed, silently', () => {
    const state = { agents: { a: { active: true } }, teamId: 't-1', events: [1, 2] };
    writeFileSync(file, JSON.stringify(state));
    expect(readStateForUpdate(file)).toEqual(state);
    expect(said()).toBe('');
  });

  it('a missing file is a fresh state, not a refusal', () => {
    expect(readStateForUpdate(file)).toEqual({ agents: {} });
    expect(said()).toBe('');
  });

  it('accepts an agents value that is absent or null (every reader downstream tolerates both)', () => {
    writeFileSync(file, '{"agents":null,"x":1}');
    expect(readStateForUpdate(file)).toEqual({ agents: null, x: 1 });
    writeFileSync(file, '{"x":1}');
    expect(readStateForUpdate(file)).toEqual({ x: 1 });
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '7'],
    ['a string', '"x"'],
    ['agents as an array', '{"agents":[]}'],
    ['agents as a string', '{"agents":"x"}'],
    ['agents as a number', '{"agents":3}'],
  ])('refuses JSON that is not a state object: %s', (_label, text) => {
    writeFileSync(file, text);
    expect(readStateForUpdate(file)).toBeNull();
    expect(said()).toContain('[artibot:subagent-handler] team state left untouched (not a state object)');
  });

  it.each(['', '   \n', '{"agents": {"a": ', 'not json{{{'])('refuses text that is not JSON: %j', (text) => {
    writeFileSync(file, text);
    expect(readStateForUpdate(file)).toBeNull();
    expect(said()).toContain('[artibot:subagent-handler] team state left untouched (not valid JSON)');
  });

  it('does not echo the file text on stderr', () => {
    writeFileSync(file, 'SECRET-TOKEN-1234 {');
    expect(readStateForUpdate(file)).toBeNull();
    expect(said()).not.toContain('SECRET-TOKEN');
  });

  it('refuses a path that is there but cannot be read as a file (a directory: EISDIR)', () => {
    mkdirSync(file);
    expect(readStateForUpdate(file)).toBeNull();
    expect(said()).toContain('[artibot:subagent-handler] team state left untouched (unreadable): ');
  });

  it.each(['EPERM', 'EACCES', 'EBUSY', 'EIO', 'ENOTDIR'])(
    'refuses a healthy file when the read fails with %s: it is not a missing file',
    (code) => {
      writeFileSync(file, JSON.stringify({ agents: { a: { active: true } } }));
      failures.set(file, code);
      expect(readStateForUpdate(file)).toBeNull();
      expect(said()).toContain(`[artibot:subagent-handler] team state left untouched (unreadable): ${code}: injected`);
    },
  );

  it('refuses a read failure that carries no errno code: it is not taken for a missing file', () => {
    writeFileSync(file, '{"agents":{}}');
    failures.set(file, null);
    expect(readStateForUpdate(file)).toBeNull();
    expect(said()).toContain('team state left untouched (unreadable): read failed: injected');
  });

  it('POSITIVE CONTROL for the injection: with no failure registered the same file reads', () => {
    writeFileSync(file, '{"agents":{"a":{"active":true}}}');
    failures.set(`${file}.other`, 'EBUSY');
    expect(readStateForUpdate(file)).toEqual({ agents: { a: { active: true } } });
  });

  it('quiet: a refusal says nothing on stderr, and is still a refusal', () => {
    writeFileSync(file, 'not json{{{');
    expect(readStateForUpdate(file, { quiet: true })).toBeNull();
    writeFileSync(file, '[]');
    expect(readStateForUpdate(file, { quiet: true })).toBeNull();
    writeFileSync(file, '{"agents":{}}');
    failures.set(file, 'EBUSY');
    expect(readStateForUpdate(file, { quiet: true })).toBeNull();
    expect(said()).toBe('');
  });

  it.each([
    ['not valid JSON', () => writeFileSync(file, 'not json{{{'), '(not valid JSON)'],
    ['not a state object', () => writeFileSync(file, '[]'), '(not a state object)'],
    ['unreadable', () => { writeFileSync(file, '{"agents":{}}'); failures.set(file, 'EBUSY'); }, '(unreadable): EBUSY'],
  ])('hook: a refusal for %s carries the label of the hook that asked', (_what, arrange, tail) => {
    arrange();
    expect(readStateForUpdate(file, { hook: 'team-idle-handler' })).toBeNull();
    expect(said()).toContain(`[artibot:team-idle-handler] team state left untouched ${tail}`);
    expect(said()).not.toContain('[artibot:subagent-handler]');
  });

  it('hook: with none given the label is subagent-handler, the first user of the guard', () => {
    writeFileSync(file, 'not json{{{');
    for (const opts of [undefined, null, {}, { quiet: false }]) {
      stderr.mockClear();
      expect(readStateForUpdate(file, opts)).toBeNull();
      expect(said()).toContain('[artibot:subagent-handler] team state left untouched (not valid JSON)');
    }
  });

  it.each([
    ['an empty string', ''],
    ['a number', 7],
    ['null', null],
    ['an object', { name: 'workflow-status' }],
    ['undefined', undefined],
  ])('hook: %s is not a label, the default is used', (_what, hook) => {
    writeFileSync(file, 'not json{{{');
    expect(readStateForUpdate(file, { hook })).toBeNull();
    expect(said()).toContain('[artibot:subagent-handler] team state left untouched (not valid JSON)');
  });

  it('hook: quiet still wins, whatever the label', () => {
    writeFileSync(file, 'not json{{{');
    expect(readStateForUpdate(file, { quiet: true, hook: 'workflow-status' })).toBeNull();
    expect(said()).toBe('');
  });

  it('POSITIVE CONTROL for hook: a readable file comes back, silently, under any label', () => {
    writeFileSync(file, '{"agents":{"a":{"active":true}}}');
    expect(readStateForUpdate(file, { hook: 'workflow-status' })).toEqual({ agents: { a: { active: true } } });
    expect(said()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// readAgentEntry - the lookup that precedes the bind
// ---------------------------------------------------------------------------

describe('readAgentEntry', () => {
  let tmp;
  let file;
  let stderr;
  const ROW = { agentType: 'team-x-impl', startedAt: '2026-10-13T00:00:00.000Z', active: false };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-state-guard-entry-')));
    file = path.join(tmp, 'artibot-state.json');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    failures.clear();
    stderr.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });
  const said = () => stderr.mock.calls.map((c) => String(c[0])).join('');

  it('POSITIVE CONTROL: the row of a registered id comes back as stored', () => {
    writeFileSync(file, JSON.stringify({ agents: { a1: ROW, a2: { agentType: 'other' } } }));
    expect(readAgentEntry(file, 'a1')).toEqual(ROW);
  });

  it('is undefined for an id with no row, a missing file, and agents that are null or absent', () => {
    writeFileSync(file, JSON.stringify({ agents: { a1: ROW } }));
    expect(readAgentEntry(file, 'a2')).toBeUndefined();
    writeFileSync(file, '{"agents":null}');
    expect(readAgentEntry(file, 'a1')).toBeUndefined();
    writeFileSync(file, '{"x":1}');
    expect(readAgentEntry(file, 'a1')).toBeUndefined();
    rmSync(file);
    expect(readAgentEntry(file, 'a1')).toBeUndefined();
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'looks up own keys only: the id %s finds nothing',
    (id) => {
      writeFileSync(file, JSON.stringify({ agents: { a1: ROW } }));
      expect(readAgentEntry(file, id)).toBeUndefined();
    },
  );

  it.each([['a number', 5], ['a string', 'text'], ['null', null], ['an array', []]])(
    'a row that is %s is not an entry',
    (_label, row) => {
      writeFileSync(file, JSON.stringify({ agents: { a1: row } }));
      expect(readAgentEntry(file, 'a1')).toBeUndefined();
    },
  );

  it('answers "not known", silently, for a file that cannot be read whole: corrupt, not an object, EBUSY', () => {
    writeFileSync(file, 'not json{{{');
    expect(readAgentEntry(file, 'a1')).toBeUndefined();
    writeFileSync(file, '{"agents":[]}');
    expect(readAgentEntry(file, 'a1')).toBeUndefined();
    writeFileSync(file, JSON.stringify({ agents: { a1: ROW } }));
    failures.set(file, 'EBUSY');
    expect(readAgentEntry(file, 'a1')).toBeUndefined();
    // The read-modify-write that follows says why it refused; this lookup does not say it twice.
    expect(said()).toBe('');
    // POSITIVE CONTROL: the same row is found once the read works again.
    failures.clear();
    expect(readAgentEntry(file, 'a1')).toEqual(ROW);
  });
});

// ---------------------------------------------------------------------------
// The other hooks that read through the guard name themselves - child processes, real files
// ---------------------------------------------------------------------------

describe('workflow-status.js and team-idle-handler.js attribute a refusal to themselves (child processes)', () => {
  const SID = 'sess-label-guard';
  const CORRUPT = 'not valid json{{{';
  let tmp;
  let statePath;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-state-guard-label-')));
    mkdirSync(path.join(tmp, 'home', '.claude'), { recursive: true });
    statePath = path.join(tmp, 'home', '.claude', 'artibot-state.json');
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /** One firing of the hook as the host spawns it, in a sandbox HOME (the env hygiene of the hooks' own suites). */
  function fire(script, args, input) {
    const home = path.join(tmp, 'home');
    const env = { ...process.env, HOME: home, USERPROFILE: home, ARTIBOT_HOOK_FIRED_DIRECT: 'off' };
    for (const key of [
      'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_TEAM_NAME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME',
    ]) delete env[key];
    const res = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'scripts', 'hooks', script), ...args], {
      input: JSON.stringify(input), encoding: 'utf-8', env, cwd: tmp, windowsHide: true, timeout: 30000,
    });
    return { status: res.status, stderr: String(res.stderr || '') };
  }
  const refusals = (stderr) => stderr.split('\n').filter((line) => line.includes('team state left untouched'));
  const payload = (name) => ({
    session_id: SID, agent_id: 'agent-label-guard', agent_type: 'tdd-guide', hook_event_name: name, cwd: os.tmpdir(),
  });

  it.each([
    ['workflow-status.js', ['teammate-update'], 'SubagentStart', 'workflow-status'],
    ['team-idle-handler.js', [], 'TeammateIdle', 'team-idle-handler'],
  ])('%s says its own name, once, when it refuses a corrupt state file', (script, args, eventName, label) => {
    writeFileSync(statePath, CORRUPT);

    const out = fire(script, args, payload(eventName));

    expect(out.status).toBe(0);
    // The refusal really happened (the file is untouched) and was said exactly once, under the caller's name.
    expect(readFileSync(statePath, 'utf-8')).toBe(CORRUPT);
    const lines = refusals(out.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[artibot:${label}] team state left untouched (not valid JSON)`);
    expect(out.stderr).not.toContain('[artibot:subagent-handler]');
  });
});

// ---------------------------------------------------------------------------
// The hook, as a child process - what actually lands on disk
// ---------------------------------------------------------------------------

describe('subagent-handler over a team-state file it cannot read (child processes, real files)', () => {
  const SID = 'sess-state-guard';
  const AGENT = 'agent-state-guard';
  const OTHER = 'agent-of-another-session';
  const TYPE = 'tdd-guide';
  const START_OUT = { message: `[team] Agent registered: ${AGENT} (${TYPE})` };
  const STOP_OUT = { message: `[team] Agent deregistered: ${AGENT}` };

  let tmp;
  let home;
  let repo;
  let statePath;
  let preload;

  /** Makes `fs.readFileSync` throw EBUSY for the one path in GUARD_EBUSY_PATH, and only that. */
  const PRELOAD_SRC = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const real = fs.readFileSync;',
    "const target = path.resolve(process.env.GUARD_EBUSY_PATH || '').toLowerCase();",
    'fs.readFileSync = function readFileSync(file, ...rest) {',
    "  if (typeof file === 'string' && path.resolve(file).toLowerCase() === target) {",
    "    throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });",
    '  }',
    '  return real.call(this, file, ...rest);',
    '};',
    'syncBuiltinESMExports();',
  ].join('\n');

  const payload = (event) => ({
    session_id: SID, agent_id: AGENT, agent_type: TYPE, hook_event_name: event, cwd: repo,
  });

  function run(action, { ebusyPath } = {}) {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    // The host session ids must not leak into the child.
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const args = [HOOK, action];
    if (ebusyPath) {
      args.unshift('--import', pathToFileURL(preload).href);
      env.GUARD_EBUSY_PATH = ebusyPath;
    }
    const res = spawnSync(process.execPath, args, {
      input: JSON.stringify(payload(action === 'start' ? 'SubagentStart' : 'SubagentStop')),
      encoding: 'utf-8',
      env,
      windowsHide: true,
      timeout: 30000,
    });
    return { status: res.status, stdout: String(res.stdout || '').trim(), stderr: String(res.stderr || '') };
  }

  const seed = () => ({
    teamId: 'team-other-session',
    domain: 'general',
    startedAt: 1760000000000,
    agents: { [OTHER]: { role: 'teammate', agentType: TYPE, active: true, startedAt: new Date().toISOString() } },
    events: [{ kind: 'kept' }],
  });
  const bytes = () => readFileSync(statePath);
  const stateNow = () => JSON.parse(readFileSync(statePath, 'utf-8'));
  const spawnEvents = () => readSpawns(repo, { sessionId: SID }).map((r) => r.event);
  const leftovers = () => readdirSync(path.dirname(statePath))
    .filter((name) => name.includes('.tmp.') || name.endsWith('.lock'));

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-state-guard-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    statePath = path.join(home, '.claude', 'artibot-state.json');
    preload = path.join(tmp, 'ebusy-preload.mjs');
    writeFileSync(preload, PRELOAD_SRC, 'utf-8');
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: a healthy file gets the row added and closed, and keeps the other session\'s row', () => {
    writeFileSync(statePath, JSON.stringify(seed()));

    const started = run('start');
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout)).toEqual(START_OUT);
    expect(stateNow().agents[AGENT]).toMatchObject({ active: true, agentType: TYPE });
    expect(stateNow().agents[OTHER]).toMatchObject({ active: true });
    expect(stateNow().events).toEqual([{ kind: 'kept' }]);

    const stopped = run('stop');
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual(STOP_OUT);
    expect(stateNow().agents[AGENT]).toMatchObject({ active: false });
    expect(stateNow().agents[OTHER]).toMatchObject({ active: true });
    expect(spawnEvents()).toEqual(['start', 'stop']);
    expect(leftovers()).toEqual([]);
  });

  it('a missing file is created by the first START: the guard does not stop a first registration', () => {
    expect(existsSync(statePath)).toBe(false);
    expect(run('start').status).toBe(0);
    expect(stateNow().agents[AGENT]).toMatchObject({ active: true });
  });

  it.each([
    ['truncated JSON', '{"agents": {"agent-of-another-session": {"active": true}}, "events": ['],
    ['text that is not JSON', 'not valid json{{{'],
    ['an empty file', ''],
    ['JSON null', 'null'],
    ['a JSON array', '[1,2]'],
    ['an agents value that is not an object', '{"agents":[],"events":[1]}'],
  ])('leaves a state file that is %s byte for byte alone across START and STOP', (_label, text) => {
    writeFileSync(statePath, text);
    const before = bytes();

    const started = run('start');
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout)).toEqual(START_OUT);
    expect(started.stderr).toContain('[artibot:subagent-handler] team state left untouched');
    expect(bytes().equals(before)).toBe(true);

    const stopped = run('stop');
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual(STOP_OUT);
    expect(stopped.stderr).toContain('[artibot:subagent-handler] team state left untouched');
    expect(bytes().equals(before)).toBe(true);

    // The ledger rows do not depend on the state file, and no temp or lock file is left behind.
    expect(spawnEvents()).toEqual(['start', 'stop']);
    expect(leftovers()).toEqual([]);
  });

  it('leaves a healthy file alone when reading it fails with EBUSY, and the next healthy event writes normally', () => {
    writeFileSync(statePath, JSON.stringify(seed(), null, 2));
    const before = bytes();

    const started = run('start', { ebusyPath: statePath });
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout)).toEqual(START_OUT);
    expect(started.stderr).toContain('[artibot:subagent-handler] team state left untouched (unreadable): EBUSY');
    expect(bytes().equals(before)).toBe(true);

    const stopped = run('stop', { ebusyPath: statePath });
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual(STOP_OUT);
    expect(bytes().equals(before)).toBe(true);
    expect(spawnEvents()).toEqual(['start', 'stop']);
    expect(leftovers()).toEqual([]);

    // The contention passes: the next START registers, beside the row that was never lost.
    expect(run('start').status).toBe(0);
    expect(Object.keys(stateNow().agents).sort()).toEqual([AGENT, OTHER].sort());
  });

  it('POSITIVE CONTROL: the same preload aimed at another path does not stop the write', () => {
    writeFileSync(statePath, JSON.stringify(seed()));

    const started = run('start', { ebusyPath: path.join(tmp, 'elsewhere.json') });

    expect(started.status).toBe(0);
    expect(started.stderr).not.toContain('team state left untouched');
    expect(stateNow().agents[AGENT]).toMatchObject({ active: true });
    expect(stateNow().agents[OTHER]).toBeDefined();
  });
});
