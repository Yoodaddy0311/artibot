/**
 * Tests for the suite-scale `tests` claim key and the widened claim shapes.
 *
 * Why this file exists: the count registry gated skills/commands/agents/hooks/CI
 * scripts, but the *test-suite size* — the most-quoted number in the plugin's
 * public copy — was bound to nothing. Measured 2026-09-05, three public strings
 * disagreed inside one repo: `plugins/artibot/marketplace.json` said
 * `9,900+ tests` in its `description` while its own `qualityMetrics.tests` field
 * said `14953`, and `plugins/artibot/CLAUDE.md` said `9,300+ tests`. Nothing
 * could fail on that, because no CLAIM_PATTERN matched a "N tests" phrase and
 * `collectActuals()` had no `tests` key to compare against.
 *
 * Two mechanics are new here and both need permanent cover:
 *   1. Thousands separators. Every pre-existing claim was `\d{2,3}` so a bare
 *      `Number(m[1])` worked. `9,900` makes `Number()` return NaN, which would
 *      have made every tests claim report as drift AND rewritten the comma away.
 *   2. Narrow binding. "N tests" is common English prose ("+14 tests" appears in
 *      the plugin README's release notes), so the pattern deliberately requires a
 *      comma-grouped number or >= 4 digits. The negative controls below are the
 *      point of that decision, not an afterthought.
 *
 * @module tests/ci/readme-claims-tests-key
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLAIM_PATTERNS,
  collectActuals,
  formatClaimNumber,
  parseClaimNumber,
  PLUGIN_ROOT,
  REPO_ROOT,
} from '../../scripts/ci/readme-claims-registry.js';
import { SYNC_TARGETS, syncFile } from '../../scripts/ci/sync-readme-claims.js';
import { SCAN_TARGETS, scanFile } from '../../scripts/ci/validate-readme-claims.js';

const actuals = collectActuals();
const patternsFor = (key) => CLAIM_PATTERNS.filter((p) => p.key === key);
const matchOnce = (pattern, text) => new RegExp(pattern.source, pattern.flags).exec(text);

describe('numeric claim parsing/formatting (thousands separators)', () => {
  it('parses a comma-grouped claim to a real number', () => {
    expect(parseClaimNumber('9,900')).toBe(9900);
    expect(parseClaimNumber('14,953')).toBe(14953);
    expect(parseClaimNumber('114')).toBe(114);
  });

  it('re-formats using the separator convention of the claim it replaces', () => {
    // The document decides the style; the registry only supplies the value.
    expect(formatClaimNumber(14953, '9,900')).toBe('14,953');
    expect(formatClaimNumber(14953, '9900')).toBe('14953');
    expect(formatClaimNumber(114, '100')).toBe('114');
  });
});

describe('collectActuals().tests', () => {
  it('exposes the committed suite size from marketplace.json#/qualityMetrics/tests', () => {
    const mp = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, 'marketplace.json'), 'utf-8')
    );
    expect(actuals.tests).toBe(mp.qualityMetrics.tests);
    expect(Number.isInteger(actuals.tests)).toBe(true);
    expect(actuals.tests).toBeGreaterThan(0);
  });
});

describe('tests claim pattern', () => {
  it('binds a comma-grouped floor claim and reconstructs it from its groups', () => {
    const [en] = patternsFor('tests').filter((p) => p.lang === 'en');
    const m = matchOnce(en.regex, 'Code. 30 agents, 114 skills, 79 commands, 9,900+ tests.');
    expect(m).not.toBeNull();
    expect(m[1]).toBe('9,900');
    // Registry contract: group1 + group2 must rebuild the whole match verbatim.
    expect(m[1] + m[2]).toBe(m[0]);
    expect(parseClaimNumber(m[1])).toBe(9900);
  });

  it('binds a plain 4-digit claim', () => {
    const [en] = patternsFor('tests').filter((p) => p.lang === 'en');
    const m = matchOnce(en.regex, 'Run the suite (14953 tests via vitest)');
    expect(m).not.toBeNull();
    expect(m[1]).toBe('14953');
    expect(m[1] + m[2]).toBe(m[0]);
  });

  it('binds the "automated tests" wording (rewording must not unbind a claim)', () => {
    const [en] = patternsFor('tests').filter((p) => p.lang === 'en');
    const m = matchOnce(en.regex, '114 domain skills, backed by 9,300+ automated tests.');
    expect(m).not.toBeNull();
    expect(m[1]).toBe('9,300');
    expect(m[1] + m[2]).toBe(m[0]);
  });

  // No Korean tests pattern exists, on purpose. The scan set has no Korean
  // suite-size sentence, and validate-readme-claims.test.js fails any Korean
  // pattern that binds nothing ("dead gate"). This asserts the absence so a
  // future author meets the rule here instead of at a red suite.
  it('declares no Korean tests pattern while no Korean claim exists', () => {
    expect(patternsFor('tests').filter((p) => p.lang === 'ko')).toHaveLength(0);
  });

  // NEGATIVE CONTROLS — the reason the pattern is narrow. Release-note prose in
  // plugins/artibot/README.md contains "+14 tests" / "+27 tests" in LIVE (not
  // frozen) sections; a loose `\d+\s*tests` would rewrite those to the suite
  // size and destroy the sentences.
  it('does NOT bind small inline test counts', () => {
    const [en] = patternsFor('tests').filter((p) => p.lang === 'en');
    expect(matchOnce(en.regex, '+14 tests (5 stacked-PR upstream + 7 age-gate)')).toBeNull();
    expect(matchOnce(en.regex, 'added 3 tests')).toBeNull();
    expect(matchOnce(en.regex, '+27 tests (21 marker hook + 6 gate)')).toBeNull();
  });
});

describe('widened agent/command claim shapes', () => {
  it('binds "specialized agents" as well as "specialist agents"', () => {
    const hits = patternsFor('agents').filter(
      (p) => matchOnce(p.regex, '29 specialized agent definitions') !== null
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it('binds the hyphenated "slash-command definitions" phrasing', () => {
    const hits = patternsFor('commands').filter(
      (p) => matchOnce(p.regex, '54 slash-command definitions') !== null
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('target lists', () => {
  it('syncs both marketplace.json files', () => {
    expect(SYNC_TARGETS).toContain(path.join(PLUGIN_ROOT, 'marketplace.json'));
    expect(SYNC_TARGETS).toContain(path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
  });

  it('every synced file is also validated (a fixer outside the gate is unguarded)', () => {
    for (const t of SYNC_TARGETS) expect(SCAN_TARGETS).toContain(t);
  });

  it('scans the install/entry docs where the census found unbound drift', () => {
    expect(SCAN_TARGETS).toContain(path.join(REPO_ROOT, 'INSTALL.md'));
    expect(SCAN_TARGETS).toContain(path.join(REPO_ROOT, 'AGENTS.md'));
    expect(SCAN_TARGETS).toContain(
      path.join(PLUGIN_ROOT, '.well-known', 'mcp-server.json')
    );
  });
});

describe('end-to-end on fixtures', () => {
  let dir;
  const write = (name, text) => {
    const p = path.join(dir, name);
    writeFileSync(p, text, 'utf-8');
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'artibot-tests-key-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites a drifting suite-size claim and keeps the comma style and the "+"', () => {
    const file = write(
      'mp.json',
      '{"description":"30 agents, 114 skills, 79 commands, 9,900+ tests."}\n'
    );
    const { changed } = syncFile(file, actuals, { write: true });
    expect(changed).toBe(true);
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain(`${formatClaimNumber(actuals.tests, '9,900')}+ tests`);
    expect(after).not.toContain('9,900+ tests');
  });

  it('leaves small inline test counts untouched in the same pass', () => {
    const file = write('notes.md', 'Fix landed with +14 tests and 3 tests skipped.\n');
    const { changed } = syncFile(file, actuals, { write: true });
    expect(changed).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('Fix landed with +14 tests and 3 tests skipped.\n');
  });

  it('the validator reports a drifting suite-size claim', () => {
    const file = write('stale.md', 'Backed by 9,300+ tests via vitest.\n');
    const findings = scanFile(file, actuals);
    const t = findings.filter((f) => !f.ok && f.label.startsWith('tests'));
    expect(t).toHaveLength(1);
    expect(t[0].claimed).toBe(9300);
    expect(t[0].actual).toBe(actuals.tests);
  });
});
