/**
 * Tests for lib/tui/dashboard.js — statusline + full dashboard rendering
 * backed by runtime/*.json state files.
 *
 * @module tests/tui/dashboard
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readDashboardState as readDashboardStateRaw,
  renderFullDashboard as renderFullDashboardRaw,
  renderStatusLine as renderStatusLineRaw,
} from '../../lib/tui/dashboard.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// O2: a reader that knows its session reads THAT session's files and nothing else, and
// the state lives under the state dir, not the plugin root. The pre-O2 suites below were
// written for one flat state under the plugin root; each of them now runs as ONE session,
// `FIXTURE_SID`, against a fresh state dir. The O2 suite further down uses the `…Raw`
// functions and passes its session ids itself.
const FIXTURE_SID = 'dash-fixture';

let fixtureStateDir = null;
let restoreFixtureState = null;

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'artibot-dashboard-'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fixtureStateDir = mkdtempSync(path.join(tmpdir(), 'artibot-dashboard-state-'));
  restoreFixtureState = pointStateDirAt(fixtureStateDir);
  return root;
}

function cleanupFixture(root) {
  if (restoreFixtureState) restoreFixtureState();
  restoreFixtureState = null;
  if (fixtureStateDir) rmSync(fixtureStateDir, { recursive: true, force: true });
  fixtureStateDir = null;
  if (root) rmSync(root, { recursive: true, force: true });
}

/** The fixture session's own state file (the plugin root is not where hooks write any more). */
function fixtureSessionFile(name) {
  const dir = path.join(fixtureStateDir, 'runtime', 'sessions', FIXTURE_SID);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function writeRuntime(_root, name, data) {
  writeFileSync(fixtureSessionFile(name), JSON.stringify(data));
}

/** A file at the pre-O2 location: `<pluginRoot>/runtime/`. */
function writeLegacy(root, name, data) {
  writeFileSync(path.join(root, 'runtime', name), JSON.stringify(data));
}

const readDashboardState = (root, opts = {}) => readDashboardStateRaw(root, { sessionId: FIXTURE_SID, ...opts });
const renderStatusLine = (args = {}) => renderStatusLineRaw({ sessionId: FIXTURE_SID, ...args });
const renderFullDashboard = (args = {}) => renderFullDashboardRaw({ sessionId: FIXTURE_SID, ...args });

const ENABLED = {
  dashboard: {
    enabled: true,
    showTeammates: true,
    showEffort: true,
    showTaskBudget: true,
  },
};

// ---------------------------------------------------------------------------
// Environment pinning (TTY + color)
// ---------------------------------------------------------------------------

const originalIsTTY = process.stdout.isTTY;
const originalNoColor = process.env.NO_COLOR;
const originalForceColor = process.env.FORCE_COLOR;

function disableColor() {
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
}

function restoreColor() {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
  });
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = originalForceColor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderStatusLine', () => {
  let root;

  beforeEach(() => {
    root = makeFixture();
    disableColor();
  });

  afterEach(() => {
    restoreColor();
    cleanupFixture(root);
  });

  it('returns empty string when dashboard.enabled is false', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'high', command: '/implement' });
    const out = await renderStatusLine({
      pluginRoot: root,
      config: { dashboard: { enabled: false } },
    });
    expect(out).toBe('');
  });

  it('returns empty string when config.dashboard is missing entirely', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'high', command: '/implement' });
    const out = await renderStatusLine({ pluginRoot: root, config: {} });
    expect(out).toBe('');
  });

  it('renders a full line when all runtime files exist', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'xhigh', command: '/implement' });
    writeRuntime(root, 'current-task-budget.json', {
      command: '/implement',
      effort: 'xhigh',
      budget: 128000,
    });
    writeRuntime(root, 'token-usage-session.json', { totalTokens: 45000 });
    writeRuntime(root, 'long-context-active.json', { enabled: true });

    const out = await renderStatusLine({ pluginRoot: root, config: ENABLED });

    expect(out).toContain('[artibot]');
    expect(out).toContain('/implement');
    expect(out).toContain('effort=xhigh');
    expect(out).toContain('budget=128K');
    expect(out).toContain('tokens=45K');
    expect(out).toContain('longCtx=on');
  });

  it('gracefully omits sections when some runtime files are missing', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'medium', command: '/plan' });
    // no task-budget, no tokens, no long-context

    const out = await renderStatusLine({ pluginRoot: root, config: ENABLED });

    expect(out).toContain('[artibot]');
    expect(out).toContain('/plan');
    expect(out).toContain('effort=medium');
    expect(out).not.toContain('budget=');
    expect(out).not.toContain('tokens=');
    expect(out).not.toContain('longCtx=');
  });

  it('emits no ANSI escape sequences when stdout is not a TTY', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'high', command: '/implement' });
    writeRuntime(root, 'current-task-budget.json', {
      command: '/implement',
      effort: 'high',
      budget: 64000,
    });

    const out = await renderStatusLine({ pluginRoot: root, config: ENABLED });

    // No ESC byte anywhere in the rendered output.
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('respects showEffort=false and showTaskBudget=false flags', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'high', command: '/refactor' });
    writeRuntime(root, 'current-task-budget.json', {
      command: '/refactor',
      effort: 'high',
      budget: 64000,
    });

    const out = await renderStatusLine({
      pluginRoot: root,
      config: {
        dashboard: {
          enabled: true,
          showEffort: false,
          showTaskBudget: false,
          showTeammates: true,
        },
      },
    });

    expect(out).toContain('/refactor');
    expect(out).not.toContain('effort=');
    expect(out).not.toContain('budget=');
  });

  it('returns empty string when pluginRoot is missing', async () => {
    const out = await renderStatusLine({ pluginRoot: '', config: ENABLED });
    expect(out).toBe('');
  });

  it('surfaces overall team progress when teammates carry a progress signal', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'high', command: '/team' });
    writeRuntime(root, 'current-teammates.json', {
      teammates: [
        { name: 'w1', progress: 100 },
        { name: 'w2', progress: 50 },
      ],
    });
    const out = await renderStatusLine({ pluginRoot: root, config: ENABLED });
    expect(out).toContain('team=');
    expect(out).toContain('prog=75%');
  });

  it('omits the progress field when no teammate carries a progress signal', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'high', command: '/team' });
    writeRuntime(root, 'current-teammates.json', {
      teammates: [{ name: 'w1' }, { name: 'w2' }],
    });
    const out = await renderStatusLine({ pluginRoot: root, config: ENABLED });
    expect(out).toContain('team=');
    expect(out).not.toContain('prog=');
  });

  it('does not throw when a runtime JSON file is malformed', async () => {
    writeFileSync(fixtureSessionFile('current-effort.json'), '{not valid json');
    writeRuntime(root, 'token-usage-session.json', { totalTokens: 1234 });
    const out = await renderStatusLine({ pluginRoot: root, config: ENABLED });
    // Malformed effort is simply dropped; tokens still render.
    expect(out).toContain('tokens=');
  });
});

describe('readDashboardState', () => {
  let root;
  beforeEach(() => { root = makeFixture(); });
  afterEach(() => { cleanupFixture(root); });

  it('returns empty defaults when pluginRoot is not a string', async () => {
    const state = await readDashboardState(undefined);
    expect(state.effort).toBeNull();
    expect(state.command).toBeNull();
    expect(state.taskBudget).toBeNull();
    expect(state.tokens).toEqual({ used: null, total: null });
    expect(state.longContext).toBe(false);
    expect(state.teammates).toEqual([]);
  });

  it('merges fields across multiple runtime files', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'xhigh', command: '/implement' });
    writeRuntime(root, 'current-task-budget.json', { budget: 128000, command: '/implement' });
    writeRuntime(root, 'token-usage-session.json', { totalTokens: 1500 });
    writeRuntime(root, 'long-context-active.json', { enabled: true });
    writeRuntime(root, 'current-teammates.json', {
      teammates: [{ name: 'frontend-developer' }, { name: 'backend-developer' }],
    });

    const state = await readDashboardState(root);
    expect(state.effort).toBe('xhigh');
    expect(state.command).toBe('/implement');
    expect(state.taskBudget).toBe(128000);
    expect(state.tokens.used).toBe(1500);
    expect(state.longContext).toBe(true);
    expect(state.teammates).toHaveLength(2);
  });

  it('preserves explicit teammate progress and derives it from task counts', async () => {
    writeRuntime(root, 'current-teammates.json', {
      teammates: [
        { name: 'a', progress: 80 },
        { name: 'b', tasksCompleted: 1, tasksTotal: 4 }, // → 25
        { name: 'c' }, // no signal → null
      ],
    });
    const state = await readDashboardState(root);
    expect(state.teammates[0].progress).toBe(80);
    expect(state.teammates[1].progress).toBe(25);
    expect(state.teammates[2].progress).toBeNull();
  });
});

/// O2 — the five files are SESSION-scoped. Hooks write them to
// `<state dir>/runtime/sessions/<session_id>/<file>`. A reader that knows its session
// reads THAT file and nothing else: a session with no file of its own shows nothing,
// never the flat file another session or a pre-O2 hook left (review 2026-09-30: such a
// session rendered `👥 ghost-from-other-session | ~987K tokens`). A reader with NO session
// id may take the flat effort record, and nothing else.
describe('readDashboardState — session-scoped state (O2)', () => {
  let root;
  let stateDir;

  beforeEach(() => {
    root = makeFixture(); // plugin root: its runtime/ is only the LEGACY location now
    stateDir = fixtureStateDir;
  });

  afterEach(() => {
    cleanupFixture(root);
  });

  function writeSession(sid, name, data) {
    const dir = path.join(stateDir, 'runtime', 'sessions', sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify(data));
  }

  function writeFlat(name, data) {
    mkdirSync(path.join(stateDir, 'runtime'), { recursive: true });
    writeFileSync(path.join(stateDir, 'runtime', name), JSON.stringify(data));
  }

  /** Everything another session, a session-less payload and a pre-O2 hook can leave behind. */
  function seedForeignFlatState() {
    writeFlat('current-teammates.json', { teammates: [{ name: 'ghost-from-other-session' }] });
    writeFlat('token-usage-session.json', { totalTokens: 987000 });
    writeFlat('current-task-budget.json', { command: 'ghost', budget: 64000 });
    writeFlat('long-context-active.json', { enabled: true });
    writeFlat('current-effort.json', { effort: 'low', command: 'flat' });
    writeLegacy(root, 'current-teammates.json', { teammates: [{ name: 'legacy-ghost' }] });
    writeLegacy(root, 'token-usage-session.json', { totalTokens: 555000 });
    writeLegacy(root, 'current-effort.json', { effort: 'medium', command: 'legacy' });
  }

  it('reads the reader\'s OWN session file, not the flat one and not the plugin-root one', async () => {
    writeSession('sess-A', 'current-effort.json', { effort: 'xhigh', command: 'implement' });
    writeFlat('current-effort.json', { effort: 'low', command: 'flat' });
    writeLegacy(root, 'current-effort.json', { effort: 'medium', command: 'legacy' });

    const state = await readDashboardStateRaw(root, { sessionId: 'sess-A' });

    expect(state.effort).toBe('xhigh');
    expect(state.command).toBe('implement');
  });

  it('two sessions each see only their own state — effort, budget, tokens, long-context, team', async () => {
    for (const [sid, n] of [['sess-A', 1], ['sess-B', 2]]) {
      writeSession(sid, 'current-effort.json', { effort: n === 1 ? 'max' : 'low', command: `cmd${n}` });
      writeSession(sid, 'current-task-budget.json', { command: `cmd${n}`, budget: n * 1000 });
      writeSession(sid, 'token-usage-session.json', { totalTokens: n * 100 });
      writeSession(sid, 'current-teammates.json', { teammates: [{ name: `mate${n}` }] });
    }
    writeSession('sess-A', 'long-context-active.json', { enabled: true });

    const a = await readDashboardStateRaw(root, { sessionId: 'sess-A' });
    const b = await readDashboardStateRaw(root, { sessionId: 'sess-B' });

    expect(a).toMatchObject({ effort: 'max', taskBudget: 1000, longContext: true });
    expect(a.tokens.used).toBe(100);
    expect(a.teammates.map((t) => t.name)).toEqual(['mate1']);
    expect(b).toMatchObject({ effort: 'low', taskBudget: 2000, longContext: false });
    expect(b.tokens.used).toBe(200);
    expect(b.teammates.map((t) => t.name)).toEqual(['mate2']);
  });

  it('a session with an id but no file of its own shows NOTHING — flat and legacy files never fill its gaps', async () => {
    seedForeignFlatState();

    const state = await readDashboardStateRaw(root, { sessionId: 'sess-Z' });

    expect(state.teammates).toEqual([]);
    expect(state.tokens).toEqual({ used: null, total: null });
    expect(state.taskBudget).toBeNull();
    expect(state.longContext).toBe(false);
    expect(state.effort).toBeNull();
    expect(state.command).toBeNull();
  });

  it('a session that has SOME files still gets nothing for the ones it lacks', async () => {
    writeSession('sess-A', 'current-effort.json', { effort: 'high', command: 'own' });
    writeFlat('token-usage-session.json', { totalTokens: 777 });
    writeLegacy(root, 'long-context-active.json', { enabled: true });

    const state = await readDashboardStateRaw(root, { sessionId: 'sess-A' });

    expect(state.effort).toBe('high'); // the session's
    expect(state.tokens.used).toBeNull(); // the state dir's flat file is not offered
    expect(state.longContext).toBe(false); // nor the plugin root's legacy file
  });

  it('a malformed session file blanks that field — it does not fall through to a flat file', async () => {
    const dir = path.join(stateDir, 'runtime', 'sessions', 'sess-A');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'current-effort.json'), '{not valid json');
    writeFlat('current-effort.json', { effort: 'medium', command: 'flat' });

    expect((await readDashboardStateRaw(root, { sessionId: 'sess-A' })).effort).toBeNull();
  });

  it('a reader with NO session id takes the flat EFFORT record (state dir, then plugin root) and none of the other four', async () => {
    writeSession('sess-A', 'current-effort.json', { effort: 'max', command: 'other-session' });
    seedForeignFlatState();

    for (const opts of [undefined, {}, { sessionId: '' }, { sessionId: null }, { sessionId: '...' }]) {
      const state = await readDashboardStateRaw(root, opts);
      const label = JSON.stringify(opts);
      expect(state.command, label).toBe('flat'); // never sess-A's, and the state dir outranks the plugin root
      expect(state.effort, label).toBe('low');
      expect(state.teammates, label).toEqual([]);
      expect(state.tokens, label).toEqual({ used: null, total: null });
      expect(state.taskBudget, label).toBeNull();
      expect(state.longContext, label).toBe(false);
    }

    // the plugin root's legacy effort record is the last resort
    rmSync(path.join(stateDir, 'runtime', 'current-effort.json'));
    expect((await readDashboardStateRaw(root)).effort).toBe('medium');
  });

  it('a hostile session id is sanitized to a safe id and reads only that id\'s own file', async () => {
    writeFlat('current-effort.json', { effort: 'low', command: 'flat' });
    mkdirSync(path.join(stateDir, 'evil'), { recursive: true });
    writeFileSync(path.join(stateDir, 'evil', 'current-effort.json'), JSON.stringify({ effort: 'max', command: 'evil' }));

    // `sessions/../../evil` would be <state dir>/evil if the id were joined raw. Sanitized it
    // is the session `evil`, which has no file: not the decoy, and not the flat file either.
    const state = await readDashboardStateRaw(root, { sessionId: '../../evil' });

    expect(state.command).toBeNull();
    expect(state.effort).toBeNull();
  });

  it('renderStatusLine and renderFullDashboard render the session they are given', async () => {
    disableColor();
    try {
      writeSession('sess-A', 'current-effort.json', { effort: 'xhigh', command: 'implement' });
      writeSession('sess-B', 'current-effort.json', { effort: 'low', command: 'daily' });

      const a = await renderStatusLineRaw({ pluginRoot: root, config: ENABLED, sessionId: 'sess-A' });
      const b = await renderStatusLineRaw({ pluginRoot: root, config: ENABLED, sessionId: 'sess-B' });
      const full = await renderFullDashboardRaw({ pluginRoot: root, config: ENABLED, sessionId: 'sess-B' });

      expect(a).toContain('effort=xhigh');
      expect(b).toContain('effort=low');
      expect(b).not.toContain('xhigh');
      expect(full).toContain('daily');
    } finally {
      restoreColor();
    }
  });

  it('renderStatusLine shows no foreign team or tokens for a session that has none of its own', async () => {
    disableColor();
    try {
      writeSession('sess-B', 'current-effort.json', { effort: 'low', command: 'daily' });
      seedForeignFlatState();

      const line = await renderStatusLineRaw({ pluginRoot: root, config: ENABLED, sessionId: 'sess-B' });

      expect(line).toContain('effort=low');
      expect(line).not.toContain('ghost');
      expect(line).not.toContain('tokens=');
      expect(line).not.toContain('team=');
      expect(line).not.toContain('longCtx=');
    } finally {
      restoreColor();
    }
  });
});

describe('renderFullDashboard', () => {
  let root;

  beforeEach(() => {
    root = makeFixture();
    disableColor();
  });

  afterEach(() => {
    restoreColor();
    cleanupFixture(root);
  });

  it('returns empty string when disabled', async () => {
    const out = await renderFullDashboard({
      pluginRoot: root,
      config: { dashboard: { enabled: false } },
    });
    expect(out).toBe('');
  });

  it('renders a multi-line dashboard when enabled', async () => {
    writeRuntime(root, 'current-effort.json', { effort: 'high', command: '/plan' });
    writeRuntime(root, 'token-usage-session.json', { totalTokens: 3200 });

    const out = await renderFullDashboard({ pluginRoot: root, config: ENABLED });

    expect(out).toContain('Artibot Dashboard');
    expect(out).toContain('command');
    expect(out).toContain('/plan');
    expect(out).toContain('effort');
    expect(out).toContain('tokens');
    expect(out.split('\n').length).toBeGreaterThan(3);
  });
});
