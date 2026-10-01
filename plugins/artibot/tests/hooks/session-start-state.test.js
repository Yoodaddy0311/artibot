/**
 * session-start.js — the state it writes, on REAL files (O2).
 *
 * `tests/hooks/session-start.test.js` mocks `node:fs` wholesale, so it can see which
 * paths the hook WROTE but not whether a file landed where a reader will look, and it
 * cannot run the parts whose `import()` targets need a real plugin root. This file
 * calls the hook's exported helpers against a tmp state dir and linked plugin roots:
 *
 *   - `activateLongContext` — the 1M-context marker is SESSION-scoped
 *     (`<state dir>/runtime/sessions/<session_id>/long-context-active.json`);
 *   - `maybeEmitFirstRunBanner` — the welcome marker is GLOBAL
 *     (`<state dir>/runtime/self-control-welcomed.marker`) and survives a plugin update.
 *     Measured 2026-09-30: the marker sat in 4 of 4 cache version dirs, so every update
 *     showed the welcome banner again;
 *   - `sweepIdleSessionState` — idle session directories are removed on session start.
 *
 * WHAT THIS CANNOT SEE: the ORDER inside `main()` and that `main()` calls them at all —
 * `session-start.test.js` pins that with its mocks (it spies on the sweep and on the
 * marker write); a real `main()` also runs an update check and a swarm probe that have no
 * business in a unit test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  activateLongContext,
  maybeEmitFirstRunBanner,
  sweepIdleSessionState,
} from '../../scripts/hooks/session-start.js';
import { makeVersionRoot } from '../helpers/linked-plugin-root.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const DAY = 24 * 60 * 60 * 1000;
const WELCOME = /^\[artibot:welcome\]/;
const CONFIG = {
  ago: { selfControl: { masterEnabled: true, firstRunMode: { enabled: true, observeRuns: 5 } } },
};

let base;
let stateDir;
let restoreState;
let savedEnv;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-ss-state-'));
  stateDir = path.join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  restoreState = pointStateDirAt(stateDir);
  savedEnv = {
    ANTHROPIC_BETA: process.env.ANTHROPIC_BETA,
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
  };
  delete process.env.ANTHROPIC_BETA;
});

afterEach(() => {
  restoreState();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

describe('activateLongContext — session-scoped marker', () => {
  const ENABLED = { runtime: { longContext: { enabled: true, betaHeader: 'context-1m-test' } } };

  it('writes the session\'s own marker under the state dir', () => {
    activateLongContext(ENABLED, 'sess-A');

    const file = path.join(stateDir, 'runtime', 'sessions', 'sess-A', 'long-context-active.json');
    expect(existsSync(file)).toBe(true);
    const marker = JSON.parse(readFileSync(file, 'utf8'));
    expect(marker).toMatchObject({ enabled: true, betaHeader: 'context-1m-test' });
    expect(typeof marker.activatedAt).toBe('string');
    expect(process.env.ANTHROPIC_BETA).toContain('context-1m-test');
  });

  it('two sessions get two markers, and the flat one is not written', () => {
    activateLongContext(ENABLED, 'sess-A');
    activateLongContext(ENABLED, 'sess-B');

    for (const sid of ['sess-A', 'sess-B']) {
      expect(existsSync(path.join(stateDir, 'runtime', 'sessions', sid, 'long-context-active.json'))).toBe(true);
    }
    expect(existsSync(path.join(stateDir, 'runtime', 'long-context-active.json'))).toBe(false);
  });

  it('a payload with no session id writes the flat marker in the state dir', () => {
    activateLongContext(ENABLED, null);
    expect(existsSync(path.join(stateDir, 'runtime', 'long-context-active.json'))).toBe(true);
    expect(existsSync(path.join(stateDir, 'runtime', 'sessions'))).toBe(false);
  });

  it('writes nothing when the option is off — a session that starts with it off shows no marker', () => {
    activateLongContext({ runtime: { longContext: { enabled: false } } }, 'sess-A');
    activateLongContext({}, 'sess-A');
    expect(existsSync(path.join(stateDir, 'runtime'))).toBe(false);
    expect(process.env.ANTHROPIC_BETA).toBeUndefined();
  });
});

describe('maybeEmitFirstRunBanner — the welcome marker is GLOBAL', () => {
  const marker = () => path.join(stateDir, 'runtime', 'self-control-welcomed.marker');

  async function banner(root) {
    process.env.CLAUDE_PLUGIN_ROOT = root;
    const lines = [];
    await maybeEmitFirstRunBanner(root, CONFIG, lines);
    return lines;
  }

  it('shows the welcome once, and the marker lands in the state dir — not in the plugin root', async () => {
    const root = makeVersionRoot(base, '4.70.0');

    const first = await banner(root);
    expect(first.some((l) => WELCOME.test(l))).toBe(true);
    expect(existsSync(marker())).toBe(true);
    expect(existsSync(path.join(root, 'runtime', 'self-control-welcomed.marker'))).toBe(false);

    const second = await banner(root);
    expect(second.some((l) => WELCOME.test(l))).toBe(false);
  });

  it('does NOT show it again after a plugin update — the previous version\'s marker is carried over', async () => {
    const previous = makeVersionRoot(base, '4.70.0');
    const running = makeVersionRoot(base, '4.71.0');
    mkdirSync(path.join(previous, 'runtime'), { recursive: true });
    writeFileSync(path.join(previous, 'runtime', 'self-control-welcomed.marker'), '2026-09-28T12:49:00.000Z\n');

    const lines = await banner(running);

    expect(lines.some((l) => WELCOME.test(l))).toBe(false);
    expect(readFileSync(marker(), 'utf8')).toBe('2026-09-28T12:49:00.000Z\n');
  });

  it('shows it for a genuinely new install (nothing anywhere) — the update path is not a blanket suppress', async () => {
    const running = makeVersionRoot(base, '4.71.0');
    makeVersionRoot(base, '4.70.0'); // a sibling that never wrote a marker

    const lines = await banner(running);

    expect(lines.some((l) => WELCOME.test(l))).toBe(true);
  });

  it('a marker already in the state dir is left as it is', async () => {
    const previous = makeVersionRoot(base, '4.70.0');
    const running = makeVersionRoot(base, '4.71.0');
    mkdirSync(path.join(previous, 'runtime'), { recursive: true });
    writeFileSync(path.join(previous, 'runtime', 'self-control-welcomed.marker'), 'old\n');
    mkdirSync(path.dirname(marker()), { recursive: true });
    writeFileSync(marker(), 'current\n');

    await banner(running);

    expect(readFileSync(marker(), 'utf8')).toBe('current\n');
  });
});

describe('sweepIdleSessionState', () => {
  function sessionDir(sid, ageMs) {
    const dir = path.join(stateDir, 'runtime', 'sessions', sid);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'current-effort.json');
    writeFileSync(file, '{}');
    const t = new Date(Date.now() - ageMs);
    utimesSync(file, t, t);
    utimesSync(dir, t, t);
    return dir;
  }

  it('removes idle session dirs, keeps a recent one, and never touches the starting session', () => {
    const stale = sessionDir('stale', 30 * DAY);
    const recent = sessionDir('recent', 1 * DAY);
    const starting = sessionDir('starting', 30 * DAY); // e.g. `claude --resume` of an old session

    sweepIdleSessionState('starting');

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(starting)).toBe(true);
  });

  it('with no session id it still sweeps, and never throws on a missing sessions/', () => {
    expect(() => sweepIdleSessionState(null)).not.toThrow();
    const stale = sessionDir('stale', 30 * DAY);
    sweepIdleSessionState(null);
    expect(existsSync(stale)).toBe(false);
  });
});
