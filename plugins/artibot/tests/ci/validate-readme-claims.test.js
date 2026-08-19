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

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCAN_TARGETS, scanFile } from '../../scripts/ci/validate-readme-claims.js';
import {
  CLAIM_PATTERNS,
  collectActuals,
  partitionFrozenHistory,
  PLUGIN_ROOT,
  REPO_ROOT,
} from '../../scripts/ci/readme-claims-registry.js';

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

// ---------------------------------------------------------------------------
// Korean prose coverage — scanner self-verification.
//
// The defect: every CLAIM_PATTERNS entry was an English regex, while
// plugins/artibot/README.md is Korean-dominant. Measured 2026-08-19 before the
// fix, that file produced exactly ONE matched claim (the English heading "28
// Specialist Agents") out of dozens of Korean counts, and three of the unseen
// ones had drifted: 65-vs-68 hook scripts, 6-vs-20 CI scripts, 24-vs-25 hook
// registrations.
//
// These tests deliberately do BOTH halves, because a pattern that matches
// nothing and a pattern that never fails both look identical from a green run:
//   (a) the Korean patterns bind to the live README's real sentences, and
//   (b) a wrong count in that same phrasing actually produces a finding.
// ---------------------------------------------------------------------------

describe('Korean count claims are gate-covered and consistent', () => {
  const PLUGIN_README = path.join(PLUGIN_ROOT, 'README.md');
  // Live region only — the same slice the validator checks. Reading the raw file
  // here would trip over the frozen release notes (README.md:1697 "117개 스킬",
  // the v1.13.0 notes' "39개 훅 등록"), which are correct history, not drift.
  const content = partitionFrozenHistory(readFileSync(PLUGIN_README, 'utf-8'))
    .filter((s) => !s.frozen)
    .map((s) => s.text)
    .join('');
  const actuals = collectActuals();
  const koPatterns = CLAIM_PATTERNS.filter((p) => p.lang === 'ko');

  it('the Korean-dominant README now yields more than the single English match', () => {
    // Non-vacuous guard on the fix itself: if a future edit unbinds the Korean
    // patterns, this drops back toward 1 and fails rather than passing quietly.
    const koMatches = koPatterns.flatMap((p) => [
      ...content.matchAll(new RegExp(p.regex.source, p.regex.flags)),
    ]);
    expect(koMatches.length, 'Korean claims must actually be matched in the live README').toBeGreaterThan(1);
  });

  for (const { key, label } of CLAIM_PATTERNS.filter((p) => p.lang === 'ko')) {
    it(`live README's Korean "${label}" claims all equal the actual count`, () => {
      const { regex } = CLAIM_PATTERNS.find((p) => p.label === label);
      const matches = [...content.matchAll(new RegExp(regex.source, regex.flags))];
      for (const m of matches) {
        expect(Number(m[1]), `"${m[0].trim()}" should equal actual ${key}`).toBe(actuals[key]);
      }
    });
  }

  it('every Korean pattern binds to at least one real sentence somewhere in the scan set', () => {
    // A pattern matching nothing anywhere is a dead gate. Checked across all
    // SCAN_TARGETS so a claim moving between files does not read as a failure.
    const corpus = SCAN_TARGETS.map((f) => readFileSync(f, 'utf-8')).join('\n');
    for (const { label, regex } of koPatterns) {
      const re = new RegExp(regex.source, regex.flags);
      expect(re.test(corpus), `Korean pattern "${label}" matches nothing — dead gate`).toBe(true);
    }
  });
});

describe('scanner reports drift it is supposed to catch (mutation check)', () => {
  let dir;
  const actuals = collectActuals();
  const write = (name, text) => {
    const p = path.join(dir, name);
    writeFileSync(p, text, 'utf-8');
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'artibot-claims-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a deliberately wrong Korean count', () => {
    const wrong = actuals.skills + 7;
    const file = write('wrong.md', `# t\n\nArtibot은 ${wrong}개 도메인 스킬을 제공합니다.\n`);
    const findings = scanFile(file, actuals).filter((f) => !f.ok);
    expect(findings.length, 'a wrong Korean count must produce a finding').toBeGreaterThan(0);
    expect(findings[0].claimed).toBe(wrong);
    expect(findings[0].actual).toBe(actuals.skills);
  });

  it('passes the same sentence when the count is right', () => {
    const file = write('right.md', `# t\n\nArtibot은 ${actuals.skills}개 도메인 스킬을 제공합니다.\n`);
    expect(scanFile(file, actuals).filter((f) => !f.ok)).toHaveLength(0);
  });

  it('flags each Korean category independently', () => {
    // One combined fixture per category, so a single over-broad pattern cannot
    // mask a category that is not actually wired up.
    const cases = [
      ['hookScripts', (n) => `${n}개 훅 스크립트 파일`],
      ['hookRegistrations', (n) => `15개 이벤트에 ${n}개 훅이 등록되어 있습니다.`],
      ['ciScripts', (n) => `${n}개 CI 검증 스크립트`],
      ['commands', (n) => `${n}개 슬래시 커맨드`],
      ['agents', (n) => `${n}개 에이전트 정의`],
    ];
    for (const [key, render] of cases) {
      const wrong = actuals[key] + 3;
      const file = write(`${key}.md`, `# t\n\n${render(wrong)}\n`);
      const findings = scanFile(file, actuals).filter((f) => !f.ok);
      expect(findings.length, `${key} drift must be caught`).toBeGreaterThan(0);
      expect(findings.some((f) => f.claimed === wrong && f.actual === actuals[key]), key).toBe(true);
    }
  });

  it('does NOT flag a wrong count inside the frozen release-note section', () => {
    // Release notes state what was true at that version. Rewriting or failing on
    // them would falsify history — README.md:1697 legitimately says "117개 스킬".
    const stale = actuals.skills + 4;
    const file = write(
      'history.md',
      `# t\n\n${actuals.skills}개 도메인 스킬\n\n## v1.14.0 주요 변경사항\n\n- ${stale}개 도메인 스킬 검증\n`
    );
    const findings = scanFile(file, actuals).filter((f) => !f.ok);
    expect(findings, 'frozen history must be exempt').toHaveLength(0);
  });

  it('flags drift in a section that FOLLOWS the release notes', () => {
    // The tail hole: the earlier single-cut split froze everything from the
    // first version heading to EOF, so `## 기여하기` / `## 라이선스` — current
    // documentation — were outside the gate. Per-section freezing keeps them in.
    const wrong = actuals.skills + 6;
    const file = write(
      'tail.md',
      `# t\n\n## v1.14.0 주요 변경사항\n\n- 117개 도메인 스킬\n\n## 기여하기\n\n${wrong}개 도메인 스킬\n`
    );
    const findings = scanFile(file, actuals).filter((f) => !f.ok);
    expect(findings, 'exactly the tail claim, not the release note').toHaveLength(1);
    expect(findings[0].claimed).toBe(wrong);
  });

  it('still flags drift that appears BEFORE the release-note section', () => {
    // Guards the opposite failure: a too-eager split silently disabling the gate.
    const wrong = actuals.skills + 5;
    const file = write(
      'mixed.md',
      `# t\n\n${wrong}개 도메인 스킬\n\n## v1.14.0 주요 변경사항\n\n- 117개 도메인 스킬\n`
    );
    const findings = scanFile(file, actuals).filter((f) => !f.ok);
    expect(findings).toHaveLength(1);
    expect(findings[0].claimed).toBe(wrong);
  });
});
