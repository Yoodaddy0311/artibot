/**
 * Regression tests for scripts/learning-diag.js — risk-signal scoring.
 *
 * Guards the `successMeasured` fix: a packaged weight that lacks a
 * `successRate` field must NOT be read as 0% success (which previously
 * fabricated false "consistent failure" critical risk signals for tools
 * and agents like PowerShell / teammate that simply were never scored on
 * success). Entries with a real low measured successRate must still be
 * flagged (no over-correction).
 *
 * Pure in-memory tests: the exported helpers take a plain `state`/`rows`
 * object, so no `~/.claude` data, temp dirs, or subprocesses are needed.
 */

import { describe, expect, it } from 'vitest';
import {
  rankableEntries,
  renderLedgerStats,
  renderRiskSignals,
  renderTopPerformers,
} from '../../scripts/learning-diag.js';

// ---------------------------------------------------------------------------
// renderLedgerStats() — F-09 ledger section
// ---------------------------------------------------------------------------

describe('renderLedgerStats() — ambient capture section', () => {
  it('shows an empty-state line when no ledger data exists', () => {
    const out = renderLedgerStats({ sessions: 0 });
    expect(out).toContain('Ledger (Ambient Capture)');
    expect(out).toContain('No ledger data');
  });

  it('renders counts and derived rates when data is present', () => {
    const out = renderLedgerStats({
      sessions: 2, lines: 10, redactions: 3, bytes: 2048, consumed: 5, pending: 4,
    });
    expect(out).toContain('| Sessions captured | 2 |');
    expect(out).toContain('| Conversation lines | 10 |');
    expect(out).toContain('3 (30% of lines)'); // redaction rate
    expect(out).toContain('5 (50%)'); // review rate
    expect(out).toContain('| Pending review | 4 |');
    expect(out).toContain('2.0 KB');
  });

  it('nudges toward `/learning review` when items are pending', () => {
    const out = renderLedgerStats({
      sessions: 1, lines: 4, redactions: 0, bytes: 100, consumed: 0, pending: 2,
    });
    expect(out).toContain('2 item(s) awaiting review');
    expect(out).toContain('/learning review');
  });

  it('omits the review nudge when nothing is pending', () => {
    const out = renderLedgerStats({
      sessions: 1, lines: 4, redactions: 0, bytes: 100, consumed: 4, pending: 0,
    });
    expect(out).not.toContain('awaiting review');
  });

  it('handles missing/zero-line stats without dividing by zero', () => {
    const out = renderLedgerStats(undefined);
    expect(out).toContain('No ledger data');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal `state` carrying only the swarm-merged weights the
 * ranking code reads. */
function makeState({ tools = {}, agents = {} } = {}) {
  return { swarmWeights: { weights: { tools, agents } } };
}

const DEFAULT_ARGS = { top: 10, bottom: 10 };

/** Find a rankable row by name. */
function row(rows, name) {
  return rows.find((r) => r.name === name);
}

// ---------------------------------------------------------------------------
// rankableEntries() — successMeasured flag
// ---------------------------------------------------------------------------
describe('rankableEntries()', () => {
  it('marks an entry without successRate as unmeasured and falls back to confidence (not 0)', () => {
    // PowerShell-class entry: confidence + sampleSize + certainty, NO successRate.
    const state = makeState({
      tools: { PowerShell: { confidence: 0.66, sampleSize: 41, certainty: 0.844 } },
    });

    const rows = rankableEntries(state);
    const ps = row(rows, 'PowerShell');

    expect(ps.successMeasured).toBe(false);
    // Fallback is confidence, NOT a fabricated 0.
    expect(ps.success).toBe(0.66);
    expect(ps.success).not.toBe(0);
  });

  it('marks an entry with a real successRate as measured and uses it verbatim', () => {
    const state = makeState({
      tools: { Glob: { confidence: 0.52, sampleSize: 82, certainty: 0.853, successRate: 0.52 } },
    });

    const glob = row(rankableEntries(state), 'Glob');

    expect(glob.successMeasured).toBe(true);
    expect(glob.success).toBe(0.52);
  });

  it('treats a measured 0% successRate as measured (not the missing-field case)', () => {
    const state = makeState({
      tools: { FailTool: { confidence: 0.7, sampleSize: 10, successRate: 0 } },
    });

    const ft = row(rankableEntries(state), 'FailTool');

    expect(ft.successMeasured).toBe(true);
    expect(ft.success).toBe(0);
  });

  it('flags agent entries lacking successRate as unmeasured too', () => {
    const state = makeState({
      agents: { teammate: { confidence: 0.74, sampleSize: 28, certainty: 0.811 } },
    });

    const tm = row(rankableEntries(state), 'teammate');

    expect(tm.type).toBe('agent');
    expect(tm.successMeasured).toBe(false);
    expect(tm.success).toBe(0.74);
  });
});

// ---------------------------------------------------------------------------
// renderRiskSignals() — the core regression
// ---------------------------------------------------------------------------
describe('renderRiskSignals()', () => {
  it('does NOT flag entries whose successRate was never measured (the original bug)', () => {
    // All four of the originally-reported false criticals: high confidence,
    // non-trivial sample, but no successRate field at all.
    const state = makeState({
      tools: { PowerShell: { confidence: 0.66, sampleSize: 41, certainty: 0.844 } },
      agents: {
        teammate: { confidence: 0.74, sampleSize: 28, certainty: 0.811 },
        'artibot:frontend-developer': { confidence: 0.66, sampleSize: 11, certainty: 0.698 },
        cleaner: { confidence: 0.56, sampleSize: 6, certainty: 0.592 },
      },
    });

    const out = renderRiskSignals(rankableEntries(state), DEFAULT_ARGS);

    expect(out).toContain('none detected');
    expect(out).not.toContain('PowerShell');
    expect(out).not.toContain('teammate');
    expect(out).not.toContain('frontend-developer');
    expect(out).not.toContain('cleaner');
  });

  it('STILL flags an entry with a real low measured success (no over-correction)', () => {
    const state = makeState({
      tools: { BadTool: { confidence: 0.7, sampleSize: 12, successRate: 0.1 } },
    });

    const out = renderRiskSignals(rankableEntries(state), DEFAULT_ARGS);

    expect(out).toContain('BadTool');
    expect(out).toContain('critical'); // success 10% < 25% -> critical note
  });

  it('does not flag a measured low-success entry below the sample-size floor', () => {
    // Real low success but n < 6: not enough signal, must stay silent.
    const state = makeState({
      tools: { Rare: { confidence: 0.6, sampleSize: 3, successRate: 0.1 } },
    });

    const out = renderRiskSignals(rankableEntries(state), DEFAULT_ARGS);

    expect(out).toContain('none detected');
  });

  it('distinguishes a measured failure from an unmeasured peer in the same run', () => {
    const state = makeState({
      tools: {
        PowerShell: { confidence: 0.66, sampleSize: 41, certainty: 0.844 }, // unmeasured
        BadTool: { confidence: 0.7, sampleSize: 12, successRate: 0.12 }, // measured fail
      },
    });

    const out = renderRiskSignals(rankableEntries(state), DEFAULT_ARGS);

    expect(out).toContain('BadTool');
    expect(out).not.toContain('PowerShell');
  });
});

// ---------------------------------------------------------------------------
// renderTopPerformers() — unmeasured entries surface honestly via fallback
// ---------------------------------------------------------------------------
describe('renderTopPerformers()', () => {
  it('renders an unmeasured entry with its confidence-derived success, not 0%', () => {
    const state = makeState({
      tools: { PowerShell: { confidence: 0.66, sampleSize: 41, certainty: 0.844 } },
    });

    const out = renderTopPerformers(rankableEntries(state), DEFAULT_ARGS);

    expect(out).toContain('PowerShell');
    expect(out).toContain('66%');
    expect(out).not.toContain('0%');
  });
});
