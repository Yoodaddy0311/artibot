/**
 * Tests for `lib/context/context-pressure.js` (vNext PR-CX02 / V5-BACKLOG SH-16).
 *
 * The module is pure by contract: same input -> same output, no clock, no
 * filesystem, no randomness, no imports. Case 8 enforces that by reading the
 * module source and asserting the effect vocabulary is absent, so the purity
 * claim is checked rather than asserted in a comment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildContextPressureEvent,
  computeContextPressure,
  estimateTokens,
  PRESSURE_STRATEGY_VERSION,
  PRESSURE_THRESHOLDS,
} from '../../lib/context/context-pressure.js';
import { normalizeEnvelope } from '../../lib/supervisor/run-store.js';
import { validateEvent } from '../../lib/supervisor/contracts.js';

const MODULE_PATH = fileURLToPath(
  new URL('../../lib/context/context-pressure.js', import.meta.url),
);

describe('PRESSURE_THRESHOLDS', () => {
  it('carries the warn/critical values scripts/hooks/context-tracker.js uses', () => {
    expect(PRESSURE_THRESHOLDS.warn).toBe(0.70);
    expect(PRESSURE_THRESHOLDS.critical).toBe(0.90);
  });

  it('is frozen so a caller cannot retune the thresholds at runtime', () => {
    expect(Object.isFrozen(PRESSURE_THRESHOLDS)).toBe(true);
  });

  it('pins the strategy version so stored scores stay comparable', () => {
    expect(PRESSURE_STRATEGY_VERSION).toBe(1);
  });
});

describe('estimateTokens', () => {
  it('returns 1 for the empty string', () => {
    expect(estimateTokens('')).toBe(1);
  });

  it('returns 2 for a 4-character string', () => {
    expect(estimateTokens('abcd')).toBe(2);
  });

  it('returns 1001 for a 4,000-character string', () => {
    expect(estimateTokens('x'.repeat(4000))).toBe(1001);
  });

  it('rounds a partial chunk up', () => {
    expect(estimateTokens('abcde')).toBe(3);
  });

  it('returns 1 for a non-string input instead of throwing', () => {
    expect(estimateTokens(undefined)).toBe(1);
    expect(estimateTokens(null)).toBe(1);
    expect(estimateTokens(42)).toBe(1);
  });
});

describe('computeContextPressure determinism', () => {
  it('returns an equal result for the same input evaluated twice', () => {
    const input = { currentTokens: 91_000, maxTokens: 128_000, compactTrigger: 'auto' };
    expect(computeContextPressure(input)).toEqual(computeContextPressure(input));
  });

  it('returns an equal result for two distinct objects with identical fields', () => {
    const a = computeContextPressure({ tokenEstimate: 140_000, maxTokens: 200_000 });
    const b = computeContextPressure({ tokenEstimate: 140_000, maxTokens: 200_000 });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe('computeContextPressure token source precedence', () => {
  it('prefers currentTokens over tokenEstimate and transcriptBytes', () => {
    const out = computeContextPressure({
      currentTokens: 64_000,
      tokenEstimate: 10,
      transcriptBytes: 40,
      maxTokens: 128_000,
    });
    expect(out.inputs.tokenSource).toBe('currentTokens');
    expect(out.inputs.tokens).toBe(64_000);
    expect(out.score).toBe(0.5);
  });

  it('prefers tokenEstimate over transcriptBytes when currentTokens is absent', () => {
    const out = computeContextPressure({
      tokenEstimate: 64_000,
      transcriptBytes: 40,
      maxTokens: 128_000,
    });
    expect(out.inputs.tokenSource).toBe('tokenEstimate');
    expect(out.inputs.tokens).toBe(64_000);
  });

  it('falls back to transcriptBytes with the chars/4 heuristic', () => {
    const out = computeContextPressure({ transcriptBytes: 4000, maxTokens: 128_000 });
    expect(out.inputs.tokenSource).toBe('transcriptBytes');
    expect(out.inputs.tokens).toBe(1001);
  });

  it('marks measured true only for the host-reported currentTokens', () => {
    expect(computeContextPressure({ currentTokens: 10, maxTokens: 100 }).inputs.measured).toBe(true);
    expect(computeContextPressure({ tokenEstimate: 10, maxTokens: 100 }).inputs.measured).toBe(false);
    expect(computeContextPressure({ transcriptBytes: 40, maxTokens: 100 }).inputs.measured).toBe(false);
  });

  it('marks overstates true only for transcriptBytes', () => {
    expect(computeContextPressure({ transcriptBytes: 40, maxTokens: 100 }).inputs.overstates).toBe(true);
    expect(computeContextPressure({ currentTokens: 10, maxTokens: 100 }).inputs.overstates).toBe(false);
    expect(computeContextPressure({ tokenEstimate: 10, maxTokens: 100 }).inputs.overstates).toBe(false);
  });

  it('honours an explicit measured override from the caller', () => {
    const out = computeContextPressure({ tokenEstimate: 10, maxTokens: 100, measured: true });
    expect(out.inputs.measured).toBe(true);
    expect(out.inputs.tokenSource).toBe('tokenEstimate');
  });

  it('ignores a non-boolean measured override', () => {
    const out = computeContextPressure({ currentTokens: 10, maxTokens: 100, measured: 'yes' });
    expect(out.inputs.measured).toBe(true);
  });
});

describe('computeContextPressure levels and recommendation', () => {
  const at = (tokens) => computeContextPressure({ currentTokens: tokens, maxTokens: 10_000 });

  it('reports low just under the warn threshold', () => {
    const out = at(6999);
    expect(out.score).toBe(0.6999);
    expect(out.level).toBe('low');
    expect(out.recommendation).toBe('none');
  });

  it('reports warn exactly at the warn threshold', () => {
    const out = at(7000);
    expect(out.score).toBe(0.7);
    expect(out.level).toBe('warn');
    expect(out.recommendation).toBe('none');
  });

  it('still reports warn just under the critical threshold', () => {
    const out = at(8999);
    expect(out.score).toBe(0.8999);
    expect(out.level).toBe('warn');
    expect(out.recommendation).toBe('none');
  });

  it('reports critical exactly at the critical threshold', () => {
    const out = at(9000);
    expect(out.score).toBe(0.9);
    expect(out.level).toBe('critical');
    expect(out.recommendation).toBe('rotate-worker');
  });

  it('recommends rotate-worker above the critical threshold too', () => {
    expect(at(9800).level).toBe('critical');
    expect(at(9800).recommendation).toBe('rotate-worker');
  });

  it('reports low at zero tokens', () => {
    const out = at(0);
    expect(out.score).toBe(0);
    expect(out.level).toBe('low');
  });

  it('rounds the score to four decimals', () => {
    const out = computeContextPressure({ currentTokens: 1, maxTokens: 3 });
    expect(out.score).toBe(0.3333);
  });

  it('stamps the strategy version on a scored result', () => {
    expect(at(100).strategy_version).toBe(PRESSURE_STRATEGY_VERSION);
    expect(at(100).reason).toBeNull();
  });
});

describe('computeContextPressure degenerate inputs', () => {
  it('returns a null score with no-token-input when no token field is given', () => {
    const out = computeContextPressure({ maxTokens: 128_000 });
    expect(out).toMatchObject({
      score: null,
      level: null,
      recommendation: 'none',
      reason: 'no-token-input',
      strategy_version: 1,
    });
    expect(out.inputs.tokenSource).toBeNull();
    expect(out.inputs.tokens).toBeNull();
  });

  it('returns capacity-unknown when maxTokens is absent', () => {
    const out = computeContextPressure({ currentTokens: 64_000 });
    expect(out.score).toBeNull();
    expect(out.level).toBeNull();
    expect(out.reason).toBe('capacity-unknown');
    expect(out.inputs.maxTokens).toBeNull();
    expect(out.inputs.tokens).toBe(64_000);
  });

  it('returns capacity-unknown for a zero, negative, or non-finite maxTokens', () => {
    for (const maxTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '128000', null]) {
      const out = computeContextPressure({ currentTokens: 100, maxTokens });
      expect(out.reason).toBe('capacity-unknown');
      expect(out.inputs.maxTokens).toBeNull();
    }
  });

  it('clamps a score above capacity to 1 and records clamped', () => {
    const out = computeContextPressure({ currentTokens: 300_000, maxTokens: 200_000 });
    expect(out.score).toBe(1);
    expect(out.level).toBe('critical');
    expect(out.recommendation).toBe('rotate-worker');
    expect(out.inputs.clamped).toBe(true);
  });

  it('leaves clamped false at exactly capacity', () => {
    const out = computeContextPressure({ currentTokens: 200_000, maxTokens: 200_000 });
    expect(out.score).toBe(1);
    expect(out.inputs.clamped).toBe(false);
  });

  it('treats a negative or non-finite token count as absent', () => {
    for (const currentTokens of [-1, Number.NaN, Number.POSITIVE_INFINITY, '64000', null]) {
      const out = computeContextPressure({ currentTokens, maxTokens: 128_000 });
      expect(out.reason).toBe('no-token-input');
    }
  });

  it('falls through to the next source when the preferred one is invalid', () => {
    const out = computeContextPressure({
      currentTokens: Number.NaN,
      tokenEstimate: 64_000,
      maxTokens: 128_000,
    });
    expect(out.inputs.tokenSource).toBe('tokenEstimate');
    expect(out.score).toBe(0.5);
  });

  it('never throws for undefined, null, empty, or non-object input', () => {
    for (const bad of [undefined, null, {}, 'transcript', 42, [], true]) {
      expect(() => computeContextPressure(bad)).not.toThrow();
      expect(computeContextPressure(bad).score).toBeNull();
      expect(computeContextPressure(bad).recommendation).toBe('none');
    }
  });
});

describe('computeContextPressure compactTrigger', () => {
  it('records an auto trigger without moving the score', () => {
    const base = computeContextPressure({ currentTokens: 9500, maxTokens: 10_000 });
    const auto = computeContextPressure({ currentTokens: 9500, maxTokens: 10_000, compactTrigger: 'auto' });
    expect(auto.inputs.compactTrigger).toBe('auto');
    expect(auto.score).toBe(base.score);
    expect(auto.level).toBe(base.level);
  });

  it('scores a manual trigger identically to an auto one', () => {
    const auto = computeContextPressure({ currentTokens: 9500, maxTokens: 10_000, compactTrigger: 'auto' });
    const manual = computeContextPressure({ currentTokens: 9500, maxTokens: 10_000, compactTrigger: 'manual' });
    expect(manual.inputs.compactTrigger).toBe('manual');
    expect(manual.score).toBe(auto.score);
    expect(manual.recommendation).toBe(auto.recommendation);
  });

  it('normalises an unknown or missing trigger to null', () => {
    expect(computeContextPressure({ currentTokens: 1, maxTokens: 10 }).inputs.compactTrigger).toBeNull();
    const odd = computeContextPressure({ currentTokens: 1, maxTokens: 10, compactTrigger: 'sideways' });
    expect(odd.inputs.compactTrigger).toBeNull();
  });
});

describe('buildContextPressureEvent', () => {
  const pressure = computeContextPressure({ currentTokens: 8200, maxTokens: 10_000 });

  it('builds a context-pressure envelope partial from a hook', () => {
    const event = buildContextPressureEvent(pressure, { laneId: 'lane-a', sessionId: 'sess-1' });
    expect(event.type).toBe('context-pressure');
    expect(event.source).toBe('hook');
    expect(event.laneId).toBe('lane-a');
    expect(event.data).toMatchObject({
      score: 0.82,
      level: 'warn',
      recommendation: 'none',
      reason: null,
      strategy_version: 1,
      session_id: 'sess-1',
    });
    expect(event.data.inputs).toEqual(pressure.inputs);
  });

  it('defaults laneId and session_id to null when meta is omitted', () => {
    const event = buildContextPressureEvent(pressure);
    expect(event.laneId).toBeNull();
    expect(event.data.session_id).toBeNull();
  });

  it('leaves eventId, ts, and runId to the run store', () => {
    const event = buildContextPressureEvent(pressure, { laneId: 'lane-a' });
    expect(Object.keys(event).sort()).toEqual(['data', 'laneId', 'source', 'type']);
  });

  it('carries a degenerate pressure through without throwing', () => {
    const event = buildContextPressureEvent(computeContextPressure({}));
    expect(event.data.score).toBeNull();
    expect(event.data.reason).toBe('no-token-input');
  });

  it('tolerates a missing pressure argument', () => {
    const event = buildContextPressureEvent(undefined);
    expect(event.type).toBe('context-pressure');
    expect(event.data.score).toBeNull();
    expect(event.data.recommendation).toBe('none');
  });

  it('passes validateEvent after the run store normalises the envelope', () => {
    const partial = buildContextPressureEvent(pressure, { laneId: 'lane-a', sessionId: 'sess-1' });
    const normalized = normalizeEnvelope('run-x', partial, { now: '2026-09-12T00:00:00.000Z' });
    const check = validateEvent(normalized);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
    expect(normalized.runId).toBe('run-x');
    expect(normalized.ts).toBe('2026-09-12T00:00:00.000Z');
  });

  it('produces no unknown envelope keys for a null-lane event', () => {
    const partial = buildContextPressureEvent(pressure);
    const normalized = normalizeEnvelope('run-x', partial, { now: '2026-09-12T00:00:00.000Z' });
    expect(validateEvent(normalized).ok).toBe(true);
    expect(normalized.laneId).toBeNull();
  });
});

describe('module purity', () => {
  const source = readFileSync(MODULE_PATH, 'utf-8');

  const forbidden = [
    ['filesystem import', /node:fs/],
    ['clock reading', /Date\.now/],
    ['clock construction', /new Date/],
    ['randomness', /Math\.random/],
    ['environment read', /process\.env/],
    ['any import statement', /^import\s/m],
  ];

  for (const [label, pattern] of forbidden) {
    it(`has no ${label}`, () => {
      expect(source.match(new RegExp(pattern.source, pattern.flags.includes('m') ? 'gm' : 'g'))).toBeNull();
    });
  }

  it('reads a non-empty source, so the greps above are meaningful', () => {
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain('computeContextPressure');
  });
});
