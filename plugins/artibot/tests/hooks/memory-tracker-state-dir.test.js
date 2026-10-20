import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * memory-tracker follows the state-dir resolver.
 *
 * WHY THIS FILE EXISTS. `memory-tracker.js#getMemoryDir` built
 * `<USERPROFILE||HOME>/.claude/artibot/memory` itself instead of calling
 * `lib/core/config.js#resolveArtibotDir`. A hooked, non-interactive session that
 * was handed `ARTIBOT_STATE_DIR` (paired with its real home through
 * `ARTIBOT_STATE_DIR_HOME`) therefore still wrote `project-contexts.json` and
 * `error-patterns.json` into the REAL `~/.claude/artibot/memory`. Reported by the
 * owner's promptfoo PoC (2026-10-19): 4 project-context records and 1
 * error-pattern record leaked that way (not re-measured here; the regression
 * below is what this file proves).
 *
 * The hook is run the way the host runs it: a child process, payload on stdin,
 * with the PoC's environment (`HOME`/`USERPROFILE` of the session, the override
 * and the home it was minted for). Every case uses a throwaway home, so the real
 * one is never touched.
 *
 * WHAT IS PINNED:
 *   - override honoured  -> every write lands under `<override>/memory`, nothing
 *     is created under `<home>/.claude`; the SessionStart reader looks there too
 *     (a decoy at the home-derived path is invisible).
 *   - no override, or one minted for another home -> `<home>/.claude/artibot/memory`
 *     exactly as before.
 *
 * WHAT THIS FILE CANNOT SEE: `lib/learning/memory-manager.js` (the other writer of
 * the same four stores, run by the SessionEnd learning pipeline) reads
 * `ARTIBOT_DIR`, the value the resolver had at import. Both agree in a spawned hook
 * because the environment exists before the process starts; this file does not
 * exercise that second module.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEMORY_TRACKER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'memory-tracker.js');

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

describe('memory-tracker — state-dir resolver', () => {
  let tmp;
  let home;
  let stateDir;
  let work;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-memtrk-')));
    home = path.join(tmp, 'home');
    stateDir = path.join(tmp, 'state');
    work = path.join(tmp, 'work');
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  /**
   * One firing of the hook. `override` is `undefined` for "no override at all",
   * or `{ dir, mintedFor }` for the pair the host (or a test harness) inherits.
   */
  function fire(payload, override) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, ARTIBOT_HOOK_FIRED_DIRECT: 'off' };
    delete env.ARTIBOT_STATE_DIR;
    delete env.ARTIBOT_STATE_DIR_HOME;
    if (override) {
      env.ARTIBOT_STATE_DIR = override.dir;
      env.ARTIBOT_STATE_DIR_HOME = override.mintedFor;
    }
    return spawnSync(process.execPath, [MEMORY_TRACKER], {
      input: JSON.stringify({ cwd: work, ...payload }),
      encoding: 'utf-8',
      env,
      cwd: work,
      windowsHide: true,
      timeout: 30000,
    });
  }

  const homeMemory = (name) => path.join(home, '.claude', 'artibot', 'memory', name);
  const stateMemory = (name) => path.join(stateDir, 'memory', name);

  const entriesOf = (file) => {
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, 'utf-8')).entries ?? [];
  };

  /** The three events that write, and the store each one writes. */
  const WRITERS = [
    ['session_end', { event_type: 'session_end', session_id: 'sess-1', project: 'p' }, 'project-contexts.json'],
    ['error', { event_type: 'error', error: { message: 'boom', command: 'x' } }, 'error-patterns.json'],
    ['command', { event_type: 'command', command: { name: 'build', args: null } }, 'command-history.json'],
  ];

  describe('override honoured (paired with the home in force)', () => {
    for (const [label, payload, store] of WRITERS) {
      it(`writes the ${label} store under the override and leaves the home tree untouched`, () => {
        const r = fire(payload, { dir: stateDir, mintedFor: home });

        expect(r.status).toBe(0);
        expect(entriesOf(stateMemory(store))).toHaveLength(1);
        expect(existsSync(homeMemory(store))).toBe(false);
        expect(existsSync(path.join(home, '.claude'))).toBe(false);
      });
    }

    it('reads the override too: a decoy at the home-derived path is invisible to SessionStart', () => {
      // 3 fresh project contexts where the hook used to look...
      const decoy = {
        entries: [1, 2, 3].map((n) => ({ id: `decoy-${n}`, type: 'context', expiresAt: FUTURE })),
        metadata: {},
      };
      mkdirSync(path.dirname(homeMemory('project-contexts.json')), { recursive: true });
      writeFileSync(homeMemory('project-contexts.json'), JSON.stringify(decoy), 'utf-8');

      // ...and exactly 1 where the override says state lives.
      fire(WRITERS[0][1], { dir: stateDir, mintedFor: home });
      const start = fire({ event_type: 'SessionStart' }, { dir: stateDir, mintedFor: home });

      expect(start.status).toBe(0);
      expect(JSON.parse(start.stdout).message).toBe('Memory system: loaded 1 project contexts.');
    });
  });

  describe('nothing redirected (production invariance)', () => {
    for (const [label, payload, store] of WRITERS) {
      it(`writes the ${label} store under <home>/.claude/artibot/memory when no override is set`, () => {
        const r = fire(payload);

        expect(r.status).toBe(0);
        expect(entriesOf(homeMemory(store))).toHaveLength(1);
        expect(existsSync(stateDir)).toBe(false);
      });
    }

    it('ignores an override minted for another home (a child handed its own HOME)', () => {
      const r = fire(WRITERS[2][1], { dir: stateDir, mintedFor: path.join(tmp, 'some-other-home') });

      expect(r.status).toBe(0);
      expect(entriesOf(homeMemory('command-history.json'))).toHaveLength(1);
      expect(existsSync(stateDir)).toBe(false);
    });

    it('ignores an override that carries no recorded home', () => {
      const env = { ...process.env, HOME: home, USERPROFILE: home, ARTIBOT_HOOK_FIRED_DIRECT: 'off' };
      delete env.ARTIBOT_STATE_DIR_HOME;
      env.ARTIBOT_STATE_DIR = stateDir;
      const r = spawnSync(process.execPath, [MEMORY_TRACKER], {
        input: JSON.stringify({ cwd: work, ...WRITERS[2][1] }),
        encoding: 'utf-8',
        env,
        cwd: work,
        windowsHide: true,
        timeout: 30000,
      });

      expect(r.status).toBe(0);
      expect(entriesOf(homeMemory('command-history.json'))).toHaveLength(1);
      expect(existsSync(stateDir)).toBe(false);
    });
  });
});
