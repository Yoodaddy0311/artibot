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

import { readdirSync, readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Script-file counts: definition + coverage.
//
// Two defects motivated these. (1) `hookScripts` counted only `.js`, so the six
// `.mjs` files were invisible — including session-readback.mjs and
// session-ledger.mjs, which hooks/dispatch-table.json registers as live hooks.
// (2) The root README's "N CI validation scripts" claim had no registry key at
// all, so it drifted to 6-vs-19 with nothing able to notice.
//
// What these tests do NOT cover: they check that the count claim in README
// prose equals collectActuals(), not that either number describes something a
// reader would call a "hook script". The definition itself (executable ESM
// modules in the directory) is a judgement encoded in the registry comment —
// no test can validate it.
// ---------------------------------------------------------------------------

describe('script-file counts count .js and .mjs alike', () => {
  const HOOKS_DIR = path.join(PLUGIN_ROOT, 'scripts', 'hooks');
  const CI_DIR = path.join(PLUGIN_ROOT, 'scripts', 'ci');
  const actuals = collectActuals();

  const countExt = (dir, ext) => readdirSync(dir).filter((f) => f.endsWith(ext)).length;

  it('hookScripts equals the .js + .mjs file count, not .js alone', () => {
    const js = countExt(HOOKS_DIR, '.js');
    const mjs = countExt(HOOKS_DIR, '.mjs');
    // Non-vacuous: if the directory ever holds no .mjs, this assertion passes
    // trivially and proves nothing — fail loudly instead so the gap is visible.
    expect(mjs, 'scripts/hooks/ should contain .mjs files for this test to mean anything').toBeGreaterThan(0);
    expect(actuals.hookScripts).toBe(js + mjs);
    expect(actuals.hookScripts).not.toBe(js);
  });

  it('ciScripts equals the .js + .mjs file count and excludes non-scripts', () => {
    const js = countExt(CI_DIR, '.js');
    const mjs = countExt(CI_DIR, '.mjs');
    const all = readdirSync(CI_DIR).length;
    expect(mjs, 'scripts/ci/ should contain .mjs files for this test to mean anything').toBeGreaterThan(0);
    expect(actuals.ciScripts).toBe(js + mjs);
    // The *-baseline.json fixtures are data, not scripts — they must not count.
    expect(actuals.ciScripts).toBeLessThan(all);
  });

  it('the registry exposes a ciScripts pattern and the root README carries the claim', () => {
    const pattern = CLAIM_PATTERNS.find((p) => p.key === 'ciScripts');
    expect(pattern, 'registry must have a ciScripts pattern or the claim is ungated').toBeDefined();
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');
    const matches = [...readme.matchAll(pattern.regex)];
    expect(matches.length, 'README should carry a CI scripts count claim').toBeGreaterThan(0);
    for (const m of matches) {
      expect(Number(m[1]), `CI scripts claim "${m[0].trim()}" should match actual`).toBe(actuals.ciScripts);
    }
  });

  it('the ciScripts pattern still binds if the prose drops the word "validation"', () => {
    // Guards the exact failure that left this claim ungated: prose wording moved
    // and no pattern followed it.
    const { regex } = CLAIM_PATTERNS.find((p) => p.key === 'ciScripts');
    for (const prose of ['19 CI scripts', '19 CI validation scripts']) {
      expect(new RegExp(regex.source, regex.flags).test(prose), `pattern should match "${prose}"`).toBe(true);
    }
  });
});
