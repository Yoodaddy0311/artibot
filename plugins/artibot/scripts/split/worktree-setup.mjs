#!/usr/bin/env node
/**
 * `split worktree-setup <worktreePath>` — make a fresh `/split` worktree able
 * to run the gates, without copying node_modules and without ever deleting
 * anything recursively.
 *
 * Measured incidents this standardises (proposal A6, Ontology 2026-09-01/02):
 *   - no node_modules in the worktree → the unused-symbol ratchet "tightened
 *     59 → 0" and passed by destroying its own baseline; a package-root SDK
 *     fallback produced a false TS2322 red and +150KB false bundle growth.
 *   - a junction removed with `rm -rf` follows into the parent — 957 parent
 *     entries were one keystroke from deletion.
 *   - `.env.local` not copied → build failure.
 *   - parallel lanes sharing one e2e DB → one lane's autoReset wiped a
 *     sibling's seeds (CI has one runner, so it never showed there).
 *
 * Config `artibot.config.json#split.worktreeSetup` (all optional, defaults shown):
 *   linkDirs:   ['plugins/artibot/node_modules']  parent dir → junction/symlink in the worktree
 *   copyFiles:  ['.env.local']                     copied only when absent in the worktree
 *   installCmd: null                               argv array (or whitespace-split string); run only when
 *                                                  no linkDir covers node_modules — never through a shell
 *   envPerLane: {}                                 { VAR: 'value with {limb} / {limb_}' } → <wt>/.artibot/split/<limb>/lane.env
 *
 * `--teardown` removes ONLY reparse points (`lstat().isSymbolicLink()` must
 * be true — measured on this host 2026-09-02: a `mklink /J` junction reports
 * true, and `rmdirSync` on it removes the link and leaves the target intact).
 * A real directory in a link slot is refused, never deleted.
 *
 * Idempotent: a second run reports every step as skipped. Exit 1 when any
 * step is refused. Output is a summary table, or JSON with `--json`.
 *
 * @module scripts/split/worktree-setup
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainEntry } from '../hooks/_main-entry.js';
import { loadConfig } from '../../lib/core/config.js';

/** Defaults for `split.worktreeSetup`. */
export const DEFAULT_WORKTREE_SETUP = Object.freeze({
  linkDirs: Object.freeze(['plugins/artibot/node_modules']),
  copyFiles: Object.freeze(['.env.local']),
  installCmd: null,
  envPerLane: Object.freeze({}),
});

export const HELP = `usage: node scripts/split/worktree-setup.mjs <worktreePath> [options]

  --limb <limb>   lane name for envPerLane substitution ({limb}, {limb_} = hyphens→underscores)
  --parent <dir>  parent (main checkout) root — default: cwd
  --teardown      remove ONLY the reparse points this script creates (never recursive)
  --json          machine output
  --dry-run       plan only, apply nothing

Reads artibot.config.json#split.worktreeSetup { linkDirs, copyFiles, installCmd, envPerLane }.`;

/**
 * @param {string[]} argv
 * @returns {{ worktreePath: string|null, limb: string|null, parent: string|null, teardown: boolean, json: boolean, dryRun: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { worktreePath: null, limb: null, parent: null, teardown: false, json: false, dryRun: false, help: false };
  const withValue = { '--limb': 'limb', '--parent': 'parent' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--teardown') out.teardown = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (withValue[a]) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      out[withValue[a]] = v;
      i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else if (out.worktreePath === null) out.worktreePath = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

/**
 * Merge `split.worktreeSetup` over the defaults; malformed fields fall back
 * to the default for that field (never to "nothing").
 *
 * @param {object|null|undefined} raw - `config.split.worktreeSetup`
 * @returns {{ linkDirs: string[], copyFiles: string[], installCmd: string[]|null, envPerLane: Record<string, string> }}
 */
export function normalizeSetupConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const strList = (v, d) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [...d]);
  let installCmd = null;
  if (Array.isArray(src.installCmd) && src.installCmd.length && src.installCmd.every((s) => typeof s === 'string')) installCmd = [...src.installCmd];
  else if (typeof src.installCmd === 'string' && src.installCmd.trim()) installCmd = src.installCmd.trim().split(/\s+/);
  const envPerLane = {};
  if (src.envPerLane && typeof src.envPerLane === 'object' && !Array.isArray(src.envPerLane)) {
    for (const [k, v] of Object.entries(src.envPerLane)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (typeof v === 'string' || typeof v === 'number')) envPerLane[k] = String(v);
    }
  }
  return {
    linkDirs: strList(src.linkDirs, DEFAULT_WORKTREE_SETUP.linkDirs),
    copyFiles: strList(src.copyFiles, DEFAULT_WORKTREE_SETUP.copyFiles),
    installCmd,
    envPerLane,
  };
}

/**
 * `lane.env` text: `KEY=value` lines with `{limb}` and `{limb_}` substituted.
 *
 * @param {Record<string, string>} envPerLane
 * @param {string} limb
 * @returns {string}
 */
export function renderLaneEnv(envPerLane, limb) {
  const underscored = String(limb).replace(/-/g, '_');
  return `${Object.entries(envPerLane)
    .map(([k, v]) => `${k}=${String(v).replace(/\{limb_\}/g, underscored).replace(/\{limb\}/g, limb)}`)
    .join('\n')}\n`;
}

const isNodeModules = (rel) => path.basename(rel.replace(/[\\/]+$/, '')) === 'node_modules';

/**
 * Plan the setup steps. Pure given the injected probes — tests drive it with
 * a fake filesystem and no junction is created.
 *
 * @param {object} input
 * @param {string} input.parentRoot
 * @param {string} input.worktreePath
 * @param {string|null} [input.limb]
 * @param {ReturnType<typeof normalizeSetupConfig>} input.setup
 * @param {(p: string) => boolean} input.exists - `fs.existsSync`-like
 * @returns {Array<{ kind: 'link'|'copy'|'install'|'env'|'skip'|'refuse', target: string, source?: string, cmd?: string[], content?: string, reason?: string }>}
 */
export function planWorktreeSetup({ parentRoot, worktreePath, limb = null, setup, exists }) {
  const actions = [];
  let nodeModulesCovered = false;
  for (const rel of setup.linkDirs) {
    const target = path.join(worktreePath, rel);
    const source = path.join(parentRoot, rel);
    if (exists(target)) {
      actions.push({ kind: 'skip', target, reason: 'already present' });
      if (isNodeModules(rel)) nodeModulesCovered = true;
    } else if (!exists(source)) {
      actions.push({ kind: 'skip', target, source, reason: 'parent lacks it — nothing to link' });
    } else {
      actions.push({ kind: 'link', target, source });
      if (isNodeModules(rel)) nodeModulesCovered = true;
    }
  }
  for (const rel of setup.copyFiles) {
    const target = path.join(worktreePath, rel);
    const source = path.join(parentRoot, rel);
    if (exists(target)) actions.push({ kind: 'skip', target, reason: 'already present' });
    else if (!exists(source)) actions.push({ kind: 'skip', target, source, reason: 'parent lacks it — nothing to copy' });
    else actions.push({ kind: 'copy', target, source });
  }
  if (setup.installCmd) {
    if (nodeModulesCovered) actions.push({ kind: 'skip', target: 'installCmd', reason: 'node_modules covered by linkDirs' });
    else actions.push({ kind: 'install', target: worktreePath, cmd: setup.installCmd });
  }
  if (Object.keys(setup.envPerLane).length) {
    if (!limb) actions.push({ kind: 'refuse', target: 'lane.env', reason: 'envPerLane is set but --limb is missing' });
    else {
      actions.push({
        kind: 'env',
        target: path.join(worktreePath, '.artibot', 'split', limb, 'lane.env'),
        content: renderLaneEnv(setup.envPerLane, limb),
      });
    }
  }
  return actions;
}

/**
 * Plan teardown: unlink reparse points only. Anything that exists but is not
 * a link is refused — this script does not know how to delete a directory and
 * must never learn.
 *
 * @param {object} input
 * @param {string} input.worktreePath
 * @param {ReturnType<typeof normalizeSetupConfig>} input.setup
 * @param {(p: string) => boolean} input.exists - true when the path exists (lstat succeeds)
 * @param {(p: string) => boolean} input.isLink - `fs.lstatSync(p).isSymbolicLink()`
 * @returns {Array<{ kind: 'unlink'|'skip'|'refuse', target: string, reason?: string }>}
 */
export function planWorktreeTeardown({ worktreePath, setup, exists, isLink }) {
  return setup.linkDirs.map((rel) => {
    const target = path.join(worktreePath, rel);
    if (!exists(target)) return { kind: 'skip', target, reason: 'absent' };
    if (!isLink(target)) return { kind: 'refuse', target, reason: 'not a reparse point — refusing; this script never deletes recursively' };
    return { kind: 'unlink', target };
  });
}

/** Real-filesystem side effects. Injectable for tests. */
export const realIo = Object.freeze({
  link(source, target) {
    // No shell: `cmd /c mklink` would receive `source`/`target` unquoted when
    // they contain `&` without spaces (review finding 2026-09-02). Node creates
    // NTFS junctions natively with type 'junction'.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (process.platform === 'win32') {
      fs.symlinkSync(source, target, 'junction');
      return 'junction (fs.symlinkSync)';
    }
    fs.symlinkSync(source, target, 'dir');
    return 'symlink';
  },
  copy(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    return 'copied';
  },
  install(cmd, cwd) {
    execFileSync(cmd[0], cmd.slice(1), { cwd, windowsHide: true, timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
    return `ran ${cmd.join(' ')}`;
  },
  writeEnv(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
    return 'written';
  },
  unlink(target) {
    // Re-checked at the moment of removal, not only at planning time.
    if (!fs.lstatSync(target).isSymbolicLink()) throw new Error(`${target} is not a reparse point — refusing`);
    // `rmdirSync` on a junction / directory symlink removes the link only
    // (host probe 2026-09-02: target intact). No shell fallback — a failure
    // here is reported, not retried through cmd.exe.
    try {
      fs.rmdirSync(target);
    } catch (err) {
      throw new Error(`rmdir failed on ${target}: ${err?.message ?? err}`, { cause: err });
    }
    return 'unlinked';
  },
});

/**
 * Apply planned actions. `skip`/`refuse` are reported, not executed.
 *
 * @param {ReturnType<typeof planWorktreeSetup>|ReturnType<typeof planWorktreeTeardown>} actions
 * @param {typeof realIo} [io=realIo]
 * @returns {Array<{ kind: string, target: string, status: 'done'|'skipped'|'refused'|'failed', detail: string }>}
 */
export function applyActions(actions, io = realIo) {
  return actions.map((a) => {
    if (a.kind === 'skip') return { kind: a.kind, target: a.target, status: 'skipped', detail: a.reason ?? '' };
    if (a.kind === 'refuse') return { kind: a.kind, target: a.target, status: 'refused', detail: a.reason ?? '' };
    try {
      let detail = '';
      if (a.kind === 'link') detail = io.link(a.source, a.target);
      else if (a.kind === 'copy') detail = io.copy(a.source, a.target);
      else if (a.kind === 'install') detail = io.install(a.cmd, a.target);
      else if (a.kind === 'env') detail = io.writeEnv(a.target, a.content);
      else if (a.kind === 'unlink') detail = io.unlink(a.target);
      else throw new Error(`unknown action kind ${a.kind}`);
      return { kind: a.kind, target: a.target, status: 'done', detail };
    } catch (e) {
      return { kind: a.kind, target: a.target, status: 'failed', detail: e.message };
    }
  });
}

/** Fixed-width summary table. */
export function renderTable(rows) {
  const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
  const cols = ['kind', 'status', 'target', 'detail'];
  const widths = Object.fromEntries(cols.map((c) => [c, w(c)]));
  const line = (r) => cols.map((c) => String(r[c]).padEnd(widths[c])).join('  ').trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join('\n');
}

/**
 * CLI entry. Returns exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, config?: object|null, io?: typeof realIo, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  if (!args.worktreePath) {
    err(`worktreePath is required\n${HELP}\n`);
    return 1;
  }
  let config = opts.config === undefined ? null : opts.config;
  if (opts.config === undefined) {
    try { config = await loadConfig(); } catch { config = null; }
  }
  const setup = normalizeSetupConfig(config?.split?.worktreeSetup);
  const parentRoot = path.resolve(args.parent ?? opts.cwd ?? process.cwd());
  const worktreePath = path.resolve(args.worktreePath);
  if (!fs.existsSync(worktreePath)) {
    err(`worktree missing: ${worktreePath} — open it first (claude --worktree <name>)\n`);
    return 1;
  }
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const actions = args.teardown
    ? planWorktreeTeardown({ worktreePath, setup, exists, isLink })
    : planWorktreeSetup({ parentRoot, worktreePath, limb: args.limb, setup, exists });
  const rows = args.dryRun
    ? actions.map((a) => ({ kind: a.kind, target: a.target, status: a.kind === 'refuse' ? 'refused' : 'planned', detail: a.reason ?? a.source ?? (a.cmd ? a.cmd.join(' ') : '') }))
    : applyActions(actions, opts.io ?? realIo);
  const bad = rows.filter((r) => r.status === 'refused' || r.status === 'failed');
  if (args.json) out(`${JSON.stringify({ worktreePath, parentRoot, teardown: args.teardown, dryRun: args.dryRun, rows, ok: bad.length === 0 }, null, 2)}\n`);
  else out(`${renderTable(rows)}\n${bad.length ? `${bad.length} refused/failed\n` : ''}`);
  return bad.length ? 1 : 0;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
