import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Learning records are grouped by a project NAME derived from the working
 * directory. Taking `basename` of the raw cwd made that name move with the
 * shell, so one project accumulated records under several names — the live
 * store held "Artibot" (repo root) and "artibot" (`plugins/artibot`) as if they
 * were different projects. These tests pin the name to the resolved project
 * root so every directory inside one project reports the same name.
 *
 * Every hook runs with HOME/USERPROFILE pointed at a temp directory: these
 * hooks persist to `~/.claude/artibot/**`, which is real user learning data.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEMORY_TRACKER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'memory-tracker.js');
const TOOL_TRACKER = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'tool-tracker.js');

describe('project name resolution (cwd-drift regression)', () => {
  let tmp;
  let home;
  let repo;
  let nested;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-projname-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'MyProject');
    nested = path.join(repo, 'plugins', 'inner', 'scripts');
    mkdirSync(home, { recursive: true });
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  function runHook(hook, payload, args = []) {
    return spawnSync(process.execPath, [hook, ...args], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      // Redirect the learning store away from the user's real ~/.claude/artibot.
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: nested,
    });
  }

  const memoryStore = (name) =>
    path.join(home, '.claude', 'artibot', 'memory', name);

  function readEntries(file) {
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  describe('memory-tracker', () => {
    it('records the project root name for a command fired from a subdirectory', () => {
      const r = runHook(MEMORY_TRACKER, {
        event_type: 'command',
        cwd: nested,
        command: { name: 'build', args: null },
      });
      expect(r.status).toBe(0);

      const entries = readEntries(memoryStore('command-history.json'));
      expect(entries).toHaveLength(1);
      // "MyProject", not "scripts" — the leaf of the cwd.
      expect(entries[0].data.project).toBe('MyProject');
    });

    it('gives one name whether the hook runs at the root or deep inside', () => {
      runHook(MEMORY_TRACKER, { event_type: 'command', cwd: repo, command: { name: 'a' } });
      runHook(MEMORY_TRACKER, { event_type: 'command', cwd: nested, command: { name: 'b' } });

      const names = new Set(
        readEntries(memoryStore('command-history.json')).map((e) => e.data.project),
      );
      // The exact failure that split the live store into "Artibot"/"artibot".
      expect([...names]).toEqual(['MyProject']);
    });

    it('records the project root name for an error event', () => {
      runHook(MEMORY_TRACKER, {
        event_type: 'error',
        cwd: nested,
        error: { message: 'boom', command: 'x' },
      });

      const entries = readEntries(memoryStore('error-patterns.json'));
      expect(entries).toHaveLength(1);
      expect(entries[0].data.project).toBe('MyProject');
    });

    it('still honors an explicit project name from the payload', () => {
      runHook(MEMORY_TRACKER, { event_type: 'session_end', cwd: nested, project: 'explicit' });

      const entries = readEntries(memoryStore('project-contexts.json'));
      expect(entries).toHaveLength(1);
      expect(entries[0].data.project).toBe('explicit');
    });
  });

  describe('tool-tracker', () => {
    it('records the project root name, not the cwd leaf', () => {
      const r = runHook(TOOL_TRACKER, {
        session_id: 'sess-1',
        cwd: nested,
        tool_name: 'Read',
        tool_input: { file_path: 'a.txt' },
        tool_response: { content: 'ok' },
      });
      expect(r.status).toBe(0);

      const experiences = path.join(home, '.claude', 'artibot', 'daily-experiences.json');
      expect(existsSync(experiences)).toBe(true);
      const parsed = JSON.parse(readFileSync(experiences, 'utf-8'));
      const rows = Array.isArray(parsed) ? parsed : (parsed.experiences || parsed.entries || []);
      const projects = new Set(
        rows.map((e) => e?.data?.project).filter(Boolean),
      );
      expect([...projects]).toEqual(['MyProject']);
    });
  });
});
