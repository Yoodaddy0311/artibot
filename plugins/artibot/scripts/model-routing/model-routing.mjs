#!/usr/bin/env node
/**
 * Show, change and check the per-plugin model routing a user has chosen on top
 * of the shipped policy — the deterministic half of `/model-routing`.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT. Every "which model" answer comes
 * from `lib/core/model-overrides.js#resolveEffectiveModel`; this file only
 * enumerates the two agent rosters, loads the shipped config, reads and writes
 * the user file, and prints. No precedence rule is re-derived here.
 *
 * THE SHIPPED CONFIG IS LOADED EXPLICITLY. `<pluginRoot>/artibot.config.json` is
 * read directly and handed to every resolver call. User overrides are NEVER
 * merged into `loadConfig()`: the CI drift gate and the routebench baselines read
 * that config, and a developer machine's override must not leak into either.
 *
 * THE SETTING ONLY TAKES EFFECT WHEN THE LEADER PASSES IT. The host spawns a
 * plugin agent on its frontmatter `model:` unless the spawn call carries a
 * `model` parameter. So every row whose effective model differs from its
 * frontmatter says `needs-spawn-param`: the value is real only if the leader
 * spawns with `Agent(model=<resolve output>)`.
 *
 * FAIL-CLOSED ON A DAMAGED USER FILE. `show` and `resolve` warn on stderr and
 * fall back to the shipped values; `set` and `reset` refuse and leave the file
 * byte-identical — a corrupt file is never overwritten silently.
 *
 * USAGE
 *   node scripts/model-routing/model-routing.mjs <subcommand> [...]
 *     show [--plugin artibot|artibot-cowork|all] [--role build|review] [--json]
 *     set agent <plugin:name> <tier> [--dry-run]
 *     set phase <build|review> <tier> [--dry-run]
 *     set plugin <artibot|artibot-cowork> <tier> [--dry-run]
 *     reset agent <plugin:name> | phase <build|review> | plugin <name> | --all  [--dry-run]
 *     validate [--json]
 *     resolve <plugin:name> [--role build|review]
 *   Every subcommand also takes --plugin-root <dir> and --cowork-root <dir>.
 *
 * EXIT CODES
 *   0 ok · 1 refused or validation errors (nothing written) · 2 usage error
 *   (unknown subcommand, flag, tier or agent; one stderr line, nothing written).
 *
 * ARTIBOT-COWORK ROSTER DISCOVERY (first hit wins, never guessed)
 *   --cowork-root <dir>/agents, else the dev tree `<pluginRoot>/../artibot-cowork/agents`,
 *   else the plugin cache `<pluginRoot>/../../artibot-cowork/<highest semver>/agents`.
 *   None of them → the cowork rows are `unavailable:roster-not-found`.
 *
 * @module scripts/model-routing/model-routing
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from '../../lib/core/file.js';
import {
  allowedTiersFor,
  clearAll,
  clearOverride,
  emptyOverrides,
  loadOverrides,
  overridesPath,
  PLUGIN_NAMES,
  qualifyAgent,
  resolveEffectiveModel,
  setOverride,
  validateOverrides,
} from '../../lib/core/model-overrides.js';
import { listTiers } from '../../lib/core/model-catalog.js';
import { resolveModelForPhase } from '../../lib/core/model-policy.js';
import { extractFrontmatter } from '../ci/ci-utils.js';
import { isMainEntry } from '../hooks/_main-entry.js';

const OWN_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Files under agents/ that are catalogs, not agent definitions. */
const NON_AGENT_FILES = new Set(['INDEX.md', 'README.md']);

/** CLI phase words → the resolver's phase-role vocabulary. */
const PHASES = Object.freeze(['build', 'review']);

/** Roles every write diffs against: no role, then each phase. */
const DIFF_ROLES = Object.freeze([null, 'build', 'review']);

/** Flags each subcommand accepts; `true` = takes a value. Anything else is exit 2. */
const COMMON_FLAGS = { 'plugin-root': true, 'cowork-root': true };
const FLAGS = Object.freeze({
  show: { ...COMMON_FLAGS, plugin: true, role: true, json: false },
  set: { ...COMMON_FLAGS, 'dry-run': false },
  reset: { ...COMMON_FLAGS, 'dry-run': false, all: false },
  validate: { ...COMMON_FLAGS, json: false },
  resolve: { ...COMMON_FLAGS, role: true },
});

/** A usage error: one stderr line, exit 2, nothing written. */
class UsageError extends Error {}

/** A refusal: one or more stderr lines, exit 1, nothing written. */
class Refusal extends Error {}

/**
 * Split argv into positionals and flags, rejecting flags the subcommand does not
 * know. Allowlist on purpose: a misspelt `--dryrun` must not silently write.
 *
 * @param {string[]} argv - Arguments after the subcommand.
 * @param {Record<string, boolean>} known - Flag name → takes a value.
 * @returns {{ positionals: string[], flags: Record<string, string|true> }}
 */
function parseFlags(argv, known) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (!Object.hasOwn(known, name)) throw new UsageError(`unknown flag: --${name}`);
    if (!known[name]) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positionals, flags };
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Agent name → frontmatter `model:` for one `agents/` directory. A leading BOM
 * and surrounding quotes are stripped; anything that is not a catalog tier
 * (absent, `inherit`, a typo) is null — unknown, never guessed.
 *
 * @param {string} agentsDir
 * @returns {Map<string, string|null>}
 */
function readRoster(agentsDir) {
  const tiers = listTiers();
  const roster = new Map();
  const files = readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md') && !NON_AGENT_FILES.has(f))
    .sort();
  for (const file of files) {
    const text = readFileSync(path.join(agentsDir, file), 'utf8');
    const fm = extractFrontmatter(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const raw = fm && typeof fm.model === 'string' ? fm.model.trim().replace(/^(["'])(.*)\1$/, '$2') : null;
    roster.set(path.basename(file, '.md'), tiers.includes(raw) ? raw : null);
  }
  return roster;
}

/**
 * Numeric compare of two `x.y.z` version directory names.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemver(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Locate the artibot-cowork `agents/` directory (see the module header for the
 * order). Returns null when none exists — the caller reports that, never guesses.
 *
 * @param {string} pluginRoot
 * @param {string|undefined} coworkRoot - Explicit `--cowork-root`, exclusive when given.
 * @returns {string|null}
 */
function findCoworkAgentsDir(pluginRoot, coworkRoot) {
  if (coworkRoot) {
    const dir = path.join(path.resolve(coworkRoot), 'agents');
    return isDirectory(dir) ? dir : null;
  }
  const devTree = path.join(pluginRoot, '..', 'artibot-cowork', 'agents');
  if (isDirectory(devTree)) return path.resolve(devTree);
  const cacheBase = path.join(pluginRoot, '..', '..', 'artibot-cowork');
  if (!isDirectory(cacheBase)) return null;
  const versions = readdirSync(cacheBase)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && isDirectory(path.join(cacheBase, v, 'agents')))
    .sort(compareSemver);
  if (versions.length === 0) return null;
  return path.resolve(cacheBase, versions[versions.length - 1], 'agents');
}

/**
 * Everything a subcommand needs: plugin root, SHIPPED config, both rosters, and
 * the user overrides file as loaded (status included, so callers decide how to
 * treat a damaged file).
 *
 * @param {Record<string, string|true>} flags
 * @returns {object}
 */
function loadContext(flags) {
  const pluginRoot = path.resolve(flags['plugin-root'] ?? OWN_PLUGIN_ROOT);
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Refusal(`cannot read the shipped config ${configPath}: ${err?.message ?? err}`);
  }
  const artibotDir = path.join(pluginRoot, 'agents');
  const coworkDir = findCoworkAgentsDir(pluginRoot, flags['cowork-root']);
  const rosters = {
    artibot: isDirectory(artibotDir) ? readRoster(artibotDir) : null,
    'artibot-cowork': coworkDir ? readRoster(coworkDir) : null,
  };
  // The cowork shipped value is its frontmatter, and only that: agents without a
  // `model:` line are left out so the resolver reports them as unknown.
  const coworkFrontmatter = Object.fromEntries(
    [...(rosters['artibot-cowork'] ?? [])].filter(([, model]) => model !== null),
  );
  const loaded = loadOverrides();
  return { pluginRoot, config, rosters, coworkFrontmatter, loaded, file: overridesPath() };
}

/**
 * The overrides to resolve with: the user's when the file loaded cleanly, else
 * empty (shipped values). A damaged file prints its warning here, on stderr, so
 * `show`/`resolve`/`validate` can never fall back silently.
 *
 * @param {object} ctx
 * @returns {object}
 */
function effectiveOverrides(ctx) {
  const { status, errors, path: file } = ctx.loaded;
  if (status === 'ok') return ctx.loaded.overrides;
  if (status === 'malformed' || status === 'unreadable') {
    const detail = Array.isArray(errors) && errors.length > 0 ? `: ${errors.join('; ')}` : '';
    process.stderr.write(
      `warning: model-routing overrides file ${file} is ${status}${detail} — IGNORED, shipped values shown\n`,
    );
  }
  return emptyOverrides();
}

/**
 * @param {string|null} role - 'build'|'review'|null
 * @returns {object}
 */
function roleOpts(role) {
  return role ? { role } : {};
}

/**
 * Resolve one agent through the single source of truth.
 *
 * @param {object} ctx
 * @param {string} plugin
 * @param {string} agent
 * @param {string|null} role
 * @param {object} overrides
 * @returns {{ model: string, source: string, reason: string|null }}
 */
function resolveRow(ctx, plugin, agent, role, overrides) {
  return resolveEffectiveModel(`${plugin}:${agent}`, roleOpts(role), {
    config: ctx.config,
    overrides,
    coworkFrontmatter: ctx.coworkFrontmatter,
  });
}

/**
 * Every row of one plugin, or an `unavailable` marker when its roster is missing.
 *
 * @param {object} ctx
 * @param {string} plugin
 * @param {string|null} role
 * @param {object} overrides
 * @returns {{ status: string, reason?: string, rows?: object[] }}
 */
function pluginRows(ctx, plugin, role, overrides) {
  const roster = ctx.rosters[plugin];
  if (!roster) return { status: 'unavailable', reason: 'roster-not-found' };
  const shippedLayer = emptyOverrides();
  const rows = [...roster].map(([agent, frontmatter]) => {
    const shipped = resolveRow(ctx, plugin, agent, role, shippedLayer);
    const effective = resolveRow(ctx, plugin, agent, role, overrides);
    return {
      plugin,
      agent,
      frontmatter,
      shipped: shipped.model,
      // The user pick the resolver applied (before gates), labelled by its scope.
      override: effective.scope ? `${effective.requested} (${effective.scope})` : null,
      effective: effective.model,
      source: effective.source,
      reason: effective.reason ?? null,
      hostPath: effective.model === frontmatter ? 'frontmatter' : 'needs-spawn-param',
    };
  });
  return { status: 'ok', rows };
}

/**
 * Validate a `--plugin` value and expand `all`.
 *
 * @param {string|true|undefined} value
 * @returns {string[]}
 */
function selectPlugins(value) {
  if (value === undefined || value === 'all') return [...PLUGIN_NAMES];
  if (PLUGIN_NAMES.includes(value)) return [value];
  throw new UsageError(`unknown plugin: ${value} (expected ${PLUGIN_NAMES.join('|')}|all)`);
}

/**
 * @param {string|true|undefined} value
 * @returns {string|null}
 */
function parseRole(value) {
  if (value === undefined) return null;
  if (PHASES.includes(value)) return value;
  throw new UsageError(`unknown role: ${value} (expected ${PHASES.join('|')})`);
}

/**
 * Plain-text table, column-aligned.
 *
 * @param {string[]} header
 * @param {string[][]} body
 * @returns {string}
 */
function renderTable(header, body) {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

/**
 * @param {object} row
 * @returns {string[]}
 */
function rowCells(row) {
  const why = row.reason ? `${row.source}/${row.reason}` : row.source;
  return [
    row.plugin,
    row.agent,
    row.frontmatter ?? '(unknown)',
    row.shipped,
    row.override ?? '—',
    `${row.effective ?? '(unknown)'} [${why}]`,
    row.hostPath,
  ];
}

/**
 * `show`: one row per agent plus the artibot phase-role block.
 *
 * @param {string[]} argv
 * @returns {number}
 */
function cmdShow(argv) {
  const { positionals, flags } = parseFlags(argv, FLAGS.show);
  if (positionals.length > 0) throw new UsageError(`show takes no arguments, got: ${positionals[0]}`);
  const plugins = selectPlugins(flags.plugin);
  const role = parseRole(flags.role);
  const ctx = loadContext(flags);
  const overrides = effectiveOverrides(ctx);
  const result = Object.fromEntries(plugins.map((p) => [p, pluginRows(ctx, p, role, overrides)]));
  const phases = PHASES.map((side) => ({
    phase: side,
    shipped: resolveModelForPhase(side, ctx.config),
    override: overrides?.plugins?.artibot?.phaseRoles?.[side] ?? null,
  }));
  if (flags.json) {
    const out = {
      file: ctx.file,
      overridesStatus: ctx.loaded.status,
      role,
      plugins: result,
      phases,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const header = ['plugin', 'agent', 'frontmatter', 'shipped', 'override', 'effective', 'host path'];
  const body = [];
  const notes = [];
  for (const plugin of plugins) {
    const entry = result[plugin];
    if (entry.status === 'ok') body.push(...entry.rows.map(rowCells));
    else notes.push(`${plugin}: unavailable:${entry.reason}`);
  }
  const lines = [
    `overrides: ${ctx.file} (${ctx.loaded.status})${role ? ` · role=${role}` : ''}`,
    renderTable(header, body),
    ...notes,
    'phase roles (artibot): ' +
      phases.map((p) => `${p.phase}=${p.shipped}${p.override ? ` → user ${p.override}` : ''}`).join(' · '),
    'needs-spawn-param = the value takes effect only if the leader spawns with Agent(model=<resolve output>).',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * Parse `<plugin:name>`, rejecting a bare name. The message names both plugins
 * when the bare name exists in both rosters, so the user sees why it matters.
 *
 * @param {object} ctx
 * @param {string|undefined} raw
 * @returns {{ plugin: string, agent: string, qualified: string }}
 */
function requireQualified(ctx, raw) {
  if (!raw) throw new UsageError('missing agent name (expected <plugin:name>)');
  const q = qualifyAgent(raw);
  if (q === null) throw new UsageError(`not an agent name: '${raw}' (expected <plugin:name>)`);
  if (q.qualified) return { plugin: q.plugin, agent: q.agent, qualified: `${q.plugin}:${q.agent}` };
  const owners = PLUGIN_NAMES.filter((p) => ctx.rosters[p]?.has(q.agent));
  if (owners.length > 1) {
    throw new UsageError(
      `ambiguous agent name '${raw}': it exists in ${owners.join(' and ')} — use ${owners
        .map((p) => `${p}:${q.agent}`)
        .join(' or ')}`,
    );
  }
  const hint = owners.length === 1 ? ` — use ${owners[0]}:${q.agent}` : '';
  throw new UsageError(`agent name must be qualified as <plugin:name>, got '${raw}'${hint}`);
}

/**
 * Reject an agent the plugin's roster does not list (or cannot be read).
 *
 * @param {object} ctx
 * @param {{ plugin: string, agent: string, qualified: string }} q
 */
function requireKnownAgent(ctx, q) {
  const roster = ctx.rosters[q.plugin];
  if (!roster) throw new UsageError(`cannot verify ${q.qualified}: ${q.plugin} roster not found`);
  if (!roster.has(q.agent)) throw new UsageError(`unknown agent: ${q.qualified}`);
}

/**
 * A tier the user may set now (core `allowedTiersFor`: fable only while the
 * shipped gate is on). Aliases are never accepted.
 *
 * @param {object} config
 * @param {string|undefined} tier
 * @returns {string}
 */
function requireTier(config, tier) {
  const allowed = allowedTiersFor(config);
  if (!tier) throw new UsageError(`missing tier (expected ${allowed.join('|')})`);
  if (!allowed.includes(tier)) {
    const why = tier === 'fable' ? ' — the fable gate is off in the shipped config' : '';
    throw new UsageError(`unknown tier: ${tier} (expected ${allowed.join('|')})${why}`);
  }
  return tier;
}

/**
 * @param {string|undefined} phase
 * @returns {string}
 */
function requirePhase(phase) {
  if (!PHASES.includes(phase)) throw new UsageError(`unknown phase: ${phase} (expected ${PHASES.join('|')})`);
  return phase;
}

/**
 * @param {string|undefined} plugin
 * @returns {string}
 */
function requirePlugin(plugin) {
  if (!PLUGIN_NAMES.includes(plugin)) {
    throw new UsageError(`unknown plugin: ${plugin} (expected ${PLUGIN_NAMES.join('|')})`);
  }
  return plugin;
}

/**
 * Turn a `set` command line into a setOverride spec.
 *
 * @param {object} ctx
 * @param {string[]} positionals
 * @returns {object}
 */
function parseSetSpec(ctx, positionals) {
  const [scope, target, tier, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  if (scope === 'agent') {
    const q = requireQualified(ctx, target);
    requireKnownAgent(ctx, q);
    return { scope, plugin: q.plugin, key: q.agent, tier: requireTier(ctx.config, tier) };
  }
  if (scope === 'phase') {
    return { scope, plugin: 'artibot', key: requirePhase(target), tier: requireTier(ctx.config, tier) };
  }
  if (scope === 'plugin') {
    return { scope, plugin: requirePlugin(target), tier: requireTier(ctx.config, tier) };
  }
  throw new UsageError(`unknown set scope: ${scope} (expected agent|phase|plugin)`);
}

/**
 * Turn a `reset` command line into a clear spec, or `{ all: true }`.
 *
 * @param {object} ctx
 * @param {string[]} positionals
 * @param {Record<string, string|true>} flags
 * @returns {object}
 */
function parseResetSpec(ctx, positionals, flags) {
  if (flags.all) {
    if (positionals.length > 0) throw new UsageError('reset --all takes no other arguments');
    return { all: true };
  }
  const [scope, target, extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  if (scope === 'agent') {
    const q = requireQualified(ctx, target);
    return { scope, plugin: q.plugin, key: q.agent };
  }
  if (scope === 'phase') return { scope, plugin: 'artibot', key: requirePhase(target) };
  if (scope === 'plugin') return { scope, plugin: requirePlugin(target) };
  throw new UsageError(`unknown reset scope: ${scope} (expected agent|phase|plugin|--all)`);
}

/**
 * Before→after EFFECTIVE values across every agent and role. A qualified name
 * whose three role variants changed identically prints once.
 *
 * @param {object} ctx
 * @param {object} before
 * @param {object} after
 * @returns {string[]}
 */
function effectiveDiff(ctx, before, after) {
  const lines = [];
  for (const plugin of PLUGIN_NAMES) {
    const roster = ctx.rosters[plugin];
    if (!roster) continue;
    for (const agent of roster.keys()) {
      const changes = DIFF_ROLES.map((role) => ({
        role,
        from: resolveRow(ctx, plugin, agent, role, before).model,
        to: resolveRow(ctx, plugin, agent, role, after).model,
      })).filter((c) => c.from !== c.to);
      if (changes.length === 0) continue;
      const uniform =
        changes.length === DIFF_ROLES.length &&
        changes.every((c) => c.from === changes[0].from && c.to === changes[0].to);
      if (uniform) lines.push(`  ${plugin}:${agent}: ${changes[0].from} → ${changes[0].to}`);
      else {
        for (const c of changes) {
          lines.push(`  ${plugin}:${agent} [role=${c.role ?? 'none'}]: ${c.from} → ${c.to}`);
        }
      }
    }
  }
  return lines;
}

/**
 * Shared write path for `set`/`reset`: refuse a damaged file, diff, then (unless
 * `--dry-run`) back up the previous file to `.bak` and write atomically.
 *
 * @param {object} ctx
 * @param {(current: object) => object} change - Pure; returns the next object.
 * @param {boolean} dryRun
 * @returns {Promise<number>}
 */
async function applyWrite(ctx, change, dryRun) {
  const { status, errors } = ctx.loaded;
  if (status === 'malformed' || status === 'unreadable') {
    const detail = Array.isArray(errors) && errors.length > 0 ? `: ${errors.join('; ')}` : '';
    throw new Refusal(
      `refusing to write: ${ctx.file} is ${status}${detail}. Fix or remove it by hand; nothing was changed.`,
    );
  }
  const before = status === 'ok' ? ctx.loaded.overrides : emptyOverrides();
  let after;
  try {
    after = change(before);
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
  // `load` mode on the whole document: setOverride already applied the strict
  // (gate-aware) rule to the one new value, and a stored fable pick the gate now
  // refuses must not block an unrelated set/reset — it stays, demoted on read.
  const check = validateOverrides(after, { mode: 'load' });
  if (!check.ok) throw new Refusal(`refusing to write an invalid result: ${check.errors.join('; ')}`);
  const diff = effectiveDiff(ctx, before, after);
  const out = [`effective changes (${diff.length === 0 ? 'none' : diff.length}):`, ...diff];
  if (dryRun) {
    out.push(`dry-run: nothing written (${ctx.file})`);
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }
  if (existsSync(ctx.file)) copyFileSync(ctx.file, `${ctx.file}.bak`);
  // setOverride/clearOverride keep the old stamp on purpose; the writer owns it.
  await atomicWriteJson(ctx.file, { ...after, updatedAt: new Date().toISOString() });
  out.push(`written: ${ctx.file}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function cmdSet(argv) {
  const { positionals, flags } = parseFlags(argv, FLAGS.set);
  const ctx = loadContext(flags);
  const spec = parseSetSpec(ctx, positionals);
  return applyWrite(
    ctx,
    (current) => setOverride(current, { ...spec, config: ctx.config }),
    flags['dry-run'] === true,
  );
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function cmdReset(argv) {
  const { positionals, flags } = parseFlags(argv, FLAGS.reset);
  const ctx = loadContext(flags);
  const spec = parseResetSpec(ctx, positionals, flags);
  if (ctx.loaded.status === 'absent') {
    process.stdout.write(`no overrides file (${ctx.file}); nothing to reset\n`);
    return 0;
  }
  const change = spec.all ? () => clearAll() : (current) => clearOverride(current, spec);
  return applyWrite(ctx, change, flags['dry-run'] === true);
}

/**
 * Findings for a cleanly loaded file (the schema already passed in `load`):
 * unknown agents, settings a gate demotes, and rows that need the spawn parameter.
 *
 * @param {object} ctx
 * @returns {{ errors: string[], warnings: string[], needsSpawnParam: string[] }}
 */
function collectFindings(ctx) {
  const overrides = ctx.loaded.overrides;
  const errors = [];
  const warnings = [];
  const needsSpawnParam = [];
  for (const plugin of PLUGIN_NAMES) {
    const roster = ctx.rosters[plugin];
    const named = Object.keys(overrides?.plugins?.[plugin]?.agents ?? {});
    if (!roster) {
      if (named.length > 0) warnings.push(`${plugin}: roster not found — ${named.length} agent override(s) unverified`);
      continue;
    }
    for (const agent of named) {
      if (!roster.has(agent)) errors.push(`unknown agent: ${plugin}:${agent}`);
    }
    for (const agent of roster.keys()) {
      for (const role of DIFF_ROLES) {
        const r = resolveRow(ctx, plugin, agent, role, overrides);
        const tag = `${plugin}:${agent}${role ? ` [role=${role}]` : ''}`;
        if (r.scope && r.reason) warnings.push(`${tag}: ${r.requested} demoted to ${r.model} (${r.reason})`);
        if (role === null && r.model !== roster.get(agent)) {
          needsSpawnParam.push(`${tag}: effective ${r.model} ≠ frontmatter ${roster.get(agent) ?? '(unknown)'}`);
        }
      }
    }
  }
  return { errors, warnings, needsSpawnParam };
}

/**
 * `validate`: exit 1 when the file is damaged or has errors.
 *
 * @param {string[]} argv
 * @returns {number}
 */
function cmdValidate(argv) {
  const { positionals, flags } = parseFlags(argv, FLAGS.validate);
  if (positionals.length > 0) throw new UsageError(`validate takes no arguments, got: ${positionals[0]}`);
  const ctx = loadContext(flags);
  const { status } = ctx.loaded;
  let findings = { errors: [], warnings: [], needsSpawnParam: [] };
  if (status === 'malformed' || status === 'unreadable') {
    findings.errors = [`${ctx.file} is ${status}`, ...(ctx.loaded.errors ?? [])];
  } else if (status === 'ok') {
    findings = collectFindings(ctx);
  }
  const exit = findings.errors.length > 0 ? 1 : 0;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ file: ctx.file, status, ...findings }, null, 2)}\n`);
    return exit;
  }
  const lines = [`overrides: ${ctx.file} (${status})`];
  if (status === 'absent') lines.push('no overrides file — the shipped policy is in force');
  for (const e of findings.errors) lines.push(`ERROR ${e}`);
  for (const w of findings.warnings) lines.push(`WARN  ${w}`);
  for (const n of findings.needsSpawnParam) lines.push(`needs-spawn-param ${n}`);
  lines.push(exit === 0 ? 'valid' : `invalid (${findings.errors.length} error(s))`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return exit;
}

/**
 * `resolve`: exactly one model string and a newline on stdout.
 *
 * @param {string[]} argv
 * @returns {number}
 */
function cmdResolve(argv) {
  const { positionals, flags } = parseFlags(argv, FLAGS.resolve);
  if (positionals.length !== 1) throw new UsageError('resolve takes exactly one <plugin:name>');
  const role = parseRole(flags.role);
  const ctx = loadContext(flags);
  const q = requireQualified(ctx, positionals[0]);
  requireKnownAgent(ctx, q);
  const overrides = effectiveOverrides(ctx);
  const { model, source } = resolveRow(ctx, q.plugin, q.agent, role, overrides);
  if (typeof model !== 'string') throw new Refusal(`cannot resolve ${q.qualified}: ${source}`);
  process.stdout.write(`${model}\n`);
  return 0;
}

const COMMANDS = Object.freeze({
  show: cmdShow,
  set: cmdSet,
  reset: cmdReset,
  validate: cmdValidate,
  resolve: cmdResolve,
});

/**
 * @param {string[]} argv - Arguments after the script path.
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv) {
  const [sub, ...rest] = argv;
  try {
    const cmd = Object.hasOwn(COMMANDS, sub ?? '') ? COMMANDS[sub] : null;
    if (!cmd) throw new UsageError(`unknown subcommand: ${sub ?? '(none)'} (expected ${Object.keys(COMMANDS).join('|')})`);
    return await cmd(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`model-routing: ${err.message}\n`);
      return 2;
    }
    if (err instanceof Refusal) {
      process.stderr.write(`model-routing: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`model-routing: unexpected failure: ${err?.message ?? err}\n`);
    return 1;
  }
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  process.exitCode = await main(argv);
}
