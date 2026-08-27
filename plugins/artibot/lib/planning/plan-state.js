/**
 * Plan-state synchronisation layer — parses plan markdown checkboxes and
 * persists `.plan-state.json` for cross-session TODO tracking. Split out of
 * `lib/planning/artifacts.js` (which re-exports {@link syncTodo} for backward
 * compatibility) so the document-artifact layer stays under the 800-line cap.
 *
 * Design rules (match lib/planning/artifacts.js):
 *   - `now` is injectable for deterministic tests: a function `() => Date`,
 *     called as `now()`. Defaults to `() => new Date()`.
 *   - Korean-path safe (path.join only), atomic writes.
 *   - Failure-tolerant: returns `{ ok: false, error }` instead of throwing.
 *   - Fail-closed on anything that could destroy prior completion state:
 *     non-string plans, zero-task parses of non-blank plans, unreadable state
 *     files. Landed 718f092c — do not relax.
 *
 * @module lib/planning/plan-state
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWriteJson } from '../core/file.js';
import { PlanTracker } from '../core/plan-tracker.js';

/** @typedef {() => Date} NowFn */

const DEFAULT_NOW = () => new Date();

/**
 * Resolve a `now` argument into a Date, tolerating both function and Date.
 * (Local copy of the artifacts.js helper — importing it back would make the
 * two modules mutually dependent, since artifacts.js re-exports syncTodo.)
 * @param {NowFn|Date} [now]
 * @returns {Date}
 */
function resolveNow(now) {
  if (typeof now === 'function') return now();
  if (now instanceof Date) return now;
  return DEFAULT_NOW();
}

/**
 * Normalise a task's text into a merge key. Whitespace-only differences (an
 * editor re-wrapping a line, a stray trailing space) must not orphan a
 * completed task, so runs of whitespace collapse and the ends are trimmed.
 * Case is preserved — two tasks differing only in case are two tasks.
 *
 * @param {unknown} text
 * @returns {string}
 */
function taskKey(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Re-apply `completed: true` flags from a prior `.plan-state.json` onto the
 * freshly parsed task list.
 *
 * `PlanTracker#parsePlan` replaces its task list wholesale, so the flags
 * restored by `fromState(prior)` are dropped on every sync. A task checked off
 * via `/plan --done` survives only because that path writes `- [x]` back into
 * the markdown; a task completed in state alone silently reverted to unchecked.
 *
 * Division of truth: the markdown decides *which* tasks exist (a task removed
 * from the plan disappears from state); prior state only contributes
 * stickiness of completion, keyed by normalized text.
 *
 * 태스크 텍스트를 편집하면 그 태스크의 완료 플래그는 사라진다(rename = 제거 + 추가).
 * 공백 차이만은 {@link taskKey} 가 흡수한다. 텍스트가 유일한 조인 키이기 때문이며,
 * stable ID 가 도입되기 전까지는 의도된 동작이다 — `tests/planning/artifacts.test.js`
 * 의 "drops completion when a task is renamed" 가 이 계약을 고정한다.
 *
 * @param {Array<{ text: string, completed: boolean }>} parsed - parsePlan result.
 * @param {object|null} prior - previously persisted state, if any.
 * @returns {Array<{ text: string, completed: boolean }>}
 */
function mergeCompletion(parsed, prior) {
  const priorTasks = Array.isArray(prior?.tasks) ? prior.tasks : [];
  const done = new Set();
  for (const t of priorTasks) {
    if (t && t.completed) done.add(taskKey(t.text));
  }
  if (done.size === 0) return parsed;
  return parsed.map((t) => (
    t.completed || !done.has(taskKey(t.text)) ? t : { ...t, completed: true }
  ));
}

/**
 * Decide whether a zero-task parse is a legitimate empty plan or a parse
 * failure whose result must not reach disk.
 *
 * A plan with prose in it always has tasks — a checkbox the parser fails to
 * recognize (CRLF line endings were the reported case) yields zero and, written
 * through, replaces real completions with an empty list under `ok: true`. Only
 * one zero-task write is safe: a blank plan with nothing tracked yet.
 *
 * @param {string} planMarkdown
 * @param {object|null} prior - Previously persisted state, if any.
 * @returns {string|null} Error message, or `null` when the write may proceed.
 */
function zeroTaskRejection(planMarkdown, prior) {
  if (planMarkdown.trim() !== '') {
    return 'plan is not empty but parsed 0 tasks — refusing to overwrite .plan-state.json';
  }
  const priorTasks = Array.isArray(prior?.tasks) ? prior.tasks.length : 0;
  if (priorTasks > 0) {
    return `blank plan would drop ${priorTasks} tracked tasks — refusing to overwrite .plan-state.json`;
  }
  return null;
}

/**
 * Parse a plan markdown into checkbox tasks and persist `.plan-state.json`
 * alongside the resolved plan file.
 *
 * What merges and what does not: `sessions` accumulate across calls, and
 * `completed` flags are carried over by normalized task text; the task *list*
 * itself is whatever the supplied markdown contains.
 *
 * `planMarkdown` must be a string. It used to be coerced with `: ''`, which
 * defeated `parsePlan`'s own type guard (non-string → return `[]`, task list
 * untouched) and turned a caller slip into an atomic overwrite of the user's
 * completed state with an empty list — reported as `ok: true`. Now the call is
 * rejected before anything is written. {@link zeroTaskRejection} closes the
 * same hole from the other side: a plan that *is* a string but parses to zero
 * tasks is treated as a parse failure, not as an emptied plan. {@link readState}
 * closes the third: a state file that exists but cannot be read stops the write
 * instead of being mistaken for "no prior tasks".
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute repo root.
 * @param {string} args.planMarkdown - Markdown containing `- [ ]` / `- [x]`.
 *   Non-string input is rejected with `{ ok: false }` and leaves disk untouched;
 *   so is a non-blank plan that yields no tasks.
 * @param {string} [args.planFile='PLAN.md'] - Plan file path (relative to
 *   projectRoot or absolute) recorded in state; state lands beside it.
 * @param {string} [args.sessionId] - Optional session to register.
 * @param {NowFn|Date} [args.now] - Injectable clock (reserved/consistency).
 * @returns {Promise<{ ok: boolean, stateFile?: string,
 *   progress?: { total: number, completed: number, percentage: number },
 *   error?: string }>}
 */
export async function syncTodo({ projectRoot, planMarkdown, planFile = 'PLAN.md', sessionId, now }) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    // Fail-closed BEFORE any read/write: a non-string plan carries no task list,
    // and writing state derived from it would destroy the prior one.
    if (typeof planMarkdown !== 'string') {
      const got = planMarkdown === null ? 'null' : typeof planMarkdown;
      return { ok: false, error: `planMarkdown must be a string (got ${got})` };
    }
    resolveNow(now); // validate clock arg for call-site consistency
    const resolvedPlan = path.isAbsolute(planFile)
      ? planFile
      : path.join(projectRoot, planFile);
    const stateFile = path.join(path.dirname(resolvedPlan), '.plan-state.json');

    const tracker = new PlanTracker();
    // Fail-closed BEFORE the write: an unreadable state file is not an absent
    // one. Proceeding would drop completion flags mergeCompletion could not
    // read, whatever the new plan parses to.
    const priorRead = await readState(stateFile);
    if (!priorRead.ok) return { ok: false, error: `refusing to overwrite state — ${priorRead.error}` };
    const prior = priorRead.data;
    if (prior) tracker.fromState(prior);
    const parsed = tracker.parsePlan(planMarkdown);
    if (parsed.length === 0) {
      const rejection = zeroTaskRejection(planMarkdown, prior);
      if (rejection) return { ok: false, error: rejection };
    }
    // parsePlan replaced the task list; put the merged one back so both
    // toState() and getProgress() see the same tasks. Passing only `tasks`
    // leaves the sessions restored above untouched.
    tracker.fromState({ tasks: mergeCompletion(parsed, prior) });
    if (sessionId) tracker.addSession(sessionId);

    const state = tracker.toState(resolvedPlan);
    await atomicWriteJson(stateFile, state);

    return { ok: true, stateFile, progress: tracker.getProgress() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Read a previously saved plan-state JSON, distinguishing absence from failure.
 *
 * Only `ENOENT` means "no prior state" — that is the first sync, and writing is
 * correct. Every other outcome (corrupt JSON, `EACCES`, `EBUSY` from a Windows
 * antivirus or concurrent handle, `EISDIR`) means state may well exist and is
 * merely unreadable. Collapsing those into `null` made the caller believe there
 * were no prior tasks, so a blank or unparsable plan overwrote good data and
 * reported `ok: true` — the same fail-open shape as the non-string bug above.
 * A BOM-prefixed state file lands here too: `JSON.parse` rejects `U+FEFF`.
 *
 * @param {string} stateFile
 * @returns {Promise<{ ok: true, data: object|null } | { ok: false, error: string }>}
 */
async function readState(stateFile) {
  let raw;
  try {
    raw = await fs.readFile(stateFile, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, data: null };
    return { ok: false, error: `cannot read ${stateFile}: ${err?.code || err?.message}` };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `${stateFile} is not valid JSON: ${err?.message}` };
  }
}
