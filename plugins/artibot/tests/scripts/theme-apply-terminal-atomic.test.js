/**
 * L19 (review-fixes 2026-11-21): theme-apply.js rewrote the Windows Terminal
 * and VS Code settings.json IN PLACE (writeFileSync) on both apply and reset.
 * A write torn part way — disk full, the process killed — left the user's
 * terminal / editor settings truncated. They now go through the same atomic
 * tmp→rename path as ~/.claude/settings.json (theme-apply.js#writeSettings).
 *
 * Real script, child process, every home-like env var (HOME, USERPROFILE,
 * APPDATA, LOCALAPPDATA) pointed at a temp dir — the user's real files are
 * never touched. The tear is injected with a `--import` preload that makes
 * any write whose path starts with the target settings.json (the file itself
 * or its tmp sibling, not its `.artibot-backup`) write a few bytes and throw
 * ENOSPC. Each torn case also asserts the tear actually fired (stderr carries
 * ENOSPC), so a tear that never reaches the write cannot pass vacuously.
 *
 * Not covered: the one-time `.artibot-backup` copies (written once, beside the
 * file) and artibot's own files (theme-backup.json, current-theme.json, the
 * output-style .md), which are not the user's settings.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'theme-apply.js');

const WT = { profiles: { defaults: { font: { face: 'Cascadia' } }, list: [] }, schemes: [] };
const VS = { 'editor.fontSize': 14, 'workbench.colorCustomizations': { 'editor.background': '#000000' } };

let home;
let wtPath;
let vsPath;

/** @param {string} [tearPrefix] - tear every write whose path starts with this */
function run(arg, tearPrefix) {
  const args = [];
  if (tearPrefix) {
    const preload = join(home, 'tear-preload.mjs');
    writeFileSync(preload, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const real = fs.writeFileSync;',
      `const prefix = ${JSON.stringify(tearPrefix)};`,
      'fs.writeFileSync = function (file, data, ...rest) {',
      // The one-time backup shares the prefix; tearing it would throw before the
      // settings write and make the apply cases pass vacuously.
      '  if (typeof file === "string" && file.startsWith(prefix) && !file.endsWith(".artibot-backup")) {',
      '    real.call(fs, file, String(data).slice(0, 5));',
      "    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });",
      '  }',
      '  return real.call(fs, file, data, ...rest);',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'));
    args.push('--import', pathToFileURL(preload).href);
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  return spawnSync(process.execPath, [...args, SCRIPT, arg], { env, encoding: 'utf8', timeout: 20_000 });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'theme-atomic-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  wtPath = join(home, 'AppData', 'Local', 'Microsoft', 'Windows Terminal', 'settings.json');
  vsPath = join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
  mkdirSync(dirname(wtPath), { recursive: true });
  mkdirSync(dirname(vsPath), { recursive: true });
  writeFileSync(wtPath, JSON.stringify(WT, null, 4));
  writeFileSync(vsPath, JSON.stringify(VS, null, 2) + '\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Files beside `p` other than the settings file and its one-time backup. */
function strays(p) {
  return readdirSync(dirname(p)).filter((f) => f !== 'settings.json' && f !== 'settings.json.artibot-backup');
}

describe('theme-apply writes Windows Terminal and VS Code settings atomically', () => {
  it('apply then reset: both files stay valid, WT keeps 4-space indent, no tmp left behind', () => {
    const a = run('neon-city');
    expect(a.status).toBe(0);
    const wtText = readFileSync(wtPath, 'utf8');
    expect(wtText).toMatch(/^\{\n {4}"/);
    expect(JSON.parse(wtText).profiles.defaults.colorScheme).toMatch(/ARTIBOT/);
    expect(JSON.parse(readFileSync(vsPath, 'utf8'))['editor.fontSize']).toBe(14);

    const r = run('reset');
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(wtPath, 'utf8')).profiles.defaults.colorScheme).toBeUndefined();
    expect(JSON.parse(readFileSync(vsPath, 'utf8'))['workbench.colorCustomizations']).toEqual(VS['workbench.colorCustomizations']);
    expect(strays(wtPath)).toEqual([]);
    expect(strays(vsPath)).toEqual([]);
  });

  it('apply: a torn Windows Terminal write leaves the original file intact', () => {
    expect(run('neon-city', wtPath).stderr).toMatch(/ENOSPC/);
    expect(JSON.parse(readFileSync(wtPath, 'utf8'))).toEqual(WT);
    expect(strays(wtPath)).toEqual([]);
  });

  it('apply: a torn VS Code write leaves the original file intact', () => {
    expect(run('neon-city', vsPath).stderr).toMatch(/ENOSPC/);
    expect(JSON.parse(readFileSync(vsPath, 'utf8'))).toEqual(VS);
    expect(strays(vsPath)).toEqual([]);
  });

  it('reset: a torn Windows Terminal write leaves the themed file intact', () => {
    expect(run('neon-city').status).toBe(0);
    const themed = readFileSync(wtPath, 'utf8');
    expect(run('reset', wtPath).stderr).toMatch(/ENOSPC/);
    expect(readFileSync(wtPath, 'utf8')).toBe(themed);
  });

  it('reset: a torn VS Code write leaves the themed file intact', () => {
    expect(run('neon-city').status).toBe(0);
    const themed = readFileSync(vsPath, 'utf8');
    expect(run('reset', vsPath).stderr).toMatch(/ENOSPC/);
    expect(readFileSync(vsPath, 'utf8')).toBe(themed);
  });
});
