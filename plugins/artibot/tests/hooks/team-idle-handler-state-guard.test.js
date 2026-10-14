/**
 * team-idle-handler.js must not write over a team-state file it could not read.
 *
 * `~/.claude/artibot-state.json` is shared by every live session. team-idle-handler.js read it
 * with `existsSync` + `JSON.parse` inside a try that ignored every failure, kept `{}` when the
 * read failed or the text was not JSON, and then wrote that `{}` (plus the payload key record)
 * back under the lock on EVERY TeammateIdle and TaskCompleted firing: one failed read (EBUSY or
 * EPERM from a scanner, say, on Windows) replaced every agent, event and task row with nothing.
 * It now reads through `readStateForUpdate` (`lib/runtime/subagent-state-guard.js`, the guard
 * subagent-handler and workflow-status use) and writes nothing when that answers null. What the
 * hook prints does not depend on the write, so stdout is unchanged.
 *
 * WHAT IS PINNED (the hook as a child process, on real files)
 *   - a corrupt file (truncated JSON, text, empty, `null`, an array, an `agents` that is not an
 *     object) and a healthy file whose read fails with EBUSY (a preload makes `fs.readFileSync`
 *     throw for that one path) stay byte for byte as they were, for a payload that carries an
 *     `agent_id` and for one that does not (the one that adds the key record); exit code 0, one
 *     stderr line, no temp or lock file left;
 *   - stdout is the bytes a missing file gives for the same payload;
 *   - POSITIVE CONTROLS: the same hook on a healthy file keeps every other row and records the
 *     key names of a payload with no `agent_id`, and reports pending tasks it can read; a missing
 *     file is created; with the preload aimed at another path the hook still writes, so
 *     "unchanged" is not an artefact of a hook that never writes;
 *   - a config that still carries the removed `team.autoStopIdle` (with `maxIdleCount`) changes
 *     neither the message nor the state: no `stop` in the output, no `idleCounts` written. The
 *     config is planted through CLAUDE_PLUGIN_ROOT.
 *
 * WHAT GREEN HERE DOES NOT PROVE
 *   - That a real scanner's sharing violation surfaces as EBUSY from `readFileSync`: the fault is
 *     injected, not measured (see the same note in subagent-state-guard.test.js).
 *   - Which hook said the stderr line. Only the part after the label is matched here; the caller's
 *     label (`hook` option) is pinned in subagent-state-guard.test.js.
 *   - That a corrupt file is replaced later: that is SessionEnd's merge
 *     (`_team-state.js#mergeSessionSnapshot`, its own suite).
 *
 * @module tests/hooks/team-idle-handler-state-guard
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
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'team-idle-handler.js');

const SID = 'sess-idle-guard';
const AGENT = 'agent-idle-guard';
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
];

// The documented TeammateIdle shape, and the one this repo's own fixture carries (no `agent_id`).
const WITH_ID = {
  hook_event_name: 'TeammateIdle', session_id: SID, agent_id: AGENT, agent_type: TYPE, cwd: os.tmpdir(),
};
const WITHOUT_ID = {
  hook_event_name: 'TeammateIdle', session_id: SID, teammate_name: 'mate-guard', team_name: 'team-guard', cwd: os.tmpdir(),
};

function makeSandbox(label) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `artibot-idle-guard-${label}-`)));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const preload = path.join(root, 'ebusy-preload.mjs');
  writeFileSync(preload, PRELOAD_SRC, 'utf-8');
  return { root, home, preload, statePath: path.join(home, '.claude', 'artibot-state.json') };
}

/** One firing of the hook as the host spawns it: `node team-idle-handler.js`, payload on stdin. */
function run(sb, input, { ebusyPath, pluginRoot } = {}) {
  const env = { ...process.env, HOME: sb.home, USERPROFILE: sb.home, ARTIBOT_HOOK_FIRED_DIRECT: 'off' };
  // The host session ids and the state-dir seam must not leak into the child.
  for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME']) {
    delete env[key];
  }
  // Where the plugin config is read from, for the one case that plants a config.
  if (pluginRoot) env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  const args = [HOOK];
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

const seed = (tasks = []) => ({
  teamId: 'team-other-session',
  domain: 'general',
  startedAt: 1760000000000,
  agents: { [OTHER]: { role: 'teammate', agentType: TYPE, active: true, startedAt: new Date().toISOString() } },
  tasks,
  events: [{ kind: 'kept' }],
});

const refusals = (stderr) => stderr.split('\n').filter((line) => line.includes('team state left untouched'));

// What a missing file makes the hook print for each payload; the old fail-open path printed the same
// (it ran over an empty `{}`), so equality with these is "stdout unchanged".
const reference = {};
let referenceSandbox;
beforeAll(() => {
  referenceSandbox = makeSandbox('reference');
  reference.withId = run(referenceSandbox, WITH_ID);
  rmSync(referenceSandbox.statePath, { force: true });
  reference.withoutId = run(referenceSandbox, WITHOUT_ID);
});
afterAll(() => {
  try { rmSync(referenceSandbox.root, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('the reference runs (a missing state file)', () => {
  it('print the idle message, so the parity below is not vacuous', () => {
    expect(reference.withId.status).toBe(0);
    expect(JSON.parse(reference.withId.stdout).message)
      .toBe(`[team] Teammate idle: ${AGENT} (${TYPE}) | No pending tasks. | Ready for new work.`);
    expect(reference.withoutId.status).toBe(0);
    expect(JSON.parse(reference.withoutId.stdout).message)
      .toBe('[team] Teammate idle: mate-guard | No pending tasks. | Ready for new work.');
  });
});

describe('team-idle-handler over a team-state file it cannot read (child processes, real files)', () => {
  let sb;
  const bytes = () => readFileSync(sb.statePath);
  const stateNow = () => JSON.parse(readFileSync(sb.statePath, 'utf-8'));
  const leftovers = () => readdirSync(path.dirname(sb.statePath))
    .filter((name) => name.includes('.tmp.') || name.endsWith('.lock'));

  beforeEach(() => { sb = makeSandbox('case'); });
  afterEach(() => {
    try { rmSync(sb.root, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: a healthy file keeps every other row, and the pending tasks it can read are reported', () => {
    const seeded = seed([{ id: 't1', status: 'pending' }, { id: 't2', status: 'completed' }]);
    writeFileSync(sb.statePath, JSON.stringify(seeded));

    const out = run(sb, WITH_ID);

    expect(out.status).toBe(0);
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout).message)
      .toBe(`[team] Teammate idle: ${AGENT} (${TYPE}) | 1 pending task(s) available for assignment.`);
    expect(stateNow()).toEqual(seeded);
    expect(leftovers()).toEqual([]);
  });

  it('POSITIVE CONTROL: a payload with no agent_id gets its key names recorded beside the rows that were there', () => {
    writeFileSync(sb.statePath, JSON.stringify(seed()));

    const out = run(sb, WITHOUT_ID);

    expect(out.status).toBe(0);
    expect(out.stdout).toBe(reference.withoutId.stdout);
    expect(stateNow().idlePayloadWithoutAgentId.keys).toEqual(Object.keys(WITHOUT_ID).sort());
    expect(stateNow().agents[OTHER]).toMatchObject({ active: true });
    expect(stateNow().teamId).toBe('team-other-session');
    expect(stateNow().events).toEqual([{ kind: 'kept' }]);
  });

  it('POSITIVE CONTROL: a missing file is created, not refused', () => {
    expect(existsSync(sb.statePath)).toBe(false);

    const out = run(sb, WITHOUT_ID);

    expect(out.status).toBe(0);
    expect(out.stdout).toBe(reference.withoutId.stdout);
    expect(out.stderr).toBe('');
    expect(stateNow().idlePayloadWithoutAgentId.keys).toEqual(Object.keys(WITHOUT_ID).sort());
    expect(leftovers()).toEqual([]);
  });

  it.each(CORRUPT)('leaves a state file that is %s byte for byte alone', (_label, text) => {
    writeFileSync(sb.statePath, text);
    const before = bytes();

    const out = run(sb, WITH_ID);

    expect(out.status).toBe(0);
    expect(out.stdout).toBe(reference.withId.stdout);
    expect(refusals(out.stderr)).toHaveLength(1);
    expect(bytes().equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  // The payload with no agent_id is the one that adds a key to whatever it writes, and the one a
  // JSON array or object would have been rebuilt around.
  it.each([
    ['truncated JSON', TRUNCATED],
    ['JSON null', 'null'],
    ['a JSON array', '[1,2]'],
  ])('leaves a state file that is %s alone for a payload with no agent_id too', (_label, text) => {
    writeFileSync(sb.statePath, text);
    const before = bytes();

    const out = run(sb, WITHOUT_ID);

    expect(out.status).toBe(0);
    expect(out.stdout).toBe(reference.withoutId.stdout);
    expect(refusals(out.stderr)).toHaveLength(1);
    expect(bytes().equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('does not echo the file text on stderr', () => {
    writeFileSync(sb.statePath, 'SECRET-TOKEN-1234 {');

    const out = run(sb, WITH_ID);

    expect(refusals(out.stderr)).toHaveLength(1);
    expect(out.stderr).not.toContain('SECRET-TOKEN');
  });

  it('leaves a healthy file alone when reading it fails with EBUSY, and the next healthy firing writes normally', () => {
    writeFileSync(sb.statePath, JSON.stringify(seed([{ id: 't1', status: 'pending' }]), null, 2));
    const before = bytes();

    const first = run(sb, WITHOUT_ID, { ebusyPath: sb.statePath });
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(reference.withoutId.stdout);
    expect(first.stderr).toContain('team state left untouched (unreadable): EBUSY');
    expect(bytes().equals(before)).toBe(true);

    const second = run(sb, WITH_ID, { ebusyPath: sb.statePath });
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(reference.withId.stdout);
    expect(bytes().equals(before)).toBe(true);
    expect(leftovers()).toEqual([]);

    // The contention passes: the next firing reads the tasks again and the rows are all still there.
    const third = run(sb, WITHOUT_ID);
    expect(third.status).toBe(0);
    expect(JSON.parse(third.stdout).message).toContain('1 pending task(s)');
    expect(stateNow().agents[OTHER]).toMatchObject({ active: true });
    expect(stateNow().tasks).toEqual([{ id: 't1', status: 'pending' }]);
  });

  it('POSITIVE CONTROL: the same preload aimed at another path does not stop the write', () => {
    writeFileSync(sb.statePath, JSON.stringify(seed()));

    const out = run(sb, WITHOUT_ID, { ebusyPath: path.join(sb.root, 'elsewhere.json') });

    expect(out.status).toBe(0);
    expect(out.stderr).not.toContain('team state left untouched');
    expect(stateNow().idlePayloadWithoutAgentId.keys).toEqual(Object.keys(WITHOUT_ID).sort());
    expect(stateNow().agents[OTHER]).toBeDefined();
  });
});

describe('team-idle-handler and the removed team.autoStopIdle option (child process, real files)', () => {
  let sb;
  beforeEach(() => { sb = makeSandbox('autostop'); });
  afterEach(() => {
    try { rmSync(sb.root, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // `stop: true` is not a TeammateIdle output field the host documents, so the option could only
  // change the message. It is gone; a config that still carries it must change nothing. The code
  // that had the option printed `stop: true` for exactly this config, which is how this case is
  // known to reach the config at all.
  it('ignores a leftover team.autoStopIdle: same message, no stop, no idle counter written', () => {
    writeFileSync(sb.statePath, JSON.stringify(seed()));
    const pluginRoot = path.join(sb.root, 'plugin');
    mkdirSync(pluginRoot);
    writeFileSync(
      path.join(pluginRoot, 'artibot.config.json'),
      JSON.stringify({ team: { autoStopIdle: true, maxIdleCount: 1 } }),
    );

    const out = run(sb, WITH_ID, { pluginRoot });

    expect(out.status).toBe(0);
    expect(out.stdout).toBe(reference.withId.stdout);
    expect(JSON.parse(out.stdout)).not.toHaveProperty('stop');
    expect(JSON.parse(readFileSync(sb.statePath, 'utf-8')).idleCounts).toBeUndefined();
  });
});
