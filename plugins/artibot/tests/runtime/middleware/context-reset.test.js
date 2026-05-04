import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createContextResetMiddleware,
  deserializeHandoff,
  serializeHandoff,
} from '../../../lib/runtime/middleware/context-reset.js';
import * as eventBus from '../../../lib/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(tokenRatio = 0, overrides = {}) {
  return {
    userPrompt: 'test prompt',
    context: {
      tokenUsage: { ratio: tokenRatio },
      intent: { best: 'action:fix' },
      currentTask: overrides.currentTask ?? null,
      completedTasks: overrides.completedTasks ?? [],
      pendingTasks: overrides.pendingTasks ?? ['task-2'],
      decisions: overrides.decisions ?? [{ id: 'd1', text: 'use ESM' }],
      constraints: overrides.constraints ?? [],
      modifiedFiles: overrides.modifiedFiles ?? ['a.js'],
      contract: overrides.contract ?? { scope: 'module' },
      sessionId: overrides.sessionId ?? 'sess-001',
      ...overrides.context,
    },
    agent: { type: overrides.agentType ?? 'frontend-developer' },
    messageParts: [],
    ...overrides,
  };
}

function passThrough(state) {
  return state;
}

afterEach(() => {
  eventBus.reset();
});

// ---------------------------------------------------------------------------
// createContextResetMiddleware
// ---------------------------------------------------------------------------

describe('context-reset/middleware', () => {
  it('passes through when usage is below threshold', async () => {
    const mw = createContextResetMiddleware({ tokenThreshold: 0.80 });
    const state = makeState(0.5);
    const result = await mw(state, passThrough);

    expect(result.context.contextReset).toBeUndefined();
  });

  it('triggers reset when usage equals threshold', async () => {
    const mw = createContextResetMiddleware({ tokenThreshold: 0.80 });
    const state = makeState(0.80);
    const result = await mw(state, passThrough);

    expect(result.context.contextReset).toBeDefined();
    expect(result.context.contextReset.triggered).toBe(true);
  });

  it('triggers reset when usage exceeds threshold', async () => {
    const mw = createContextResetMiddleware({ tokenThreshold: 0.80 });
    const state = makeState(0.95);
    const result = await mw(state, passThrough);

    expect(result.context.contextReset.triggered).toBe(true);
    expect(result.context.contextReset.reason).toContain('95.0%');
    expect(result.context.contextReset.reason).toContain('80%');
  });

  it('includes handoff in reset info', async () => {
    const mw = createContextResetMiddleware();
    const state = makeState(0.90, { sessionId: 'sess-xyz' });
    const result = await mw(state, passThrough);

    const handoff = result.context.contextReset.handoff;
    expect(handoff.sessionId).toBe('sess-xyz');
    expect(handoff.pendingTasks).toEqual(['task-2']);
    expect(handoff.decisions).toEqual([{ id: 'd1', text: 'use ESM' }]);
    expect(handoff.modifiedFiles).toEqual(['a.js']);
  });

  it('respects custom threshold and preserveRatio', async () => {
    const mw = createContextResetMiddleware({ tokenThreshold: 0.60, preserveRatio: 0.99 });
    const state = makeState(0.65);
    const result = await mw(state, passThrough);

    expect(result.context.contextReset.triggered).toBe(true);
    expect(result.context.contextReset.preserveRatio).toBe(0.99);
    expect(result.context.contextReset.reason).toContain('60%');
  });

  it('uses default threshold 0.80 when no config given', async () => {
    const mw = createContextResetMiddleware();
    const belowState = makeState(0.79);
    const belowResult = await mw(belowState, passThrough);
    expect(belowResult.context.contextReset).toBeUndefined();

    const atState = makeState(0.80);
    const atResult = await mw(atState, passThrough);
    expect(atResult.context.contextReset).toBeDefined();
  });

  it('emits context:reset event', async () => {
    const handler = vi.fn();
    eventBus.on('context:reset', handler);

    const mw = createContextResetMiddleware();
    const state = makeState(0.85, { sessionId: 'sess-emit', agentType: 'planner' });
    await mw(state, passThrough);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].sessionId).toBe('sess-emit');
    expect(handler.mock.calls[0][0].agentType).toBe('planner');
  });

  it('does not emit event when below threshold', async () => {
    const handler = vi.fn();
    eventBus.on('context:reset', handler);

    const mw = createContextResetMiddleware();
    await mw(makeState(0.50), passThrough);

    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves existing context properties', async () => {
    const mw = createContextResetMiddleware();
    const state = makeState(0.90);
    state.context.customField = 'keep-me';
    const result = await mw(state, passThrough);

    expect(result.context.customField).toBe('keep-me');
    expect(result.context.tokenUsage.ratio).toBe(0.90);
  });

  it('handles missing tokenUsage gracefully (defaults to 0)', async () => {
    const mw = createContextResetMiddleware();
    const state = { context: {}, agent: {}, messageParts: [] };
    const result = await mw(state, passThrough);

    expect(result.context.contextReset).toBeUndefined();
  });

  it('calls next() in both paths', async () => {
    const next = vi.fn((s) => ({ ...s, passed: true }));
    const mw = createContextResetMiddleware();

    const belowResult = await mw(makeState(0.50), next);
    expect(belowResult.passed).toBe(true);

    const aboveResult = await mw(makeState(0.90), next);
    expect(aboveResult.passed).toBe(true);

    expect(next).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// serializeHandoff
// ---------------------------------------------------------------------------

describe('context-reset/serializeHandoff', () => {
  it('extracts all expected fields from state', () => {
    const state = makeState(0.90, {
      currentTask: { id: 't1' },
      completedTasks: [{ id: 't0' }],
      pendingTasks: ['t2', 't3'],
      decisions: [{ id: 'd1' }],
      constraints: ['no-mutation'],
      modifiedFiles: ['x.js', 'y.js'],
      contract: { scope: 'project' },
      sessionId: 'sess-ser',
      agentType: 'architect',
    });

    const handoff = serializeHandoff(state);

    expect(handoff.currentTask).toEqual({ id: 't1' });
    expect(handoff.completedTasks).toEqual([{ id: 't0' }]);
    expect(handoff.pendingTasks).toEqual(['t2', 't3']);
    expect(handoff.decisions).toEqual([{ id: 'd1' }]);
    expect(handoff.constraints).toEqual(['no-mutation']);
    expect(handoff.modifiedFiles).toEqual(['x.js', 'y.js']);
    expect(handoff.contract).toEqual({ scope: 'project' });
    expect(handoff.sessionId).toBe('sess-ser');
    expect(handoff.agentType).toBe('architect');
    expect(handoff.timestamp).toBeTruthy();
  });

  it('returns frozen object', () => {
    const handoff = serializeHandoff(makeState(0.90));
    expect(Object.isFrozen(handoff)).toBe(true);
  });

  it('defaults missing fields to null or empty arrays', () => {
    const state = { context: {}, agent: {} };
    const handoff = serializeHandoff(state);

    expect(handoff.currentTask).toBeNull();
    expect(handoff.completedTasks).toEqual([]);
    expect(handoff.pendingTasks).toEqual([]);
    expect(handoff.decisions).toEqual([]);
    expect(handoff.constraints).toEqual([]);
    expect(handoff.modifiedFiles).toEqual([]);
    expect(handoff.contract).toBeNull();
    expect(handoff.sessionId).toBeNull();
    expect(handoff.agentType).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deserializeHandoff
// ---------------------------------------------------------------------------

describe('context-reset/deserializeHandoff', () => {
  it('reconstructs context from handoff', () => {
    const handoff = {
      currentTask: { id: 't1' },
      completedTasks: [{ id: 't0' }],
      pendingTasks: ['t2'],
      decisions: [{ text: 'use ESM' }],
      constraints: ['immutable'],
      modifiedFiles: ['a.js'],
      contract: { scope: 'file' },
      agentType: 'backend-developer',
      timestamp: '2026-03-27T00:00:00.000Z',
    };

    const ctx = deserializeHandoff(handoff);

    expect(ctx.previousSession.tasks.current).toEqual({ id: 't1' });
    expect(ctx.previousSession.tasks.completed).toEqual([{ id: 't0' }]);
    expect(ctx.previousSession.tasks.pending).toEqual(['t2']);
    expect(ctx.previousSession.decisions).toEqual([{ text: 'use ESM' }]);
    expect(ctx.previousSession.constraints).toEqual(['immutable']);
    expect(ctx.previousSession.modifiedFiles).toEqual(['a.js']);
    expect(ctx.previousSession.contract).toEqual({ scope: 'file' });
    expect(ctx.resumedFrom).toBe('2026-03-27T00:00:00.000Z');
    expect(ctx.originalAgent).toBe('backend-developer');
  });

  it('roundtrip: serialize → deserialize preserves data', () => {
    const state = makeState(0.90, {
      currentTask: { id: 'rt1' },
      completedTasks: [{ id: 'rt0' }],
      pendingTasks: ['rt2'],
      decisions: [{ key: 'val' }],
      constraints: ['c1'],
      modifiedFiles: ['f.js'],
      contract: { type: 'sprint' },
      sessionId: 'sess-rt',
      agentType: 'qa',
    });

    const handoff = serializeHandoff(state);
    const ctx = deserializeHandoff(handoff);

    expect(ctx.previousSession.tasks.current).toEqual({ id: 'rt1' });
    expect(ctx.previousSession.tasks.completed).toEqual([{ id: 'rt0' }]);
    expect(ctx.previousSession.tasks.pending).toEqual(['rt2']);
    expect(ctx.previousSession.decisions).toEqual([{ key: 'val' }]);
    expect(ctx.previousSession.constraints).toEqual(['c1']);
    expect(ctx.previousSession.modifiedFiles).toEqual(['f.js']);
    expect(ctx.previousSession.contract).toEqual({ type: 'sprint' });
    expect(ctx.originalAgent).toBe('qa');
  });

  it('handles null input gracefully', () => {
    const ctx = deserializeHandoff(null);
    expect(ctx.previousSession).toBeNull();
    expect(ctx.resumedFrom).toBeNull();
    expect(ctx.originalAgent).toBeNull();
  });

  it('handles undefined input gracefully', () => {
    const ctx = deserializeHandoff(undefined);
    expect(ctx.previousSession).toBeNull();
  });

  it('handles empty object with defaults', () => {
    const ctx = deserializeHandoff({});
    expect(ctx.previousSession.tasks.completed).toEqual([]);
    expect(ctx.previousSession.tasks.pending).toEqual([]);
    expect(ctx.previousSession.tasks.current).toBeNull();
    expect(ctx.previousSession.decisions).toEqual([]);
    expect(ctx.resumedFrom).toBeNull();
    expect(ctx.originalAgent).toBeNull();
  });
});
