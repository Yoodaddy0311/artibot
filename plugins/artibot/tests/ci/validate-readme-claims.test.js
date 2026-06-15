/**
 * Tests for the README/CLAUDE.md claim validator (scripts/ci/validate-readme-claims.js).
 *
 * These lock in the self-validation-gap fix: count claims in plugins/artibot/CLAUDE.md
 * (skills/commands/agents on the Stack line) were previously outside every CI gate, so
 * they silently drifted. The validator now scans CLAUDE.md alongside the two READMEs.
 *
 * The tests assert two contracts:
 *   1. SCAN_TARGETS actually includes plugins/artibot/CLAUDE.md (the gap-closing file).
 *   2. CLAUDE.md's count claims are non-vacuous AND currently consistent with
 *      collectActuals() — i.e. the gate has something real to check and it matches.
 *
 * @module tests/ci/validate-readme-claims
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCAN_TARGETS } from '../../scripts/ci/validate-readme-claims.js';
import { CLAIM_PATTERNS, collectActuals, PLUGIN_ROOT, REPO_ROOT } from '../../scripts/ci/readme-claims-registry.js';

const CLAUDE_MD = path.join(PLUGIN_ROOT, 'CLAUDE.md');

describe('SCAN_TARGETS', () => {
  it('scans both READMEs and the plugin CLAUDE.md', () => {
    expect(SCAN_TARGETS).toContain(path.join(REPO_ROOT, 'README.md'));
    expect(SCAN_TARGETS).toContain(path.join(PLUGIN_ROOT, 'README.md'));
    expect(SCAN_TARGETS).toContain(CLAUDE_MD);
  });

  it('importing the validator module does not execute the CLI (no process.exit on import)', () => {
    // If this test file runs at all, the import above did not call process.exit —
    // the invokedDirectly guard works. Asserting the export is present confirms load.
    expect(Array.isArray(SCAN_TARGETS)).toBe(true);
  });
});

describe('CLAUDE.md count claims are gate-covered and consistent', () => {
  const content = readFileSync(CLAUDE_MD, 'utf-8');
  const actuals = collectActuals();

  for (const key of ['skills', 'commands', 'agents']) {
    it(`CLAUDE.md states a ${key} count and it matches the actual file-system count`, () => {
      const pattern = CLAIM_PATTERNS.find((p) => p.key === key);
      expect(pattern, `registry has a ${key} pattern`).toBeDefined();
      const matches = [...content.matchAll(pattern.regex)];
      // Non-vacuous: CLAUDE.md must actually carry the claim, else the gate checks nothing.
      expect(matches.length, `CLAUDE.md should contain a ${key} count claim`).toBeGreaterThan(0);
      // Consistent: every stated count must equal the real count (drift would FAIL CI).
      for (const m of matches) {
        expect(Number(m[1]), `${key} claim "${m[0].trim()}" should match actual`).toBe(actuals[key]);
      }
    });
  }
});
