/**
 * Shared harness for the two plugin-root gates
 * (`tests/commands/plugin-root-finder.test.js`, `tests/commands/plugin-root-chains.test.js`).
 *
 * WHY A BATCH RUNNER (measured 2026-09-30, Windows + Git Bash)
 * Those gates used to spawn one `bash -c` per scenario, about 45 spawns in a file,
 * and the whole-suite run timed out some of them under load (the same load class
 * that flakes `batch-landing` and `dev-verify-gate-ledger`). `runBatch` writes every
 * scenario as a script FILE, runs them all from ONE driver process, a few at a time,
 * and reads each scenario's stdout / stderr / exit code back from files. The test
 * process spawns once; a slow machine makes the one call slower, not 45 calls
 * individually fragile. Callers give the `beforeAll` that calls it an explicit
 * timeout.
 *
 * WHAT THIS CANNOT SEE
 * - Anything the real host does. The host's inline substitution of the plugin path is
 *   MODELLED by the caller (replace the token with a literal before the script is
 *   written); this module only runs what it is given.
 * - zsh, dash, or a bash older than 4. Only the `bash` on PATH is exercised, and only
 *   where `probeBash()` says it can open native paths.
 * - Background-job concurrency above `chunk`. Cases share no mutable state (fixtures
 *   are built before the driver starts), but a machine that cannot fork `chunk` bash
 *   processes at once would show up as a missing `.rc` file (status `null`).
 *
 * @module tests/helpers/plugin-root-harness
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toBashPath } from '../../scripts/utils/bash-compat.js';

/** The plugin directory of THIS checkout (`plugins/artibot`). */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Normalise CRLF (the worktree is CRLF on this host, the git blob is LF). */
export const lf = (s) => s.replace(/\r\n/g, '\n');

/** Read a plugin-relative file, newline-normalised. */
export const read = (rel) => lf(readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8'));

/** Forward-slash form that Git Bash (and POSIX) accept. */
export const posix = toBashPath;

/** The literal tokens, written so a linter does not read them as template placeholders. */
export const TOKEN = '$' + '{CLAUDE_PLUGIN_ROOT}';
export const TOKEN_ENV = '$' + '{CLAUDE_PLUGIN_ROOT:-}';

/** What every finder prints when it finds nothing. */
export const NOT_FOUND = 'artibot plugin root not found - run /update';

/**
 * The test a working-directory candidate must pass before it is trusted: the manifest
 * under it names `artibot` (and not `artibot-cowork`, whose closing quote differs).
 */
export const NAME_CHECK = `grep -q '"name"[[:space:]]*:[[:space:]]*"artibot"'`;

/** Single-quote a string for POSIX shell (an apostrophe becomes `'\''`). */
export const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** Real path of `p`, or its resolved form when it does not exist. */
export function canon(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Do two paths name the same place? Bash prints the canonical long form
 * (`pwd -W`), while `os.tmpdir()` can be an 8.3 short name on the same directory,
 * and Windows paths are case-insensitive.
 */
export function same(a, b) {
  const norm = (p) => canon(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** Create a file (and its directories). */
export function touch(p, text = '// probe\n') {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** Write `<dir>/.claude-plugin/plugin.json`; `raw` replaces the whole text. */
export function writeManifest(dir, name = 'artibot', raw = undefined) {
  touch(path.join(dir, '.claude-plugin', 'plugin.json'), raw ?? `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`);
}

/** `<home>/.claude/plugins/cache/artibot/artibot/<version>` */
export const cacheDir = (home, version) => path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', version);

/** `<home>/.claude/plugins/marketplaces/<name>/plugins/artibot` */
export const mirrorDir = (home, name = 'artibot') => path.join(home, '.claude', 'plugins', 'marketplaces', name, 'plugins', 'artibot');

/** `<home>/.claude/artibot` — the legacy copy `install.sh` makes. */
export const globalDir = (home) => path.join(home, '.claude', 'artibot');

/**
 * Fenced blocks of one language, with the list-item indentation removed.
 *
 * @param {string} text - Newline-normalised markdown.
 * @param {string} lang - Fence language (`js`, `bash`).
 * @returns {string[]} block bodies
 */
export function fencesOf(text, lang) {
  const out = [];
  const re = new RegExp(`^([ \\t]*)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\``, 'gm');
  for (const m of text.matchAll(re)) {
    const indent = m[1];
    out.push(m[2].split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n'));
  }
  return out;
}

/**
 * Run many shell scenarios from ONE spawn. Each case is a script FILE sourced by its own
 * subshell with its own HOME, cwd and (optionally) CLAUDE_PLUGIN_ROOT; the host session
 * env never reaches it (`CLAUDE_PLUGIN_ROOT` is unset unless `envRoot` is given). A case
 * script must not `exit` (it would end only its own subshell, which is harmless, but the
 * status is then the script's own).
 *
 * @param {string} workDir - Directory for the scripts and result files.
 * @param {Array<{ id: string, script: string, cwd: string, home: string, envRoot?: string, nounset?: boolean }>} cases
 * @param {{ chunk?: number, timeoutMs?: number }} [opts]
 * @returns {{ results: Map<string, { status: number|null, out: string, err: string }>, driver: { status: number|null, stderr: string, timedOut: boolean } }}
 */
export function runBatch(workDir, cases, { chunk = 10, timeoutMs = 240_000 } = {}) {
  mkdirSync(workDir, { recursive: true });
  const ids = new Set();
  const lines = ['#!/bin/bash'];
  cases.forEach((c, i) => {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);
    const stem = path.join(workDir, `c${i}`);
    writeFileSync(`${stem}.sh`, `${c.script}\n`, 'utf-8');
    const s = posix(stem);
    // Each case is a SUBSHELL that sources its script: one fork, no second bash to start. Its
    // exports and variables die with it, so cases cannot see each other.
    lines.push(
      '(',
      `  export HOME=${sq(posix(c.home))} USERPROFILE=${sq(posix(c.home))}`,
      c.envRoot === undefined ? '  unset CLAUDE_PLUGIN_ROOT' : `  export CLAUDE_PLUGIN_ROOT=${sq(posix(c.envRoot))}`,
      `  cd ${sq(posix(c.cwd))} || exit 97`,
      c.nounset ? '  set -u' : '  :',
      `  . ${sq(`${s}.sh`)} >${sq(`${s}.out`)} 2>${sq(`${s}.err`)}`,
      `  echo $? >${sq(`${s}.rc`)}`,
      ') &',
    );
    if ((i + 1) % chunk === 0) lines.push('wait');
  });
  lines.push('wait');
  const driver = path.join(workDir, 'driver.sh');
  writeFileSync(driver, `${lines.join('\n')}\n`, 'utf-8');
  const r = spawnSync('bash', [posix(driver)], { encoding: 'utf-8', timeout: timeoutMs });

  const results = new Map();
  cases.forEach((c, i) => {
    const stem = path.join(workDir, `c${i}`);
    const get = (ext) => {
      try {
        return readFileSync(`${stem}.${ext}`, 'utf-8');
      } catch {
        return null;
      }
    };
    const rc = get('rc');
    results.set(c.id, { status: rc === null ? null : Number(rc.trim()), out: (get('out') ?? '').trim(), err: (get('err') ?? '').trim() });
  });
  return { results, driver: { status: r.status, stderr: String(r.stderr || ''), timedOut: r.error?.code === 'ETIMEDOUT' } };
}
