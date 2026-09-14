/**
 * F03 — budget unit normalization (tokens vs USD).
 *
 * RED pin: the autopilot budget is documented in TOKENS (`--budget <tokens>`,
 * default 2_000_000) but was enforced in DOLLARS, so 2.1M tokens against the
 * 2M default reported `{limit:2000000, used:45, percent:0}` and never paused.
 *
 * All cases are pure / DI — in-memory session store, no real session files.
 */
import {
  describe, expect, it, vi,
} from 'vitest';
import {
  budgetStatus,
  normalizeBudget,
  pauseReason,
  readUsage,
  shouldPause,
} from '../../lib/autopilot/safety.js';
import {
  checkBudgetThreshold,
  getSessionCost,
  recordPhaseUsage,
  renderCostBlock,
  renderCostInline,
} from '../../lib/autopilot/cost-tracker.js';
import { buildCostWarningInstruction, checkBudgetGate, makeInitialState } from '../../lib/autopilot/_engine-helpers.js';

/** In-memory session store + telemetry spy (same shape as cost-tracker.test.js). */
function makeStore(initialState) {
  const store = new Map();
  if (initialState && initialState.sessionId) {
    store.set(initialState.sessionId, JSON.parse(JSON.stringify(initialState)));
  }
  const loadSession = vi.fn((id) => {
    const s = store.get(id);
    return s ? JSON.parse(JSON.stringify(s)) : null;
  });
  const saveSession = vi.fn((s) => {
    store.set(s.sessionId, JSON.parse(JSON.stringify(s)));
    return s;
  });
  const appendEvent = vi.fn(() => ({}));
  return {
    store, opts: { loadSession, saveSession, appendEvent }, loadSession, saveSession, appendEvent,
  };
}

/** Session state with a token budget and a recorded token spend. */
function tokenState(sessionId, { limit, tokens, ...rest }) {
  return {
    sessionId,
    options: { budgetTokens: limit },
    usage: {
      totals: { tokensIn: tokens, tokensOut: 0, costUsd: 0 },
      phases: { EXECUTE: { tokensIn: tokens, tokensOut: 0, costUsd: 0, lastTs: '2026-09-14T08:00:00.000Z' } },
      thresholdsFired: { tokens: [], usd: [] },
      receipts: [],
    },
    ...rest,
  };
}

describe('F03 (a) 2.1M tokens against the 2M default budget', () => {
  it('exceeds, pauses, and fires the 95% token threshold', () => {
    const state = tokenState('ap-a', { limit: 2_000_000, tokens: 2_100_000 });
    const m = makeStore(state);

    const status = budgetStatus(state);
    expect(status.usageKnown).toBe(true);
    expect(status.tokens).toMatchObject({ unit: 'tokens', limit: 2_000_000, used: 2_100_000 });
    expect(status.tokens.percent).toBe(105);
    expect(status.tokens.exceeded).toBe(true);
    expect(status.usd).toBeNull();

    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('budget-exceeded');

    const crossed = checkBudgetThreshold('ap-a', m.opts);
    expect(crossed.crossed).toBe(95);
    expect(crossed.unit).toBe('tokens');
    expect(crossed.used).toBe(2_100_000);
    expect(crossed.percent).toBe(105);
    expect(crossed.usageKnown).toBe(true);
    expect(crossed.byUnit.usd).toBeNull();
  });
});

describe('F03 (b)(c) exhaustion boundary', () => {
  it('treats used === limit as exceeded (fail-closed reading of 초과 시 pause)', () => {
    const state = tokenState('ap-b', { limit: 2_000_000, tokens: 2_000_000 });
    const m = makeStore(state);
    expect(budgetStatus(state).tokens.exceeded).toBe(true);
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('budget-exceeded');
    expect(checkBudgetThreshold('ap-b', m.opts)).toMatchObject({ crossed: 95, unit: 'tokens', percent: 100 });
  });

  it('at 1.9M fires 95% but does not pause', () => {
    const state = tokenState('ap-c', { limit: 2_000_000, tokens: 1_900_000 });
    const m = makeStore(state);
    expect(budgetStatus(state).tokens.exceeded).toBe(false);
    expect(shouldPause(state)).toBe(false);
    expect(pauseReason(state)).toBeNull();
    expect(checkBudgetThreshold('ap-c', m.opts)).toMatchObject({ crossed: 95, unit: 'tokens', percent: 95 });
  });
});

describe('F03 (d) unknown usage is never "0 = unlimited safe"', () => {
  it('reports usageKnown:false, never pauses, crosses nothing', () => {
    const state = { sessionId: 'ap-d', options: { budgetTokens: 2_000_000 } };
    const m = makeStore(state);
    expect(readUsage(state)).toEqual({
      tokens: null, usd: null, known: false, source: null, measuredAt: null,
    });
    const status = budgetStatus(state);
    expect(status.usageKnown).toBe(false);
    expect(status.tokens.exceeded).toBe(false);
    expect(shouldPause(state)).toBe(false);
    expect(pauseReason(state)).toBeNull();
    const crossed = checkBudgetThreshold('ap-d', m.opts);
    expect(crossed.crossed).toBeNull();
    expect(crossed.usageKnown).toBe(false);
  });

  it('checkBudgetGate warns about unknown usage exactly once across two calls', () => {
    const state = { sessionId: 'ap-d2', options: { budgetTokens: 2_000_000 } };
    const appendEvent = vi.fn();
    const persist = vi.fn((s) => s);
    checkBudgetGate(state, 'dispatch', { appendEvent, persist });
    checkBudgetGate(state, 'ack', { appendEvent, persist });
    const types = appendEvent.mock.calls.map((c) => c[1].type);
    expect(types.filter((t) => t === 'budget-usage-unknown')).toHaveLength(1);
    expect(types.filter((t) => t === 'budget-check')).toHaveLength(2);
    expect(typeof state.usage.unknownWarnedAt).toBe('string');
  });

  it('emits budget-exceeded from the gate when a unit is over its limit', () => {
    const state = tokenState('ap-d3', { limit: 2_000_000, tokens: 2_100_000 });
    const appendEvent = vi.fn();
    const status = checkBudgetGate(state, 'dispatch', { appendEvent, persist: (s) => s });
    expect(status.tokens.exceeded).toBe(true);
    const types = appendEvent.mock.calls.map((c) => c[1].type);
    expect(types).toContain('budget-exceeded');
    expect(types).not.toContain('budget-usage-unknown');
  });

  it('never throws when telemetry or state is unusable', () => {
    expect(() => checkBudgetGate(null, 'dispatch')).not.toThrow();
    expect(() => checkBudgetGate({ sessionId: 'x' }, 'dispatch', {
      appendEvent: () => { throw new Error('telemetry down'); },
      persist: () => { throw new Error('disk full'); },
    })).not.toThrow();
  });
});

describe('F03 (e) receiptId de-duplication', () => {
  it('counts a repeated receiptId once and reports it as a duplicate', () => {
    const m = makeStore({ sessionId: 'ap-e' });
    const first = recordPhaseUsage('ap-e', 'EXECUTE', {
      tokensIn: 100, tokensOut: 50, costUsd: 0.01, receiptId: 'r-1',
    }, m.opts);
    expect(first).toMatchObject({ tokensIn: 100, tokensOut: 50 });
    const saveCalls = m.saveSession.mock.calls.length;

    const second = recordPhaseUsage('ap-e', 'EXECUTE', {
      tokensIn: 100, tokensOut: 50, costUsd: 0.01, receiptId: 'r-1',
    }, m.opts);
    expect(second).toBeNull();
    expect(m.saveSession.mock.calls).toHaveLength(saveCalls);
    expect(m.store.get('ap-e').usage.totals).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0.01 });
    expect(m.store.get('ap-e').usage.receipts).toEqual(['r-1']);
    const dup = m.appendEvent.mock.calls.map((c) => c[1]).find((e) => e.type === 'usage-duplicate');
    expect(dup).toBeDefined();
    expect(dup.level).toBe('info');
  });

  it('still records payloads that carry no receiptId', () => {
    const m = makeStore({ sessionId: 'ap-e2' });
    recordPhaseUsage('ap-e2', 'EXECUTE', { tokensIn: 10 }, m.opts);
    recordPhaseUsage('ap-e2', 'EXECUTE', { tokensIn: 10 }, m.opts);
    expect(m.store.get('ap-e2').usage.totals.tokensIn).toBe(20);
  });

  it('caps the receipts ledger at 200 entries, dropping the oldest', () => {
    const m = makeStore({ sessionId: 'ap-e3' });
    for (let i = 0; i < 205; i += 1) {
      recordPhaseUsage('ap-e3', 'EXECUTE', { tokensIn: 1, receiptId: `r-${i}` }, m.opts);
    }
    const { receipts } = m.store.get('ap-e3').usage;
    expect(receipts).toHaveLength(200);
    expect(receipts[0]).toBe('r-5');
    expect(receipts[199]).toBe('r-204');
  });
});

describe('F03 (f) the two units are independent', () => {
  it('fires USD thresholds without touching the token list', () => {
    const state = {
      sessionId: 'ap-f',
      options: { budgetTokens: 2_000_000, budgetUsd: 10 },
      usage: {
        totals: { tokensIn: 100_000, tokensOut: 0, costUsd: 8.5 },
        phases: {},
        thresholdsFired: { tokens: [], usd: [] },
        receipts: [],
      },
    };
    const m = makeStore(state);
    const out = checkBudgetThreshold('ap-f', m.opts);
    expect(out.byUnit.tokens).toMatchObject({ crossed: null, percent: 5 });
    expect(out.byUnit.usd).toMatchObject({ crossed: 80, limit: 10, used: 8.5, percent: 85 });
    expect(out.crossed).toBe(80);
    expect(out.unit).toBe('usd');
    const stored = m.store.get('ap-f').usage.thresholdsFired;
    expect(stored.usd).toEqual([50, 80]);
    expect(stored.tokens).toEqual([]);
  });

  it('migrates a legacy thresholdsFired number[] into the usd list', () => {
    const state = {
      sessionId: 'ap-f2',
      options: { budgetUsd: 10 },
      usage: {
        totals: { tokensIn: 0, tokensOut: 0, costUsd: 8.5 },
        phases: {},
        thresholdsFired: [50],
      },
    };
    const m = makeStore(state);
    const out = checkBudgetThreshold('ap-f2', m.opts);
    expect(out.crossed).toBe(80); // 50 already fired under the legacy list
    expect(out.unit).toBe('usd');
    expect(m.store.get('ap-f2').usage.thresholdsFired).toEqual({ tokens: [], usd: [50, 80] });
  });

  it('lets tokens win a tie when both units cross the same line', () => {
    const state = {
      sessionId: 'ap-f3',
      options: { budgetTokens: 1000, budgetUsd: 10 },
      usage: {
        totals: { tokensIn: 600, tokensOut: 0, costUsd: 6 },
        phases: {},
        thresholdsFired: { tokens: [], usd: [] },
      },
    };
    const m = makeStore(state);
    const out = checkBudgetThreshold('ap-f3', m.opts);
    expect(out.crossed).toBe(50);
    expect(out.unit).toBe('tokens');
    expect(out.byUnit.usd.crossed).toBe(50);
  });
});

describe('F03 (g) normalizeBudget', () => {
  it('prefers canonical budgetTokens over the legacy budget field', () => {
    expect(normalizeBudget({ budgetTokens: 5, budget: 9 })).toEqual({
      budgetTokens: 5, budgetUsd: null, source: 'budgetTokens',
    });
  });

  it('reads a lone legacy budget AS TOKENS (documented contract)', () => {
    expect(normalizeBudget({ budget: 2_000_000 })).toEqual({
      budgetTokens: 2_000_000, budgetUsd: null, source: 'budget-compat',
    });
  });

  it('treats budgetUsd as an independent limit', () => {
    expect(normalizeBudget({ budgetUsd: 60 })).toEqual({
      budgetTokens: null, budgetUsd: 60, source: 'none',
    });
    expect(normalizeBudget({ budgetTokens: 10, budgetUsd: 60 })).toEqual({
      budgetTokens: 10, budgetUsd: 60, source: 'budgetTokens',
    });
  });

  it.each([
    ['string', { budgetTokens: '2000000' }],
    ['NaN', { budgetTokens: NaN }],
    ['zero', { budgetTokens: 0 }],
    ['negative', { budgetTokens: -1 }],
    ['Infinity', { budgetTokens: Infinity }],
    ['null options', null],
    ['undefined options', undefined],
  ])('rejects %s', (_name, options) => {
    expect(normalizeBudget(options)).toEqual({
      budgetTokens: null, budgetUsd: null, source: 'none',
    });
  });

  it('rejects the same set for the legacy and USD fields', () => {
    expect(normalizeBudget({ budget: '5' }).budgetTokens).toBeNull();
    expect(normalizeBudget({ budget: 0 }).budgetTokens).toBeNull();
    expect(normalizeBudget({ budgetUsd: -3 }).budgetUsd).toBeNull();
    expect(normalizeBudget({ budgetUsd: 'x' }).budgetUsd).toBeNull();
  });
});

describe('F03 (h) buildCostWarningInstruction renders the crossed unit', () => {
  it('renders the tokens form for a tokens threshold', () => {
    const state = tokenState('ap-h', { limit: 2_000_000, tokens: 2_100_000 });
    const notifyPause = vi.fn((sid, reason) => ({ sid, reason }));
    const out = buildCostWarningInstruction(state, {
      crossed: 80, unit: 'tokens', used: 2_100_000, percent: 105,
    }, { notifyPause });
    expect(out.reason).toBe('budget 80% reached (2.1M / 2.0M tokens = 105%)');
    expect(notifyPause).toHaveBeenCalledTimes(1);
  });

  it('renders the $ form for a usd threshold', () => {
    const state = { sessionId: 'ap-h2', options: { budgetUsd: 60 } };
    const notifyPause = vi.fn((sid, reason) => ({ sid, reason }));
    const out = buildCostWarningInstruction(state, {
      crossed: 50, unit: 'usd', used: 45, percent: 75,
    }, { notifyPause });
    expect(out.reason).toBe('budget 50% reached ($45.0000 / $60.0000 = 75%)');
  });

  it('routes 95 through notifyDanger with the unit attached', () => {
    const state = tokenState('ap-h3', { limit: 2_000_000, tokens: 2_100_000 });
    const notifyDanger = vi.fn((sid, payload) => ({ sid, payload }));
    const out = buildCostWarningInstruction(state, {
      crossed: 95, unit: 'tokens', used: 2_100_000, percent: 105,
    }, { notifyDanger });
    expect(notifyDanger).toHaveBeenCalledTimes(1);
    expect(out.payload).toEqual({
      riskType: 'budget-threshold-95',
      detail: {
        used: 2_100_000, limit: 2_000_000, percent: 105, unit: 'tokens',
      },
    });
  });

  it('returns null when nothing crossed', () => {
    expect(buildCostWarningInstruction({ sessionId: 'x' }, { crossed: null })).toBeNull();
    expect(buildCostWarningInstruction(null, { crossed: 95 })).toBeNull();
  });
});

describe('F03 state + render surfaces', () => {
  it('makeInitialState defaults budgetTokens and mirrors the legacy field', () => {
    const s = makeInitialState({ task: 't' });
    expect(s.options.budgetTokens).toBe(2_000_000);
    expect(s.options.budget).toBe(2_000_000);
  });

  it('mirrors a caller-supplied legacy budget into budgetTokens', () => {
    const s = makeInitialState({ task: 't', options: { budget: 500_000 } });
    expect(s.options.budgetTokens).toBe(500_000);
    expect(s.options.budget).toBe(500_000);
  });

  it('keeps an explicit budgetTokens over a conflicting legacy budget', () => {
    const s = makeInitialState({ task: 't', options: { budget: 9, budgetTokens: 7 } });
    expect(s.options.budgetTokens).toBe(7);
  });

  it('renders the token budget with its unit and the USD budget with $', () => {
    const m = makeStore(tokenState('ap-r', { limit: 2_000_000, tokens: 2_100_000 }));
    const summary = getSessionCost('ap-r', m.opts);
    expect(summary.budgetUsage.tokens).toEqual({ limit: 2_000_000, used: 2_100_000, percent: 105 });
    expect(summary.budgetUsage.usd).toBeNull();
    expect(summary.budgetUsage.usageKnown).toBe(true);
    expect(renderCostBlock(summary)).toContain('**Budget**: 2.1M / 2.0M tokens (105%)');
    expect(renderCostInline(summary)).toContain('budget: 2.1M / 2.0M tokens (105%)');
  });

  it('renders the USD line when only a USD limit is set', () => {
    const summary = {
      totalTokens: 100,
      totalCostUsd: 45,
      perPhase: [{
        phase: 'EXECUTE', tokensIn: 100, tokensOut: 0, costUsd: 45,
      }],
      budgetUsage: {
        tokens: null, usd: { limit: 60, used: 45, percent: 75 }, usageKnown: true, source: 'none', measuredAt: null,
      },
    };
    expect(renderCostBlock(summary)).toContain('**Budget**: $45.0000 / $60.0000 (75%)');
  });

  it('renders "budget: unknown usage" instead of a fake 0%', () => {
    const summary = {
      totalTokens: 0,
      totalCostUsd: 0,
      perPhase: [{
        phase: 'EXECUTE', tokensIn: 0, tokensOut: 0, costUsd: 0,
      }],
      budgetUsage: {
        tokens: { limit: 2_000_000, used: 0, percent: 0 },
        usd: null,
        usageKnown: false,
        source: 'budgetTokens',
        measuredAt: null,
      },
    };
    // The literal `budget: unknown usage` is the inline (TUI footer) form;
    // the markdown block carries its own **Budget** label.
    expect(renderCostBlock(summary)).toContain('**Budget**: unknown usage');
    expect(renderCostBlock(summary)).not.toContain('(0%)');
    expect(renderCostInline(summary)).toContain('budget: unknown usage');
  });
});

describe('F03 (i) makeInitialState coerces budget options at the state boundary', () => {
  // The command driver passes `--budget 500000` as text. normalizeBudget
  // rejects strings on purpose, so an uncoerced string would persist and
  // silently mean "no limit" — the exact hole the reviewer constructed.
  it('accepts a numeric-string legacy budget as tokens', () => {
    const s = makeInitialState({ task: 't', options: { budget: '500000' } });
    expect(s.options.budgetTokens).toBe(500000);
    expect(s.options.budget).toBe(500000);
    expect(normalizeBudget(s.options)).toMatchObject({ budgetTokens: 500000, source: 'budgetTokens' });
    expect(budgetStatus({ ...s, usage: { totals: { tokensIn: 600000, tokensOut: 0, costUsd: 0 } } }).tokens.exceeded).toBe(true);
  });

  it('falls back to the 2M default for a non-numeric string (fail-closed, never unlimited)', () => {
    const s = makeInitialState({ task: 't', options: { budgetTokens: 'abc', budget: '' } });
    expect(s.options.budgetTokens).toBe(2_000_000);
    expect(normalizeBudget(s.options).budgetTokens).toBe(2_000_000);
  });

  it('coerces budgetUsd strings and drops invalid ones', () => {
    expect(makeInitialState({ task: 't', options: { budgetUsd: '12.5' } }).options.budgetUsd).toBe(12.5);
    expect(makeInitialState({ task: 't', options: { budgetUsd: 'nope' } }).options.budgetUsd).toBeUndefined();
    expect(normalizeBudget(makeInitialState({ task: 't', options: { budgetUsd: 'nope' } }).options).budgetUsd).toBeNull();
  });

  it('mirrors one resolved value into legacy budget when both keys are given', () => {
    const s = makeInitialState({ task: 't', options: { budget: 5, budgetTokens: 7 } });
    expect(s.options.budgetTokens).toBe(7);
    expect(s.options.budget).toBe(7);
  });
});
