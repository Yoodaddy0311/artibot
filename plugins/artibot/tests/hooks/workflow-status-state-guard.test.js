/**
 * workflow-status.js must not write over a team-state file it could not read.
 *
 * `~/.claude/artibot-state.json` is shared by every live session. workflow-status.js had its own
 * `loadState`, which answered a fresh skeleton for a file that is unreadable AND for one that is
 * not JSON, and then wrote that skeleton plus this event back under the lock: one failed read
 * (EBUSY or EPERM from a scanner, say, on Windows) replaced every other agent's row with a single
 * one. It runs on SubagentStart, SubagentStop (through the dispatcher), TeammateIdle and
 * Notification, so the guard on subagent-handler's half of those writes
 * (`lib/runtime/subagent-state-guard.js`, `subagent-state-guard.test.js`) left the file exposed.
 * It now reads through the same `readStateForUpdate` and, when that answers null, writes neither
 * the state file nor the teammate roster derived from it.
 *
 * WHAT IS PINNED (the hook as a child process, on real files)
 *   - a corrupt file (truncated JSON, text, empty, `null`, an array, an `agents` that is not an
 *     object, a `tasks` or `events` that is not a list) and a healthy file whose read fails with
 *     EBUSY (a preload makes `fs.readFileSync` throw for that one path) stay byte for byte as they
 *     were across START and STOP, for every event type the script takes; exit code 0, one stderr
 *     line, no temp or lock file left;
 *   - stdout is the bytes a missing file gives for the same payload, which is what the old
 *     fail-open path printed for every case above but JSON `null` (there it died on
 *     `null.agents`, exit 0, nothing on stdout; measured 2026-10-13 against git HEAD), and the
 *     roster file of the session is not written;
 *   - the `tasks` or `events` that is not a list is a separate old defect, not that path: the hook
 *     spread it, so a string was written back as its characters and a number threw before anything
 *     was printed (exit 0, empty stdout; measured 2026-10-14 against git HEAD);
 *   - POSITIVE CONTROLS: the same hook on a healthy file adds and closes its row, keeps the other
 *     session's row and the unrelated top-level keys, and writes the roster; a missing file is
 *     created; with the preload aimed at another path the hook still writes, so "unchanged" is not
 *     an artefact of a hook that never writes.
 *
 * WHAT GREEN HERE DOES NOT PROVE
 *   - That a real scanner's sharing violation surfaces as EBUSY from `readFileSync`: the fault is
 *     injected, not measured (see the same note in subagent-state-guard.test.js).
 *   - Which hook said the stderr line. Only the part after the label is matched here; the caller's
 *     label (`hook` option) is pinned in subagent-state-guard.test.js.
 *   - That a corrupt file is replaced later: that is SessionEnd's merge
 *     (`_team-state.js#mergeSessionSnapshot`, its own suite).
 *   - The dispatcher hop. The SubagentStop dispatcher spawns this script with the host payload;
 *     here the script is run directly with a SubagentStop payload.
 *   - The in-process (mocked fs) variants: those live in workflow-status.test.js.
 *
 * @module tests/hooks/workflow-status-state-guard
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every case spawns node two to four times; a full suite run in parallel crosses the 30 s default.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'workflow-status.js');

const SID = 'sess-wf-guard';
const AGENT = 'agent-wf-guard';
const OTHER = 'agent-of-another-session';
const TYPE = 'tdd-guide';

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

const TRUNCATED = '{"agents": {"agent-of-another-session": {"active": true}}, "events": [';

const CORRUPT = [
  ['truncated JSON', TRUNCATED],
  ['text that is not JSON', 'not valid json{{{'],
  ['an empty file', ''],
  ['JSON null', 'null'],
  ['a JSON array', '[1,2]'],
  ['an agents value that is not an object', '{"agents":[],"events":[1]}'],
  ['an events value that is a string', '{"agents":{},"events":"abc"}'],
  ['a tasks value that is a number', '{"agents":{},"tasks":5}'],
];

const payload = (event, extra = {}) => ({
  session_id: SID, agent_id: AGENT, agent_type: TYPE, hook_event_name: event, cwd: os.tmpdir(), ...extra,
});
const START = payload('SubagentStart');
const STOP = payload('SubagentStop');

function makeSandbox(label) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `artibot-wf-guard-${label}-`)));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const preload = path.join(root, 'ebusy-preload.mjs');
  writeFileSync(preload, PRELOAD_SRC, 'utf-8');
  return {
    root,
    home,
    preload,
    statePath: path.join(home, '.claude', 'artibot-state.json'),
    rosterPath: path.join(home, '.claude', 'artibot', 'runtime', 'sessions', SID, 'current-teammates.json'),
  };
}

/** One firing of the hook as the host spawns it: `node workflow-status.js <event>`, payload on stdin. */
function run(sb, eventType, input, { ebusyPath } = {}) {
  const env = { ...process.env, HOME: sb.home, USERPROFILE: sb.home, ARTIBOT_HOOK_FIRED_DIRECT: 'off' };
  // The host session ids, the team name and the state-dir seam must not leak into the child.
  for (const key of [
    'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_TEAM_NAME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME',
  ]) delete env[key];
  const args = [HOOK, eventType];
  if (ebusyPath) {
    args.unshift('--import', pathToFileURL(sb.preload).href);
    env.GUARD_EBUSY_PATH = ebusyPath;
  }
  const res = spawnSync(process.execPath, args, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env,
    cwd: sb.root,
    windowsHide: true,
    timeout: 30000,
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

const seed = () => ({
  teamId: 'team-other-session',
  domain: 'general',
  startedAt: 1760000000000,
  agents: {
    [OTHER]: {
      role: 'teammate', agentType: TYPE, active: true, sessionId: 'sess-other',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  },
  tasks: [],
  events: [{ kind: 'kept' }],
});

const refusals = (stderr) => stderr.split('\n').filter((line) => line.includes('team state left untouched'));

// What a missing file makes the hook print for each payload: the dashboard of the old fail-open
// path too, since that path ran the event over the same empty skeleton.
const reference = {};
let referenceSandbox;
beforeAll(() => {
  referenceSandbox = makeSandbox('reference');
  reference.start = run(referenceSandbox, 'teammate-update', START);
  rmSync(referenceSandbox.statePath, { force: true });
  reference.stop = run(referenceSandbox, 'teammate-update', STOP);
});
afterAll(() => {
  try { rmSync(referenceSandbox.root, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('the reference runs (a missing state file)', () => {
  it('print a real dashboard for a START and an empty object for a STOP nobody started, so the parity below is not vacuous', () => {
    expect(reference.start.status).toBe(0);
    expect(JSON.parse(reference.start.stdout).message).toContain('Team: 1 members');
    expect(reference.stop.status).toBe(0);
    expect(JSON.parse(reference.stop.stdout)).toEqual({});
  });
});

describe('workflow-status over a team-state file it cannot read (child processes, real files)', () => {
  let sb;
  const bytes = () => readFileSync(sb.statePath);
  const stateNow = () => JSON.parse(readFileSync(sb.statePath, 'utf-8'));
  const leftovers = () => readdirSync(path.dirname(sb.statePath))
    .filter((name) => name.includes('.tmp.') || name.endsWith('.lock'));

  beforeEach(() => { sb = makeSandbox('case'); });
  afterEach(() => {
    try { rmSync(sb.root, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: a healthy file gets the row added and closed; the other session\'s row and the top-level keys stay', () => {
    writeFileSync(sb.statePath, JSON.stringify(seed()));

    const started = run(sb, 'teammate-update', START);
    expect(started.status).toBe(0);
    expect(started.stderr).toBe('');
    expect(JSON.parse(started.stdout).message).toContain('Team: 2 members');
    expect(stateNow().agents[AGENT]).toMatchObject({ active: true, role: TYPE, sessionId: SID });
    expect(stateNow().agents[OTHER]).toMatchObject({ active: true, sessionId: 'sess-other' });
    expect(stateNow().teamId).toBe('team-other-session');
    expect(stateNow().events[0]).toEqual({ kind: 'kept' });
    expect(stateNow().events.at(-1)).toMatchObject({ agent: AGENT, message: 'Agent updated' });
    expect(JSON.parse(readFileSync(sb.rosterPath, 'utf-8')).teammates.map((t) => t.name)).toEqual([AGENT]);

    const stopped = run(sb, 'teammate-update', STOP);
    expect(stopped.status).toBe(0);
    expect(stateNow().agents[AGENT]).toMatchObject({ active: false });
    expect(stateNow().agents[OTHER]).toMatchObject({ active: true });
    expect(stateNow().events.at(-1)).toMatchObject({ agent: AGENT, message: 'Agent stopped' });
    expect(leftovers()).toEqual([]);
  });

  it('POSITIVE CONTROL: a missing file is created by the first START and its roster is written', () => {
    expect(existsSync(sb.statePath)).toBe(false);

    const started = run(sb, 'teammate-update', START);

    expect(started.status).toBe(0);
    expect(started.stdout).toBe(reference.start.stdout);
    expect(stateNow().agents[AGENT]).toMatchObject({ active: true });
    expect(existsSync(sb.rosterPath)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it.each(CORRUPT)('leaves a state file that is %s byte for byte alone across START and STOP', (_label, text) => {
    writeFileSync(sb.statePath, text);
    const before = bytes();

    const started = run(sb, 'teammate-update', START);
    expect(started.status).toBe(0);
    expect(started.stdout).toBe(reference.start.stdout);
    expect(refusals(started.stderr)).toHaveLength(1);
    expect(bytes().equals(before)).toBe(true);

    const stopped = run(sb, 'teammate-update', STOP);
    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toBe(reference.stop.stdout);
    expect(refusals(stopped.stderr)).toHaveLength(1);
    expect(bytes().equals(before)).toBe(true);

    // A roster derived from a state nobody read would replace the real one with a partial one.
    expect(existsSync(sb.rosterPath)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ['task-complete', { task_id: '1', subject: 'x' }],
    ['task-error', { task_id: '1', error: 'boom' }],
    ['workflow-advance', { phase: 2, playbook: 'feature' }],
    ['notification', {}],
  ])('%s: a corrupt file is left alone by the other event types too', (eventType, extra) => {
    writeFileSync(sb.statePath, TRUNCATED);
    const before = bytes();

    const out = run(sb, eventType, payload('Notification', extra));

    expect(out.status).toBe(0);
    expect(refusals(out.stderr)).toHaveLength(1);
    expect(bytes().equals(before)).toBe(true);
    expect(existsSync(sb.rosterPath)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('does not echo the file text on stderr', () => {
    writeFileSync(sb.statePath, 'SECRET-TOKEN-1234 {');

    const out = run(sb, 'teammate-update', START);

    expect(refusals(out.stderr)).toHaveLength(1);
    expect(out.stderr).not.toContain('SECRET-TOKEN');
  });

  it('leaves a healthy file alone when reading it fails with EBUSY, and the next healthy event writes normally', () => {
    writeFileSync(sb.statePath, JSON.stringify(seed(), null, 2));
    const before = bytes();

    const started = run(sb, 'teammate-update', START, { ebusyPath: sb.statePath });
    expect(started.status).toBe(0);
    expect(started.stdout).toBe(reference.start.stdout);
    expect(started.stderr).toContain('team state left untouched (unreadable): EBUSY');
    expect(bytes().equals(before)).toBe(true);

    const stopped = run(sb, 'teammate-update', STOP, { ebusyPath: sb.statePath });
    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toBe(reference.stop.stdout);
    expect(bytes().equals(before)).toBe(true);
    expect(existsSync(sb.rosterPath)).toBe(false);
    expect(leftovers()).toEqual([]);

    // The contention passes: the next START registers, beside the row that was never lost.
    expect(run(sb, 'teammate-update', START).status).toBe(0);
    expect(Object.keys(stateNow().agents).sort()).toEqual([AGENT, OTHER].sort());
  });

  it('POSITIVE CONTROL: the same preload aimed at another path does not stop the write', () => {
    writeFileSync(sb.statePath, JSON.stringify(seed()));

    const started = run(sb, 'teammate-update', START, { ebusyPath: path.join(sb.root, 'elsewhere.json') });

    expect(started.status).toBe(0);
    expect(started.stderr).not.toContain('team state left untouched');
    expect(stateNow().agents[AGENT]).toMatchObject({ active: true });
    expect(stateNow().agents[OTHER]).toBeDefined();
  });
});
