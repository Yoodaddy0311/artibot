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
 * F04(b) ADDED THE SAME SWEEP WITH THE CONSUMER ON. `team.followWorkflowPlan`
 * makes the plan decide the mode, which means `data.runner` and `data.mode`
 * become one fact and the mismatch count collapses to 0 by construction. That
 * is asserted below — not as an improvement, but as the reason the key ships
 * off (owner decision OD5): the key-off sweep is the only one that still has a
 * denominator, so it stays in this file and is run first.
 * Measured 2026-09-15 with the key OFF: 2 of 10 fixture prompts mismatch, both
 * `runner: 'team'` under `mode: 'subAgent'` — a plan electing a team on a
 * system1 prompt. Those same 2 are what flips when the key goes on.
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
    // Key ABSENT by default — what ships (owner decision OD5). A test that
    // wants the F04(b) consumer must say so, and the two states never share a
    // config file.
    writeSweepConfig();
    // `threshold` is mutable module state (adaptThreshold moves it).
    resetRouter();
  });

  /**
   * Write the sweep's `artibot.config.json`.
   *
   * @param {boolean} [followWorkflowPlan] - Omit for the shipped default (key
   *   absent); pass `true`/`false` to pin the F04(b) consumer explicitly.
   * @returns {void}
   */
  function writeSweepConfig(followWorkflowPlan) {
    const team = followWorkflowPlan === undefined
      ? CONFIG.team
      : { ...CONFIG.team, followWorkflowPlan };
    writeFileSync(
      path.join(pluginRoot, 'artibot.config.json'),
      JSON.stringify({
        team,
        runtime: { effort: { budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 } } },
      }),
    );
  }

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  /**
   * Drive router → tasks for one prompt under its own session id.
   *
   * @param {string} prompt
   * @param {number} index - Distinct session id per case; the store is keyed by it.
   * @param {string} [tag] - Extra session-id segment so two sweeps in ONE test
   *   (key off vs key on) cannot pool their lines into the same session.
   * @returns {Promise<{mode: string, lines: object[]}>}
   */
  async function sweepOne(prompt, index, tag = 'base') {
    const sessionId = `sess-f04a-sweep-${tag}-${index}`;
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

  /**
   * Run the whole fixture set and reduce each case to a comparable row.
   *
   * @param {string} tag - Session-id segment, distinct per sweep.
   * @returns {Promise<Array<{runner: string, mode: string, mismatch: boolean,
   *   agreesWithEnvelope: boolean}>>}
   */
  async function sweepRows(tag) {
    const prompts = fixturePrompts();
    expect(prompts).toHaveLength(10);
    const rows = [];
    for (const [i, prompt] of prompts.entries()) {
      const { mode, lines } = await sweepOne(prompt, i, tag);
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
    return rows;
  }

  /** @param {object[]} rows @returns {string} the measurement with its denominator. */
  function mismatchReport(rows) {
    const mismatches = rows.filter((r) => r.mismatch).length;
    return `plan-vs-mode mismatch: ${mismatches} of ${rows.length} fixture prompts `
      + `(runner/mode pairs: ${rows.map((r) => `${r.runner}/${r.mode}`).join(', ')})`;
  }

  it('reports the plan-vs-mode mismatch count over the 10 fixture prompts (measurement, not an invariant)', async () => {
    const rows = await sweepRows('keyoff');

    // The measurement, with its denominator, in the failure message of an
    // assertion that cannot fail for a number — only for a broken sweep.
    expect(rows.filter((r) => r.mismatch).length, mismatchReport(rows))
      .toBeLessThanOrEqual(rows.length);

    // Asserted, unlike the count: the recorded mode is the caller's real one.
    expect(rows.filter((r) => !r.agreesWithEnvelope)).toEqual([]);
    expect(rows.every((r) => r.mode === 'agentTeam' || r.mode === 'subAgent')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // F04(b) — the same sweep with `team.followWorkflowPlan` ON.
  //
  // THE MEASUREMENT TRAP, pinned as a test rather than left in a comment: once
  // the plan decides the mode, `data.runner === 'team'` and
  // `data.mode === 'agentTeam'` are the SAME fact, so the mismatch count is 0
  // by construction and SH-04 has no denominator left to measure. The assertion
  // below is therefore not evidence that anything improved — it is evidence
  // that the metric stops working. That is why owner decision OD5 ships the key
  // off and the key-off sweep above stays in this file.
  // ---------------------------------------------------------------------------
  describe('with team.followWorkflowPlan ON (F04(b) consumer)', () => {
    it('still records exactly one line with a non-null mode for all 10 prompts', async () => {
      writeSweepConfig(true);
      const rows = await sweepRows('keyon');
      expect(rows.filter((r) => !r.agreesWithEnvelope)).toEqual([]);
      expect(rows.every((r) => r.mode === 'agentTeam' || r.mode === 'subAgent')).toBe(true);
    });

    it('drives the mismatch count to 0 BY DEFINITION — the SH-04 denominator is gone', async () => {
      writeSweepConfig(true);
      const rows = await sweepRows('keyon-mismatch');

      expect(
        rows.filter((r) => r.mismatch).length,
        `${mismatchReport(rows)} — with the key ON this can only be 0: the mode IS `
        + 'the plan. A non-zero count here means the consumer is not wired, not '
        + 'that the plan and the mode genuinely disagree.',
      ).toBe(0);
    });

    it('changes the answer for at least one prompt, or the key is not wired', async () => {
      // Negative control for the two assertions above. If the fixtures happened
      // to agree on all 10 rows under both settings, "mismatch === 0" would be
      // satisfied by a middleware that ignores the key entirely, and this file
      // would be pinning nothing. Measured 2026-09-15: the two sweeps differ.
      writeSweepConfig(false);
      const off = await sweepRows('control-off');
      writeSweepConfig(true);
      const on = await sweepRows('control-on');

      const changed = off.filter((row, i) => row.mode !== on[i].mode);
      expect(
        changed.length,
        `key off vs on: ${off.map((r) => r.mode).join(',')} -> ${on.map((r) => r.mode).join(',')}`,
      ).toBeGreaterThan(0);
    });

    it('leaves the key-off sweep identical to F04(a): explicit false === absent', async () => {
      // Behaviour change 0 on the shipped default, asserted rather than
      // asserted-about. `absent` is what `artibot.config.json` holds today.
      const absent = await sweepRows('absent');
      writeSweepConfig(false);
      const explicitFalse = await sweepRows('explicit-false');
      expect(explicitFalse).toEqual(absent);
    });
  });
});
