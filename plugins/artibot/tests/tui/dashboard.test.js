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
  readDashboardState,
  renderFullDashboard,
  renderStatusLine,
} from '../../lib/tui/dashboard.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'artibot-dashboard-'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  return root;
}

function writeRuntime(root, name, data) {
  writeFileSync(path.join(root, 'runtime', name), JSON.stringify(data));
}

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
    if (root) rmSync(root, { recursive: true, force: true });
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
    writeFileSync(path.join(root, 'runtime', 'current-effort.json'), '{not valid json');
    writeRuntime(root, 'token-usage-session.json', { totalTokens: 1234 });
    const out = await renderStatusLine({ pluginRoot: root, config: ENABLED });
    // Malformed effort is simply dropped; tokens still render.
    expect(out).toContain('tokens=');
  });
});

describe('readDashboardState', () => {
  let root;
  beforeEach(() => { root = makeFixture(); });
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

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

// O2 — the five files are SESSION-scoped. Hooks write them to
// `<state dir>/runtime/sessions/<session_id>/<file>`; a reader that knows its session
// reads that first, then the flat file in the state dir, then the flat file under
// `pluginRoot` (where hooks wrote before O2 — every fixture above is that shape).
describe('readDashboardState — session-scoped state (O2)', () => {
  let root;
  let stateDir;
  let restoreState;

  beforeEach(() => {
    root = makeFixture(); // plugin root: its runtime/ is only the LEGACY location now
    stateDir = mkdtempSync(path.join(tmpdir(), 'artibot-dashboard-state-'));
    restoreState = pointStateDirAt(stateDir);
  });

  afterEach(() => {
    restoreState();
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
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

  it('reads the reader\'s OWN session file, not the flat one and not the plugin-root one', async () => {
    writeSession('sess-A', 'current-effort.json', { effort: 'xhigh', command: 'implement' });
    writeFlat('current-effort.json', { effort: 'low', command: 'flat' });
    writeRuntime(root, 'current-effort.json', { effort: 'medium', command: 'legacy' });

    const state = await readDashboardState(root, { sessionId: 'sess-A' });

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

    const a = await readDashboardState(root, { sessionId: 'sess-A' });
    const b = await readDashboardState(root, { sessionId: 'sess-B' });

    expect(a).toMatchObject({ effort: 'max', taskBudget: 1000, longContext: true });
    expect(a.tokens.used).toBe(100);
    expect(a.teammates.map((t) => t.name)).toEqual(['mate1']);
    expect(b).toMatchObject({ effort: 'low', taskBudget: 2000, longContext: false });
    expect(b.tokens.used).toBe(200);
    expect(b.teammates.map((t) => t.name)).toEqual(['mate2']);
  });

  it('falls back per file: session → flat in the state dir → flat under the plugin root', async () => {
    writeSession('sess-A', 'current-effort.json', { effort: 'high', command: 'own' });
    writeFlat('token-usage-session.json', { totalTokens: 777 });
    writeRuntime(root, 'long-context-active.json', { enabled: true });

    const state = await readDashboardState(root, { sessionId: 'sess-A' });

    expect(state.effort).toBe('high'); // the session's
    expect(state.tokens.used).toBe(777); // the state dir's flat file
    expect(state.longContext).toBe(true); // the plugin root's legacy file
  });

  it('a malformed session file falls through to the next candidate instead of blanking the field', async () => {
    const dir = path.join(stateDir, 'runtime', 'sessions', 'sess-A');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'current-effort.json'), '{not valid json');
    writeFlat('current-effort.json', { effort: 'medium', command: 'flat' });

    expect((await readDashboardState(root, { sessionId: 'sess-A' })).effort).toBe('medium');
  });

  it('without a session id no session file is consulted (never another session\'s state as its own)', async () => {
    writeSession('sess-A', 'current-effort.json', { effort: 'max', command: 'other-session' });
    writeFlat('current-effort.json', { effort: 'low', command: 'flat' });

    expect((await readDashboardState(root)).command).toBe('flat');
    expect((await readDashboardState(root, {})).effort).toBe('low');
    expect((await readDashboardState(root, { sessionId: '' })).effort).toBe('low');
  });

  it('a session with nothing of its own and no flat file sees nothing', async () => {
    writeSession('sess-A', 'current-effort.json', { effort: 'max', command: 'someone-else' });

    const state = await readDashboardState(root, { sessionId: 'sess-B' });

    expect(state.effort).toBeNull();
    expect(state.command).toBeNull();
    expect(state.teammates).toEqual([]);
  });

  it('a hostile session id cannot read outside sessions/', async () => {
    writeFlat('current-effort.json', { effort: 'low', command: 'flat' });
    mkdirSync(path.join(stateDir, 'evil'), { recursive: true });
    writeFileSync(path.join(stateDir, 'evil', 'current-effort.json'), JSON.stringify({ effort: 'max', command: 'evil' }));

    // `sessions/../../evil` would be <state dir>/evil if the id were joined raw.
    expect((await readDashboardState(root, { sessionId: '../../evil' })).command).toBe('flat');
  });

  it('renderStatusLine and renderFullDashboard render the session they are given', async () => {
    disableColor();
    try {
      writeSession('sess-A', 'current-effort.json', { effort: 'xhigh', command: 'implement' });
      writeSession('sess-B', 'current-effort.json', { effort: 'low', command: 'daily' });

      const a = await renderStatusLine({ pluginRoot: root, config: ENABLED, sessionId: 'sess-A' });
      const b = await renderStatusLine({ pluginRoot: root, config: ENABLED, sessionId: 'sess-B' });
      const full = await renderFullDashboard({ pluginRoot: root, config: ENABLED, sessionId: 'sess-B' });

      expect(a).toContain('effort=xhigh');
      expect(b).toContain('effort=low');
      expect(b).not.toContain('xhigh');
      expect(full).toContain('daily');
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
    if (root) rmSync(root, { recursive: true, force: true });
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
