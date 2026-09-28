#!/usr/bin/env node
/**
 * Show, change and check the per-plugin model routing a user has chosen on top
 * of the shipped policy — the deterministic half of `/model-routing`.
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DOES NOT. Every "which model" answer comes
 * from `lib/core/model-overrides.js#resolveEffectiveModel`; this file only
 * parses arguments, loads the shipped config, reads and writes the user file,
 * diffs, prints and sets exit codes. No precedence rule is re-derived here.
 * Roster discovery (both `agents/` directories, frontmatter `model:`) and the
 * `show` table/JSON rendering live in the sibling `model-routing-roster.mjs`.
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
 * FAIL-CLOSED ON A DAMAGED USER FILE. `show`, `resolve` and `validate --live`
 * warn on stderr and fall back to the shipped values; `set` and `reset` refuse
 * and leave the file byte-identical — a corrupt file is never overwritten silently.
 *
 * `validate --live` — WAS THE EFFECTIVE ROUTING SERVED? It reads the central
 * ledger READ-ONLY (`lib/runtime/ledger.js#readLedgerCensus` is the only ledger
 * function imported; `appendLedgerEvent` deliberately is not), joins
 * `route.bound` to `usage.receipt` (`lib/replay/spawn-outcome.js`) and hands the
 * pairs to `lib/replay/routing-honor.js#foldRoutingHonor`, which owns every
 * verdict, reason and denominator — its CANNOT SEE list applies unchanged. Two
 * of those are printed as caveats: the expected tier is TODAY's config and
 * overrides of THIS plugin root (`pluginRoot`/`configPath` in the report; window
 * with `--since`, judge the installed copy with `--plugin-root`), and `honored` mostly means the frontmatter
 * default was served. `--cwd` is the LEDGER root and must be the REPOSITORY
 * ROOT: the path resolver does not walk upward, so a subdirectory such as the
 * plugin root reads `<cwd>/.artibot/runtime/ledger.jsonl`, usually absent (the
 * `scripts/ledger/existence-audit.mjs` trap). `inputPath` names the file read.
 *
 * USAGE
 *   node scripts/model-routing/model-routing.mjs <subcommand> [...]
 *     show [--plugin artibot|artibot-cowork|all] [--role build|review] [--json]
 *     set agent <plugin:name> <tier> [--dry-run]
 *     set phase <build|review> <tier> [--dry-run]
 *     set plugin <artibot|artibot-cowork> <tier> [--dry-run]
 *     reset agent <plugin:name> | phase <build|review> | plugin <name> | --all  [--dry-run]
 *     validate [--json]
 *     validate --live [--since <iso-with-Z-or-offset|epoch-ms>] [--cwd <projectRoot>] [--json]
 *       (all-digit --since is EPOCH MILLISECONDS, never a year; date-only is refused)
 *     resolve <plugin:name> [--role build|review]
 *   Every subcommand also takes --plugin-root <dir> and --cowork-root <dir>.
 *
 * EXIT CODES
 *   0 ok · 1 refused or validation errors (nothing written) · 2 usage error
 *   (unknown subcommand, flag, tier or agent; one stderr line, nothing written).
 *   `validate --live` is an observation: 0 whenever it printed, INCLUDING
 *   unhonored rows and a missing or unreadable ledger (they are data, not a
 *   CLI failure); 2 on a usage error such as an unparseable `--since`.
 *
 * ARTIBOT-COWORK ROSTER DISCOVERY — see `model-routing-roster.mjs` for the order;
 *   when no roster is found the cowork rows are `unavailable:roster-not-found`.
 *
 * @module scripts/model-routing/model-routing
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
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
import { resolveModelForPhase } from '../../lib/core/model-policy.js';
import { resolveModelIdentity } from '../../lib/economics/usage-receipt.js';
import { foldRoutingHonor } from '../../lib/replay/routing-honor.js';
import { joinSpawnOutcomes } from '../../lib/replay/spawn-outcome.js';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { isMainEntry } from '../hooks/_main-entry.js';
import { findCoworkAgentsDir, loadRosters, renderShowJson, renderShowText, renderTable } from './model-routing-roster.mjs';

const OWN_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  validate: { ...COMMON_FLAGS, json: false, live: false, since: true, cwd: true },
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
  const rosters = loadRosters(pluginRoot, flags['cowork-root']);
  // The cowork shipped value is its frontmatter, and only that: agents without a
  // `model:` line are left out so the resolver reports them as unknown.
  const coworkFrontmatter = Object.fromEntries(
    [...(rosters['artibot-cowork'] ?? [])].filter(([, model]) => model !== null),
  );
  const loaded = loadOverrides();
  return { pluginRoot, configPath, config, rosters, coworkFrontmatter, loaded, file: overridesPath() };
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
  // `plugins` keeps the selection order, which is also the text table's row order.
  const view = { file: ctx.file, overridesStatus: ctx.loaded.status, role, plugins: result, phases };
  process.stdout.write(flags.json ? renderShowJson(view) : renderShowText(view));
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

/** The two CANNOT SEE items of `routing-honor.js` every live report repeats. */
const LIVE_CAVEATS = Object.freeze([
  "expected tier = TODAY's config, rosters and overrides as read from the plugin root above, which may differ from the installed plugin that served the spawns — pass --plugin-root (and --cowork-root) to judge against the installed copy; a spawn from before the last change is judged against them — window with --since",
  'honored mostly means the frontmatter default was served; only an override-* row whose override differs from the frontmatter says anything about an override',
]);

/** Each rate of the fold → [numerator, denominator] as `denominators`/`verdicts` keys. */
const RATE_TERMS = Object.freeze({
  join_of_binds: ['joined', 'binds'],
  join_of_subagent_runs: ['joined', 'subagent_runs'],
  measured_of_joined: ['measured', 'joined'],
  honored_of_measured: ['honored', 'measured'],
});

/** ISO-8601 date-time with an EXPLICIT zone; date-only and zone-less forms are refused. */
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `--since` → epoch milliseconds. ALLOWLIST: all digits = epoch ms (never a
 * year), or {@link ISO_WITH_ZONE}. Everything else is a usage error — V8's
 * `Date.parse` alone would take `-1`, `123 ` and a zone-less time read as LOCAL
 * (9 h off in KST), and rolls `02-31`/`24:00` over; a date-only value is refused
 * rather than guessed as UTC or local midnight. An out-of-range ms, which the
 * ledger reader would silently ignore, is refused too.
 *
 * @param {string|true|undefined} value
 * @returns {number|null}
 */
function parseSince(value) {
  if (value === undefined) return null;
  const iso = ISO_WITH_ZONE.exec(value);
  const ms = /^\d+$/.test(value) ? Number(value) : iso ? Date.parse(value) : Number.NaN;
  const [, y, mo, d, h, mi] = iso ?? [];
  const wall = iso ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)) : null;
  const calendar = !iso || (wall.getUTCMonth() === +mo - 1 && wall.getUTCDate() === +d && wall.getUTCHours() === +h);
  if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime()) || !calendar) {
    throw new UsageError(`unparseable --since: ${value} (expected epoch milliseconds or an ISO date-time with Z or ±HH:MM)`);
  }
  return ms;
}

/**
 * The census line: which file was read, or why nothing was.
 *
 * @param {object} census - `readLedgerCensus().census`.
 * @returns {string}
 */
function ledgerLine(census) {
  const { file, lines, survivors, dropped_total: dropped } = census;
  if (!file.present) return `ledger absent: ${file.path ?? '(no path)'} — nothing to judge`;
  if (!file.readable) return `ledger unreadable: ${file.path} — nothing to judge`;
  return `ledger: ${file.path} (${file.bytes} bytes · ${lines.nonblank} lines · ${survivors} read · loss ${dropped.loss} · selected out ${dropped.selection})`;
}

/**
 * `validate --live` text: census, denominators, rates, verdicts, breakdowns,
 * every unhonored row, then the caveats. No clock — same ledger, same bytes.
 *
 * @param {object} report - `{ inputPath, since, census, overridesFile, overridesStatus, ...fold }`.
 * @returns {string}
 */
function renderLiveText(report) {
  const { denominators: den, rates, verdicts } = report;
  const terms = { ...den, ...verdicts };
  const rateRows = Object.entries(RATE_TERMS).map(([name, [num, of]]) => [
    name,
    `${terms[num]}/${terms[of]}`,
    rates[name] === null ? 'null (denominator 0)' : `${(rates[name] * 100).toFixed(1)}%`,
  ]);
  const counts = (obj) => Object.entries(obj).map(([k, n]) => `${k} ${n}`).join(' · ') || '(none)';
  const lines = [
    ledgerLine(report.census),
    `since: ${report.since ?? '(whole ledger)'}`,
    `judged against: plugin root ${report.pluginRoot} · config ${report.configPath} · cowork roster ${report.coworkAgentsDir ?? '(not found)'}`,
    `overrides: ${report.overridesFile} (${report.overridesStatus})`,
    `denominators: ${counts(den)}`,
    renderTable(['rate', 'n/d', 'value'], rateRows),
    `verdicts: ${counts(verdicts)}`,
    `unmeasured_by_reason: ${counts(report.unmeasured_by_reason)}`,
    `by_expected_source honored: ${counts(report.by_expected_source.honored)}`,
    `by_expected_source unhonored: ${counts(report.by_expected_source.unhonored)}`,
    ...report.rows
      .filter((r) => r.verdict === 'unhonored')
      .map(
        (r) =>
          `unhonored ${r.agent_type}: expected ${r.expected_tier} [${r.expected_source}${r.expected_gate ? `/${r.expected_gate}` : ''}] served ${r.served_tier} (${r.served_model}) · ${r.session_id}/${r.agent_id}`,
      ),
    ...LIVE_CAVEATS.map((c) => `caveat: ${c}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * `validate --live`: read the ledger (never write it), join, fold, print. Exit 0
 * whenever it printed — unhonored rows and a missing ledger are data.
 *
 * @param {Record<string, string|true>} flags
 * @returns {number}
 */
function cmdValidateLive(flags) {
  const since = parseSince(flags.since);
  const ctx = loadContext(flags);
  const overrides = effectiveOverrides(ctx);
  const opts = { config: ctx.config, overrides, coworkFrontmatter: ctx.coworkFrontmatter };
  // Only the rosters that loaded: a missing cowork roster leaves its names out,
  // so those spawns read `agent-not-in-roster`, never a guessed verdict.
  const roster = PLUGIN_NAMES.flatMap((p) => [...(ctx.rosters[p]?.keys() ?? [])].map((a) => `${p}:${a}`));
  const { events, census } = readLedgerCensus(path.resolve(flags.cwd ?? process.cwd()), since === null ? {} : { since });
  const fold = foldRoutingHonor(joinSpawnOutcomes(events), {
    resolve: (name) => resolveEffectiveModel(name, {}, opts),
    tierOfServedModel: (id) => resolveModelIdentity(id)?.tier ?? null,
    roster,
  });
  const report = {
    inputPath: census.file.path,
    since: since === null ? null : new Date(since).toISOString(),
    // What the expected side was read from — not necessarily the installed plugin.
    pluginRoot: ctx.pluginRoot,
    configPath: ctx.configPath,
    coworkAgentsDir: findCoworkAgentsDir(ctx.pluginRoot, flags['cowork-root']),
    census,
    overridesFile: ctx.file,
    overridesStatus: ctx.loaded.status,
    caveats: LIVE_CAVEATS,
    ...fold,
  };
  process.stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderLiveText(report));
  return 0;
}

/**
 * `validate`: exit 1 when the file is damaged or has errors. `--live` is the
 * served-routing report instead; `--since`/`--cwd` belong to it alone.
 *
 * @param {string[]} argv
 * @returns {number}
 */
function cmdValidate(argv) {
  const { positionals, flags } = parseFlags(argv, FLAGS.validate);
  if (positionals.length > 0) throw new UsageError(`validate takes no arguments, got: ${positionals[0]}`);
  if (flags.live) return cmdValidateLive(flags);
  const stray = ['since', 'cwd'].find((f) => flags[f] !== undefined);
  if (stray) throw new UsageError(`--${stray} is only valid with --live`);
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
