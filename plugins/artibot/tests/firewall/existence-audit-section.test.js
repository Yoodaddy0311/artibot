/**
 * Firewall — the constitution carries a periodic existence-proof rule (A-3 / D18).
 *
 * ── Why a gate at all ───────────────────────────────────────────────────────
 * Design §3.7 records that removal *precedent* exists (R1~R14 are all measured
 * removal candidates) while a standing rule that makes modules re-prove their
 * existence each release does not. A rule that lives only in a design document
 * is not in the read path of anyone doing the work, so it decays into a
 * one-time cleanup. This gate pins the sentence into the developer-facing
 * constitution and pins the exemption list beside it — a removal rule without
 * an allowlist of safety contracts is fail-open in the destructive direction.
 *
 * The exemption list is asserted item by item on purpose. Design §3.7's
 * 유지(REJECT) roster is the canonical source; if the section keeps the heading
 * but silently sheds an entry, "면제 목록이 있다" would still be true while a
 * safety contract had become removable. Membership is the property that
 * matters, not the presence of a bulleted line.
 *
 * ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
 *   - Whether anyone measures anything. This asserts that a rule is written
 *     down. It does not assert that a consumer/utterance ledger exists, that a
 *     release ever folded counts into it, or that a candidate was ever raised.
 *     Text ≠ instrumentation ≠ execution ≠ a result row.
 *   - The utterance denominator. Hook/command/skill firing counts are UNMEASURED
 *     as of 2026-09-02; the rule names a quantity nothing currently produces.
 *   - Whether `plugins/artibot/CLAUDE.md` is the right home. Design §3.7 assigns
 *     A-3 no destination file; this path was chosen by the Phase 0 planner and
 *     recorded as judgment, not design (PRD 미확인 §, "A-3 … 목적지 파일은
 *     설계가 지정하지 않았다").
 *   - The 4K-chars-per-instruction-file budget this same file declares at its
 *     `## Context Efficiency` bullet. That budget is already exceeded and no
 *     gate enforces it; see the size observation asserted below, which records
 *     the overage rather than pretending it away.
 *   - Drift in the design document. If §3.7's 유지(REJECT) roster gains or loses
 *     an entry, this list goes stale silently — nothing cross-checks the two.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);
const CLAUDE_MD = path.join(PLUGIN_ROOT, 'CLAUDE.md');

const HEADING = '## Existence Audit';

/**
 * Canonical safety contracts exempt from the audit — design §3.7 유지(REJECT).
 * Substrings, matched against the section body verbatim.
 */
const EXEMPT = Object.freeze([
  '보고·중계 계약',
  '{sid}',
  'Phase 0 VALIDATE',
  'Phase 4.5',
  'fast 하드캡',
  'Operator-Waits',
  'FABLE_DENYLIST',
  'task-budget 하한',
  'PreToolUse 보안 훅',
  'dispatch-table',
  'vitest-only',
  '격리',
  'ambiguity-guard',
  'verification-discipline',
]);

/** Terms that carry the rule itself, not its formatting. */
const RULE_TERMS = Object.freeze(['소비처', '발화', '2릴리스', '제거 후보']);

/**
 * Slice one `## ` section out of a markdown document.
 *
 * @param {string} doc - Full markdown text (CRLF or LF).
 * @param {string} heading - Exact heading line, e.g. `## Existence Audit`.
 * @returns {string|null} Section body, or null when the heading is absent.
 */
export function sectionBody(doc, heading) {
  const lines = String(doc).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function read() {
  return fsSync.readFileSync(CLAUDE_MD, 'utf8');
}

describe('constitution A-3 — Existence Audit section', () => {
  it('declares the section in plugins/artibot/CLAUDE.md', () => {
    expect(sectionBody(read(), HEADING)).not.toBeNull();
  });

  it('states the measured removal rule, not just a title', () => {
    const body = sectionBody(read(), HEADING);
    for (const term of RULE_TERMS) expect(body).toContain(term);
  });

  it('keeps the removal rule advisory — candidate, not auto-delete', () => {
    const body = sectionBody(read(), HEADING);
    expect(body).toContain('자동 삭제가 아니');
    expect(body).toContain('사람이 승인');
  });

  it('carries the safety-contract exemption allowlist in full', () => {
    const body = sectionBody(read(), HEADING);
    expect(body).toContain('면제');
    const missing = EXEMPT.filter((item) => !body.includes(item));
    expect(missing).toEqual([]);
  });

  it('names §3.7 as the canonical source of the exemption list', () => {
    expect(sectionBody(read(), HEADING)).toContain('§3.7');
  });

  it('sits after Quality Gates, inside the behavioral-discipline block', () => {
    const doc = read();
    expect(doc.indexOf('## Quality Gates')).toBeLessThan(doc.indexOf(HEADING));
    expect(doc.indexOf(HEADING)).toBeLessThan(doc.indexOf('## Context Efficiency'));
  });

  // Scanner self-verification (rules §10): a green run must mean the predicate
  // discriminates, not that it returns truthy for everything handed to it.
  describe('sectionBody discriminates', () => {
    it('returns null when the heading is absent', () => {
      expect(sectionBody('# t\n\n## Other\n\nbody\n', HEADING)).toBeNull();
    });

    it('stops at the next h2 rather than swallowing the rest of the file', () => {
      const doc = `${HEADING}\n\nmine\n\n## Next\n\nnot mine\n`;
      expect(sectionBody(doc, HEADING)).toContain('mine');
      expect(sectionBody(doc, HEADING)).not.toContain('not mine');
    });

    it('handles CRLF, which this repo writes', () => {
      expect(sectionBody(`${HEADING}\r\n\r\nmine\r\n`, HEADING)).toContain('mine');
    });
  });

  // Recorded, not enforced. The file declares a 4K-chars-per-file instruction
  // budget it already violates; asserting the section did not *cause* that is
  // honest, asserting the file is under budget would be false.
  it('records that the 4K instruction budget is already exceeded', () => {
    const chars = read().length;
    expect(chars).toBeGreaterThan(4_000);
    const section = sectionBody(read(), HEADING) ?? '';
    expect(section.length).toBeLessThan(1_000);
  });
});
