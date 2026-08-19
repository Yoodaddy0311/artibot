/**
 * readme-claims-registry.js — Single source of truth for README count claims.
 *
 * Both the validator (validate-readme-claims.js, which FAILS on drift) and the
 * auto-fixer (sync-readme-claims.js, which REWRITES drift) need the same two
 * things: the actual file-system counts, and the regexes that locate count
 * claims in README prose/badges. Keeping them in one place guarantees the gate
 * and the self-heal can never disagree about what a "claim" is or what it should
 * equal — the failure mode that would let drift slip past one but not the other.
 *
 * Exports:
 *   REPO_ROOT, PLUGIN_ROOT — resolved repo paths (callers pass nothing).
 *   collectActuals(opts)   — file-system counts; opts.full adds coverage.
 *   CLAIM_PATTERNS         — [{ key, regex, label, lang }] matching prose/badges.
 *   splitFrozenHistory(s)  — { scanned, frozen }; only `scanned` is claim-checked.
 *
 * Regex contract: each pattern has capture group 1 = numeric claim, group 2 =
 * the trailing phrase (e.g. " slash commands", or "개 도메인 스킬"). The validator
 * reads group 1 to compare; the sync reads group 2 to rebuild the replacement
 * verbatim, so `group1 + group2` must always reconstruct the whole match. The
 * `gi` flag is intentional (case-insensitive, all occurrences).
 *
 * `lang` is 'en' or 'ko'. It is not used for matching — Korean tails begin with
 * the counter "개" rather than whitespace, so it exists so tests can assert the
 * right shape per language instead of assuming the English leading-space form.
 *
 * Zero dependencies. Node 20+ built-ins only.
 *
 * @module scripts/ci/readme-claims-registry
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(scriptDir, '..', '..');
export const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

function countDirsWith(dir, marker) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() && existsSync(path.join(full, marker));
  }).length;
}

/**
 * Count files in `dir` matching one or more extensions.
 * @param {string} dir - Directory to scan (missing dir counts 0).
 * @param {string|string[]} ext - Extension or list of extensions to accept.
 * @param {string[]} [exclude] - Exact filenames to skip.
 * @returns {number} matching file count
 */
function countFiles(dir, ext, exclude = []) {
  if (!existsSync(dir)) return 0;
  const exts = Array.isArray(ext) ? ext : [ext];
  return readdirSync(dir).filter(
    (f) => exts.some((e) => f.endsWith(e)) && !exclude.includes(f)
  ).length;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Collect actual counts from the file system.
 * @param {{ full?: boolean }} [opts] - When `full`, also reads coverage summary.
 * @returns {Record<string, number>} category -> count
 */
export function collectActuals(opts = {}) {
  const actuals = {
    skills: countDirsWith(path.join(PLUGIN_ROOT, 'skills'), 'SKILL.md'),
    commands: countFiles(path.join(PLUGIN_ROOT, 'commands'), '.md'),
    agents: countFiles(path.join(PLUGIN_ROOT, 'agents'), '.md', ['INDEX.md', 'README.md']),
    // Script-file counts are "executable ESM modules in this directory", i.e.
    // .js + .mjs. `.mjs` is NOT a separate category: hooks/dispatch-table.json
    // registers session-readback.mjs (SessionStart) and session-ledger.mjs
    // (Stop, SessionEnd) as live hooks, and the counts already include
    // non-registered helpers like _main-entry.js — so an extension split would
    // be the only inconsistent boundary here. Non-script files (.sh, .md, the
    // *-baseline.json fixtures) are excluded by having no matching extension.
    hookScripts: countFiles(path.join(PLUGIN_ROOT, 'scripts', 'hooks'), ['.js', '.mjs']),
    ciScripts: countFiles(path.join(PLUGIN_ROOT, 'scripts', 'ci'), ['.js', '.mjs']),
  };

  // hooks.json registration count (sum of array lengths across event types).
  const hooksJson = readJsonSafe(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'));
  if (hooksJson?.hooks) {
    actuals.hookRegistrations = Object.values(hooksJson.hooks).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
  }

  if (opts.full) {
    const summary = readJsonSafe(
      path.join(PLUGIN_ROOT, 'coverage', 'coverage-summary.json')
    );
    if (summary?.total) {
      actuals.statementCoverage = Math.round(summary.total.statements.pct);
    }
  }

  return actuals;
}

// Heading that opens the frozen release-note region of a README. Everything
// from the first such heading onward is a historical record of what was true at
// that version ("117개 스킬" in the v1.14.0 notes, "39개 훅 등록" in v1.13.0) and
// must NOT be rewritten to today's counts — doing so would falsify history.
// Matches `## v2.1.0 주요 변경사항` but not `### 런타임 파이프라인 (v1.14.0+)`,
// which is current documentation that merely cites a version.
const FROZEN_HISTORY_HEADING = /^##\s+v\d+\.\d+/m;

/**
 * Split README content into the live region (claim-checked) and the frozen
 * release-note region (left alone).
 *
 * `scanned + frozen === content` always holds, so the sync rewriter can operate
 * on `scanned` and reassemble the file without touching history.
 *
 * @param {string} content - Full file text.
 * @returns {{ scanned: string, frozen: string }}
 */
export function splitFrozenHistory(content) {
  const m = FROZEN_HISTORY_HEADING.exec(content);
  if (!m) return { scanned: content, frozen: '' };
  return { scanned: content.slice(0, m.index), frozen: content.slice(m.index) };
}

// Claim patterns. Group 1 = numeric claim, group 2 = trailing phrase (preserved
// verbatim by the sync rewriter). `label` is for validator/sync human output.
//
// Coverage (statementCoverage) is intentionally NOT pattern-matched here: it is
// a "≈"/threshold claim, not a file-system fact, so the auto-fixer must never
// silently rewrite it — that stays validator-only territory.
//
// ---------------------------------------------------------------------------
// What this gate still does NOT see (write it down, or the gate becomes the
// next false-confidence source):
//   1. Badge numbers. The shields.io URLs at the top of both READMEs encode
//      counts/percentages inside a query string (`coverage-90%25%2B`); none of
//      these patterns look inside a URL, and badge sync is a separate step.
//   2. Number-after-noun phrasing. `| 슬래시 커맨드 | ✅ 78개 |` in the platform
//      support matrix puts the count AFTER the noun, so no pattern here binds
//      it. A regex loose enough to catch it would also match every unrelated
//      "N개" in a table. The stale value it carried (75 vs an actual 78) was
//      hand-corrected on 2026-08-19, and the sibling row `28개 에이전트
//      (오케스트레이터 1 + 전문 27)` is unbound for the same reason — both are
//      right today and can drift again silently. Binding them needs a reword,
//      not a looser regex: phrasing the cell as "78개 슬래시 커맨드" would let
//      the existing `commands (ko)` pattern take it. Left as prose by choice.
//   3. Sub-category counts (`12개 페르소나 스킬`, `23개 마케팅 스킬`,
//      `9개 서브툴`, `16개 언어`). collectActuals() has no truth source for the
//      breakdowns, so gating them would assert a number nothing can verify.
//   4. Parenthetical arithmetic. `(.js 62 + .mjs 6)` next to a gated total is
//      free to disagree with it; only the total is bound.
//   5. Event-type counts (`15개 이벤트`). hooks.json's event-key count is not in
//      collectActuals(); only the registration total (hookRegistrations) is.
//   6. Languages other than English and Korean, and any file outside
//      SCAN_TARGETS (validate-readme-claims.js).
//   7. Which "hook count" a claim means. `hookRegistrations` counts hooks.json
//      MATCHER GROUPS — the top-level array entries per event. Measured
//      2026-08-19 the same file yields four different defensible numbers: 15
//      event types, 25 matcher groups, 27 command entries (a group may hold
//      several), and 24 distinct script files referenced. Only 25 is gated, and
//      `hookScripts` (68) is a fifth number counting files ON DISK under
//      scripts/hooks/, not the 24 that hooks.json actually references. Prose
//      saying "N개 훅" binds to whichever noun the pattern matches, so state the
//      unit ("훅 등록" vs "훅 스크립트") or the claim is unfalsifiable.
// ---------------------------------------------------------------------------
export const CLAIM_PATTERNS = [
  { key: 'skills', regex: /(\d{2,3})(\s+(?:domain\s+)?skills?\b)/gi, label: 'skills', lang: 'en' },
  { key: 'skills', regex: /(\d{2,3})(\s+skill\s+director(?:y|ies))/gi, label: 'skill dirs', lang: 'en' },
  { key: 'commands', regex: /(\d{2,3})(\s+(?:slash\s+)?commands?\b)/gi, label: 'commands', lang: 'en' },
  { key: 'agents', regex: /(\d{2,3})(\s+(?:specialist\s+)?agents?\b)/gi, label: 'agents', lang: 'en' },
  { key: 'agents', regex: /(\d{2,3})(\s+agent\s+definitions?)/gi, label: 'agent defs', lang: 'en' },
  { key: 'hookRegistrations', regex: /(\d{2,3})(\s+hook\s+registrations?)/gi, label: 'hook regs', lang: 'en' },
  { key: 'hookScripts', regex: /(\d{2,3})(\s+hook\s+scripts?)/gi, label: 'hook scripts', lang: 'en' },
  // `validation` is optional so that rewording the prose ("19 CI scripts" <->
  // "19 CI validation scripts") cannot silently unbind the gate — the failure
  // mode that left this claim uncovered while it drifted to 6-vs-19.
  { key: 'ciScripts', regex: /(\d{1,3})(\s+CI\s+(?:validation\s+)?scripts?\b)/gi, label: 'CI scripts', lang: 'en' },

  // --- Korean prose -------------------------------------------------------
  // plugins/artibot/README.md is Korean-dominant: before these entries existed
  // it contributed exactly ONE matched claim (the English "28 Specialist
  // Agents" heading) while carrying dozens of Korean counts that could drift
  // freely. Measured on 2026-08-19, three of them had: 65-vs-68 hook scripts,
  // 6-vs-20 CI scripts, 24-vs-25 hook registrations.
  //
  // Each tail is anchored on a noun that maps 1:1 onto a collectActuals() key.
  // `\s*` after 개 absorbs the optional space in "24개 훅 등록" / "24개 훅이 등록".
  { key: 'skills', regex: /(\d{2,3})(개\s*(?:도메인\s*)?스킬)/gi, label: 'skills (ko)', lang: 'ko' },
  { key: 'commands', regex: /(\d{2,3})(개\s*슬래시\s*커맨드)/gi, label: 'commands (ko)', lang: 'ko' },
  // NOTE: the bare phrase "N개 전문 에이전트" is deliberately NOT gated. It is
  // genuinely ambiguous in this document: README.md:817 uses 28 (every agent)
  // while README.md:1565 uses 27 correctly (the teammate .md files, listed
  // beside orchestrator.md on the line above). Binding it to actuals.agents=28
  // would demand a wrong number at 1565. "에이전트 정의" carries no such
  // ambiguity — it names the whole agents/ directory — so that is what binds.
  { key: 'agents', regex: /(\d{2,3})(개\s*에이전트\s*정의)/gi, label: 'agent defs (ko)', lang: 'ko' },
  { key: 'hookRegistrations', regex: /(\d{2,3})(개\s*훅(?:이)?\s*등록)/gi, label: 'hook regs (ko)', lang: 'ko' },
  { key: 'hookScripts', regex: /(\d{2,3})(개\s*훅\s*스크립트(?:\s*파일)?)/gi, label: 'hook scripts (ko)', lang: 'ko' },
  // Single-digit floor for the same reason as the English CI pattern: the value
  // this exists to catch was a literal "6개 CI 검증 스크립트" beside an actual 20.
  { key: 'ciScripts', regex: /(\d{1,3})(개\s*CI\s*(?:검증\s*)?스크립트)/gi, label: 'CI scripts (ko)', lang: 'ko' },
];
