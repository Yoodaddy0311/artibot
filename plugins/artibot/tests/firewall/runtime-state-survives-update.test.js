/**
 * Firewall — hook state written to the versioned plugin root is lost on every
 * plugin update and shared between concurrent sessions. (O2)
 *
 * ── what was measured, and why this gate exists ─────────────────────────────
 * 2026-09-30, the owner's machine: `~/.claude/plugins/cache/artibot/artibot/`
 * held 4.67.0, 4.68.0, 4.69.0 and 4.70.0, and EACH had its own `runtime/` with
 * its own `first-run-state.json` (3 of 4), `self-control-welcomed.marker`
 * (4 of 4) and `user-profile.json` (3 of 4: 8,959 B in 4.67.0 against 2,550 B in
 * 4.70.0 when measured; it grows with every prompt). The hook reads the plugin root
 * from `CLAUDE_PLUGIN_ROOT`, which in a
 * marketplace install is that cache directory, so every update:
 *   - re-showed the welcome banner and restarted the "first 5 runs are
 *     observe-only" counter,
 *   - discarded the learned skill level and macro suggestions,
 *   - stranded `current-teammates.json` / `token-usage-session.json` where the
 *     statusline (which reads `~/.claude/artibot/runtime/`) never looked.
 * And `current-effort.json` was ONE file per plugin root, so two sessions
 * overwrote each other (F05 bolted an identity gate onto the reader; the
 * storage was still shared).
 *
 * Where it lives now: GLOBAL state at `<state dir>/runtime/<file>`, SESSION state
 * at `<state dir>/runtime/sessions/<session_id>/<file>`, with
 * `<state dir> = resolveArtibotDir()` (`~/.claude/artibot`, redirectable in
 * tests with `ARTIBOT_STATE_DIR`). See `lib/core/runtime-state.js`.
 *
 * ── what this test drives ───────────────────────────────────────────────────
 * The REAL writers — `handleUserPromptSubmit` (effort, task budget, token usage,
 * user profile, macro observation), the `workflow-status` hook as a child
 * process (teammates), `bumpRunCounter`/`getFirstRunState`, `observePrompt`,
 * `getProfile` — under two fake marketplace cache directories
 * (`…/4.70.0`, `…/4.71.0`) and ONE shared HOME, which is the brief's "two fake
 * pluginRoots, the same HOME". Version A is deleted outright before B reads, as
 * the host does on update.
 *
 * ── what it cannot see ──────────────────────────────────────────────────────
 * - A real Claude Code session: the hook payloads here are synthesized. That the
 *   host's `SubagentStart`/`SubagentStop` `session_id` names the PARENT session was
 *   measured from the repo ledger's `hook.fired` rows (see workflow-status.js
 *   `payloadSessionId`), not from this test; the statusLine payload's `session_id`
 *   is the documented schema, not re-measured.
 * - `session-start.js` (welcome marker, long-context marker, session sweep): it
 *   is covered in `tests/hooks/session-start.test.js` with the fs mocks that file
 *   needs, because the real hook spawns an update check and a swarm probe.
 * - `statusline.sh`: `tests/hooks/statusline-runtime-state.test.js`.
 * - Writers nobody migrated (kill-switch, wakeup, next-session suggestions, …):
 *   they are listed in the O2 report, and this gate says nothing about them.
 *
 * @module tests/firewall/runtime-state-survives-update
 */

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';
import { NATIVE_EFFORT_ENV_VARS } from '../../lib/cognitive/native-effort.js';
import { resolveArtibotDir } from '../../lib/core/config.js';
import { _resetPathCache, configureProfilePath, getProfile } from '../../lib/core/user-profile.js';
import { bumpRunCounter, getFirstRunState } from '../../lib/learning/first-run-guard.js';
import { getMacroSuggestions, observePrompt } from '../../lib/learning/macro-learner.js';
import { getMemoryStatsTool } from '../../lib/mcp/tools/get-memory-stats.js';
import { readEffortRecord, readEffortSnapshot } from '../../lib/runtime/task-budget.js';
import { readDashboardState } from '../../lib/tui/dashboard.js';
import { makeVersionRoot } from '../helpers/linked-plugin-root.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_STATUS = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'workflow-status.js');

/** Everything O2 moved out of `<pluginRoot>/runtime/`. */
const MOVED_FILES = Object.freeze([
  'current-effort.json', 'current-task-budget.json', 'token-usage-session.json',
  'current-teammates.json', 'long-context-active.json',
  'user-profile.json', 'first-run-state.json', 'self-control-welcomed.marker',
  'macro-suggestions.json', 'memory-metrics.json',
]);

// Several cases run a full UserPromptSubmit in-process and spawn node for the roster hook;
// on a busy machine that alone crosses the 30 s default (measured: 38 s under a full CI run).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME', 'ARTIBOT_USER_PROFILE_PATH',
  'CLAUDE_PLUGIN_ROOT', 'ARTIBOT_RUNTIME_CHECKPOINT_DISABLE', 'ARTIBOT_RUNTIME_MEMORY_DISABLE',
  // The host's own effort band outranks the heuristic one (runtime-prompt.js#resolveEffortMeta),
  // so a developer shell that exports CLAUDE_EFFORT=max would make every prompt below read
  // `max` and "two sessions keep DIFFERENT efforts" could not be told from "one slot".
  ...NATIVE_EFFORT_ENV_VARS,
];

let base;
let home;
let project;
let savedEnv;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-o2-'));
  home = path.join(base, 'home');
  project = path.join(base, 'project');
  mkdirSync(home, { recursive: true });
  // The `.git` marker pins the sandbox as its own project root, so the decision store
  // and the ledger the hook also writes land here, not in this repository.
  mkdirSync(path.join(project, '.git'), { recursive: true });

  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  // PRODUCTION-LIKE: no ARTIBOT_STATE_DIR override, so the state dir is derived from HOME.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ARTIBOT_STATE_DIR;
  delete process.env.ARTIBOT_STATE_DIR_HOME;
  delete process.env.ARTIBOT_USER_PROFILE_PATH;
  for (const name of NATIVE_EFFORT_ENV_VARS) delete process.env[name];
  process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
  process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
  _resetPathCache();
});

afterEach(() => {
  _resetPathCache();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

const stateDir = () => resolveArtibotDir();
const sessionFile = (sid, name) => path.join(stateDir(), 'runtime', 'sessions', sid, name);
const flatFile = (name) => path.join(stateDir(), 'runtime', name);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** One UserPromptSubmit exactly as the host delivers it, run under plugin root `root`. */
async function prompt(root, sessionId, text, promptId) {
  process.env.CLAUDE_PLUGIN_ROOT = root;
  const payload = { hook_event_name: 'UserPromptSubmit', prompt: text, cwd: project };
  if (sessionId !== null) payload.session_id = sessionId;
  if (promptId) payload.prompt_id = promptId;
  const out = await handleUserPromptSubmit(payload);
  expect(out).not.toBeNull();
  return out;
}

/** One SubagentStart/Stop roster update, as the spawned hook process. */
function teammateUpdate(sessionId, agentId, task) {
  const payload = { agent_id: agentId, current_task: task, cwd: project };
  if (sessionId !== null) payload.session_id = sessionId;
  const r = spawnSync(process.execPath, [WORKFLOW_STATUS, 'teammate-update'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env },
  });
  expect(r.status, r.stderr).toBe(0);
}

function pluginRootLeftovers(root) {
  const left = MOVED_FILES.filter((name) => existsSync(path.join(root, 'runtime', name)));
  if (existsSync(path.join(root, 'runtime', 'effort'))) left.push('effort/');
  if (existsSync(path.join(root, 'runtime', 'sessions'))) left.push('sessions/');
  return left;
}

function seed(root, rel, content, mtimeMs) {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    utimesSync(file, t, t);
  }
  return file;
}

describe('sandbox', () => {
  it('carries the linked modules, so "nothing written to the plugin root" is not vacuous', () => {
    // NEGATIVE CONTROL. Without the links every dynamic import in the hook falls into its
    // catch block, nothing is written anywhere, and the leftovers check below would pass.
    const root = makeVersionRoot(base, '4.70.0');
    expect(existsSync(path.join(root, 'lib', 'runtime', 'task-budget.js'))).toBe(true);
    expect(existsSync(path.join(root, 'lib', 'core', 'runtime-state.js'))).toBe(true);
    expect(existsSync(path.join(root, 'artibot.config.json'))).toBe(true);
    // and the state dir really is HOME-derived, not the per-worker test default.
    expect(stateDir()).toBe(path.join(home, '.claude', 'artibot'));
  });
});

describe('O2 — hook state outlives a plugin update', () => {
  it('session state written under version A is still readable after A is replaced by B', async () => {
    const a = makeVersionRoot(base, '4.70.0');
    const b = makeVersionRoot(base, '4.71.0');

    await prompt(a, 'sess-A', '/implement add oauth login', 'p-1');

    for (const name of ['current-effort.json', 'current-task-budget.json', 'token-usage-session.json']) {
      expect(existsSync(sessionFile('sess-A', name)), `${name} under the state dir`).toBe(true);
    }
    expect(pluginRootLeftovers(a)).toEqual([]);

    // The host replaces the cache directory on update.
    rmSync(a, { recursive: true, force: true });
    process.env.CLAUDE_PLUGIN_ROOT = b;

    expect(readEffortRecord(b, { sessionId: 'sess-A', promptId: 'p-1' })).toMatchObject({
      command: 'implement', sessionId: 'sess-A', promptId: 'p-1',
    });
    const snapshot = readEffortSnapshot(b, { sessionId: 'sess-A', promptId: 'p-1' });
    expect(snapshot).toMatchObject({ command: 'implement' });
    expect(snapshot.taskBudget).toBeGreaterThan(0);
  });

  it('global state — user profile, first-run counter, macro observations — survives the same update', async () => {
    const a = makeVersionRoot(base, '4.70.0');
    const b = makeVersionRoot(base, '4.71.0');

    // Version A: a real prompt (records a profile signal) + three self-control runs + one macro observation.
    await prompt(a, 'sess-A', 'explain the plan please', 'p-1');
    process.env.CLAUDE_PLUGIN_ROOT = a;
    for (let i = 0; i < 3; i += 1) await bumpRunCounter('autoCommit', {});
    await observePrompt('security check then run the tests and build', { pluginRoot: a, config: {} });

    expect(existsSync(flatFile('user-profile.json'))).toBe(true);
    expect(existsSync(flatFile('first-run-state.json'))).toBe(true);
    expect(existsSync(flatFile('macro-suggestions.json'))).toBe(true);
    expect(pluginRootLeftovers(a)).toEqual([]);

    rmSync(a, { recursive: true, force: true });
    process.env.CLAUDE_PLUGIN_ROOT = b;

    // Version B, a fresh process: the hook re-applies config.ux.profilePath on every prompt.
    _resetPathCache();
    configureProfilePath('runtime/user-profile.json');
    const profile = await getProfile();
    expect(profile.evidence.join(' ')).toMatch(/insufficient signals \(1\/10\)/);
    expect((await getFirstRunState({})).runsSoFar).toBe(3);
    expect(await getMacroSuggestions(b, {})).toEqual([]); // observed once: below minOccurrences, but the store is READ, not reset
    expect(readJson(flatFile('macro-suggestions.json')).observations).toBeTypeOf('object');
    expect(Object.keys(readJson(flatFile('macro-suggestions.json')).observations)).toHaveLength(1);
  });

  it('a prompt run under version B does not create runtime/ state in the plugin root either', async () => {
    const b = makeVersionRoot(base, '4.71.0');
    await prompt(b, 'sess-B', '/plan the migration', 'p-1');
    expect(pluginRootLeftovers(b)).toEqual([]);
  });
});

describe('O2 — concurrent sessions do not mix', () => {
  it('two sessions keep separate effort, task-budget and token-usage files', async () => {
    const root = makeVersionRoot(base, '4.70.0');

    await prompt(root, 'sess-A', '/implement add oauth login', 'a-1');
    await prompt(root, 'sess-B', '/daily', 'b-1');
    await prompt(root, 'sess-A', 'and add the tests too', 'a-2');

    const a = readJson(sessionFile('sess-A', 'current-effort.json'));
    const b = readJson(sessionFile('sess-B', 'current-effort.json'));
    // B's prompt did not clobber A's record (the pre-O2 bug: one file per plugin root).
    expect(a).toMatchObject({ command: 'implement', sessionId: 'sess-A' });
    expect(b).toMatchObject({ command: 'daily', sessionId: 'sess-B' });
    expect(a.effort).not.toBe(b.effort);

    expect(readJson(sessionFile('sess-A', 'current-task-budget.json')).command).toBe('implement');
    expect(readJson(sessionFile('sess-B', 'current-task-budget.json')).command).toBe('daily');
    for (const sid of ['sess-A', 'sess-B']) {
      expect(readJson(sessionFile(sid, 'token-usage-session.json')).totalTokens).toBeGreaterThan(0);
    }

    // and each session's reader gets its own record back.
    expect(readEffortRecord(root, { sessionId: 'sess-A', promptId: 'a-1' })?.command).toBe('implement');
    expect(readEffortRecord(root, { sessionId: 'sess-B', promptId: 'b-1' })?.command).toBe('daily');
    expect(existsSync(flatFile('current-effort.json'))).toBe(false);
  });

  it('two sessions keep separate teammate rosters although the workflow state is one shared file', () => {
    teammateUpdate('sess-A', 'alpha', 'planning');
    teammateUpdate('sess-B', 'beta', 'building');
    teammateUpdate('sess-A', 'gamma', 'reviewing');

    const namesOf = (sid) => readJson(sessionFile(sid, 'current-teammates.json')).teammates.map((t) => t.name).sort();
    expect(namesOf('sess-A')).toEqual(['alpha', 'gamma']);
    expect(namesOf('sess-B')).toEqual(['beta']);
    expect(existsSync(flatFile('current-teammates.json'))).toBe(false);
  });

  it('a payload with no session id falls back to the flat file in the STATE dir, never the plugin root', async () => {
    const root = makeVersionRoot(base, '4.70.0');
    await prompt(root, null, '/implement add oauth login');
    teammateUpdate(null, 'solo', 'working');

    expect(readJson(flatFile('current-effort.json')).command).toBe('implement');
    expect(readJson(flatFile('token-usage-session.json')).totalTokens).toBeGreaterThan(0);
    expect(readJson(flatFile('current-teammates.json')).teammates.map((t) => t.name)).toEqual(['solo']);
    expect(pluginRootLeftovers(root)).toEqual([]);
  });
});

describe('O2 — legacy state is migrated once (copy-if-absent)', () => {
  const T = Date.parse('2026-09-30T00:00:00.000Z');

  function seedPreviousVersion(root) {
    seed(root, 'runtime/first-run-state.json', JSON.stringify({ globalRuns: 3, features: {}, transitions: [] }), T);
    seed(root, 'runtime/self-control-welcomed.marker', '2026-09-28T12:49:00.000Z\n', T);
    seed(root, 'runtime/user-profile.json', JSON.stringify({
      skillLevel: 'novice',
      source: 'initial',
      signals: Array.from({ length: 8 }, (_, i) => ({ type: 'slash-command', value: `plan ${i}`, timestamp: T + i })),
      evidence: [],
      updatedAt: new Date(T).toISOString(),
    }), T);
    seed(root, 'runtime/macro-suggestions.json', JSON.stringify({
      suggestions: [{ id: 'macro-1', status: 'pending', pattern: { fingerprint: 'test>build' } }],
      observations: {},
    }), T);
    seed(root, 'runtime/memory-metrics.json', JSON.stringify({
      date: '2026-09-29',
      working: { hits: 3, queries: 4, rate: 0.75 },
      episodic: { hits: 0, queries: 0, rate: 0 },
      semantic: { hits: 0, queries: 0, rate: 0 },
    }), T);
  }

  it('picks up what the PREVIOUS version wrote, which sits next to the running one in the cache', async () => {
    const previous = makeVersionRoot(base, '4.70.0');
    const running = makeVersionRoot(base, '4.71.0');
    seedPreviousVersion(previous);
    process.env.CLAUDE_PLUGIN_ROOT = running;

    expect((await getFirstRunState({})).runsSoFar).toBe(3);

    _resetPathCache();
    configureProfilePath('runtime/user-profile.json');
    expect((await getProfile()).evidence.join(' ')).toMatch(/\(8\/10\)/);

    const suggestions = await getMacroSuggestions(running, {});
    expect(suggestions.map((s) => s.id)).toEqual(['macro-1']);

    const stats = JSON.parse((await getMemoryStatsTool.handler({})).content[0].text);
    expect(stats.present).toBe(true);
    expect(stats.layers.working.hits).toBe(3);
    expect(stats.metricsPath).toBe(flatFile('memory-metrics.json'));

    for (const name of ['first-run-state.json', 'user-profile.json', 'macro-suggestions.json', 'memory-metrics.json']) {
      expect(existsSync(flatFile(name)), `${name} copied to the state dir`).toBe(true);
    }
    // a COPY: the previous version's files are left in place.
    expect(existsSync(path.join(previous, 'runtime', 'first-run-state.json'))).toBe(true);
  });

  it('never overwrites state that is already at the new location', async () => {
    const previous = makeVersionRoot(base, '4.70.0');
    const running = makeVersionRoot(base, '4.71.0');
    seedPreviousVersion(previous);
    seed(stateDir(), 'runtime/first-run-state.json', JSON.stringify({ globalRuns: 4, features: {}, transitions: [] }));
    process.env.CLAUDE_PLUGIN_ROOT = running;

    expect((await getFirstRunState({})).runsSoFar).toBe(4);
    expect(readJson(flatFile('first-run-state.json')).globalRuns).toBe(4);
  });

  it('keeps counting from the migrated value (no restart at zero)', async () => {
    const previous = makeVersionRoot(base, '4.70.0');
    const running = makeVersionRoot(base, '4.71.0');
    seedPreviousVersion(previous);
    process.env.CLAUDE_PLUGIN_ROOT = running;

    const next = await bumpRunCounter('autoCommit', {});

    expect(next.runsSoFar).toBe(4);
    expect(readJson(flatFile('first-run-state.json')).globalRuns).toBe(4);
  });
});

describe('O2 — readers agree with writers', () => {
  it('the dashboard reads exactly what the hook wrote, per session', async () => {
    const root = makeVersionRoot(base, '4.70.0');
    await prompt(root, 'sess-A', '/implement add oauth login', 'a-1');
    await prompt(root, 'sess-B', '/daily', 'b-1');
    teammateUpdate('sess-A', 'alpha', 'planning');
    teammateUpdate('sess-B', 'beta', 'building');

    const forA = await readDashboardState(root, { sessionId: 'sess-A' });
    const forB = await readDashboardState(root, { sessionId: 'sess-B' });

    expect(forA.command).toBe('implement');
    expect(forB.command).toBe('daily');
    expect(forA.effort).not.toBe(forB.effort);
    expect(forA.teammates.map((t) => t.name)).toEqual(['alpha']);
    expect(forB.teammates.map((t) => t.name)).toEqual(['beta']);
    expect(forA.tokens.used).toBeGreaterThan(0);
    // a session that never wrote anything sees NOBODY else's state.
    const stranger = await readDashboardState(root, { sessionId: 'sess-C' });
    expect(stranger.command).toBeNull();
    expect(stranger.teammates).toEqual([]);
  });
});
