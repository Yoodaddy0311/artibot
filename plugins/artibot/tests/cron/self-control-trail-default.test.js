/**
 * D9 — the DEFAULT `trail` binding of the four self-control runners.
 *
 * The sibling runner suites inject a `trail` spy on every call, so the default
 * `(decision) => recordSelfControlDecision(runId, decision, { cwd })` was code
 * no test executed (cross-review 2026-09-05, finding #3). Each case here leaves
 * `trail` unset, hands the runner only a `runId`, and asserts that one
 * `self-control-decided` line landed in the decisions store under the run's
 * project root. The earliest refusal path is used for each runner so no git,
 * tool, or scheduler side effect is needed.
 *
 * WHAT THIS SUITE CANNOT SEE: the CLI `main()` of each runner (it reads the
 * real config and calls `process.exit`); only the exported pipeline function
 * runs. That `main()` mints `cronRunId(...)` is asserted by source scan in
 * `tests/observability/decision-events-d9.test.js`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAutoCleanup } from '../../scripts/cron/auto-cleanup-runner.js';
import { runAutoCommit } from '../../scripts/cron/auto-commit-runner.js';
import { runAutoMacroRegister } from '../../scripts/cron/auto-macro-register-runner.js';
import { createAutoPR } from '../../scripts/cron/auto-pr-creator.js';
import {
  readDecisionEvents,
  resetDecisionRecorderStats,
  SELF_CONTROL_DECIDED,
} from '../../lib/observability/decision-events.js';

/** A throwaway project root. The `.git` marker pins `resolveProjectRoot` here. */
let root;
const RUN_ID = 'cron-default-binding-20260905-000000';

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'artibot-cron-default-'));
  mkdirSync(path.join(root, '.git'), { recursive: true });
  resetDecisionRecorderStats();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetDecisionRecorderStats();
});

const trippedKillSwitch = () => ({
  isKillSwitchTripped: vi.fn(async () => true),
  recordFailure: vi.fn(async () => undefined),
});
const quietGuard = () => ({
  shouldObserveOnly: vi.fn(async () => ({ shouldObserve: false, mode: 'active' })),
  bumpRunCounter: vi.fn(async () => undefined),
});
const logger = { log: vi.fn() };

/** The one line the run wrote, read back from `<root>/.artibot/runtime/decisions/`. */
function writtenLine() {
  const events = readDecisionEvents(RUN_ID, { projectRoot: root });
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe(SELF_CONTROL_DECIDED);
  return events[0];
}

describe('each runner records through the default trail when no trail is injected', () => {
  it('auto-cleanup → refused (kill switch) lands under cwd', async () => {
    const config = { ago: { selfControl: { masterEnabled: true, autoCleanup: { enabled: true, tools: ['eslint-fix'] } } } };
    const r = await runAutoCleanup({
      cwd: root, config, logger, runId: RUN_ID,
      killSwitch: trippedKillSwitch(), firstRunGuard: quietGuard(),
    });
    expect(r.ran).toBe(false);
    expect(writtenLine().data).toMatchObject({ subsystem: 'auto-cleanup', action: 'refused' });
  });

  it('auto-commit → refused (kill switch) lands under cwd', async () => {
    const config = { ago: { selfControl: { masterEnabled: true, autoCommit: { enabled: true } } } };
    const r = await runAutoCommit({
      cwd: root, config, logger, runId: RUN_ID,
      killSwitch: trippedKillSwitch(), firstRunGuard: quietGuard(),
    });
    expect(r.ran).toBe(false);
    expect(writtenLine().data).toMatchObject({ subsystem: 'auto-commit', action: 'refused' });
  });

  it('auto-macro-register → refused (opt-out) lands under pluginRoot', async () => {
    const config = { ago: { selfControl: { masterEnabled: false } } };
    const r = await runAutoMacroRegister({ pluginRoot: root, config, logger, runId: RUN_ID });
    expect(r.ran).toBe(false);
    expect(writtenLine().data).toMatchObject({ subsystem: 'auto-macro-register', action: 'refused' });
  });

  it('auto-pr-creator → rejected (gate closed) lands under pluginRoot', async () => {
    const config = { ago: { selfControl: { masterEnabled: false } } };
    const r = await createAutoPR({ config, pluginRoot: root, category: 'drift', runId: RUN_ID });
    expect(r.status).toBe('rejected');
    expect(writtenLine().data).toMatchObject({ subsystem: 'auto-pr-creator', action: 'rejected' });
  });

  it('writes nothing at all when the runner gets no runId (no session, no file)', async () => {
    const config = { ago: { selfControl: { masterEnabled: false } } };
    await runAutoMacroRegister({ pluginRoot: root, config, logger });
    expect(readDecisionEvents(RUN_ID, { projectRoot: root })).toEqual([]);
  });
});
