/**
 * Plan repair — turns review findings into plan tasks, deterministically.
 *
 * Observe stage (design §2.5): nothing here writes a file or reaches a plan
 * store. `repairPlan` takes a plan value, returns a new plan value, and never
 * touches the one it was given.
 *
 * ── What "repair" is allowed to mean in a pure function ───────────────────
 * A plan is mostly prose intent, and a pure function cannot rewrite intent.
 * What it CAN do without judgement is carry each actionable finding into the
 * task graph so nothing quietly falls off the list. So the whole contract is:
 *
 *   - append one task per actionable finding, never delete or reorder;
 *   - bump `revision`;
 *   - report every mutation in `changed[]`.
 *
 * Deleting or rewriting existing tasks is deliberately out of scope. A module
 * that silently drops planned work on the strength of a reviewer comment is a
 * worse failure than one that leaves a stale task for a person to close.
 *
 * ── Which findings become tasks ───────────────────────────────────────────
 * Only `critical` and `high`. That is not a severity preference: those are
 * exactly the two severities for which `review-output.schema.json` makes
 * `suggestion` a required field (the `allOf`/`if` block on `definitions/finding`).
 * A finding without a required suggestion has no deterministic remediation
 * text to put in a task body, so writing one would mean inventing the fix.
 * Lower-severity findings stay in `review.md` where a person reads them.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 * Task ids are content-derived (`T-REPAIR-<8 hex>` over file, line and
 * description), so repairing the same plan with the same findings twice adds
 * nothing the second time and returns `changed: []`. That matters because the
 * controller can reach `repair` several times for one mission, and a plan that
 * grows a duplicate task per attempt is how a retry loop looks like progress.
 *
 * @module lib/recovery/plan-repair
 */

import { createHash } from 'node:crypto';

/**
 * Severities that produce a task. See the module note: this list is the set
 * for which the review schema requires `suggestion`, not a judgement call
 * about what matters.
 * @type {readonly string[]}
 */
export const ACTIONABLE_SEVERITIES = Object.freeze(['critical', 'high']);

/** Status new tasks enter at, `task-graph.schema.json` enum. */
const NEW_TASK_STATUS = 'queued';

const ID_PREFIX = 'T-REPAIR-';

/**
 * Stable id for a finding. sha1 is used as a content digest, never as a
 * security primitive; 8 hex characters is 32 bits, which is ample for the
 * handful of findings one review produces and keeps the id readable in a plan.
 * Collisions would surface as a skipped task rather than a wrong one, because
 * the dedup check below compares ids only within a single plan.
 */
function findingId(finding) {
  const material = [
    typeof finding.file === 'string' ? finding.file : '',
    Number.isInteger(finding.line) ? String(finding.line) : '',
    typeof finding.description === 'string' ? finding.description : '',
  ].join('\0');
  return ID_PREFIX + createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 8);
}

function isActionable(finding) {
  return (
    finding !== null
    && typeof finding === 'object'
    && ACTIONABLE_SEVERITIES.includes(finding.severity)
    && typeof finding.description === 'string'
    && finding.description.trim() !== ''
  );
}

function taskTitle(finding) {
  const where = typeof finding.file === 'string' && finding.file !== ''
    ? `${finding.file}${Number.isInteger(finding.line) ? `:${finding.line}` : ''}`
    : 'unspecified location';
  return `Repair (${finding.severity}) ${where}`;
}

/**
 * Deep-clone through JSON. The input is a plan document — data that already
 * round-trips through `plan.json` — so there is nothing in it that JSON would
 * lose, and this avoids a hand-written cloner that would need updating every
 * time the plan schema grows a field.
 */
function clonePlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

/**
 * Add tasks to a plan for the actionable findings of a review.
 *
 * Pure: the `plan` argument is cloned before anything is written, so the
 * caller's object is untouched whether or not any change is made.
 *
 * @param {object} input
 * @param {object} input.plan Plan document carrying a `tasks` array, the shape
 *   of `schemas/task-graph.schema.json`. `revision` is bumped when it is an
 *   integer and initialised to 1 when it is absent.
 * @param {Array<object>} [input.findings] Findings in the shape of
 *   `review-output.schema.json#/definitions/finding`. Non-actionable and
 *   malformed entries are skipped rather than rejected: a review is allowed to
 *   contain findings that do not translate into planned work.
 * @returns {{plan: object, changed: Array<{type: string, taskId?: string,
 *   from?: number, to?: number, finding?: {file: string|null, line: number|null,
 *   severity: string}}>}} The new plan and one entry per mutation. An empty
 *   `changed` means the plan already covered every actionable finding.
 * @throws {TypeError} When `plan` is not an object or `plan.tasks` is not an
 *   array. Repairing a plan whose shape is unknown would mean guessing where
 *   tasks live, so this fails closed instead.
 */
export function repairPlan(input) {
  const source = input === null || typeof input !== 'object' ? {} : input;
  const { plan, findings } = source;

  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('repairPlan: plan must be an object');
  }
  if (!Array.isArray(plan.tasks)) {
    throw new TypeError('repairPlan: plan.tasks must be an array');
  }

  const next = clonePlan(plan);
  const changed = [];
  const existingIds = new Set(
    next.tasks
      .filter((task) => task !== null && typeof task === 'object' && typeof task.id === 'string')
      .map((task) => task.id),
  );

  const candidates = Array.isArray(findings) ? findings.filter(isActionable) : [];

  for (const finding of candidates) {
    const id = findingId(finding);
    if (existingIds.has(id)) continue;
    existingIds.add(id);

    const task = {
      id,
      status: NEW_TASK_STATUS,
      title: taskTitle(finding),
      origin: 'plan-repair',
      finding: {
        severity: finding.severity,
        file: typeof finding.file === 'string' ? finding.file : null,
        line: Number.isInteger(finding.line) ? finding.line : null,
        description: finding.description,
        suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : null,
      },
    };
    if (typeof next.mission_id === 'string') task.mission_id = next.mission_id;

    next.tasks.push(task);
    changed.push({
      type: 'task-added',
      taskId: id,
      finding: {
        severity: finding.severity,
        file: task.finding.file,
        line: task.finding.line,
      },
    });
  }

  if (changed.length > 0) {
    const from = Number.isInteger(next.revision) ? next.revision : 0;
    next.revision = from + 1;
    changed.push({ type: 'revision-bumped', from, to: next.revision });
  }

  return { plan: next, changed };
}
