/**
 * Tests for the shared README-claim registry
 * (scripts/ci/readme-claims-registry.js).
 *
 * This module is the single source of truth that both validate-readme-claims.js
 * (the drift gate) and sync-readme-claims.js (the auto-fixer) import. These tests
 * lock in the two contracts that prevent the two consumers from ever disagreeing:
 *   1. collectActuals() yields real, non-negative integer counts (and gates the
 *      coverage field behind opts.full).
 *   2. Every CLAIM_PATTERNS entry obeys the group1=number / group2=tail regex
 *      contract and points at a key collectActuals() actually produces — so a
 *      pattern can never silently reference a count that does not exist.
 *
 * @module tests/ci/readme-claims-registry
 */

import { describe, expect, it } from 'vitest';
import {
  CLAIM_PATTERNS,
  collectActuals,
  PLUGIN_ROOT,
  REPO_ROOT,
} from '../../scripts/ci/readme-claims-registry.js';

describe('collectActuals', () => {
  it('returns non-negative integer counts for the structural categories', () => {
    const actuals = collectActuals();
    for (const key of ['skills', 'commands', 'agents', 'hookScripts', 'hookRegistrations']) {
      expect(Number.isInteger(actuals[key]), `${key} should be an integer`).toBe(true);
      expect(actuals[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it('omits coverage in structural mode and includes it under { full: true }', () => {
    expect(collectActuals()).not.toHaveProperty('statementCoverage');
    // statementCoverage is only present when a coverage-summary.json exists; we
    // assert the structural-mode invariant (absent) which holds regardless.
    const full = collectActuals({ full: true });
    if ('statementCoverage' in full) {
      expect(Number.isInteger(full.statementCoverage)).toBe(true);
    }
  });
});

describe('CLAIM_PATTERNS contract', () => {
  it('exposes resolved repo paths', () => {
    expect(typeof REPO_ROOT).toBe('string');
    expect(typeof PLUGIN_ROOT).toBe('string');
    expect(PLUGIN_ROOT.startsWith(REPO_ROOT)).toBe(true);
  });

  it('every pattern key maps to a category collectActuals() can produce', () => {
    // Coverage is deliberately NOT in CLAIM_PATTERNS, so include it here so the
    // membership check reflects the full set of producible keys.
    const producible = new Set(Object.keys(collectActuals({ full: true })));
    producible.add('statementCoverage');
    for (const { key } of CLAIM_PATTERNS) {
      expect(producible.has(key), `pattern key "${key}" must be producible`).toBe(true);
    }
  });

  it('each regex captures group1=number and group2=trailing phrase', () => {
    for (const { regex, label } of CLAIM_PATTERNS) {
      // Build a synthetic claim that the pattern must match: a 2-digit count
      // followed by the phrase the regex was written for. We derive a probe by
      // matching against a representative string per known label.
      const probe = {
        skills: '42 skills',
        'skill dirs': '42 skill directories',
        commands: '42 slash commands',
        agents: '42 specialist agents',
        'agent defs': '42 agent definitions',
        'hook regs': '42 hook registrations',
        'hook scripts': '42 hook scripts',
        'CI scripts': '42 CI scripts',
      }[label];
      expect(probe, `no probe defined for label "${label}"`).toBeTruthy();

      const fresh = new RegExp(regex.source, regex.flags);
      const m = fresh.exec(probe);
      expect(m, `pattern for "${label}" should match "${probe}"`).not.toBeNull();
      expect(m[1]).toBe('42'); // group 1 = numeric claim
      expect(m[2]).toMatch(/^\s+/); // group 2 = trailing phrase (leading space)
      // Rebuild contract used by the sync rewriter: number + tail === full match.
      expect(`${m[1]}${m[2]}`).toBe(m[0]);
    }
  });

  it('does not match single-digit or "N+" forms (validator parity)', () => {
    // "70+ slash commands" and "1 command" must be left alone — same guarantee
    // the live README relies on (root README lines for "70+" and "1 command").
    const cmd = CLAIM_PATTERNS.find((p) => p.label === 'commands');
    const reA = new RegExp(cmd.regex.source, cmd.regex.flags);
    expect(reA.exec('70+ slash commands')).toBeNull();
    const reB = new RegExp(cmd.regex.source, cmd.regex.flags);
    expect(reB.exec('1 command')).toBeNull();
  });

  it('ciScripts deliberately DOES match single digits (unlike the others)', () => {
    // Divergence on purpose, not an oversight to "normalize" to \d{2,3}: the
    // drift this key exists to catch was the single-digit "6 CI validation
    // scripts" sitting next to an actual 19. A 2-digit floor would have let
    // exactly that value through, so the floor is 1 digit here.
    const ci = CLAIM_PATTERNS.find((p) => p.label === 'CI scripts');
    const re = new RegExp(ci.regex.source, ci.regex.flags);
    const m = re.exec('6 CI validation scripts');
    expect(m, 'the historical drifted value must be matchable').not.toBeNull();
    expect(m[1]).toBe('6');
  });
});
