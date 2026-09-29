/**
 * Shared plumbing for the OB-24 / R1 direct-hook suites
 * (`tests/hooks/hook-fired-direct.test.js` and `hook-fired-direct-unit.test.js`).
 *
 * TWO THINGS LIVE HERE AND NOWHERE ELSE.
 *   1. THE REGISTRY, MEASURED. The direct registrations are derived at load time
 *      from `hooks/hooks.json` and `hooks/dispatch-table.json`, never hand-listed:
 *      a hand-listed registry is the copy nobody compares.
 *   2. THE SANDBOX. Every spawned hook gets a `git init` repository under
 *      `os.tmpdir()`, a redirected HOME, and a scrubbed host environment, so no
 *      row can reach the developer's real central ledger. The scrub also removes
 *      `VITEST*`, so a child behaves like a PRODUCTION hook process; a test that
 *      wants the runner's environment puts `VITEST` back through `extraEnv`.
 *
 * Not a test file (no `.test.` infix), so vitest never collects it.
 *
 * @module tests/helpers/hook-fired-harness
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
export const HOOKS_DIR = path.join(PLUGIN_ROOT, 'scripts', 'hooks');
export const HOOKS_JSON = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
export const TABLE = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'dispatch-table.json'), 'utf-8'));

export const RECORDER_URL = pathToFileURL(path.join(HOOKS_DIR, '_hook-fired-record.js')).href;
export const MAIN_ENTRY_URL = pathToFileURL(path.join(HOOKS_DIR, '_main-entry.js')).href;

// ---------------------------------------------------------------------------
// Registry, measured from the two registration files
// ---------------------------------------------------------------------------

export const DISPATCHER_SCRIPTS = new Set(
  Object.values(TABLE.slots)
    .filter((d) => typeof d.dispatcher === 'string')
    .map((d) => path.posix.basename(d.dispatcher)),
);
export const DISPATCHER_SLOTS = Object.entries(TABLE.slots)
  .filter(([, d]) => typeof d.dispatcher === 'string')
  .map(([slot]) => slot)
  .sort();
export const DISPATCHED_SCRIPTS = new Set(
  Object.values(TABLE.slots).flatMap((d) => (d.handlers ?? []).map((h) => h.script)),
);

/**
 * Every hooks.json command that is NOT one of the six dispatchers, in file
 * order, with the arguments the host passes.
 *
 * @returns {Array<{event: string, matcher: string, script: string, args: string[], stem: string, label: string}>}
 */
function directEntries() {
  const out = [];
  for (const [event, groups] of Object.entries(HOOKS_JSON.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const tail = hook.command.trim().match(/[^\s/\\]+\.(?:c|m)?js\b.*$/)?.[0];
        const [script, ...args] = tail.split(/\s+/);
        if (DISPATCHER_SCRIPTS.has(script)) continue;
        out.push({
          event,
          matcher: group.matcher,
          script,
          args,
          stem: script.replace(/\.[cm]?js$/, ''),
          label: `${event} ${script}${args.length ? ` ${args.join(' ')}` : ''}`,
        });
      }
    }
  }
  return out;
}

export const ENTRIES = directEntries();
export const DISTINCT_SCRIPTS = [...new Set(ENTRIES.map((e) => e.script))].sort();
export const PER_EVENT = ENTRIES.reduce((acc, e) => ({ ...acc, [e.event]: (acc[e.event] ?? 0) + 1 }), {});

// ---------------------------------------------------------------------------
// Sandbox plumbing for the spawned hooks
// ---------------------------------------------------------------------------

const sandboxes = [];

/**
 * A git repository under os.tmpdir() with its own HOME. Register
 * {@link removeSandboxes} in `afterEach`.
 *
 * @param {string} [label]
 * @returns {{root: string, repo: string, home: string, tmp: string}}
 */
export function makeSandbox(label = 'sb') {
  // `.native`, not the JS realpath: only the native one expands a Windows 8.3 short name
  // (C:\Users\HEECHA~1), which is the spelling the repo resolvers canonicalise to.
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `artibot-r1-${label}-`)));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  writeFileSync(path.join(repo, 'artibot.config.json'), '{}\n', 'utf-8');
  writeFileSync(path.join(repo, 'CLAUDE.md'), '# sandbox\n', 'utf-8');
  writeFileSync(path.join(repo, 'src', 'existing.js'), 'const a = 1;\n', 'utf-8');
  const sb = { root, repo, home, tmp };
  sandboxes.push(sb);
  return sb;
}

/**
 * A linked worktree of a sandbox's repository, in the exact shape `git worktree
 * add` leaves: a directory whose `.git` is a POINTER FILE (`gitdir: <p>`), with
 * a `commondir` beside the target that leads back to the main `.git`. It is the
 * layout every `/split` limb runs in, and the one where "the repository's
 * ledger" is the SHARED one under the main repository.
 *
 * @param {{root: string, repo: string}} sb
 * @param {string} [name]
 * @returns {string} absolute path of the linked worktree
 */
export function makeLinkedWorktree(sb, name = 'linked-wt') {
  const wt = path.join(sb.root, name);
  const wtGitDir = path.join(sb.repo, '.git', 'worktrees', name);
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n', 'utf-8');
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`, 'utf-8');
  return wt;
}

/** Remove every sandbox made since the last call. */
export function removeSandboxes() {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    try { rmSync(sb.root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * A PRODUCTION-LIKE child environment: host session ids blanked, HOME/TEMP in
 * the sandbox, no inherited plugin root, no recorder switch, no `VITEST*`.
 *
 * @param {{home: string, tmp: string}} sb
 * @param {Record<string, string>} [extra] applied last, so a test can put back
 *   whatever it is exercising
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(sb, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k.startsWith('VITEST')) delete env[k];
  }
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.ARTIBOT_HOOK_FIRED_DIRECT;
  return {
    ...env,
    HOME: sb.home,
    USERPROFILE: sb.home,
    TEMP: sb.tmp,
    TMP: sb.tmp,
    TMPDIR: sb.tmp,
    CLAUDE_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    ...extra,
  };
}

/**
 * Spawn a hook script exactly as the host would: argv[1] is the script, the
 * payload is on stdin.
 *
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
export function runScript(sb, script, args, input, extraEnv = {}, cwd = sb.repo) {
  const res = spawnSync(process.execPath, [path.join(HOOKS_DIR, script), ...args], {
    input,
    encoding: 'utf-8',
    windowsHide: true,
    cwd,
    env: childEnv(sb, extraEnv),
    timeout: 60_000,
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

/** Every line of a sandbox's central ledger, parsed. */
export function ledgerLines(sb) {
  const file = ledgerFilePath(sb.repo);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** The `hook.fired` lines of a sandbox's central ledger. */
export const firedRows = (sb) => ledgerLines(sb).filter((l) => l.event === 'hook.fired');
