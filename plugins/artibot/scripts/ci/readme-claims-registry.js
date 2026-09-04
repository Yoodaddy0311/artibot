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
 *   parseClaimNumber(s)    — claim text -> number (tolerates "9,900").
 *   formatClaimNumber(n,s) — number -> claim text in `s`'s separator style.
 *   partitionFrozenHistory(s) — ordered [{text, frozen}]; only live ones are
 *                            claim-checked. Lossless: the texts rejoin into `s`.
 *
 * Regex contract: each pattern has capture group 1 = numeric claim, group 2 =
 * the trailing phrase (e.g. " slash commands", or "개 도메인 스킬"). The validator
 * reads group 1 to compare; the sync reads group 2 to rebuild the replacement
 * verbatim, so `group1 + group2` must always reconstruct the whole match. The
 * `gi` flag is intentional (case-insensitive, all occurrences).
 *
 * Group 1 may carry thousands separators ("9,900"), so callers must go through
 * parseClaimNumber/formatClaimNumber rather than `Number(m[1])` and `${actual}`.
 * A bare `Number("9,900")` is NaN — it would report every such claim as drift
 * and then rewrite the comma out of the document.
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

// ---------------------------------------------------------------------------
// Target lists. Kept HERE, not in the two scripts, for the same reason the
// patterns are: the gate and the auto-fixer must never disagree about which
// files carry claims. Before 2026-09-05 the fixer rewrote two files while the
// validator scanned four, so `plugins/artibot/CLAUDE.md` and
// `plugins/artibot/marketplace.json` could only be fixed by hand — and the
// census below found that hand-fixing is exactly what does not happen.
//
// Measured 2026-09-05 across the tracked public docs, every one of these files
// carried at least one count that no pattern bound or no fixer healed:
//   INSTALL.md:67,69                       28 agents / 111 skills  (actual 30 / 114)
//   plugins/artibot/AGENTS.md:4            28 agents + 113 skills + 72 commands
//   plugins/artibot/.well-known/
//     mcp-server.json:6                    28 agents, 100 skills
//   plugins/artibot/docs/
//     MARKETPLACE-SUBMISSION.md:191-192    28 agents, 75 commands, 9,300+ tests
//   plugins/artibot/marketplace.json:10    9,900+ tests (its own
//                                          qualityMetrics.tests said 14953)
//   plugins/artibot/CLAUDE.md:101          9,300+ tests
//
// SYNC = the fixer rewrites it. VALIDATE_ONLY = checked but hand-fixed; use it
// only for files whose claims cannot be healed by substituting a number.
//
// NOT in either list, on purpose:
//   - CONTRIBUTING.md (root). It says "all 28 agents" three times (actual 30),
//     but two of those are unsafe to auto-substitute. `:127-129` is a bucket
//     table whose rows must sum to the total (`high` 21 + `medium` 7 = 28);
//     rewriting the total to 30 would leave 21 + 7 = 30, a NEW false statement,
//     and the rows are themselves stale (artibot.config.json measured
//     2026-09-05: high 23, medium 7). `:133` reads "Measured 2026-08-19 across
//     all 28 agents", a dated observation that a rewrite would falsify exactly
//     the way partitionFrozenHistory exists to prevent. Fixing that file needs
//     a reword and a re-measure by a human, so gating it would only create a
//     RED nobody may safely clear.
//   - The Korean phrase "N개 전문 에이전트" wherever it appears (e.g.
//     plugins/artibot/docs/ROADMAP-CLAUDE-TAG-CONVERGENCE.md:48). It is left
//     unbound for the reason recorded at the ko `agent defs` pattern below.
//   - AGENTS.md at the repo root is listed but is UNTRACKED (git ls-files
//     returns nothing for it, measured 2026-09-05). The fixer heals it on a
//     machine that has it; CI will never see its drift. Do not cite it as
//     evidence that a claim is gated.
const SYNC_RELATIVE = [
  ['REPO', 'README.md'],
  ['REPO', 'INSTALL.md'],
  ['REPO', 'AGENTS.md'],
  ['REPO', '.claude-plugin/marketplace.json'],
  ['PLUGIN', 'README.md'],
  ['PLUGIN', 'CLAUDE.md'],
  ['PLUGIN', 'AGENTS.md'],
  ['PLUGIN', 'marketplace.json'],
  ['PLUGIN', '.well-known/mcp-server.json'],
  ['PLUGIN', 'docs/MARKETPLACE-SUBMISSION.md'],
];

/** Files the auto-fixer rewrites. Absolute paths. */
export const SYNC_TARGETS = SYNC_RELATIVE.map(([root, rel]) =>
  path.join(root === 'REPO' ? REPO_ROOT : PLUGIN_ROOT, ...rel.split('/'))
);

/** Checked by the validator but never rewritten. Absolute paths. */
export const VALIDATE_ONLY_TARGETS = [];

/** Everything the validator scans. Every synced file is necessarily scanned. */
export const SCAN_TARGETS = [...SYNC_TARGETS, ...VALIDATE_ONLY_TARGETS];

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
 * Read a claim's numeric value, tolerating thousands separators.
 *
 * @param {string} raw - Capture group 1 of a CLAIM_PATTERNS match.
 * @returns {number} the value, or NaN when `raw` is not a number.
 */
export function parseClaimNumber(raw) {
  return Number(String(raw).replace(/,/g, ''));
}

/**
 * Render `value` in the separator style of the claim it replaces.
 *
 * The document, not the registry, decides whether counts are grouped: rewriting
 * "9,900+ tests" must yield "14,953+ tests", while a JSON field written as
 * `9900` must stay ungrouped. `sample` is the original group-1 text.
 *
 * @param {number} value - Actual count.
 * @param {string} sample - The claim text being replaced.
 * @returns {string} formatted number
 */
export function formatClaimNumber(value, sample) {
  return String(sample).includes(',') ? value.toLocaleString('en-US') : String(value);
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
    // `rules` = the .md rule files directly under rules/ (2026-08-22 리더 결정).
    // rules/csv/ and everything inside it are NOT rules — the directory holds
    // lookup tables consumed BY rules, and countFiles' extension filter already
    // drops it (a directory named `csv` does not end in `.md`). Nested .md files
    // are likewise out of scope: the count is deliberately 1-depth, matching how
    // marketplace.json#/entryPoints/rules advertises the directory to users.
    rules: countFiles(path.join(PLUGIN_ROOT, 'rules'), '.md'),
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

  // Suite size. Unlike every other key here this is NOT a file-system fact —
  // no directory listing yields "how many test cases exist", and a real count
  // needs a full vitest run (minutes). So the truth source is the number the
  // release pipeline already measured and committed:
  // marketplace.json#/qualityMetrics/tests, whose ONLY writer is
  // scripts/ci/sync-marketplace-meta.mjs (from `--tests=N` or a cached
  // runtime/vitest-report.json#numTotalTests). One writer, one reader.
  //
  // Reproduce the underlying measurement with:
  //   npx vitest run --reporter=json --outputFile=runtime/vitest-report.json
  //   node scripts/ci/sync-marketplace-meta.mjs
  // then this key follows automatically.
  //
  // What this does NOT prove (write it down or the gate becomes the next false
  // confidence source):
  //   - It does not verify the suite actually has that many cases TODAY. It
  //     asserts that public prose agrees with the last committed measurement,
  //     nothing more. A hand-edited qualityMetrics.tests propagates silently
  //     into every synced document — the field is the contract, so review it
  //     like one.
  //   - runtime/ is gitignored (plugins/artibot/.gitignore:10), so the cached
  //     vitest report is machine-local and absent in CI. Reading it here would
  //     make the gate's value depend on whether someone happened to run the
  //     suite locally, and would let a dev machine's number and the committed
  //     number disagree in opposite directions. That is why the report is NOT
  //     consulted here even though sync-marketplace-meta.mjs consults it: that
  //     script is the writer, this one is the reader.
  //   - When the field is missing or non-numeric the key is left undefined,
  //     which both the validator and the sync already treat as "skip". That is
  //     deliberate fail-safe (no assertion), not fail-open coverage.
  const marketplace = readJsonSafe(path.join(PLUGIN_ROOT, 'marketplace.json'));
  const committedTests = marketplace?.qualityMetrics?.tests;
  if (Number.isInteger(committedTests) && committedTests > 0) {
    actuals.tests = committedTests;
  }

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

// Heading that opens a frozen release-note section. Such a section is a
// historical record of what was true at that version ("117개 스킬" in the
// v1.14.0 notes, "39개 훅 등록" in v1.13.0) and must NOT be rewritten to today's
// counts — doing so would falsify history. Matches `## v2.1.0 주요 변경사항` but
// not `### 런타임 파이프라인 (v1.14.0+)`, which is current documentation that
// merely cites a version.
const FROZEN_HISTORY_HEADING = /^##\s+v\d+\.\d+/;

/** Any `##` (h2) heading — the granularity at which freeze is decided. */
const H2_HEADING = /^##\s+/;

/** Fence opener/closer. Tracked so a `## …` line inside a code block is text. */
const FENCE = /^\s*(?:```|~~~)/;

/**
 * Partition README content into ordered segments, each marked frozen or live.
 *
 * Freeze is decided **per `##` section**, not by a single cut point. An earlier
 * design froze everything from the first version heading to EOF, which also
 * swallowed the sections that follow the release notes — in
 * plugins/artibot/README.md that is `## 기여하기` and `## 라이선스`, current
 * documentation that would silently leave the gate. Per-section classification
 * also removes an ordering assumption: a non-version section appearing between
 * two version blocks no longer un-freezes every release note after it.
 *
 * `segments.map((s) => s.text).join('') === content` always holds, so the sync
 * rewriter can rebuild the file from the segments without touching history.
 *
 * Known limit: fences are tracked so `##` inside a code block is not read as a
 * heading, but only ``` / ~~~ fences — an indented (4-space) code block whose
 * content starts with `##` would still be read as a heading. No scan target
 * contains one (measured 2026-08-19: 0 fenced `##` lines across all three).
 *
 * @param {string} content - Full file text.
 * @returns {Array<{ text: string, frozen: boolean }>} Ordered, lossless.
 */
export function partitionFrozenHistory(content) {
  const segments = [];
  let buf = '';
  let frozen = false;
  let inFence = false;

  for (const line of content.split(/(?<=\n)/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
    } else if (!inFence && H2_HEADING.test(line)) {
      const nextFrozen = FROZEN_HISTORY_HEADING.test(line);
      if (nextFrozen !== frozen) {
        if (buf !== '') segments.push({ text: buf, frozen });
        buf = '';
        frozen = nextFrozen;
      }
    }
    buf += line;
  }
  if (buf !== '') segments.push({ text: buf, frozen });
  return segments;
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
//      A sixth number exists and matters most when reading the first five:
//      hooks.json is not the only registration table. hooks/dispatch-table.json
//      names 47 scripts that the `*-dispatcher.js` hooks fan out to, 35 of them
//      not in hooks.json (the other 12 overlap with its 24), so 24 + 35 = 59 of
//      the 68 files are reachable through the two tables combined (re-measured
//      2026-08-24 against the real directory listing: unchanged from the
//      2026-08-19 figures — 68 = 62 .js + 6 .mjs, union 59, remainder 9, and
//      the same 9 filenames). The remaining 9 are NOT the dead list. Table
//      registration is only one of the ways a hook file is reached: a dynamic
//      import from a registered hook also reaches one, and a file can be the
//      named deliverable of an opt-in surface that nothing in this repo wires
//      up. Measured 2026-08-24, the 9 fall into four evidence tiers — none of
//      them "dead", but they are NOT equally well evidenced, so do not quote
//      them as one bucket:
//      (a) Live code path, reachable today — 4:
//        - `_main-entry.js` — 64 importers, 61 under scripts/hooks/. (63 until
//          scripts/evals/harness-ablation.js:9 added one; the number moves with
//          the tree, so re-measure before quoting it.)
//        - `_dispatcher-utils.js` — 8: the six `*-dispatcher.js` plus two
//          tests under tests/dispatcher/.
//        - `git-autopilot-merge.js` — imported by the registered
//          git-autopilot-session.js:16.
//        - `skill-discovery-inject.js` — NOT importer-less. session-start.js
//          (`maybeInjectSkillDiscovery`, :620 on 2026-08-24) builds the path
//          with path.join() and `await import()`s it (AD-23, first-session-of-
//          day meta-skill inject), and session-start.js is dispatch-table
//          SessionStart handlers[0]. A static import scan cannot see a
//          path.join()'d specifier; tests/hooks/skill-discovery-inject.test.js
//          covers it. The wiring audit reached this independently and files it
//          under bySubsystem[19].findings[2] as gapType FALSE_POSITIVE,
//          missingLink "None — wired via dynamic in-process import from the
//          registered session-start.js handler." (That entry cites :594-598 and
//          :683; those line numbers are from the 2026-05-30 audit and have
//          since drifted — the symbol names still resolve.)
//      (b) Deliberately kept, never executed — 1:
//        - `check-console-log.js` — a deliberate KEEP, not a removal candidate.
//          tests/hooks/legacy-stubs.test.js asserts the file exists and parses
//          (V3_LEGACY_HOOKS array at :18-27, assertions at :29-54), because
//          sessions that cached the v3.0.0 hooks.json still exec this path on
//          Stop and would MODULE_NOT_FOUND without it. The wiring audit agrees
//          twice over — dormant[] and bySubsystem[19].findings[0], both
//          INTENTIONAL_DORMANT, missingLink "None — intentional backward-compat
//          stub kept alive on purpose by legacy-stubs.test.js ... Do not fix."
//          Its header's "Safe to remove" is conditional ("after all open
//          sessions are restarted"); quoting it without that clause inverts the
//          verdict.
//      (c) Schedule intended, not proven to run anywhere — 2:
//        - the `nightly-*.mjs` pair — named in the TRAINERS registry at
//          scripts/setup-nightly-trainers.js:28-41. That script PRINTS a
//          crontab/schtasks guide rather than installing one.
//      (d) Named deliverable of an opt-in surface, no wiring in this repo — 2.
//          Weakest tier: for these two, "not dead" rests on documented intent,
//          not on any executed path.
//        - `event-emitter.mjs` — deliverable #1 of the `hook-event-emitter`
//          skill and step 3 of its (unchecked) build checklist; the skill's
//          pipeline diagram at skills/hook-event-emitter/SKILL.md:59-67 shows
//          `Claude Code hook -> scripts/hooks/event-emitter.mjs (stdin JSON)`,
//          and downstream consumers of its envelope exist in
//          lib/runtime/dashboard/{server.mjs,aggregator.js} and
//          bin/artibot-dashboard.mjs. Three registered hooks cite
//          `event-emitter.mjs:84` as the payload-shape reference (post-bash.js,
//          post-edit-recovery.js, tool-tracker.js) but none import it. NOTE: no
//          settings.json wiring for it exists anywhere in this repo — SKILL.md
//          contains the string "settings.json" zero times, and its one "opt-in"
//          (:47) is about http-notify.js, not this file. An earlier revision of
//          this comment asserted a user-side settings.json entry; that was
//          unsourced. What is sourced is the skill contract, not an invocation.
//        - `session-start-sweep.mjs` — zero importers, no table entry, no test.
//          Unlike event-emitter.mjs it does carry a settings.json snippet in its
//          own header (:23-25), under the heading "Hook registration (pending —
//          v0.5.1 roadmap)". Dormant by declaration.
//      Two cautions on the audit itself. It is plugins/artibot/docs/
//      wiring-audit-result.json, NOT docs/ at the repo root, and it is
//      UNTRACKED — .gitignore:24 ignores `plugins/artibot/docs/*`, so it exists
//      only on machines that ran the audit and `git log` on it returns nothing.
//      No generator ships in this repo (scripts/ci/triage-wiring-gaps.mjs
//      READS it), so it cannot be regenerated to check staleness; the local copy
//      is dated 2026-05-30 by FILE MTIME ONLY — the JSON carries no generated-at
//      field, and the sibling docs/WIRING-AUDIT-2026-05-30.md is the same date.
//      Search all FOUR top-level keys when checking it — confirmedRealGaps,
//      dormant, refuted AND bySubsystem. An earlier revision of this comment
//      claimed the audit had no entry for skill-discovery-inject.js; that was a
//      scoping error (three keys searched, bySubsystem missed). It has no entry
//      for `event-emitter.mjs` or `session-start-sweep.mjs` — zero occurrences
//      across the whole file, verified 2026-08-24 — and there, silence is
//      absence of evidence, not a dormant verdict.
//      So do not subtract a registration count from the file count and read the
//      difference as dead files. On this measurement the difference contains
//      zero removable files.
//      Counting these by regex is itself error-prone: a naive
//      `\.m?js` scan of dispatch-table.json returns 50, because it also
//      matches prose in the file's own `description` (`*-dispatcher.js`,
//      `dispatch-table-loader.js`) and the `.js` inside the string `hooks.json`.
//      Intersect against the real directory listing before believing any of it.
// ---------------------------------------------------------------------------
export const CLAIM_PATTERNS = [
  { key: 'skills', regex: /(\d{2,3})(\s+(?:domain\s+)?skills?\b)/gi, label: 'skills', lang: 'en' },
  { key: 'skills', regex: /(\d{2,3})(\s+skill\s+director(?:y|ies))/gi, label: 'skill dirs', lang: 'en' },
  // `slash[- ]command` covers the hyphenated compound. Measured 2026-09-05,
  // AGENTS.md:8 read "54 slash-command definitions" against an actual 79 and no
  // pattern bound it — the hyphen alone was the whole gap.
  { key: 'commands', regex: /(\d{2,3})(\s+(?:slash[-\s])?commands?\b)/gi, label: 'commands', lang: 'en' },
  // `specialist|specialized` for the same reason: AGENTS.md:7 said
  // "29 specialized agent definitions" (actual 30) and only "specialist" was
  // listed, so the adjective silently unbound the claim.
  { key: 'agents', regex: /(\d{2,3})(\s+(?:specialist\s+|specialized\s+)?agents?\b)/gi, label: 'agents', lang: 'en' },
  { key: 'agents', regex: /(\d{2,3})(\s+(?:specialist\s+|specialized\s+)?agent\s+definitions?)/gi, label: 'agent defs', lang: 'en' },
  { key: 'hookRegistrations', regex: /(\d{2,3})(\s+hook\s+registrations?)/gi, label: 'hook regs', lang: 'en' },
  { key: 'hookScripts', regex: /(\d{2,3})(\s+hook\s+scripts?)/gi, label: 'hook scripts', lang: 'en' },
  // `validation` is optional so that rewording the prose ("19 CI scripts" <->
  // "19 CI validation scripts") cannot silently unbind the gate — the failure
  // mode that left this claim uncovered while it drifted to 6-vs-19.
  { key: 'ciScripts', regex: /(\d{1,3})(\s+CI\s+(?:validation\s+)?scripts?\b)/gi, label: 'CI scripts', lang: 'en' },

  // Suite size. DELIBERATELY NARROW: it binds only comma-grouped numbers or
  // 4-or-more digits, so it sees "9,900+ tests" and "14953 tests" but not the
  // ordinary prose "+14 tests" / "3 tests". That prose is not hypothetical —
  // plugins/artibot/README.md's release-note lines (":261 +14 tests",
  // ":269 +27 tests", measured 2026-09-05) sit in LIVE, non-frozen sections, so
  // a loose `\d+\s*tests` would rewrite them to the suite size and wreck the
  // sentences. The consequence of the narrowing is equally real and is the
  // gate's blind spot: a genuine suite-size claim written as "990 tests" (three
  // digits, no separator) stays unbound. Widening needs a different anchor
  // noun, not a looser number.
  //
  // The optional `\+` lives in group 2 so a floor claim stays a floor claim:
  // "9,900+ tests" heals to "14,953+ tests", never to a bare "14,953 tests".
  // `automated` is optional for the same reason `validation` is optional in the
  // CI-scripts pattern: rewording the noun phrase must not silently unbind the
  // claim. Measured 2026-09-05, docs/MARKETPLACE-SUBMISSION.md:192 read
  // "9,300+ automated tests" and the adjective alone hid it from the gate.
  { key: 'tests', regex: /(\d{1,3}(?:,\d{3})+|\d{4,})(\+?\s*(?:automated\s+)?tests?\b)/gi, label: 'tests', lang: 'en' },

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
  // NO Korean `tests` pattern, deliberately. One was written and then removed
  // on 2026-09-05: the scan set contains zero Korean suite-size claims, so the
  // pattern matched nothing and `tests/ci/validate-readme-claims.test.js`
  // ("every Korean pattern binds to at least one real sentence ... — dead
  // gate") failed on it, correctly. A pattern that binds nothing is not free
  // insurance — it is an untested regex that will be trusted the first time
  // someone writes the phrase. Add it together with the first real Korean
  // suite-size sentence, not before.
];
