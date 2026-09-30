/**
 * Canary task tier (CA-02) — the SHIPPED, cheap default of the `/model-routing`
 * task layer, and the one reader of `artibot.config.json#/routing/canary` that
 * decides what a spawn is RESOLVED to.
 *
 * WHAT IT DOES. `routing.canary` ships
 * `{ actionClasses: ['classify', 'status'], tier: 'sonnet' }`. When a spawn is
 * resolved for one of those two TASKS (`resolve <plugin:name> --task classify`),
 * {@link canaryTierFor} answers the low tier and
 * `lib/core/model-overrides.js#resolveEffectiveModel` returns it instead of the
 * shipped opus — unless {@link canaryMayLower} holds the spawn (a review role, or a
 * review/architecture agent: see THE REVIEW GUARD below). That answer is only real
 * when the leader passes it on as `Agent(model=<resolve output>)` — the owner
 * recognised exactly that path as the CA-02 actuator (decision D1, 2026-09-28: the
 * `/model-routing` task layer, leader relay, NO enforcing hook). Nothing here
 * spawns anything.
 *
 * PRIORITY. It is a shipped DEFAULT of the task layer, so it sits below every
 * user setting and above the shipped policy:
 *   user agent > user task > user phase > user plugin default
 *     > canary (this module) > shipped (`resolveModel` / cowork frontmatter)
 * `resolveEffectiveModel` only asks this module after `pickOverride` found no user
 * pick, so a user's explicit `set task classify opus` (or any wider setting) wins.
 *
 * CLOSED VOCABULARY — an ALLOWLIST, never a denylist. Only the two classes CA-02
 * names ({@link CANARY_ACTION_CLASSES}) can ever be armed, and only the two cheap
 * tiers the design names ("haiku/sonnet", {@link CANARY_TIERS}) can be the answer.
 * A class outside the vocabulary that appears in the list is IGNORED, so a new
 * action class never switches on by being added to the config; a tier outside it
 * (or no tier at all) leaves the canary OFF rather than guessing one. The JSON
 * schema enums in `config-schema.js` are the same two lists, and
 * `tests/core/model-canary.test.js` pins that they cannot drift.
 *
 * ONE KEY, TWO READERS. `adaptive-model-router.js#resolveCanaryClasses` reads the
 * same `routing.canary.actionClasses` to write `canary:<tier>` onto a
 * `route.selected` SHADOW receipt (intent inside the policy ceiling; not a spawn).
 * This module reads it to answer `resolve`. lib/core may not import lib/routing, so
 * the carrier rule is restated here — array of non-empty strings, ONE unusable
 * member discards the whole list — and `tests/core/model-canary.test.js` asserts the
 * actuator's list equals the router's list narrowed to the vocabulary, carrier by
 * carrier.
 *
 * THE REVIEW GUARD (CA-02 review, SHOULD-1). The owner's rule is design and review =
 * opus, implementation = sonnet, and the canary is a cost lever for spawns that are
 * genuinely classify/status work — so a leader that labels a REVIEW or DESIGN spawn
 * `--task status` must not get sonnet. {@link canaryMayLower} is the one place that
 * says whether a spawn may be lowered, and it is an ALLOWLIST: ALL of these must hold.
 *  - The role is absent or a build word (`BUILD_ROLES`). A review word, and any word
 *    core does not know (`planning`, `design`), keeps the shipped tier.
 *  - The agent's OWN default task is absent or one of
 *    {@link CANARY_LOWERABLE_AGENT_CLASSES} — the eight action classes minus `review`
 *    and `architecture`. Anything else, a near miss included, keeps the shipped tier.
 *  - The agent is not in {@link CANARY_PROTECTED_AGENTS}.
 * lib/core cannot read `AGENT_ACTION_CLASS` (lib/routing is a higher layer), so the
 * default task arrives as DATA: `opts.agentTask` of `resolveEffectiveModel`, which
 * the `/model-routing` CLI fills in (`model-routing.mjs#callOpts`). A caller that
 * passes none is judged on role and name only — the class guard needs its input.
 *
 * WHAT THIS MODULE CANNOT SEE:
 *  - Whether a leader ever passes `--task classify|status`. No agent DEFAULTS to
 *    those classes (`AGENT_ACTION_CLASS`), so an unlabelled spawn is never lowered.
 *  - Whether the host serves what was resolved; only `usage.receipt` shows that.
 *  - The router's policy ceiling (`allowedTiers`). This is the user-override
 *    layer's answer, which — like any user pick — is not bounded by it; the guards
 *    are {@link canaryMayLower} (what it may lower) and `resolveEffectiveModel`
 *    (never raise a seat).
 *  - The agent's default task, unless the caller passes it (see the guard above).
 *  - The receipt path. `adaptive-model-router.js` writes `canary:<tier>` from the
 *    same key WITHOUT this guard: that is record-only intent inside the policy
 *    ceiling (its own header says so), not an answer to `resolve`.
 *
 * Layer 1 (lib/core): imports lib/core only. Pure: no I/O, never throws, never
 * mutates its input.
 *
 * @module lib/core/model-canary
 */

import { listTiers } from './model-catalog.js';
import { BUILD_ROLES } from './model-policy.js';

/**
 * The action classes the canary may ever be armed for — CA-02's own names
 * (`V5-BACKLOG.md` CA-02, design D5). A subset of
 * `lib/routing/action-classifier.js#ACTION_CLASSES` (pinned by a test, since core
 * cannot import routing).
 *
 * @type {readonly string[]}
 */
export const CANARY_ACTION_CLASSES = Object.freeze(['classify', 'status']);

/**
 * The tiers the canary may answer. The design says "haiku/sonnet" without choosing
 * (`ARTIBOT-5.0-DESIGN.md` §4 Canary row, D5), so the choice is a config value —
 * `routing.canary.tier` — inside this closed pair. Never opus or fable: a canary
 * exists to lower a seat.
 *
 * @type {readonly string[]}
 */
export const CANARY_TIERS = Object.freeze(['haiku', 'sonnet']);

/**
 * The `source` a canary answer carries in a `resolveEffectiveModel` result. Not an
 * `override-*` name: it is not a user setting, and `show` must not present it as one.
 *
 * @type {string}
 */
export const CANARY_SOURCE = 'canary-task';

/**
 * The DEFAULT tasks (`lib/routing/action-classifier.js#AGENT_ACTION_CLASS`) of the
 * agents the canary may lower: every action class EXCEPT `review` and
 * `architecture` — the owner's "design and review = opus" (2026-09-29). It is an
 * ALLOWLIST on purpose: a class that is not listed is held, so a ninth action class
 * stays protected until somebody decides otherwise, and
 * `tests/core/model-canary.test.js` fails until they do (this list plus
 * `review` and `architecture` must partition `ACTION_CLASSES`). A subset of that
 * vocabulary, pinned by the same test, because core cannot import routing. No agent
 * defaults to `classify` or `status` today; they are listed so an agent that did
 * would still be lowered for its own default task.
 *
 * @type {readonly string[]}
 */
export const CANARY_LOWERABLE_AGENT_CLASSES = Object.freeze([
  'classify',
  'status',
  'explore',
  'edit-routine',
  'implement',
  'complex-debug',
]);

/**
 * Agents the canary NEVER lowers, whatever the task, role or default task a call
 * names — bare, lower-case names. It is the canary's OWN list, deliberately not
 * `FABLE_DENYLIST`: that one answers "may this agent run on the fable tier" (a
 * refusal-classifier concern), this one answers "may a cost lever lower this seat".
 * Two levers, so widening one must not silently widen the other. It STARTS with the
 * same member (`security-reviewer`); `tests/core/model-overrides-canary.test.js`
 * pins the independence in both directions. It is also the floor for a caller that
 * names no default task — `security-reviewer` defaults to `review`, which the class
 * guard already holds, but only when the caller says so.
 *
 * @type {readonly string[]}
 */
export const CANARY_PROTECTED_AGENTS = Object.freeze(['security-reviewer']);

/**
 * `{ classes, tier, ignored }` for a config that arms nothing.
 *
 * @returns {{ classes: string[], tier: null, ignored: string[] }}
 */
function inertPlan() {
  return { classes: [], tier: null, ignored: [] };
}

/**
 * @param {*} value
 * @returns {boolean} True for a non-null, non-array object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * De-duplicate, keeping first-seen order.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
function unique(names) {
  return [...new Set(names)];
}

/**
 * The canary as `config` declares it, normalised FAIL-CLOSED.
 *
 *  - `classes` — the listed classes that are in {@link CANARY_ACTION_CLASSES}, trimmed
 *    and de-duplicated. A malformed member (not a string, or blank) discards the
 *    WHOLE list: a partially applied allowlist would move a seat its author never
 *    named. That is the router's carrier rule, restated.
 *  - `ignored` — the well-formed strings that are NOT in the vocabulary. They never
 *    apply; they are reported so a gate can see them (the shipped file must have none).
 *  - `tier` — `routing.canary.tier` when it is exactly one of {@link CANARY_TIERS},
 *    else null. There is no default: absent or unusable means the canary is OFF.
 *
 * Never throws — a config that cannot carry a canary at all (undefined, `{}`, a
 * throwing getter) reads as {@link inertPlan}.
 *
 * @param {*} config - The parsed `artibot.config.json` (or anything).
 * @returns {{ classes: string[], tier: string|null, ignored: string[] }}
 *
 * @example
 * readCanaryPlan({ routing: { canary: { actionClasses: ['classify', 'explore'], tier: 'sonnet' } } });
 * // { classes: ['classify'], tier: 'sonnet', ignored: ['explore'] }
 */
export function readCanaryPlan(config) {
  try {
    const canary = config?.routing?.canary;
    if (!isPlainObject(canary)) return inertPlan();
    const tier = CANARY_TIERS.includes(canary.tier) ? canary.tier : null;
    const list = canary.actionClasses;
    if (!Array.isArray(list)) return { classes: [], tier, ignored: [] };
    const named = [];
    for (const entry of list) {
      const name = typeof entry === 'string' ? entry.trim() : '';
      if (name === '') return { classes: [], tier, ignored: [] };
      named.push(name);
    }
    return {
      classes: unique(named.filter((name) => CANARY_ACTION_CLASSES.includes(name))),
      tier,
      ignored: unique(named.filter((name) => !CANARY_ACTION_CLASSES.includes(name))),
    };
  } catch {
    return inertPlan();
  }
}

/**
 * The tier the canary answers for a task, or null when it does not apply.
 *
 * Applies only when ALL of these hold: `task` is exactly one of the armed class
 * words (no trimming, no case folding — a near miss is not a class), the list is
 * usable, and `routing.canary.tier` is in the vocabulary.
 *
 * @param {*} config - The parsed `artibot.config.json`.
 * @param {*} task - The task (action class) the spawn is resolved for.
 * @returns {string|null} 'haiku' | 'sonnet' | null.
 *
 * @example
 * canaryTierFor(shippedConfig, 'classify'); // 'sonnet'
 * canaryTierFor(shippedConfig, 'implement'); // null
 */
export function canaryTierFor(config, task) {
  if (typeof task !== 'string') return null;
  const { classes, tier } = readCanaryPlan(config);
  return tier !== null && classes.includes(task) ? tier : null;
}

/**
 * True when `tier` is a strictly more capable (costlier) catalog tier than `than` —
 * catalog order, cheapest first: haiku < sonnet < opus < fable. Anything the catalog
 * does not know, or a non-string, is never above and never below anything, so a
 * caller that only ever LOWERS a seat leaves an unrecognised tier alone.
 *
 * @param {*} tier - Candidate tier.
 * @param {*} than - Baseline tier.
 * @returns {boolean}
 *
 * @example
 * outranksTier('opus', 'sonnet'); // true — a canary may lower this seat
 * outranksTier('sonnet', 'sonnet'); // false — equal is not costlier
 * outranksTier('haiku', 'sonnet'); // false — cheaper; a canary must not lift it
 */
export function outranksTier(tier, than) {
  const order = listTiers();
  const a = order.indexOf(tier);
  const b = order.indexOf(than);
  return a !== -1 && b !== -1 && a > b;
}

/**
 * @param {*} value
 * @returns {boolean} True for `undefined` and `null` — "the caller named nothing".
 */
function isAbsent(value) {
  return value === undefined || value === null;
}

/**
 * @param {*} role - The spawn's `opts.role`.
 * @returns {boolean} True when it is absent or exactly a build word. A review word,
 *   an unknown word, a near miss (`Build`, ` build`), an empty string and a non-string
 *   are all false: a cost lever must not read "not review" as "build".
 */
function roleAllowsCanary(role) {
  return isAbsent(role) || (typeof role === 'string' && BUILD_ROLES.has(role));
}

/**
 * @param {*} agentTask - The agent's OWN default task, as the caller read it.
 * @returns {boolean} True when it is absent (the agent has none, or the caller did not
 *   say) or exactly one of {@link CANARY_LOWERABLE_AGENT_CLASSES}. `review`,
 *   `architecture`, any other string (a near miss included) and any non-string are false.
 */
function classAllowsCanary(agentTask) {
  return isAbsent(agentTask) || (typeof agentTask === 'string' && CANARY_LOWERABLE_AGENT_CLASSES.includes(agentTask));
}

/**
 * @param {*} agent - Bare or `plugin:`-prefixed agent name.
 * @returns {boolean} True for a non-blank name that is not in
 *   {@link CANARY_PROTECTED_AGENTS}. The name is trimmed, stripped of its plugin prefix
 *   and lower-cased first — the same spellings `qualifyAgent` folds together — so a
 *   variant cannot slip past the list. A non-string or blank name is false.
 */
function agentAllowsCanary(agent) {
  if (typeof agent !== 'string') return false;
  const bare = agent.trim().split(':').pop().trim().toLowerCase();
  return bare !== '' && !CANARY_PROTECTED_AGENTS.includes(bare);
}

/**
 * Whether the canary may lower THIS spawn's seat — the review guard (SHOULD-1).
 *
 * An ALLOWLIST: true only when the role is absent or a build word, the agent's own
 * default task is absent or one of {@link CANARY_LOWERABLE_AGENT_CLASSES}, and the
 * agent is off {@link CANARY_PROTECTED_AGENTS}. Anything the guard cannot read as
 * lowerable — a review word, an unknown role, a near-miss class, a non-string, a
 * spawn that is not a plain object — is false. It says nothing about WHICH tier the
 * canary answers ({@link canaryTierFor}) or whether that lowers anything
 * ({@link outranksTier}); `resolveEffectiveModel` asks all three.
 *
 * Never throws (a throwing getter on `spawn` reads as false), never mutates `spawn`.
 *
 * @param {{ agent?: string, role?: string, agentTask?: string|null }} spawn - The agent
 *   (bare or prefixed), the spawn's `opts.role`, and the agent's own default task
 *   (`getActionClassForAgent`, which core cannot import — the caller passes it).
 * @returns {boolean}
 *
 * @example
 * canaryMayLower({ agent: 'doc-updater', role: 'build', agentTask: 'edit-routine' }); // true
 * canaryMayLower({ agent: 'code-reviewer', role: 'review' }); // false — a review role
 * canaryMayLower({ agent: 'planner', agentTask: 'architecture' }); // false — a design agent
 * canaryMayLower({ agent: 'security-reviewer' }); // false — the protected list
 */
export function canaryMayLower(spawn) {
  try {
    if (!isPlainObject(spawn)) return false;
    const { agent, role, agentTask } = spawn;
    return roleAllowsCanary(role) && classAllowsCanary(agentTask) && agentAllowsCanary(agent);
  } catch {
    return false;
  }
}
