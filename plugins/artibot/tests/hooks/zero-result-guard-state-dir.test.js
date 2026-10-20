import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COUNTER_FILENAME, counterPath, readCounter, recordFire } from '../../scripts/hooks/zero-result-guard.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

/**
 * The zero-result firing counter follows the state-dir resolver.
 *
 * `scripts/hooks/zero-result-guard.js#counterPath` built `~/.claude/artibot/zero-result-guard-counter.json`
 * from the home dir, so a hooked, non-interactive session that was handed
 * `ARTIBOT_STATE_DIR` (paired with its real home) still bumped the REAL counter whenever
 * a Grep/Glob came back empty (found by the 2026-10-20 hook-writer census after the
 * owner's promptfoo PoC). `recordFire` is the one writer — the Bash-channel twin
 * `post-tool-failure-advisor.js` imports it — and `readCounter` the one JS reader, so one
 * answer from `counterPath()` keeps them on the same file.
 *
 * Every case uses throwaway homes: `USERPROFILE` and `HOME` are both repointed
 * (`getHomeDir()` reads them in that order), so the real one is never touched.
 *
 * WHAT THIS FILE CANNOT SEE: the shell statuslines that render the counter. `statusline.sh`
 * follows the same rule through its own `STATE_ROOT` (see `tests/hooks/statusline-zero-result-segment.test.js`);
 * `statusline-themed.sh` reads the home path and never runs in an isolated session.
 */

const ENV_KEYS = ['USERPROFILE', 'HOME', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME'];

/** @type {Record<string, string|undefined>} */
let saved = {};
let tmp;
let homeA;
let homeB;
let stateDir;

const homeCounter = (home) => path.join(home, '.claude', 'artibot', COUNTER_FILENAME);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-zrg-sd-')));
  homeA = path.join(tmp, 'home-a');
  homeB = path.join(tmp, 'home-b');
  stateDir = path.join(tmp, 'state');
  process.env.USERPROFILE = homeA;
  process.env.HOME = homeA;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('counterPath — override honoured', () => {
  it('names the counter inside the override, not ~/.claude/artibot', () => {
    pointStateDirAt(stateDir);

    expect(counterPath()).toBe(path.join(stateDir, COUNTER_FILENAME));
  });

  it('recordFire writes inside the override and leaves the home alone; readCounter reads it back', () => {
    pointStateDirAt(stateDir);

    recordFire('b1');
    recordFire('b2');

    expect(existsSync(path.join(stateDir, COUNTER_FILENAME))).toBe(true);
    expect(existsSync(homeCounter(homeA))).toBe(false);
    expect(readCounter()).toMatchObject({ fired: 2, byChannel: { b1: 1, b2: 1 } });
    expect(JSON.parse(readFileSync(path.join(stateDir, COUNTER_FILENAME), 'utf-8')).fired).toBe(2);
  });

  it('follows the override when it changes between calls (read at call time)', () => {
    const restore = pointStateDirAt(stateDir);
    const first = counterPath();
    restore();

    expect(counterPath()).toBe(homeCounter(homeA));
    expect(first).toBe(path.join(stateDir, COUNTER_FILENAME));
  });
});

describe('counterPath — nothing redirected (production invariance)', () => {
  it('names ~/.claude/artibot/zero-result-guard-counter.json when no override is set', () => {
    expect(counterPath()).toBe(homeCounter(homeA));
  });

  it('recordFire keeps writing the home counter when no override is set', () => {
    recordFire('b1');

    expect(JSON.parse(readFileSync(homeCounter(homeA), 'utf-8')).fired).toBe(1);
    expect(existsSync(stateDir)).toBe(false);
  });

  it('ignores an override minted for another home (a child handed its own HOME)', () => {
    process.env.ARTIBOT_STATE_DIR = stateDir;
    process.env.ARTIBOT_STATE_DIR_HOME = homeB;

    expect(counterPath()).toBe(homeCounter(homeA));
  });

  it('ignores an override that carries no recorded home', () => {
    process.env.ARTIBOT_STATE_DIR = stateDir;

    expect(counterPath()).toBe(homeCounter(homeA));
  });

  it('follows the home in force when HOME changes (no override)', () => {
    process.env.USERPROFILE = homeB;
    process.env.HOME = homeB;

    expect(counterPath()).toBe(homeCounter(homeB));
  });
});
