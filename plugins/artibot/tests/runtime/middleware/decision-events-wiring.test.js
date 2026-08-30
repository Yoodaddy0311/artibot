/**
 * Decision-events WIRING — does the live middleware chain actually record?
 *
 * `tests/observability/decision-events.test.js` proves the recorder works when
 * handed a run id. It cannot prove the middleware hands it one: every case there
 * builds the resolver argument by hand (`{ hookData: { session_id } }`), which
 * is a shape no production caller constructs. Measured 2026-08-29 against that
 * green suite, the live chain recorded 0 of 2 decisions and counted both as
 * `skipped`, because the call sites passed `state.context` while the session id
 * lives at `state.input.hookData`.
 *
 * So this file asserts the seam the unit suite structurally cannot reach: drive
 * the real `createArtibotAgent().preparePrompt()` with a real hook payload and
 * require that events land on disk.
 *
 * Writes are pinned to a throwaway plugin root by `useTrailSandbox`, because the
 * middleware calls the recorder with no `storeDir` — it resolves
 * `getPluginRoot()/runtime/decisions/` at write time, which is the repo's live
 * store unless `CLAUDE_PLUGIN_ROOT` is redirected.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useTrailSandbox } from '../../helpers/trail-sandbox.js';
import { createArtibotAgent } from '../../../lib/runtime/create-artibot-agent.js';
import { resetRouter } from '../../../lib/cognitive/router.js';
import {
  getDecisionRecorderStats,
  readDecisionEvents,
  resetDecisionRecorderStats,
  ROUTING_CLASSIFIED,
  WORKFLOW_PLANNED,
} from '../../../lib/observability/decision-events.js';

const sandbox = useTrailSandbox('decision-events-wiring');

/**
 * One session id per test. The sandbox root is per-file, and the store is keyed
 * by session id, so a shared id would let earlier cases' lines accumulate into
 * the file a later case reads.
 */
let sessionId = '';
let sessionCounter = 0;

/**
 * Lands at score 0.62 against the default 0.4 threshold (measured 2026-08-29),
 * a 0.22 margin. The margin matters: D7 only fires on the `agentTeam` branch
 * (`tasks.js` — `mode === 'agentTeam'`), so a fixture that drifts under the
 * threshold would still pass every assertion about D5 while silently never
 * reaching D7. The precondition test below is what keeps that honest.
 */
const SYSTEM2_PROMPT = 'Plan the migration, refactor the backend API, redesign the '
  + 'frontend components, update the database schema, and verify security across '
  + 'the whole system';

/** Minimal config so classification does not depend on the ambient install. */
const CONFIG = { automation: {}, cognitive: { router: { threshold: 0.4 } } };

/**
 * @param {object} hookData - The hook payload, as `runtime-prompt.js` passes it.
 * @returns {Promise<object>} the `preparePrompt` envelope
 */
async function runPipeline(hookData) {
  const agent = createArtibotAgent({ pluginRoot: sandbox.root(), config: CONFIG });
  return agent.preparePrompt({ prompt: SYSTEM2_PROMPT, hookData });
}

beforeEach(() => {
  // `threshold` is mutable module state (adaptThreshold moves it), so pin it
  // rather than inherit whatever a previous run left behind.
  resetRouter();
  resetDecisionRecorderStats();
  sessionCounter += 1;
  sessionId = `sess-wiring-${sessionCounter}`;
});

describe('decision-events wiring — live middleware chain', () => {
  it('reaches both wiring points with this fixture', async () => {
    // NEGATIVE CONTROL. If either assertion fails, the recording assertions
    // below would be vacuous — a green suite that never exercised the code.
    const prepared = await runPipeline({ session_id: sessionId, event: 'UserPromptSubmit' });

    expect(prepared.context.routing.system).toBe('system2');
    expect(prepared.context.tasks.meta.workflowPlan).toBeTruthy();
  });

  it('records the routing classification (D5) and the workflow plan (D7)', async () => {
    await runPipeline({ session_id: sessionId, event: 'UserPromptSubmit' });

    expect(getDecisionRecorderStats()).toMatchObject({
      recorded: 2,
      failed: 0,
      skipped: 0,
    });

    const onDisk = readDecisionEvents(sessionId);
    expect(onDisk.map((e) => e.type)).toEqual([ROUTING_CLASSIFIED, WORKFLOW_PLANNED]);
    expect(onDisk.every((e) => e.sessionId === sessionId)).toBe(true);
  });

  it('writes the classifier outputs, and no prompt text, into the D5 line', async () => {
    await runPipeline({ session_id: sessionId, event: 'UserPromptSubmit' });

    const [routing] = readDecisionEvents(sessionId);
    expect(routing.phase).toBe('ROUTE');
    expect(routing.data.system).toBe(2);
    expect(typeof routing.data.score).toBe('number');
    expect(routing.data.factors).toMatchObject({ steps: expect.any(Number) });

    // The prompt must not ride along in any field of the persisted line.
    expect(JSON.stringify(routing)).not.toContain('database schema');
  });

  it('still skips — rather than inventing a bucket — when the payload has no session', async () => {
    // Guards the fix against over-correction: the absence must stay visible as
    // `skipped`, which is what /doctor Check 7 reads.
    await runPipeline({ event: 'UserPromptSubmit' });

    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, failed: 0, skipped: 2 });
  });
});
