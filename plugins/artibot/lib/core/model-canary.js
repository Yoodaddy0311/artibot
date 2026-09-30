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
 * shipped opus. That answer is only real when the leader passes it on as
 * `Agent(model=<resolve output>)` — the owner recognised exactly that path as the
 * CA-02 actuator (decision D1, 2026-09-28: the `/model-routing` task layer, leader
 * relay, NO enforcing hook). Nothing here spawns anything.
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
 * WHAT THIS MODULE CANNOT SEE:
 *  - Whether a leader ever passes `--task classify|status`. No agent DEFAULTS to
 *    those classes (`AGENT_ACTION_CLASS`), so an unlabelled spawn is never lowered.
 *  - Whether the host serves what was resolved; only `usage.receipt` shows that.
 *  - The router's policy ceiling (`allowedTiers`). This is the user-override
 *    layer's answer, which — like any user pick — is not bounded by it; the guards
 *    live in `resolveEffectiveModel` (never raise a seat, never move
 *    `FABLE_DENYLIST`).
 *
 * Layer 1 (lib/core): imports lib/core only. Pure: no I/O, never throws, never
 * mutates its input.
 *
 * @module lib/core/model-canary
 */

import { listTiers } from './model-catalog.js';

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
