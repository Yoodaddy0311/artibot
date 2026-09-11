/**
 * Gate: no SKILL.md / agent / command frontmatter declares a required key with
 * an empty quoted value (`key: ""` or `key: ''`).
 *
 * Why this exists: `scripts/ci/ci-utils.js#extractFrontmatter` stored inline
 * values as raw text, so `description: ""` parsed to the two-character truthy
 * string `'""'`. Every validator built on it checks presence with
 * `!frontmatter[field]`, so a file with a key present and no value at all read
 * as green: measured 2026-09-11, a probe skill/agent/command spelled `""` came
 * back PASS from `validate-skills.js`, `validate-agents.js` and
 * `validate-commands.js` alike (exit 0 on all three), and the same for `''`.
 * Only the bare `description:` with no value failed. The parser now folds those
 * two spellings to `''`, which the same presence checks reject.
 *
 * The live corpus has zero occurrences (measured 2026-09-11: 0 across 114
 * artibot + 46 cowork SKILL.md, 30 + 12 cowork agent .md, 79 + 21 command
 * .md), so this
 * gate is preventive, not a cleanup. That is the point: the defect class was
 * invisible, not absent.
 *
 * Deliberately NOT built on `extractFrontmatter`: after the repair that parser
 * returns `''` for both spellings, so the object it hands back can no longer
 * distinguish "key absent" from "key present but empty" — it cannot see the
 * spelling this gate is about. The scan below reads the raw frontmatter lines,
 * making it a second independent reader of the same headers (the same
 * two-readers argument recorded at `scripts/ci/validate-skills.js:55-58`).
 *
 * What this gate does NOT see:
 *
 * - How the HOST treats an empty description in agents/commands frontmatter.
 *   Only plugin SKILLS were measured against a live host; plugin agents were
 *   never loaded in that experiment. This gate is a repo-side fail-closed
 *   check, not proof of any host behaviour.
 * - Values that are semantically empty but not spelled as empty quotes:
 *   whitespace inside quotes (`" "`), a comment inside quotes, and placeholder
 *   text such as `description: TODO` or `description: -`. This gate covers the
 *   two empty-quote spellings only. (An empty folded scalar, `description: >`
 *   with no body, is a separate case already caught upstream — the parser folds
 *   an empty body to `''`.)
 * - Behaviour of user and project skills (`~/.claude/skills`,
 *   `.claude/skills`). Only plugin skills were measured. Note that the
 *   "description omitted falls back to the body's first paragraph" claim in
 *   `docs/investigations/skill-description-render-20260910.md` section 5
 *   CONFLICTS with the plugin-skill measurement (a no-description skill's body
 *   tokens rendered 0 times); the fallback was not observed.
 * - Anything outside the first `---`…`---` block, nested keys, and semantic
 *   conflicts between DIFFERENT keys — the same blind spots recorded in
 *   `tests/ci/frontmatter-duplicate-keys.test.js`.
 * - Evidence grade of the related `triggers:` verdict (see
 *   `schemas/skill.schema.json`): host render count 0 is MEASURED; "the
 *   binary's recognised-key array is the complete set of recognised keys" is
 *   INFERENCE; the official documentation was not read.
 *
 * @module tests/ci/frontmatter-empty-values
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertEntityFloors,
  countByRoot,
  listAllSkillFiles,
  listEntityRoots,
  qualify,
} from '../../scripts/ci/skill-scan-roots.js';

/** Documentation files that live beside entities but are not entities. */
const NON_ENTITY_FILES = new Set(['INDEX.md', 'README.md']);

/**
 * Keys whose emptiness is a defect: the union of `REQUIRED_FIELDS` across
 * `validate-skills.js` (name, description), `validate-agents.js` (name,
 * description, model) and `validate-commands.js` (description, argument-hint).
 */
const REQUIRED_KEYS = ['description', 'name', 'model', 'argument-hint'];

/**
 * A required key at column 0 whose entire value is an empty quote pair.
 *
 * `[ \t]*` rather than `\s*` to name the whitespace class explicitly. The input
 * is already split into single lines, so the two are equivalent here; the
 * narrower class just states the intent.
 */
const EMPTY_QUOTED_VALUE = new RegExp(`^(${REQUIRED_KEYS.join('|')}):[ \\t]*(""|'')[ \\t]*$`);

/**
 * Find required frontmatter keys declared with an empty quoted value.
 *
 * Uses the same column-0 `^(\w[\w-]*):` shape as
 * `ci-utils.js#extractFrontmatter`, so a line this reports is a line that
 * parser reads as a key. Line numbers are absolute within the file (the opening
 * `---` is line 1).
 *
 * @param {string} content - Raw Markdown file content (CRLF tolerated).
 * @returns {Array<{key: string, line: number, spelling: string}>} One entry per offending line.
 */
export function findEmptyQuotedFrontmatterValues(content) {
  const normalized = String(content).replace(/\r\n/g, '\n');
  const matched = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!matched) return [];

  const found = [];
  const lines = matched[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const hit = lines[i].match(EMPTY_QUOTED_VALUE);
    if (!hit) continue;
    // +2: the frontmatter body starts on the line after the opening `---`,
    // and file lines are 1-based.
    found.push({ key: hit[1], line: i + 2, spelling: hit[2] });
  }
  return found;
}

/**
 * Enumerate every entity file the gate covers, across all plugin roots.
 *
 * @param {'skills'|'agents'|'commands'} kind - Entity directory name.
 * @returns {Array<{rootName: string, key: string, file: string}>} Entity files.
 */
function listEntityFiles(kind) {
  if (kind === 'skills') {
    return listAllSkillFiles().map(({ rootName, key, file }) => ({ rootName, key, file }));
  }
  const out = [];
  for (const { name: rootName, dir } of listEntityRoots(kind)) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.md') || NON_ENTITY_FILES.has(entry)) continue;
      out.push({
        rootName,
        key: qualify(rootName, entry),
        file: path.join(dir, entry),
      });
    }
  }
  return out;
}

describe('frontmatter empty-value scanner (self-verification)', () => {
  let tmpRoot = null;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  /**
   * Write a fixture file and return its content.
   *
   * @param {string} body - File content to write.
   * @returns {string} The same content, read back from disk.
   */
  function fixture(body) {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'fm-empty-'));
    const file = path.join(tmpRoot, 'SKILL.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf-8');
    return readFileSync(file, 'utf-8');
  }

  // --- red fixtures: the scanner must report these ---

  it('reports an empty double-quoted description with its line number', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\nname: demo\ndescription: ""\n---\n\nbody\n'),
    );
    expect(found).toEqual([{ key: 'description', line: 3, spelling: '""' }]);
  });

  it('reports an empty single-quoted description', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture("---\nname: demo\ndescription: ''\n---\n\nbody\n"),
    );
    expect(found).toEqual([{ key: 'description', line: 3, spelling: "''" }]);
  });

  it('reports every required key, not just description', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\nname: ""\ndescription: \'\'\nmodel: ""\nargument-hint: ""\n---\n'),
    );
    expect(found.map((f) => f.key)).toEqual(['name', 'description', 'model', 'argument-hint']);
    expect(found.map((f) => f.line)).toEqual([2, 3, 4, 5]);
  });

  it('reports an empty quoted value in a CRLF file', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\r\nname: demo\r\ndescription: ""\r\n---\r\n'),
    );
    expect(found).toEqual([{ key: 'description', line: 3, spelling: '""' }]);
  });

  it('reports an empty value followed by trailing whitespace', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\nname: demo\ndescription: ""  \n---\n'),
    );
    expect(found).toEqual([{ key: 'description', line: 3, spelling: '""' }]);
  });

  // --- green fixtures: the scanner must stay silent ---

  it('reports nothing for a normally populated frontmatter', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\nname: demo\ndescription: Does a thing.\nmodel: opus\n---\n\nbody\n'),
    );
    expect(found).toEqual([]);
  });

  it('reports nothing for a quoted value that has content', () => {
    // Includes the boundary case the parser deliberately leaves verbatim: a
    // quoted single space is NOT an empty spelling.
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\nname: "demo"\ndescription: " "\nmodel: "opus"\n---\n'),
    );
    expect(found).toEqual([]);
  });

  it('does not count indented keys or block-scalar body lines', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture(
        '---\nname: demo\ndescription: |\n  description: ""\n  name: \'\'\nmeta:\n  model: ""\n---\n',
      ),
    );
    expect(found).toEqual([]);
  });

  it('does not count an empty quoted value that appears only in the body', () => {
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\nname: demo\ndescription: real\n---\n\ndescription: ""\n'),
    );
    expect(found).toEqual([]);
  });

  it('does not count a non-required key left empty', () => {
    // The gate names the keys the validators require. Widening it to every key
    // would turn an unrelated authoring choice into a CI failure.
    const found = findEmptyQuotedFrontmatterValues(
      fixture('---\nname: demo\ndescription: real\ntokens: ""\n---\n'),
    );
    expect(found).toEqual([]);
  });

  it('reports nothing for a file with no frontmatter at all', () => {
    expect(findEmptyQuotedFrontmatterValues(fixture('# Title\n\ndescription: ""\n'))).toEqual([]);
  });
});

describe('live corpus has no empty quoted frontmatter values', () => {
  for (const kind of ['skills', 'agents', 'commands']) {
    it(`finds no empty required value in any ${kind} frontmatter`, () => {
      const files = listEntityFiles(kind);
      // Fail-closed: an empty or short scan must not read as a pass.
      expect(assertEntityFloors(kind, countByRoot(files))).toEqual([]);

      const offenders = [];
      for (const { key, file } of files) {
        for (const hit of findEmptyQuotedFrontmatterValues(readFileSync(file, 'utf-8'))) {
          offenders.push(`${key}: '${hit.key}' is empty (${hit.spelling}) at line ${hit.line}`);
        }
      }
      expect(offenders, `empty required frontmatter values in ${files.length} ${kind} file(s)`).toEqual([]);
    });
  }
});
