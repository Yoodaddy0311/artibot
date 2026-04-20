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
