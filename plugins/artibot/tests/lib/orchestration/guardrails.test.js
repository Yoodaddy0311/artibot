import { beforeEach, describe, expect, it } from 'vitest';
import {
  Guardrail,
  GuardrailTripped,
  runAll,
  runOrThrow,
} from '../../../lib/orchestration/guardrails.js';
import {
  clearToolGuardrails,
  evaluateToolInput,
  inspectRegistry,
  registerToolGuardrail,
  ToolGuardrailRejection,
} from '../../../lib/orchestration/tool-guardrails.js';

describe('Guardrail', () => {
  it('requires name and run function', () => {
    expect(() => new Guardrail({ name: 'a' })).toThrow(TypeError);
    expect(() => new Guardrail({ run: () => ({}) })).toThrow(TypeError);
    expect(() => new Guardrail({ name: 'ok', run: () => ({}) })).not.toThrow();
  });

  it('runAll returns tripped=false when all pass', async () => {
    const g1 = new Guardrail({ name: 'a', run: async () => ({ tripwireTriggered: false }) });
    const g2 = new Guardrail({ name: 'b', run: async () => ({ tripwireTriggered: false }) });
    const result = await runAll([g1, g2], {}, 'input');
    expect(result.tripped).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => !r.tripwireTriggered)).toBe(true);
  });

  it('runAll trips when any guardrail trips', async () => {
    const g1 = new Guardrail({ name: 'clean', run: async () => ({ tripwireTriggered: false }) });
    const g2 = new Guardrail({
      name: 'pii',
      run: async () => ({ tripwireTriggered: true, info: { kind: 'email' } }),
    });
    const result = await runAll([g1, g2], {}, 'input');
    expect(result.tripped).toBe(true);
    const trippedEntry = result.results.find((r) => r.tripwireTriggered);
    expect(trippedEntry.name).toBe('pii');
    expect(trippedEntry.info).toEqual({ kind: 'email' });
  });

  it('runAll returns empty results for empty list', async () => {
    const result = await runAll([], {}, 'x');
    expect(result.tripped).toBe(false);
    expect(result.results).toEqual([]);
  });

  it('runOrThrow throws GuardrailTripped on trip', async () => {
    const g = new Guardrail({
      name: 'block',
      run: async () => ({ tripwireTriggered: true, info: 'why' }),
    });
    await expect(runOrThrow([g], {}, 'x')).rejects.toBeInstanceOf(GuardrailTripped);
  });

  it('runs in parallel (slowest determines wall time)', async () => {
    const slow = new Guardrail({
      name: 'slow',
      run: () =>
        new Promise((resolve) => setTimeout(() => resolve({ tripwireTriggered: false }), 30)),
    });
    const fast = new Guardrail({
      name: 'fast',
      run: () =>
        new Promise((resolve) => setTimeout(() => resolve({ tripwireTriggered: false }), 5)),
    });
    const start = Date.now();
    await runAll([slow, fast], {}, 'x');
    const elapsed = Date.now() - start;
    // Sequential would be ~35ms; parallel should be closer to 30ms
    expect(elapsed).toBeLessThan(60);
  });
});

describe('Tool guardrails registry', () => {
  beforeEach(() => clearToolGuardrails());

  it('allows when no guardrail is registered', async () => {
    const result = await evaluateToolInput('Bash', { cmd: 'ls' });
    expect(result.allowed).toBe(true);
  });

  it('rejects with refusal under reject_content behavior', async () => {
    registerToolGuardrail(
      'Bash',
      async (params) => ({
        tripwireTriggered: params?.cmd?.includes('rm -rf /'),
        refusal: 'destructive command refused',
      }),
      'reject_content',
    );
    const ok = await evaluateToolInput('Bash', { cmd: 'ls' });
    const bad = await evaluateToolInput('Bash', { cmd: 'rm -rf /' });
    expect(ok.allowed).toBe(true);
    expect(bad.allowed).toBe(false);
    expect(bad.refusal).toMatch(/destructive/);
  });

  it('throws under raise_exception behavior', async () => {
    registerToolGuardrail(
      'Write',
      async () => ({ tripwireTriggered: true, info: { reason: 'sensitive' } }),
      'raise_exception',
    );
    await expect(evaluateToolInput('Write', { path: '/etc/passwd' })).rejects.toBeInstanceOf(
      ToolGuardrailRejection,
    );
  });

  it('rejects unknown behavior at registration', () => {
    expect(() => registerToolGuardrail('X', () => ({}), 'banana')).toThrow(TypeError);
  });

  it('inspectRegistry reports counts', () => {
    registerToolGuardrail('A', async () => ({ tripwireTriggered: false }));
    registerToolGuardrail('A', async () => ({ tripwireTriggered: false }));
    registerToolGuardrail('B', async () => ({ tripwireTriggered: false }));
    expect(inspectRegistry()).toEqual({ A: 2, B: 1 });
  });
});
