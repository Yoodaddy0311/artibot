/**
 * Change specs for `model-routing.mjs`: argument validation for `set`, `reset`
 * and `apply`, the TASK (action-class) scope, and the `show` task summary.
 *
 * WHAT LIVES HERE. Everything that turns user input into
 * `setOverride`/`clearOverride` specs, so the three writers share one set of
 * validators and one set of error texts: `apply` checks each change with the
 * very function `set`/`reset` use on a command line. Specs carry `tier` — a
 * string sets, null clears — and {@link applySpecs} folds them into a document.
 * No process, argv, exit code or stdout/stderr here, and no main entry; the CLI
 * maps {@link UsageError} to exit 2 and {@link Refusal} to exit 1.
 *
 * THE TASK VOCABULARY IS NOT RE-LISTED. It is
 * `lib/routing/action-classifier.js#ACTION_CLASSES`, imported. An agent's
 * DEFAULT task is `getActionClassForAgent` from the same module (the
 * `AGENT_ACTION_CLASS` table; null for an exempt or unmapped agent — that agent
 * has no task layer). The core resolver derives no default task (lib/core may
 * not import lib/routing), so every CLI resolve passes one via {@link rowTask}.
 *
 * @module scripts/model-routing/model-routing-task
 */

import { readFileSync } from 'node:fs';
import {
  allowedTiersFor,
  clearOverride,
  emptyOverrides,
  PLUGIN_NAMES,
  qualifyAgent,
  setOverride,
} from '../../lib/core/model-overrides.js';
import { ACTION_CLASSES, AGENT_CLASS_EXEMPT, getActionClassForAgent } from '../../lib/routing/action-classifier.js';

/** A usage error: one stderr line, exit 2, nothing written. */
export class UsageError extends Error {}

/** A refusal: one or more stderr lines, exit 1, nothing written. */
export class Refusal extends Error {}

/** CLI phase words → the resolver's phase-role vocabulary. */
export const PHASES = Object.freeze(['build', 'review']);

/** Scopes an `apply` change may name. */
const APPLY_SCOPES = Object.freeze(['agent', 'task', 'phase', 'plugin']);

/** Keys an `apply` change may carry (allowlist: anything else is an invalid change). */
const CHANGE_KEYS = Object.freeze(['scope', 'plugin', 'key', 'tier']);

/**
 * Validate a `--plugin` value and expand `all`.
 *
 * @param {string|true|undefined} value
 * @returns {string[]}
 */
export function selectPlugins(value) {
  if (value === undefined || value === 'all') return [...PLUGIN_NAMES];
  if (PLUGIN_NAMES.includes(value)) return [value];
  throw new UsageError(`unknown plugin: ${value} (expected ${PLUGIN_NAMES.join('|')}|all)`);
}

/**
 * Parse `<plugin:name>`, rejecting a bare name. The message names both plugins
 * when the bare name exists in both rosters, so the user sees why it matters.
 *
 * @param {object} ctx
 * @param {string|undefined} raw
 * @returns {{ plugin: string, agent: string, qualified: string }}
 */
export function requireQualified(ctx, raw) {
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
export function requireKnownAgent(ctx, q) {
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
export function requireTier(config, tier) {
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
export function requirePhase(phase) {
  if (!PHASES.includes(phase)) throw new UsageError(`unknown phase: ${phase} (expected ${PHASES.join('|')})`);
  return phase;
}

/**
 * @param {string|undefined} plugin
 * @returns {string}
 */
export function requirePlugin(plugin) {
  if (!PLUGIN_NAMES.includes(plugin)) {
    throw new UsageError(`unknown plugin: ${plugin} (expected ${PLUGIN_NAMES.join('|')})`);
  }
  return plugin;
}

/**
 * One of the eight action classes, exactly as spelled in `ACTION_CLASSES`.
 *
 * @param {string|true|undefined} task
 * @returns {string}
 */
export function requireTask(task) {
  const expected = `(expected ${ACTION_CLASSES.join('|')})`;
  if (task === undefined) throw new UsageError(`missing task ${expected}`);
  if (!ACTION_CLASSES.includes(task)) throw new UsageError(`unknown task: ${task} ${expected}`);
  return task;
}

/**
 * `--plugin` is a task-scope flag only; on any other scope it stays exactly the
 * unknown-flag error it was before the task scope existed.
 *
 * @param {string} scope
 * @param {Record<string, string|true>} flags
 */
function rejectPluginFlagOutsideTask(scope, flags) {
  if (scope !== 'task' && flags.plugin !== undefined) throw new UsageError('unknown flag: --plugin');
}

/**
 * Turn a `set` command line into specs (one per plugin for the task scope).
 *
 * @param {object} ctx
 * @param {string[]} positionals
 * @param {Record<string, string|true>} [flags]
 * @returns {object[]}
 */
export function parseSetSpec(ctx, positionals, flags = {}) {
  const [scope, target, tier, extra] = positionals;
  rejectPluginFlagOutsideTask(scope, flags);
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  if (scope === 'agent') {
    const q = requireQualified(ctx, target);
    requireKnownAgent(ctx, q);
    return [{ scope, plugin: q.plugin, key: q.agent, tier: requireTier(ctx.config, tier) }];
  }
  if (scope === 'task') {
    const key = requireTask(target);
    const picked = requireTier(ctx.config, tier);
    return selectPlugins(flags.plugin).map((plugin) => ({ scope, plugin, key, tier: picked }));
  }
  if (scope === 'phase') {
    return [{ scope, plugin: 'artibot', key: requirePhase(target), tier: requireTier(ctx.config, tier) }];
  }
  if (scope === 'plugin') {
    return [{ scope, plugin: requirePlugin(target), tier: requireTier(ctx.config, tier) }];
  }
  throw new UsageError(`unknown set scope: ${scope} (expected agent|task|phase|plugin)`);
}

/**
 * Turn a `reset` command line into clear specs (`tier: null`), or `{ all: true }`.
 *
 * @param {object} ctx
 * @param {string[]} positionals
 * @param {Record<string, string|true>} flags
 * @returns {object[]|{ all: true }}
 */
export function parseResetSpec(ctx, positionals, flags) {
  if (flags.all) {
    rejectPluginFlagOutsideTask('--all', flags);
    if (positionals.length > 0) throw new UsageError('reset --all takes no other arguments');
    return { all: true };
  }
  const [scope, target, extra] = positionals;
  rejectPluginFlagOutsideTask(scope, flags);
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  if (scope === 'agent') {
    const q = requireQualified(ctx, target);
    return [{ scope, plugin: q.plugin, key: q.agent, tier: null }];
  }
  if (scope === 'task') {
    const key = requireTask(target);
    return selectPlugins(flags.plugin).map((plugin) => ({ scope, plugin, key, tier: null }));
  }
  if (scope === 'phase') return [{ scope, plugin: 'artibot', key: requirePhase(target), tier: null }];
  if (scope === 'plugin') return [{ scope, plugin: requirePlugin(target), tier: null }];
  throw new UsageError(`unknown reset scope: ${scope} (expected agent|task|phase|plugin|--all)`);
}

/**
 * Fold specs into a NEW document: a string tier sets, null clears. A core
 * TypeError is re-thrown as is (the CLI maps it to exit 2), except on a spec
 * that carries an `apply` index, where it becomes that change's refusal.
 *
 * @param {object} current
 * @param {object[]} specs
 * @param {object} config - The shipped config (fable gate).
 * @returns {object}
 */
export function applySpecs(current, specs, config) {
  return specs.reduce((doc, { index, tier, ...target }) => {
    try {
      return tier === null ? clearOverride(doc, target) : setOverride(doc, { ...target, tier, config });
    } catch (err) {
      if (index !== undefined && err instanceof TypeError) throw new Refusal(`change ${index}: ${err.message}`);
      throw err;
    }
  }, current);
}

/**
 * One `apply` change → specs, validated with the `set`/`reset` validators.
 * Throws {@link UsageError} with the reason; the caller adds the index.
 *
 * FIELD RULES (the contract the menu writes against):
 *   scope  | key                                 | plugin
 *   agent  | `<plugin:name>`, required, qualified | omitted, or equal to the key's plugin
 *   task   | one of the 8 classes, required       | artibot | artibot-cowork | all; omitted = all
 *   phase  | build | review, required             | omitted or artibot
 *   plugin | omitted or null                      | artibot | artibot-cowork, required
 *   tier: haiku | sonnet | opus | null (null = reset). `plugin: null` counts as
 *   omitted, so on the plugin scope it is refused as missing.
 *
 * @param {object} ctx
 * @param {*} change
 * @returns {object[]}
 */
function changeSpecs(ctx, change) {
  if (change === null || typeof change !== 'object' || Array.isArray(change)) {
    throw new UsageError('must be an object');
  }
  const stray = Object.keys(change).find((k) => !CHANGE_KEYS.includes(k));
  if (stray !== undefined) throw new UsageError(`unknown key ${JSON.stringify(stray)} (expected ${CHANGE_KEYS.join('|')})`);
  const { scope, key = null, tier } = change;
  // `plugin: null` reads as omitted everywhere; the plugin scope then refuses it as missing.
  const plugin = change.plugin ?? undefined;
  if (!APPLY_SCOPES.includes(scope)) throw new UsageError(`unknown scope: ${scope} (expected ${APPLY_SCOPES.join('|')})`);
  if (tier !== null) requireTier(ctx.config, tier);
  if (scope === 'task') {
    const task = requireTask(key ?? undefined);
    return selectPlugins(plugin).map((p) => ({ scope, plugin: p, key: task, tier }));
  }
  if (scope === 'plugin') {
    if (key !== null) throw new UsageError('plugin scope takes no key');
    if (plugin === undefined) throw new UsageError(`missing plugin (expected ${PLUGIN_NAMES.join('|')})`);
    return [{ scope, plugin: requirePlugin(plugin), tier }];
  }
  if (scope === 'phase') {
    if (plugin !== undefined && plugin !== 'artibot') {
      throw new UsageError(`phase overrides exist only for plugin artibot, got: ${plugin}`);
    }
    return [{ scope, plugin: 'artibot', key: requirePhase(key ?? undefined), tier }];
  }
  const q = requireQualified(ctx, typeof key === 'string' ? key : undefined);
  if (plugin !== undefined && plugin !== q.plugin) {
    throw new UsageError(`plugin ${plugin} does not match the key's plugin ${q.plugin}`);
  }
  if (tier !== null) requireKnownAgent(ctx, q);
  return [{ scope, plugin: q.plugin, key: q.agent, tier }];
}

/**
 * Validate EVERY change of an `apply` document before anything is written.
 * Each spec keeps its 1-based change index. Any invalid change → one
 * {@link Refusal} listing every bad change, one line each.
 *
 * @param {object} ctx
 * @param {*} doc - Parsed `{ changes: [...] }`.
 * @param {string} file - For the message.
 * @returns {object[]}
 */
export function parseApplyChanges(ctx, doc, file) {
  const changes = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc.changes : undefined;
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new Refusal(`refusing to apply ${file}: expected { "changes": [ ... ] } with at least one change; nothing was changed.`);
  }
  const specs = [];
  const errors = [];
  changes.forEach((change, i) => {
    try {
      const own = changeSpecs(ctx, change).map((s) => ({ ...s, index: i + 1 }));
      // Trial-fold on an empty document so a core refusal is reported per change too.
      applySpecs(emptyOverrides(), own, ctx.config);
      specs.push(...own);
    } catch (err) {
      if (!(err instanceof UsageError) && !(err instanceof Refusal)) throw err;
      errors.push(err instanceof Refusal ? err.message : `change ${i + 1}: ${err.message}`);
    }
  });
  if (errors.length > 0) {
    throw new Refusal(
      [`refusing to apply ${file}: ${errors.length} of ${changes.length} change(s) invalid; nothing was changed.`, ...errors].join('\n'),
    );
  }
  return specs;
}

/**
 * Read and parse an `apply` file. Unreadable or non-JSON → {@link Refusal}.
 *
 * @param {string} file
 * @returns {*}
 */
export function readApplyDocument(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Refusal(`cannot read ${file}: ${err?.message ?? err}`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Refusal(`refusing to apply ${file}: invalid JSON: ${err.message}; nothing was changed.`);
  }
}

/**
 * The task a spawn is resolved under — THE one place the CLI derives it. An
 * explicit task applies to ANY agent (the user asked for it). Without one, the
 * agent's default: `AGENT_ACTION_CLASS` by bare name (the plugin prefix is
 * ignored — one table serves both plugins); an agent in `AGENT_CLASS_EXEMPT`
 * or unmapped (e.g. cowork-only `case-study-writer`) has none, so the task
 * layer is skipped for it.
 *
 * @param {string} name - `<plugin:name>` (or any agent type string).
 * @param {string|null} [task] - Explicit task, or null.
 * @returns {string|null}
 */
export function rowTask(name, task = null) {
  if (task !== null) return task;
  const bare = typeof name === 'string' ? name.trim().split(':').pop() : '';
  return AGENT_CLASS_EXEMPT.includes(bare) ? null : getActionClassForAgent(bare);
}

/**
 * `validate` warnings for stored task keys that are not action classes. Core
 * accepts any well-shaped key and keeps it inert — no resolve ever names it —
 * so it is flagged here rather than silently doing nothing.
 *
 * @param {object|null} overrides
 * @returns {string[]}
 */
export function inertTaskKeys(overrides) {
  return PLUGIN_NAMES.flatMap((plugin) =>
    Object.keys(overrides?.plugins?.[plugin]?.tasks ?? {})
      .filter((key) => !ACTION_CLASSES.includes(key))
      .map((key) => `${plugin}: task override "${key}" is not an action class (expected ${ACTION_CLASSES.join('|')}) — it never applies`),
  );
}

/**
 * Effective-diff rows for task settings under an EXPLICIT task context. The
 * per-agent rows resolve each agent under its DEFAULT task only, so a changed
 * pick for a class no agent defaults to (`status`, `classify`) would diff as
 * none although `resolve --task <class>` changes. For every class whose stored
 * value differs between `before` and `after` in a plugin, each roster agent
 * whose default task is NOT that class (those are already in the per-agent
 * rows) is resolved with `--task <class>` under every role. An agent whose role
 * variants changed identically counts once; otherwise per changed role, as the
 * per-agent rows do. One row per plugin, class and outcome, counted over those
 * agents, e.g. `  artibot [task=status]: opus → haiku for 30 of 30 agent(s) not
 * defaulting to status`. A re-set value or a pick every agent override shadows
 * gives no row.
 *
 * @param {object} ctx
 * @param {object} before
 * @param {object} after
 * @param {ReadonlyArray<string|null>} roles - The role variants the per-agent rows diff.
 * @param {(plugin: string, agent: string, role: string|null, overrides: object, task: string) => string|null} resolve
 * @returns {string[]}
 */
export function taskContextDiff(ctx, before, after, roles, resolve) {
  const storedTask = (doc, plugin, task) => doc?.plugins?.[plugin]?.tasks?.[task] ?? null;
  return PLUGIN_NAMES.filter((plugin) => ctx.rosters[plugin]).flatMap((plugin) =>
    ACTION_CLASSES.filter((task) => storedTask(before, plugin, task) !== storedTask(after, plugin, task)).flatMap((task) => {
      const agents = [...ctx.rosters[plugin].keys()].filter((a) => rowTask(`${plugin}:${a}`) !== task);
      const counts = new Map();
      for (const agent of agents) {
        const changes = roles
          .map((role) => ({ role, from: resolve(plugin, agent, role, before, task), to: resolve(plugin, agent, role, after, task) }))
          .filter((c) => c.from !== c.to);
        const uniform =
          changes.length === roles.length && changes.every((c) => c.from === changes[0].from && c.to === changes[0].to);
        const keys = uniform
          ? [`[task=${task}]: ${changes[0].from} → ${changes[0].to}`]
          : changes.map((c) => `[task=${task} role=${c.role ?? 'none'}]: ${c.from} → ${c.to}`);
        for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts].map(([key, n]) => `  ${plugin} ${key} for ${n} of ${agents.length} agent(s) not defaulting to ${task}`);
    }),
  );
}

/**
 * `show` top-level `tasks`: per class, the agents (of the selected plugins)
 * whose DEFAULT task it is, and each plugin's stored override for it.
 *
 * @param {object} ctx
 * @param {string[]} plugins - Selected plugins, in order.
 * @param {object} overrides - The overrides the rows were resolved with.
 * @returns {{ task: string, agents: string[], overrides: Record<string, string|null> }[]}
 */
export function taskSummary(ctx, plugins, overrides) {
  const agentsFor = (task) =>
    plugins.flatMap((p) => [...(ctx.rosters[p]?.keys() ?? [])].filter((a) => rowTask(`${p}:${a}`) === task).map((a) => `${p}:${a}`));
  const stored = (plugin, task) => {
    const tasks = overrides?.plugins?.[plugin]?.tasks;
    return tasks && Object.hasOwn(tasks, task) ? tasks[task] : null;
  };
  return ACTION_CLASSES.map((task) => ({
    task,
    agents: agentsFor(task),
    overrides: Object.fromEntries(PLUGIN_NAMES.map((p) => [p, stored(p, task)])),
  }));
}
