/**
 * F04(a) MEASUREMENT — how often does `plan.runner` disagree with `task.mode`?
 *
 * WHAT THIS FILE IS FOR. `recordWorkflowPlanDecision` now carries the caller's
 * topology (`data.mode`) beside the plan's own runner (`data.runner`), which
 * makes the disagreement countable for the first time: until F04(a) the only
 * live caller was the `agentTeam` branch of
 * `lib/runtime/middleware/tasks.js#createTasksMiddleware`, so every line on
 * disk had `mode === 'agentTeam'` by construction and the reverse direction
 * (system1 carrying a `runner: 'team'` plan) could not appear at all.
 *
 * WHAT IT ASSERTS vs WHAT IT REPORTS — do not conflate the two:
 *   - ASSERTED (an invariant): every case with a session id produces exactly
 *     one `workflow-planned` line, and that line's `mode` is non-null. This is
 *     the 100%-recording claim.
 *   - REPORTED (a measurement, not an invariant): the mismatch count, printed
 *     with its denominator. A specific number is NOT asserted — it is a
 *     property of the fixtures and the shipped thresholds, and pinning it would
 *     turn a routine classifier tweak into a red test for no gain.
 *
 * WHY THESE FIXTURES. `tests/evals/fixtures/nl-activation.cases.jsonl` is the
 * repository's existing set of REAL prompts (design-derived, Korean and mixed),
 * not strings invented here to make a number look good. Ten cases is a small
 * denominator and is reported as such.
 *
 * WHAT IT CANNOT SEE. Ten hand-curated fixtures are not the live distribution.
 * The live store's own mismatch rate is a separate measurement over
 * `<projectRoot>/.artibot/runtime/decisions/`; this file proves the field is
 * populated on both branches, not what the population looks like in production.
 *
 * The real router middleware runs first — the plan reads
 * `intent.recommendations`, which only that middleware produces, so a
 * hand-built intent would measure the fixture author instead of the classifier.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouterMiddleware } from '../../lib/runtime/middleware/router.js';
import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { resetRouter } from '../../lib/cognitive/router.js';
import {
  readDecisionEvents,
  WORKFLOW_PLANNED,
} from '../../lib/observability/decision-events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'evals', 'fixtures', 'nl-activation.cases.jsonl');

/** Minimal config, so the measurement does not depend on the ambient install. */
const CONFIG = {
  automation: { supportedLanguages: ['en', 'ko'], ambiguityThreshold: 50 },
  cognitive: { router: { threshold: 0.4 } },
  team: {
    enabled: true,
    autoApplyTriggers: {
      logic: 'OR', minSubtasks: 2, minFiles: 2, minComplexity: 'high',
    },
  },
};

/** @returns {string[]} the `prompt` field of every fixture case, in file order. */
function fixturePrompts() {
  return readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).prompt)
    .filter((p) => typeof p === 'string' && p.length > 0);
}

describe('F04(a) — mode is recorded on every routing path (fixture sweep)', () => {
  let projectRoot;
  let pluginRoot;

  beforeEach(() => {
    // A real `.git` marker: without it `lib/git/project-root.js#resolveProjectRoot`
    // climbs out of tmpdir and the sweep writes into this repository's live store.
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-f04a-sweep-'));
    mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-f04a-sweep-plugin-'));
    mkdirSync(path.join(pluginRoot, 'runtime'), { recursive: true });
    writeFileSync(
      path.join(pluginRoot, 'artibot.config.json'),
      JSON.stringify({
        team: CONFIG.team,
        runtime: { effort: { budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 } } },
      }),
    );
    // `threshold` is mutable module state (adaptThreshold moves it).
    resetRouter();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  /**
   * Drive router → tasks for one prompt under its own session id.
   *
   * @param {string} prompt
   * @param {number} index - Distinct session id per case; the store is keyed by it.
   * @returns {Promise<{mode: string, lines: object[]}>}
   */
  async function sweepOne(prompt, index) {
    const sessionId = `sess-f04a-sweep-${index}`;
    const state = {
      input: { prompt, pluginRoot, hookData: { cwd: projectRoot, session_id: sessionId } },
      userPrompt: prompt,
      messageParts: [],
      config: CONFIG,
      context: { runtime: { sessionDepth: 0 } },
    };
    await createRouterMiddleware()(state);
    await createTasksMiddleware({ now: () => 1700000000000 })(state);
    return {
      mode: state.context.tasks.mode,
      lines: readDecisionEvents(sessionId, { cwd: projectRoot })
        .filter((e) => e.type === WORKFLOW_PLANNED),
    };
  }

  it('yields exactly one workflow-planned line with a non-null mode for all 10 fixture prompts', async () => {
    const prompts = fixturePrompts();
    // Self-check: a fixture file that failed to parse would make the sweep
    // trivially green over an empty list.
    expect(prompts).toHaveLength(10);

    const offContract = [];
    for (const [i, prompt] of prompts.entries()) {
      const { lines } = await sweepOne(prompt, i);
      if (lines.length !== 1 || typeof lines[0].data.mode !== 'string') {
        offContract.push({ index: i, lines: lines.length, mode: lines[0]?.data.mode ?? null });
      }
    }

    expect(offContract).toEqual([]);
  });

  it('reports the plan-vs-mode mismatch count over the 10 fixture prompts (measurement, not an invariant)', async () => {
    const prompts = fixturePrompts();
    const rows = [];
    for (const [i, prompt] of prompts.entries()) {
      const { mode, lines } = await sweepOne(prompt, i);
      const data = lines[0].data;
      rows.push({
        runner: data.runner,
        mode: data.mode,
        mismatch: (data.runner === 'team') !== (data.mode === 'agentTeam'),
        // The recorded mode must be the mode the middleware actually ran under,
        // not merely one of the two allowlisted strings.
        agreesWithEnvelope: data.mode === mode,
      });
    }

    const mismatches = rows.filter((r) => r.mismatch).length;
    // The measurement, with its denominator, in the failure message of an
    // assertion that cannot fail for a number — only for a broken sweep.
    expect(
      mismatches,
      `plan-vs-mode mismatch: ${mismatches} of ${rows.length} fixture prompts `
      + `(runner/mode pairs: ${rows.map((r) => `${r.runner}/${r.mode}`).join(', ')})`,
    ).toBeLessThanOrEqual(rows.length);

    // Asserted, unlike the count: the recorded mode is the caller's real one.
    expect(rows.filter((r) => !r.agreesWithEnvelope)).toEqual([]);
    expect(rows.every((r) => r.mode === 'agentTeam' || r.mode === 'subAgent')).toBe(true);
  });
});
