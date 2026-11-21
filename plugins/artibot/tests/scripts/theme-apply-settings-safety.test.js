/**
 * Regression guard: `/theme` must never wipe the user's ~/.claude/settings.json.
 *
 * Before the fix, `readJson(SETTINGS, {})` turned any parse failure (a UTF-8
 * BOM, a `//` comment, a trailing comma) into `{}`, and the next write replaced
 * the whole file with just `statusLine` + `outputStyle` — permissions, hooks and
 * env gone, exit 0, "✓ statusLine → themed" printed.
 *
 * These tests run the real script in a child process with HOME / USERPROFILE /
 * APPDATA / LOCALAPPDATA all pointed at a temp dir, so the user's real files are
 * never touched and the Windows Terminal / VS Code branches find nothing.
 *
 * What this does NOT cover: Windows Terminal and VS Code settings (those paths
 * already skip on a parse failure and keep a one-time `.artibot-backup`).
 *
 * @module tests/scripts/theme-apply-settings-safety
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'theme-apply.js');

let home;
let settingsPath;

function run(arg) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  return spawnSync(process.execPath, [SCRIPT, arg], { env, encoding: 'utf8', timeout: 20_000 });
}

const USER_SETTINGS = {
  permissions: { allow: ['Bash(npm test)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
  env: { FOO: 'bar' },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'theme-safety-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  settingsPath = join(home, '.claude', 'settings.json');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('theme-apply never destroys an unparseable settings.json', () => {
  const unparseable = {
    'a // comment': `{\n  // my notes\n  "permissions": { "allow": ["Bash(npm test)"] }\n}\n`,
    'a trailing comma': `{ "permissions": { "allow": ["Bash(npm test)"] }, }\n`,
    'a JSON array': `[1, 2, 3]\n`,
  };

  for (const [label, body] of Object.entries(unparseable)) {
    it(`apply: leaves settings.json byte-identical when it has ${label}, and exits non-zero`, () => {
      writeFileSync(settingsPath, body);
      const r = run('neon-city');
      expect(readFileSync(settingsPath, 'utf8')).toBe(body);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/settings\.json/);
      // "nothing changed" means no other surface was touched either
      expect(existsSync(settingsPath + '.artibot-backup')).toBe(false);
      expect(existsSync(join(home, '.claude', 'artibot', 'runtime'))).toBe(false);
      expect(existsSync(join(home, '.claude', 'output-styles'))).toBe(false);
    });

    it(`reset: leaves settings.json byte-identical when it has ${label}, and exits non-zero`, () => {
      writeFileSync(settingsPath, body);
      const r = run('reset');
      expect(readFileSync(settingsPath, 'utf8')).toBe(body);
      expect(r.status).not.toBe(0);
    });
  }
});

describe('theme-apply preserves the rest of settings.json', () => {
  it('apply: a UTF-8 BOM file is parsed, user keys survive, statusLine/outputStyle are set', () => {
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(settingsPath, bom + JSON.stringify(USER_SETTINGS, null, 2));
    // The fixture must really start with EF BB BF, or this test proves nothing.
    expect([...readFileSync(settingsPath).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const r = run('neon-city');
    expect(r.status).toBe(0);
    const text = readFileSync(settingsPath, 'utf8');
    const after = JSON.parse(text.startsWith(bom) ? text.slice(1) : text);
    expect(after.permissions).toEqual(USER_SETTINGS.permissions);
    expect(after.hooks).toEqual(USER_SETTINGS.hooks);
    expect(after.env).toEqual(USER_SETTINGS.env);
    expect(after.statusLine.command).toMatch(/statusline-themed\.sh/);
    expect(typeof after.outputStyle).toBe('string');
  });

  it('apply: keeps a one-time byte-for-byte backup of the original settings.json', () => {
    const original = JSON.stringify(USER_SETTINGS, null, 2) + '\n';
    writeFileSync(settingsPath, original);
    expect(run('neon-city').status).toBe(0);
    expect(run('matrix').status).toBe(0);
    const backup = settingsPath + '.artibot-backup';
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, 'utf8')).toBe(original);
  });

  it('apply then reset: user keys survive the round trip', () => {
    writeFileSync(settingsPath, JSON.stringify(USER_SETTINGS, null, 2));
    expect(run('neon-city').status).toBe(0);
    expect(run('reset').status).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(after.permissions).toEqual(USER_SETTINGS.permissions);
    expect(after.hooks).toEqual(USER_SETTINGS.hooks);
    expect(after.env).toEqual(USER_SETTINGS.env);
  });

  it('apply: an empty (0-byte) settings.json holds no data and is treated as {}', () => {
    writeFileSync(settingsPath, '');
    const r = run('neon-city');
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command).toMatch(/statusline-themed\.sh/);
  });

  it.skipIf(process.platform === 'win32')('apply: keeps a 0600 mode on POSIX', () => {
    writeFileSync(settingsPath, JSON.stringify(USER_SETTINGS));
    chmodSync(settingsPath, 0o600);
    expect(run('neon-city').status).toBe(0);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('apply: a symlinked settings.json stays a symlink and its target is updated', () => {
    const real = join(home, 'dotfiles-settings.json');
    writeFileSync(real, JSON.stringify(USER_SETTINGS));
    symlinkSync(real, settingsPath);
    expect(run('neon-city').status).toBe(0);
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    const after = JSON.parse(readFileSync(real, 'utf8'));
    expect(after.permissions).toEqual(USER_SETTINGS.permissions);
    expect(after.statusLine.command).toMatch(/statusline-themed\.sh/);
  });

  it('apply: a missing settings.json is created (first-run behaviour unchanged)', () => {
    const r = run('neon-city');
    expect(r.status).toBe(0);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(after.statusLine.command).toMatch(/statusline-themed\.sh/);
  });
});
