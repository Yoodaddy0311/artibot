#!/usr/bin/env node
/**
 * CI: Validate skills SKILL.md files.
 * Checks that each skill directory has a SKILL.md with required fields:
 *   name, description
 *
 * The checking logic lives in {@link validateSkillsDir}, a pure function over a
 * directory path, so tests can point it at a temporary fixture tree instead of
 * the live corpus. `main()` only formats and exits.
 *
 * @module scripts/ci/validate-skills
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMainEntry } from '../hooks/_main-entry.js';
import { extractFrontmatter, getPluginRoot } from './ci-utils.js';

const REQUIRED_FIELDS = ['name', 'description'];

/**
 * Locate the frontmatter body, matching `ci-utils.js#extractFrontmatter`.
 * Kept local because that module exports only the parsed fields, and a block
 * scalar's body is exactly what the parse throws away.
 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * A top-level `description:` opening a block scalar: `|`, `|-`, `|+`, `>`,
 * `>-`, `>+`, and the explicit-indent spellings (`|2`, `|2-`).
 *
 * Anchored at column 0 on purpose. `extractFrontmatter` only treats a column-0
 * `key:` as a field, so a `description:` nested under some other key is not the
 * field this gate is about and must not be judged as one.
 *
 * The trailing comment is allowed because rejecting it was fail-OPEN, not
 * strict: a header written `description: | # note` failed to match here, so this
 * returned null while `extractFrontmatter` stored the truthy value `"| # note"`
 * — an empty body then passed on both paths at once (measured 2026-09-11).
 * Whitespace before the `#` is optional for the same reason: `|#note` is not a
 * valid YAML header, and treating it as one only ever adds a visible failure,
 * never a silent pass.
 */
const BLOCK_SCALAR_DESCRIPTION = /^description:[ \t]*([|>][0-9+-]*)[ \t]*(?:#.*)?$/;

/**
 * Inspect a `description` written as a YAML block scalar.
 *
 * Why this exists: `ci-utils.js#extractFrontmatter` used to store `description: |`
 * as the literal value `"|"` (documented as intentional at its block-scalar
 * comment). That value is truthy, so a presence check alone passed a skill
 * whose description body is empty — the gate reported green on a skill that had
 * no description at all. Presence of the KEY is not presence of the VALUE.
 *
 * Kept after that parser was repaired (2026-09-11, empty body now folds to
 * `''`) rather than deleted as redundant: this is the check that names the
 * requirement, and it is a second reader of the same headers, so the two going
 * out of step becomes a visible failure instead of a silent shared blind spot.
 *
 * @param {string} content Raw SKILL.md text (CRLF tolerated).
 * @returns {{ indicator: string, empty: boolean }|null} Null when the
 *   description is absent or written inline; inline descriptions keep their
 *   existing verdict untouched.
 */
export function inspectBlockScalarDescription(content) {
  const normalized = String(content).replace(/\r\n/g, '\n');
  const matched = normalized.match(FRONTMATTER_RE);
  if (!matched) return null;

  const lines = matched[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(BLOCK_SCALAR_DESCRIPTION);
    if (!header) continue;

    let body = '';
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      // Blank lines belong to the block; they just carry no content.
      if (line.trim() === '') continue;
      // Anything back at column 0 is the next key: the block ended.
      if (!/^[ \t]/.test(line)) break;
      body += line.trim();
    }
    return { indicator: header[1], empty: body.trim() === '' };
  }
  return null;
}

/**
 * Validate every skill directory under `skillsDir`.
 *
 * @param {string} skillsDir Absolute path to a `skills/` directory.
 * @returns {{ skipped: string|null, total: number, results: Array<{ skill: string, errors: string[] }> }}
 *   `skipped` carries the reason when there is nothing to check. Each error is
 *   a complete, printable message including the offending path.
 */
export function validateSkillsDir(skillsDir) {
  if (!existsSync(skillsDir)) {
    return { skipped: 'No skills/ directory found. Skipping.', total: 0, results: [] };
  }

  const entries = readdirSync(skillsDir).filter((e) => {
    const full = path.join(skillsDir, e);
    return statSync(full).isDirectory();
  });

  if (entries.length === 0) {
    return { skipped: 'No skill directories found. Skipping.', total: 0, results: [] };
  }

  const results = entries.map((dir) => ({ skill: dir, errors: validateSkill(skillsDir, dir) }));
  return { skipped: null, total: entries.length, results };
}

/**
 * Validate one skill directory.
 *
 * @param {string} skillsDir Absolute path to the `skills/` directory.
 * @param {string} dir Skill directory name.
 * @returns {string[]} Printable error messages, empty when the skill is valid.
 */
function validateSkill(skillsDir, dir) {
  const skillPath = path.join(skillsDir, dir, 'SKILL.md');

  if (!existsSync(skillPath)) {
    return [`skills/${dir}/ - Missing SKILL.md`];
  }

  const content = readFileSync(skillPath, 'utf-8');
  const frontmatter = extractFrontmatter(content);

  if (!frontmatter) {
    return [`skills/${dir}/SKILL.md - Missing YAML frontmatter`];
  }

  const errors = [];

  // Determined before the presence loop so the specific diagnostic can
  // supersede the generic one. Until 2026-09-11 these could not collide:
  // `extractFrontmatter` stored the block header, so `description` was the
  // truthy `"|"` and only this check fired. The parser now folds an empty body
  // to `''`, which the presence check rejects too — and reporting both would
  // name a single defect twice while handing the author the wrong repair, since
  // "Missing required field" is false for a key that is present but empty.
  const blockScalar = inspectBlockScalarDescription(content);
  const emptyBlockDescription = Boolean(blockScalar?.empty);

  for (const field of REQUIRED_FIELDS) {
    if (field === 'description' && emptyBlockDescription) continue;
    if (!frontmatter[field]) {
      errors.push(`skills/${dir}/SKILL.md - Missing required field: ${field}`);
    }
  }

  if (emptyBlockDescription) {
    errors.push(`skills/${dir}/SKILL.md - Empty block scalar description`);
  }

  return errors;
}

function main() {
  const outcome = validateSkillsDir(path.join(getPluginRoot(), 'skills'));

  if (outcome.skipped) {
    console.log(outcome.skipped);
    process.exit(0);
  }

  let errors = 0;
  for (const { skill, errors: skillErrors } of outcome.results) {
    for (const message of skillErrors) {
      console.error(`FAIL: ${message}`);
      errors += 1;
    }
    if (skillErrors.length === 0) console.log(`PASS: skills/${skill}/`);
  }

  if (errors > 0) {
    console.error(`\n${errors} validation error(s) found.`);
    process.exit(1);
  }

  console.log(`\nAll ${outcome.total} skill(s) validated successfully.`);
}

// Run only when invoked directly (not when imported by tests).
if (isMainEntry(import.meta.url)) {
  main();
}
