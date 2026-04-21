/**
 * Tests for scripts/cron/auto-macro-register-runner.
 *
 * Covers the default-ON gate model + observe-mode + kill-switch wiring.
 * All deps are injected via the `deps` bag — no real module loads, no FS.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  checkGates,
  runAutoMacroRegister,
} from '../../scripts/cron/auto-macro-register-runner.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig({ masterEnabled = true, enabled = true } = {}) {
  return {
    ago: {
      selfControl: {
        masterEnabled,
        autoMacroRegister: { enabled },
      },
    },
  };
}

function makeKillSwitch({ tripped = false } = {}) {
  return {
    isKillSwitchTripped: vi.fn(async () => tripped),
    recordFailure: vi.fn(async () => undefined),
  };
}

function makeFirstRunGuard({ observe = false } = {}) {
  return {
    shouldObserveOnly: vi.fn(async () => ({ shouldObserve: observe })),
    bumpRunCounter: vi.fn(async () => undefined),
  };
}

function makeMacroLearner({ registered = [], skipped = [], reason } = {}) {
  return {
    sweepAutoRegister: vi.fn(async () => ({ registered, skipped, reason })),
  };
}

function makeDeps(overrides = {}) {
  return {
    pluginRoot: '/repo',
    config: makeConfig(),
    dryRun: false,
    logger: { log: vi.fn() },
    killSwitch: makeKillSwitch(),
    firstRunGuard: makeFirstRunGuard(),
    macroLearner: makeMacroLearner({ registered: [{ id: 's1', macroId: 'm_s1' }] }),
    trail: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkGates
// ---------------------------------------------------------------------------

describe('auto-macro-register-runner checkGates', () => {
  it('allows by default when no opt-out keys are set', () => {
    expect(checkGates({}).allowed).toBe(true);
  });

  it('blocks when masterEnabled=false', () => {
    const r = checkGates(makeConfig({ masterEnabled: false }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('masterEnabled=false');
  });

  it('blocks when autoMacroRegister.enabled=false', () => {
    const r = checkGates(makeConfig({ enabled: false }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('autoMacroRegister.enabled=false');
  });
});

// ---------------------------------------------------------------------------
// runAutoMacroRegister — Gate 1 (opt-out)
// ---------------------------------------------------------------------------

describe('runAutoMacroRegister opt-out', () => {
  it('short-circuits when masterEnabled=false', async () => {
    const deps = makeDeps({ config: makeConfig({ masterEnabled: false }) });
    const r = await runAutoMacroRegister(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('masterEnabled=false');
    expect(deps.macroLearner.sweepAutoRegister).not.toHaveBeenCalled();
    expect(deps.trail).toHaveBeenCalledWith(expect.objectContaining({ action: 'refused' }));
  });

  it('short-circuits when autoMacroRegister.enabled=false', async () => {
    const deps = makeDeps({ config: makeConfig({ enabled: false }) });
    const r = await runAutoMacroRegister(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('autoMacroRegister.enabled=false');
    expect(deps.macroLearner.sweepAutoRegister).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runAutoMacroRegister — Gate 2 (kill switch)
// ---------------------------------------------------------------------------

describe('runAutoMacroRegister kill-switch', () => {
  it('short-circuits when kill-switch is tripped', async () => {
    const deps = makeDeps({ killSwitch: makeKillSwitch({ tripped: true }) });
    const r = await runAutoMacroRegister(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('kill-switch-tripped');
    expect(deps.macroLearner.sweepAutoRegister).not.toHaveBeenCalled();
  });

  it('records failure on sweep throw', async () => {
    const ks = makeKillSwitch();
    const macroLearner = {
      sweepAutoRegister: vi.fn(async () => { throw new Error('boom'); }),
    };
    const deps = makeDeps({ killSwitch: ks, macroLearner });
    await expect(runAutoMacroRegister(deps)).rejects.toThrow('boom');
    expect(ks.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'auto-macro-register', error: 'boom' }),
      expect.anything(),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// runAutoMacroRegister — Gate 3 (first-run guard)
// ---------------------------------------------------------------------------

describe('runAutoMacroRegister first-run-guard', () => {
  it('bumps run counter even when active', async () => {
    const frg = makeFirstRunGuard({ observe: false });
    const deps = makeDeps({ firstRunGuard: frg });
    await runAutoMacroRegister(deps);
    expect(frg.bumpRunCounter).toHaveBeenCalledWith(
      'auto-macro-register',
      expect.anything(),
      expect.anything(),
    );
  });

  it('propagates observeMode=true when guard is active', async () => {
    const deps = makeDeps({ firstRunGuard: makeFirstRunGuard({ observe: true }) });
    const r = await runAutoMacroRegister(deps);
    expect(r.observeMode).toBe(true);
    // Sweep still runs; macro-learner itself enforces observe-only per entry.
    expect(deps.macroLearner.sweepAutoRegister).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runAutoMacroRegister — dry-run + happy path
// ---------------------------------------------------------------------------

describe('runAutoMacroRegister dry-run + sweep', () => {
  it('does not invoke sweep when --dry-run', async () => {
    const deps = makeDeps({ dryRun: true });
    const r = await runAutoMacroRegister(deps);
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('dry-run');
    expect(deps.macroLearner.sweepAutoRegister).not.toHaveBeenCalled();
  });

  it('returns registered/skipped counts and records decision', async () => {
    const deps = makeDeps({
      macroLearner: makeMacroLearner({
        registered: [{ id: 'a', macroId: 'm_a' }, { id: 'b', macroId: 'm_b' }],
        skipped: [{ id: 'c', reason: 'low-confidence' }],
      }),
    });
    const r = await runAutoMacroRegister(deps);
    expect(r.ran).toBe(true);
    expect(r.registered).toBe(2);
    expect(r.skipped).toBe(1);
    expect(deps.trail).toHaveBeenCalledWith(expect.objectContaining({
      subsystem: 'auto-macro-register',
      action: 'registered',
    }));
  });

  it('action=swept when no macros registered', async () => {
    const deps = makeDeps({
      macroLearner: makeMacroLearner({ registered: [], skipped: [{ id: 'a', reason: 'not-pending' }] }),
    });
    await runAutoMacroRegister(deps);
    expect(deps.trail).toHaveBeenCalledWith(expect.objectContaining({ action: 'swept' }));
  });
});
