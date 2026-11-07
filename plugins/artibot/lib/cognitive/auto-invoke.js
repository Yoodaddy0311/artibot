/**
 * The auto-invoke set — the names the model must be able to start on its own
 * (L4, constants only).
 *
 * WHY ONE CONSTANT. `CLAUDE.md` "Auto-invoke Principle" says users never type a
 * slash command: the model starts the command or skill itself through the
 * host's Skill tool. Which names that covers lived in three places — the
 * Canary allowlist (`./auto-activate.js#AUTO_ACTIVATE_ALLOWLIST`), the
 * recommend-hint targets (`../observability/decision-events.js#HINT_SLASH_MAP`,
 * `workflow` deliberately absent) and a list in `CLAUDE.md` prose with no code
 * behind it. The first two are imported, not copied; the prose list now lives
 * here, and `CLAUDE.md` points at this file.
 *
 * WHAT GUARDS IT. The frontmatter key `disable-model-invocation: true` (dmi)
 * refuses the model's Skill call outright, so a dmi on the wrong file switches
 * auto-invoke off for that name and nothing errors anywhere. Owner decision
 * 2026-11-07 (relayed by the leader): no new dmi. `DMI_EXCEPTIONS` lists every
 * dmi surface that existed at `afe4a680`, each with its reason, and
 * `tests/firewall/auto-invoke-dmi-guard.test.js` fails on a dmi outside it, on
 * an exception that is no longer dmi, and on a name below that has no surface
 * the model may call.
 *
 * NO RUNTIME IMPORTER, ON PURPOSE. Nothing in lib/ or scripts/ imports this
 * file; it is the source of truth a firewall test and `CLAUDE.md` read. That is
 * the opposite of the 13 modules deleted on 2026-11-07, which had no reader at
 * all — deleting this one would leave the guard test without its list.
 *
 * NOT SEEN HERE: which file the host's Skill tool resolves when a command and a
 * skill share a name and only one is dmi (`daily`), and how the host coerces a
 * dmi value other than the literal `true`. Both unverified.
 *
 * @module lib/cognitive/auto-invoke
 */

import { HINT_SLASH_MAP } from '../observability/decision-events.js';
import { AUTO_ACTIVATE_ALLOWLIST } from './auto-activate.js';

/**
 * The names `CLAUDE.md` "Auto-invoke Principle" spells out, in its order. The
 * only source with no code behind it before this file;
 * `tests/firewall/auto-invoke-dmi-guard.test.js` pins the prose to this array.
 * @type {readonly string[]}
 */
export const AUTO_INVOKE_PROSE_NAMES = Object.freeze([
  'team', 'implement', 'plan', 'code-review', 'verify', 'daily',
]);

/**
 * Every name the model must be able to start: the Canary allowlist, the slash
 * targets of a recommend hint (started after the user confirms — still a model
 * call), and the prose names. Deduplicated, in that order.
 * @type {readonly string[]}
 */
export const AUTO_INVOKE_NAMES = Object.freeze([...new Set([
  ...AUTO_ACTIVATE_ALLOWLIST,
  ...Object.values(HINT_SLASH_MAP),
  ...AUTO_INVOKE_PROSE_NAMES,
])]);

/**
 * Names in the set that have no command and no skill on purpose. The guard
 * fails the day one grows a surface, so that day is a decision.
 * @type {Readonly<Record<string, string>>}
 */
export const AUTO_INVOKE_SURFACELESS = Object.freeze({
  why: 'In the Canary allowlist because the v5 design names it; it has no command file and no trigger, '
    + 'so it can never fire (auto-activate.js "THE ALLOWLIST HAS FIVE NAMES AND FOUR SURFACES").',
});

const DELEGATION_DISPATCHER = 'Pure delegation dispatcher, dmi by design since it shipped '
  + '(CHANGELOG "disable-model-invocation: 순수 위임 커맨드 (spawn/swarm/orchestrate)").';
const USER_INVOKED_CEREMONY = 'Authoring/settings ceremony made user-invoked on purpose in v4.37.0 '
  + '(CHANGELOG "스킬 invocation 축 1차 배치" — 오발동 억제·의도적 호출화).';
const LEGACY_SKILL_BATCH = 'Pre-existing from the "Add disable-model-invocation (10 skills)" batch '
  + '(CHANGELOG P0); the per-skill reason is not recorded — unverified, review before relying on it.';

/**
 * Every dmi surface at `afe4a680` (plugin-relative path → reason). A ratchet:
 * adding a dmi means adding a line here with a reason, removing one means
 * deleting its line — the guard fails on both kinds of drift.
 * @type {Readonly<Record<string, string>>}
 */
export const DMI_EXCEPTIONS = Object.freeze({
  'commands/orchestrate.md': 'Harness Constraint: orchestrate MUST NEVER auto-fire without explicit user opt-in '
    + '(docs/ORCHESTRATION-ROUTING.md "Harness Constraint"); reachable only as an advisory recommend=workflow, '
    + 'which is outside the auto-invoke set. ' + DELEGATION_DISPATCHER,
  'commands/spawn.md': DELEGATION_DISPATCHER,
  'commands/swarm.md': DELEGATION_DISPATCHER,
  'commands/dynamic.md': 'Explicit opt-in entry to the harness Workflow tool (its own description; '
    + 'docs/ORCHESTRATION-ROUTING.md classifier table: /dynamic is advisory only).',
  'commands/codex.md': 'External Codex plugin bridge; dmi since it shipped, the reason is not recorded in the file '
    + '— unverified (docs/WIRING-AUDIT-2026-05-30.md notes the flag).',
  'skills/daily/SKILL.md': 'Same-name commands/daily.md carries no dmi, so daily keeps a model-callable surface; '
    + 'which of the two the host Skill tool resolves for artibot:daily is unverified.',
  'skills/persona-distill/SKILL.md': USER_INVOKED_CEREMONY,
  'skills/tool-approval/SKILL.md': USER_INVOKED_CEREMONY,
  'skills/prompt-caching-strategy/SKILL.md': USER_INVOKED_CEREMONY,
  'skills/skill-authoring/SKILL.md': USER_INVOKED_CEREMONY,
  'skills/hook-event-emitter/SKILL.md': USER_INVOKED_CEREMONY,
  'skills/setup/SKILL.md': LEGACY_SKILL_BATCH,
  'skills/session-worklog/SKILL.md': LEGACY_SKILL_BATCH,
  'skills/scheduled-learning/SKILL.md': LEGACY_SKILL_BATCH,
});
