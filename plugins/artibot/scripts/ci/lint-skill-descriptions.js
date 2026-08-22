#!/usr/bin/env node
/**
 * CI: Lint SKILL.md frontmatter `description` quality (CSO compliance).
 *
 * Background (benchmark-verified): when a skill's `description` embeds a
 * workflow summary, the model acts on the summary WITHOUT reading the skill
 * body (superpowers' "Claude Skips Onboarding" / CSO failure). A description
 * must answer only "WHEN does this fire" + trigger utterances — never "HOW the
 * workflow runs".
 *
 * Rules:
 *   R1 (trigger floor)    — ≥3 activation signals. severity: error.
 *   R2 (no workflow, CSO) — no pipeline tokens / arrow chains / numbered steps
 *                            / 3-verb procedural chains. severity: error.
 *   R3 (length)           — description > 1024 chars. severity: warn.
 *   R4 (Red Flags body)   — SKILL.md *body* lacks a `## Red Flags` section.
 *                            severity: warn. Body-rule (reads markdown body, not
 *                            the frontmatter description). Ratcheted against its
 *                            own frozen baseline so only NEW/edited skills must
 *                            ship a Red Flags section; the 85+ legacy skills that
 *                            predate the convention are regression-frozen.
 *
 * Two independent ratchet gates (see runRatchet) freeze the current violating
 * sets so only NEW violations fail CI. Mirrors the validate-doc-links.js style.
 *   - description gate (R1/R2 errors) → `skill-lint-baseline.json`
 *   - Red Flags gate (R4 warns)       → `skill-redflags-baseline.json`
 *
 * Both gates are enforced in BOTH directions (see evaluateGates):
 *   - grow  → a skill violating outside the baseline fails CI (new violation),
 *   - shrink → a baseline entry whose skill no longer violates ALSO fails CI.
 * A baseline entry that outlived its violation ("fossil") is not cosmetic
 * debt: it is a live re-entry permit. The name stays excused, so if that same
 * skill regresses later the ratchet stays silent — the exact regression the
 * gate exists to catch. Shrink enforcement keeps the baseline monotonically
 * decreasing, which is the only property that makes a ratchet a ratchet.
 *
 * Zero external dependencies (node:fs / node:path / node:url only).
 * Never-throw: a skill that fails to parse is reported as a warning and skipped.
 *
 * @module scripts/ci/lint-skill-descriptions
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from './ci-utils.js';
import { assertEntityFloors, countByRoot, listAllSkillFiles } from './skill-scan-roots.js';

/** Minimum number of distinct activation signals required by R1. */
export const MIN_TRIGGERS = 3;
/** Maximum description length before R3 warns. */
export const MAX_DESC_LEN = 1024;

/**
 * Extract the raw `description` value from SKILL.md frontmatter, supporting
 * both inline (`description: "..."`) and YAML block scalar (`description: |`)
 * forms. Returns the joined text with surrounding quotes stripped.
 *
 * @param {string} content - Raw SKILL.md file content.
 * @returns {string|null} Description text, or null if none / no frontmatter.
 */
export function extractDescription(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const lines = fm[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();
    // Block scalar: `description: |` or `description: >` → gather indented lines.
    if (inline === '' || inline === '|' || inline === '>' || /^[|>][+-]?$/.test(inline)) {
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\S/.test(lines[j]) && lines[j].trim() !== '') break; // next top-level key
        block.push(lines[j].trim());
      }
      return block.join(' ').trim();
    }
    return inline.replace(/^["']|["']$/g, '').trim();
  }
  return null;
}

/**
 * Count distinct activation signals in a description (R1 heuristic): quoted
 * utterances, "Use when/whenever", "Triggers:" lists, and Korean colloquial
 * request endings ("~해줘", "~할까" and kin).
 *
 * @param {string} desc - Description text.
 * @returns {number} Count of detected activation signals.
 */
export function countTriggers(desc) {
  const text = String(desc);
  let n = 0;
  // Quoted utterances (single, double, or curly quotes).
  n += (text.match(/'[^']+'|"[^"]+"|[“”][^“”]+[“”]/g) || []).length;
  // Korean colloquial request endings (vibe-coder utterances). The leading
  // Hangul char is optional so phrase-initial verbs ("만들어줘") still count.
  n += (text.match(/[가-힣]?(?:해줘|해 줘|할까|만들어|그려줘|바꿔|수정해|고쳐|구체적으로)/g) || []).length;
  // Trigger-enumeration clauses: "Use when user says A, B, C", "Triggers on: …",
  // "Auto-activates when: …", "활성화 …". The clause itself is one signal and each
  // comma-separated item in it adds another, so a well-enumerated description
  // clears the R1 floor without needing quotes.
  const clause =
    /(?:Use\s+(?:when|whenever)[^.]*?(?:says|asks|requests|mentions|wants)|Triggers?(?:\s+on)?\s*:|Auto-activates?\s+when\s*:|활성화)([^.]*)/gi;
  let m;
  while ((m = clause.exec(text)) !== null) {
    n += 1; // the clause itself is one signal
    n += (m[1].match(/,/g) || []).length; // plus each comma-separated item
  }
  return n;
}

/**
 * Detect workflow-summary patterns in a description (R2 / CSO). Returns the list
 * of matched pattern labels (empty array = compliant).
 *
 * @param {string} desc - Description text.
 * @returns {string[]} Matched workflow-pattern labels.
 */
export function detectWorkflowSummary(desc) {
  const text = String(desc);
  const hits = [];
  // Uppercase pipeline tokens, e.g. DECOMPOSE-EXECUTE-VERIFY, CLASSIFY-GENERATE-RANK.
  if (/\b[A-Z]{3,}(?:-[A-Z]{3,}){1,}\b/.test(text)) hits.push('pipeline-token');
  // Arrow chains: ->, →, ⇒.
  if (/(?:->|→|⇒)/.test(text)) hits.push('arrow-chain');
  // Numbered / phased steps: "1.", "2.", "Phase 2", "Step 3".
  if (/(?:\b[1-9]\.\s|\bPhase\s+\d|\bStep\s+\d)/i.test(text)) hits.push('numbered-step');
  // 3+ chained procedural verbs (EN past-participle list or KO connective chain).
  if (detectVerbChain(text)) hits.push('verb-chain');
  return hits;
}

/**
 * Detect a 3+ procedural-verb chain describing HOW the workflow runs, e.g.
 * "decomposed, executed, verified, and reported" or Korean "분해하고 실행하고 검증".
 *
 * @param {string} text - Description text.
 * @returns {boolean} True when a 3+ verb procedural chain is present.
 */
function detectVerbChain(text) {
  // Process-verb stems that signal "HOW the workflow runs" when chained.
  const verbStems =
    'decompos|execut|verif|report|analyz|generat|classif|rank|validat|implement|review|plan|refin|synthesiz|evaluat|orchestrat|transform';
  // (a) ≥3 process verbs in one comma/"and" list: "decomposed, executed, verified, and reported".
  const enList = new RegExp(
    `\\b(?:${verbStems})\\w*\\b[^.]*?,[^.]*?\\b(?:${verbStems})\\w*\\b[^.]*?(?:,|\\band\\b)[^.]*?\\b(?:${verbStems})\\w*\\b`,
    'i'
  );
  if (enList.test(text)) return true;
  // (b) ≥3 process verbs used as sentence-leading actions across the description,
  //     e.g. "Transforms … Classifies … Generates …" (clarify's CSO pipeline prose).
  const lead = new RegExp(`\\b(?:${verbStems})(?:ies|es|s|ed|ing|y)?\\b`, 'gi');
  const leadHits = text.match(lead) || [];
  if (leadHits.length >= 3) return true;
  // (c) KO: ≥3 "~하고/~하여/~한 뒤" connective chain of process verbs.
  const koChain = /(?:[가-힣]{2,}(?:하고|하여|한 뒤|한 후)\s*){2,}[가-힣]{2,}/;
  return koChain.test(text);
}

/**
 * Detect whether a SKILL.md body carries a `## Red Flags` heading (R4).
 * Reads the markdown body (everything after the frontmatter block), so a literal
 * "Red Flags" mention inside the frontmatter `description` does not count.
 * Matches an ATX heading at any depth (`##`/`###`) case-insensitively, allowing
 * trailing decoration (e.g. `## Red Flags (anti-patterns)`).
 *
 * @param {string} content - Raw SKILL.md file content.
 * @returns {boolean} True when a `Red Flags` section heading is present in body.
 */
export function hasRedFlagsSection(content) {
  const text = String(content).replace(/\r\n/g, '\n');
  // Strip the leading frontmatter block so a description mention does not count.
  const body = text.replace(/^---\n[\s\S]*?\n---/, '');
  return /^#{2,}\s+red\s*flags\b/im.test(body);
}

/**
 * Lint a single description against R1/R2/R3. Pure — no I/O.
 *
 * @param {string|null} desc - Extracted description (null if absent).
 * @returns {{violations: Array<{rule:string,severity:string,detail:string}>,
 *           triggerCount:number, length:number}} Lint result.
 */
export function lintDescription(desc) {
  const violations = [];
  if (desc === null || desc === undefined || desc === '') {
    violations.push({ rule: 'R1', severity: 'error', detail: 'missing description' });
    return { violations, triggerCount: 0, length: 0 };
  }
  const triggerCount = countTriggers(desc);
  const length = desc.length;
  if (triggerCount < MIN_TRIGGERS) {
    violations.push({
      rule: 'R1',
      severity: 'error',
      detail: `only ${triggerCount} activation signal(s), need ≥${MIN_TRIGGERS}`,
    });
  }
  const wf = detectWorkflowSummary(desc);
  if (wf.length > 0) {
    violations.push({
      rule: 'R2',
      severity: 'error',
      detail: `workflow summary in description (CSO): ${wf.join(', ')}`,
    });
  }
  if (length > MAX_DESC_LEN) {
    violations.push({
      rule: 'R3',
      severity: 'warn',
      detail: `description ${length} chars > ${MAX_DESC_LEN}`,
    });
  }
  return { violations, triggerCount, length };
}

/**
 * Collect every `skills/<name>/SKILL.md` under the plugin root.
 *
 * @param {string} root - Plugin root absolute path.
 * @returns {Array<{name:string, file:string}>} Skill name + absolute path pairs.
 */
export function gatherSkills(root) {
  const dir = path.join(root, 'skills');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (existsSync(file)) out.push({ name: entry.name, file });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lint every skill across EVERY project plugin root (never-throw).
 *
 * Results are keyed by the root-qualified name (`artibot-cowork/daily`) because
 * 31 skill names are shared between the main plugin and cowork; a bare-name key
 * would let one baseline entry excuse violations in both.
 *
 * @returns {{results: Array, perRoot: Record<string, number>}} Per-skill lint
 *   results plus the per-root denominator.
 */
export function lintEveryRoot() {
  const files = listAllSkillFiles();
  const results = [];
  for (const { key, rootName, file } of files) {
    results.push({ rootName, ...lintSkillFile(key, file) });
  }
  return { results, perRoot: countByRoot(files) };
}

/**
 * Lint a single SKILL.md file (never-throw: unreadable → warn+skip).
 *
 * @param {string} name - Reporting/baseline key for this skill.
 * @param {string} file - Absolute path to SKILL.md.
 * @returns {{name:string, violations:Array, triggerCount:number,
 *           length:number, skipped?:boolean}} Lint result.
 */
export function lintSkillFile(name, file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    return {
      name,
      violations: [{ rule: 'parse', severity: 'warn', detail: `unreadable: ${err.message}` }],
      triggerCount: 0,
      length: 0,
      skipped: true,
    };
  }
  const desc = extractDescription(content);
  const { violations, triggerCount, length } = lintDescription(desc);
  // R4 (body-rule, warn): flag a missing `## Red Flags` body section.
  if (!hasRedFlagsSection(content)) {
    violations.push({
      rule: 'R4',
      severity: 'warn',
      detail: 'SKILL.md body has no `## Red Flags` section',
    });
  }
  return { name, violations, triggerCount, length };
}

/**
 * Lint every skill under ONE plugin root (never-throw: unreadable → warn+skip).
 *
 * Retained as the single-root entry point used by
 * `tests/ci/lint-skill-descriptions.test.js`; the CLI uses
 * {@link lintEveryRoot}.
 *
 * @param {string} root - Plugin root absolute path.
 * @returns {Array<{name:string, violations:Array, triggerCount:number,
 *           length:number, skipped?:boolean}>} Per-skill lint results.
 */
export function lintAllSkills(root) {
  const results = [];
  for (const { name, file } of gatherSkills(root)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      results.push({
        name,
        violations: [{ rule: 'parse', severity: 'warn', detail: `unreadable: ${err.message}` }],
        triggerCount: 0,
        length: 0,
        skipped: true,
      });
      continue;
    }
    const desc = extractDescription(content);
    const { violations, triggerCount, length } = lintDescription(desc);
    // R4 (body-rule, warn): flag a missing `## Red Flags` body section.
    if (!hasRedFlagsSection(content)) {
      violations.push({
        rule: 'R4',
        severity: 'warn',
        detail: 'SKILL.md body has no `## Red Flags` section',
      });
    }
    results.push({ name, violations, triggerCount, length });
  }
  return results;
}

/**
 * Reduce per-skill results to the set of skill names that lack a `## Red Flags`
 * body section (R4). Used by the dedicated Red Flags ratchet gate.
 *
 * @param {Array} results - Output of lintAllSkills.
 * @returns {string[]} Sorted skill names missing a Red Flags section.
 */
export function redFlagViolatingSkillNames(results) {
  return results
    .filter((r) => r.violations.some((v) => v.rule === 'R4'))
    .map((r) => r.name)
    .sort();
}

/**
 * Reduce per-skill results to the set of skill names with at least one ERROR
 * violation (R3 warn does not count toward the ratchet).
 *
 * @param {Array} results - Output of lintAllSkills.
 * @returns {string[]} Sorted skill names with error-severity violations.
 */
export function violatingSkillNames(results) {
  return results
    .filter((r) => r.violations.some((v) => v.severity === 'error'))
    .map((r) => r.name)
    .sort();
}

/**
 * Apply the ratchet gate against a frozen baseline of violating skill names.
 *
 * `pass` covers the GROW direction only (no violation outside the baseline).
 * The SHRINK direction — `fixed` must be empty — is decided by
 * {@link evaluateGates}, which owns the whole CLI verdict; keeping it out of
 * `pass` preserves the meaning "no NEW violations" for existing callers.
 *
 * @param {string[]} current - Skill names violating now (error severity).
 * @param {string[]} baseline - Frozen baseline skill names.
 * @returns {{newViolations:string[], stillViolating:string[], fixed:string[],
 *           pass:boolean}} Ratchet decision.
 */
export function runRatchet(current, baseline) {
  const base = new Set(baseline);
  const cur = new Set(current);
  const newViolations = current.filter((n) => !base.has(n));
  const stillViolating = current.filter((n) => base.has(n));
  const fixed = baseline.filter((n) => !cur.has(n));
  return { newViolations, stillViolating, fixed, pass: newViolations.length === 0 };
}

/**
 * Command that regenerates BOTH baselines. Run from `plugins/artibot/`.
 * Kept as one exported constant so the failure message and the docs can never
 * drift from the actual npm script (`package.json#scripts.skill:lint:desc:baseline`).
 *
 * @type {string}
 */
export const BASELINE_REGEN_CMD = 'npm run skill:lint:desc:baseline';

/**
 * Build the shrink-direction failure block for one ratchet.
 *
 * @param {string[]} fossils - Baseline names whose skill no longer violates.
 * @param {string} baselineName - Baseline file name, for the operator.
 * @param {string} what - Human label for what stopped violating.
 * @returns {string[]} stderr lines (empty when there is nothing to report).
 */
function fossilMessages(fossils, baselineName, what) {
  if (fossils.length === 0) return [];
  const lines = [
    `\nFAIL: ${fossils.length} stale entr(y|ies) in ${baselineName} — ${what}:`,
    ...fossils.map((n) => `  - ${n}`),
    'A baseline entry that outlived its violation still excuses that skill by name,',
    'so the same violation could come back unnoticed. The baseline must shrink.',
    `Regenerate it (from plugins/artibot/):  ${BASELINE_REGEN_CMD}`,
    `  equivalently:  node scripts/ci/lint-skill-descriptions.js --update-baseline`,
    `Then commit the updated ${baselineName} alongside your change.`,
  ];
  return lines;
}

/**
 * Decide the CLI verdict from both ratchets plus the denominator check.
 *
 * Pure (no I/O) so the exit-path can be unit-tested without spawning. Floor
 * failures are counted into `failed` but NOT re-rendered here: main() prints
 * them earlier, before the `--update-baseline` branch, and duplicating them
 * would make the operator think there were twice as many.
 *
 * @param {{ratchet:{pass:boolean,newViolations:string[],fixed:string[]},
 *          redFlagRatchet:{pass:boolean,newViolations:string[],fixed:string[]},
 *          floorFailures?:string[]}} input - Gate inputs.
 * @returns {{failed:boolean, messages:string[]}} Verdict + stderr lines.
 */
export function evaluateGates({ ratchet, redFlagRatchet, floorFailures = [] }) {
  const descFossils = ratchet.fixed || [];
  const redFlagFossils = redFlagRatchet.fixed || [];
  const messages = [];

  if (!ratchet.pass) {
    messages.push(`\nFAIL: ${ratchet.newViolations.length} NEW description-violating skill(s):`);
    for (const n of ratchet.newViolations) messages.push(`  - ${n}`);
    messages.push('Fix the description or justify, then re-run.');
  }
  if (!redFlagRatchet.pass) {
    messages.push(
      `\nFAIL: ${redFlagRatchet.newViolations.length} NEW/edited skill(s) missing a \`## Red Flags\` section:`
    );
    for (const n of redFlagRatchet.newViolations) messages.push(`  - ${n}`);
    messages.push('Add a `## Red Flags` section to the SKILL.md body, then re-run.');
  }
  messages.push(
    ...fossilMessages(descFossils, 'skill-lint-baseline.json', 'these skills no longer violate R1/R2')
  );
  messages.push(
    ...fossilMessages(
      redFlagFossils,
      'skill-redflags-baseline.json',
      'these skills now have a `## Red Flags` section'
    )
  );

  const failed =
    !ratchet.pass ||
    !redFlagRatchet.pass ||
    descFossils.length > 0 ||
    redFlagFossils.length > 0 ||
    floorFailures.length > 0;
  return { failed, messages };
}

/** Resolve baseline paths (committed) and report path (runtime, gitignored). */
function paths(root) {
  return {
    baseline: path.join(root, 'scripts', 'ci', 'skill-lint-baseline.json'),
    redFlagsBaseline: path.join(root, 'scripts', 'ci', 'skill-redflags-baseline.json'),
    report: path.join(root, 'runtime', 'skill-lint-report.json'),
  };
}

/**
 * Read the committed baseline (array of skill names). Missing file → [].
 *
 * @param {string} file - Baseline absolute path.
 * @returns {string[]} Baseline skill names.
 */
export function readBaseline(file) {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data.skills) ? data.skills : Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Write a JSON report to runtime/ (gitignored), creating the dir if needed.
 *
 * @param {string} file - Report absolute path.
 * @param {object} payload - Report body.
 */
function writeReport(file, payload) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

/**
 * Render a compact human table of violating skills to stdout.
 *
 * @param {Array} results - lintAllSkills output.
 */
function printTable(results) {
  const rows = results.filter((r) => r.violations.length > 0);
  if (rows.length === 0) {
    console.log('| skill | — | all descriptions compliant |');
    return;
  }
  console.log('| skill | rule | severity | detail |');
  console.log('| --- | --- | --- | --- |');
  for (const r of rows) {
    for (const v of r.violations) {
      console.log(`| ${r.name} | ${v.rule} | ${v.severity} | ${v.detail} |`);
    }
  }
}

/**
 * CLI entry: lint all skills, write report, apply ratchet, exit non-zero on
 * NEW violations. `--update-baseline` rewrites the baseline to current state.
 */
function main() {
  const root = getPluginRoot();
  const { baseline: baselineFile, redFlagsBaseline: redFlagsFile, report: reportFile } = paths(root);
  const update = process.argv.includes('--update-baseline');

  const { results, perRoot } = lintEveryRoot();
  const floorFailures = assertEntityFloors('skills', perRoot);
  const current = violatingSkillNames(results);
  const baseline = readBaseline(baselineFile);
  const redFlagCurrent = redFlagViolatingSkillNames(results);
  const redFlagBaseline = readBaseline(redFlagsFile);

  const r1 = results.reduce((n, r) => n + r.violations.filter((v) => v.rule === 'R1').length, 0);
  const r2 = results.reduce((n, r) => n + r.violations.filter((v) => v.rule === 'R2').length, 0);
  const r3 = results.reduce((n, r) => n + r.violations.filter((v) => v.rule === 'R3').length, 0);
  const r4 = redFlagCurrent.length;

  printTable(results);
  console.log(
    `\nSkills: ${results.length} across ${Object.keys(perRoot).length} root(s) [` +
      Object.entries(perRoot)
        .map(([rn, n]) => `${rn}=${n}`)
        .join(' ') +
      `] · violating(error): ${current.length} · ` +
      `R1=${r1} R2=${r2} R3(warn)=${r3} R4(warn)=${r4}`
  );

  // Denominator first: if a root went unscanned, every count above is a
  // statement about the wrong population and must not be read as a pass.
  if (floorFailures.length > 0) {
    console.error(`\nFAIL: skill scan denominator (${floorFailures.length}):`);
    for (const f of floorFailures) console.error(`  - ${f}`);
  }

  if (update) {
    // Refuse to freeze a scan that did not see everything it should have.
    // Otherwise a mis-pointed scanner writes a near-empty baseline and every
    // later run "passes" against it — the ratchet destroying its own reference,
    // which is exactly how check-unused-ratchet once zeroed itself.
    if (floorFailures.length > 0) {
      console.error('\nRefusing to update baselines: the scan failed its denominator check above.');
      process.exit(1);
    }
    writeFileSync(
      baselineFile,
      JSON.stringify({ skills: current, generatedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8'
    );
    writeFileSync(
      redFlagsFile,
      JSON.stringify({ skills: redFlagCurrent, generatedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8'
    );
    console.log(
      `\nBaselines updated → ${current.length} description + ${redFlagCurrent.length} Red Flags skill(s) frozen.`
    );
    writeReport(reportFile, { results, current, baseline: current, redFlagCurrent, redFlagBaseline: redFlagCurrent });
    process.exit(0);
  }

  const ratchet = runRatchet(current, baseline);
  const redFlagRatchet = runRatchet(redFlagCurrent, redFlagBaseline);
  writeReport(reportFile, { results, current, baseline, ratchet, redFlagCurrent, redFlagBaseline, redFlagRatchet });

  const { failed, messages } = evaluateGates({ ratchet, redFlagRatchet, floorFailures });
  for (const line of messages) console.error(line);
  if (failed) process.exit(1);

  // Both fixed[] counts are structurally 0 here (shrink enforcement exits above),
  // so they are not printed — a "0 fixed" column would only look like a metric.
  console.log(
    `\nPASS: no new violations, no stale baseline entries ` +
      `(desc: ${ratchet.stillViolating.length} baselined · ` +
      `Red Flags: ${redFlagRatchet.stillViolating.length} baselined).`
  );
  process.exit(0);
}

// Run only when invoked directly (not when imported by tests).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('lint-skill-descriptions.js')
) {
  main();
}
