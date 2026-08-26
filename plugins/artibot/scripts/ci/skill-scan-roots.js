/**
 * skill-scan-roots.js — Which plugin roots the *skill/command/agent* gates scan,
 * and the denominator floors that prove they actually scanned them.
 *
 * ── Why this file exists (2026-08-16) ───────────────────────────────────────
 * `skill:check` (gen-skill-docs.js + lint-skill-descriptions.js +
 * lint-skill-size.js) and `scripts/validate.js` all resolved their target
 * directory as `<artibot plugin root>/skills` — a single hardcoded root. The
 * result was that `plugins/artibot-cowork/` (46 skills, 21 commands, 12 agents
 * at the time of writing) passed through every one of those gates without a
 * single file being read, and each gate still printed a confident PASS.
 *
 * That is the same class of defect `ci-utils.js#MIN_DOC_FILES` was created to
 * close for the documentation gates. This module is the skills-side analogue.
 * It deliberately does NOT reuse `MIN_DOC_FILES`: that map counts markdown
 * files, this one counts skill directories / command files / agent files, and
 * conflating the two denominators would make each gate's floor meaningless for
 * the other.
 *
 * ── Root enumeration is delegated, not duplicated ───────────────────────────
 * `listPluginRoots()` / `isProjectPluginDir()` live in `ci-utils.js`. Copying
 * that predicate here would recreate the exact drift this gate exists to
 * prevent: a future `plugins/artibot-<x>/` would be picked up by the doc gates
 * and silently missed by the skill gates (or vice versa). One predicate, two
 * consumers.
 *
 * ── `null` floor means "asserted absent", not "unchecked" ───────────────────
 * A root that legitimately has no skills (`_shared`) is written as `null`
 * rather than omitted. Omission would be indistinguishable from "we forgot",
 * and {@link assertEntityFloors} fails on roots it has never heard of — so a
 * new plugin root cannot coast on an unchecked zero.
 *
 * Reproduce the measured counts (2026-08-16, from repo root):
 *   $ ls plugins/artibot/skills | wc -l            # 113
 *   $ ls plugins/artibot/commands | wc -l          # 78
 *   $ ls plugins/artibot/agents | wc -l            # 29 files = 28 agents + INDEX.md
 *   $ ls plugins/artibot-cowork/skills | wc -l     # 46
 *   $ ls plugins/artibot-cowork/commands | wc -l   # 21
 *   $ ls plugins/artibot-cowork/agents | wc -l     # 12
 *
 * Zero dependencies. Node 20+ built-ins only.
 *
 * @module scripts/ci/skill-scan-roots
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { listPluginRoots } from './ci-utils.js';

/**
 * The plugin root whose entity names stay unqualified.
 *
 * Ratchet baselines (`skill-lint-baseline.json`,
 * `skill-redflags-baseline.json`) were frozen when only this root was scanned,
 * so its 113 entries are keyed by bare skill name. Qualifying them now would
 * rewrite all 85 baselined names in one commit and destroy the ratchet's audit
 * value. New roots are prefixed instead — see {@link qualify}.
 *
 * @type {string}
 */
export const PRIMARY_ROOT = 'artibot';

/**
 * Minimum entity counts per plugin root. `null` = this root is asserted to have
 * none of that entity (its absence is the expected state, not an oversight).
 *
 * Floors are round numbers below the 2026-08-16 measured counts, with slack for
 * ordinary churn. They exist to catch "the scanner pointed at the wrong
 * directory and found nothing", not to pin exact inventory — that job belongs
 * to `validate-readme-claims.js`, which compares README prose against
 * `collectActuals()`.
 *
 * @type {Record<string, {skills: number|null, commands: number|null, agents: number|null}>}
 */
export const MIN_ENTITY_COUNTS = {
  artibot: { skills: 100, commands: 70, agents: 25 },
  'artibot-cowork': { skills: 40, commands: 18, agents: 10 },
  // `_shared` holds cross-plugin markdown only; it has no skills/commands/agents
  // directories and is expected never to grow them.
  _shared: { skills: null, commands: null, agents: null },
};

/**
 * Qualify an entity name with its plugin root.
 *
 * Cowork and the main plugin share 31 skill names (`daily`, `clarify`,
 * `delegation`, `principles`, … — measured 2026-08-16 via
 * `comm -12 <(ls artibot/skills|sort) <(ls artibot-cowork/skills|sort)`).
 * Without qualification a single baseline entry named `daily` would silently
 * excuse violations in BOTH plugins, and fixing one would look like a
 * regression in the other.
 *
 * @param {string} rootName - Plugin root directory name (e.g. `artibot-cowork`).
 * @param {string} entityName - Skill/command/agent name.
 * @returns {string} Bare name for the primary root, `<root>/<name>` otherwise.
 */
export function qualify(rootName, entityName) {
  return rootName === PRIMARY_ROOT ? entityName : `${rootName}/${entityName}`;
}

/**
 * Enumerate project plugin roots that declare an entity directory of `kind`.
 *
 * Roots without the directory are omitted from the result — which would be
 * fail-open on its own, so every caller must pair this with
 * {@link assertEntityFloors} to prove the expected roots were present.
 *
 * @param {'skills'|'commands'|'agents'} kind - Entity directory name.
 * @param {object} [options] - Forwarded to {@link listPluginRoots}; `trackedNames`
 *   lets a fixture stand in for git. See `tests/firewall/gate-scan-anchoring.test.js`.
 * @returns {Array<{name: string, root: string, dir: string}>} Sorted roots.
 */
export function listEntityRoots(kind, options) {
  const out = [];
  for (const root of listPluginRoots(options)) {
    const dir = path.join(root, kind);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    out.push({ name: path.basename(root), root, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Enumerate `skills/<name>/SKILL.md` across every scanned root.
 *
 * @param {object} [options] - Forwarded to {@link listEntityRoots}.
 * @returns {Array<{root: string, rootName: string, name: string, key: string, file: string}>}
 *   `name` is the bare directory name; `key` is the {@link qualify}-ed name used
 *   by ratchet baselines and report output.
 */
export function listAllSkillFiles(options) {
  const out = [];
  for (const { name: rootName, dir } of listEntityRoots('skills', options)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      out.push({
        root: path.dirname(dir),
        rootName,
        name: entry.name,
        key: qualify(rootName, entry.name),
        file,
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Verify each root met its floor and that no root is unaccounted for.
 *
 * Three distinct failures, all of which were silently passing before this
 * module existed:
 *   1. a root in the map was not scanned at all,
 *   2. a root was scanned but came back below its floor (wrong directory,
 *      permissions, a glob that matched nothing),
 *   3. a root exists on disk that the map has never heard of.
 *
 * @param {'skills'|'commands'|'agents'} kind - Entity kind being asserted.
 * @param {Record<string, number>} counts - Root directory name → entities found.
 * @returns {string[]} Human-readable failures (empty when all floors are met).
 */
export function assertEntityFloors(kind, counts) {
  const failures = [];
  for (const [name, floors] of Object.entries(MIN_ENTITY_COUNTS)) {
    const floor = floors[kind];
    if (floor === null) {
      if (counts[name]) {
        failures.push(
          `'${name}' was declared to have no ${kind} but ${counts[name]} were found — ` +
            `update MIN_ENTITY_COUNTS.${name}.${kind} with a real floor`,
        );
      }
      continue;
    }
    if (!(name in counts)) {
      failures.push(`expected plugin root '${name}' contributed no ${kind} at all`);
    } else if (counts[name] < floor) {
      failures.push(`'${name}' scanned ${counts[name]} ${kind}, below floor ${floor}`);
    }
  }
  for (const name of Object.keys(counts)) {
    if (!(name in MIN_ENTITY_COUNTS)) {
      failures.push(
        `plugin root '${name}' has no entry in MIN_ENTITY_COUNTS — add one so its ` +
          `${kind} denominator is asserted too (a new root must not coast on an unchecked zero)`,
      );
    }
  }
  return failures;
}

/**
 * Tally entities per root name from a list carrying `rootName`.
 *
 * @param {Array<{rootName: string}>} items - Scanned entities.
 * @returns {Record<string, number>} Root name → count.
 */
export function countByRoot(items) {
  const counts = {};
  for (const { rootName } of items) counts[rootName] = (counts[rootName] || 0) + 1;
  return counts;
}
