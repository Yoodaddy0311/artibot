/**
 * Tests for the SKILL.md size gate (scripts/ci/lint-skill-size.js).
 *
 * Locks in the progressive-disclosure ratchet: no SKILL.md may exceed the
 * 500-line ceiling. Asserts the scanner finds real skills, the current tree is
 * within budget (so the gate is GREEN today), and the offender filter works
 * against a synthetic ceiling (so the gate actually fails when it should).
 *
 * @module tests/ci/lint-skill-size
 */

import { describe, expect, it } from 'vitest';
import {
  collectSkillSizes,
  findOversizedSkills,
  MAX_SKILL_LINES,
  PLUGIN_ROOT,
} from '../../scripts/ci/lint-skill-size.js';

describe('lint-skill-size', () => {
  const sizes = collectSkillSizes(PLUGIN_ROOT);

  it('scans the real skills tree and finds many SKILL.md files', () => {
    expect(sizes.length).toBeGreaterThan(50);
    for (const s of sizes) {
      expect(Number.isInteger(s.lines)).toBe(true);
      expect(s.lines).toBeGreaterThan(0);
      expect(s.file.endsWith('SKILL.md')).toBe(true);
    }
  });

  it('every current SKILL.md is within the 500-line ceiling (gate is GREEN)', () => {
    const offenders = findOversizedSkills(PLUGIN_ROOT, MAX_SKILL_LINES);
    expect(offenders, `oversized: ${offenders.map((o) => `${o.name}=${o.lines}`).join(', ')}`).toEqual([]);
  });

  it('the offender filter actually flags violations (gate can fail)', () => {
    // Pick a ceiling just below the current largest so at least one trips.
    const largest = Math.max(...sizes.map((s) => s.lines));
    const offenders = findOversizedSkills(PLUGIN_ROOT, largest - 1);
    expect(offenders.length).toBeGreaterThanOrEqual(1);
    expect(offenders.every((o) => o.lines > largest - 1)).toBe(true);
  });

  it('exports a 500-line ceiling', () => {
    expect(MAX_SKILL_LINES).toBe(500);
  });
});
