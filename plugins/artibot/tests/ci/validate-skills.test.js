/**
 * Regression pins for `scripts/ci/validate-skills.js`.
 *
 * WHY THIS FILE EXISTS. The skills gate used to answer "is there a description?"
 * with a truthiness test on the parsed frontmatter. That question is not the one
 * it means to ask, because `ci-utils.js#extractFrontmatter` used to store a
 * block scalar header (`description: |`) as the literal string `"|"` — a
 * documented, deliberate simplification of that parser. So a SKILL.md carrying
 *
 *     description: |
 *
 * and nothing after it parsed to `{ description: '|' }`, which is truthy, and
 * the gate printed PASS. Presence of the KEY is not presence of the VALUE.
 *
 * That parser was repaired on 2026-09-11: it now folds a block scalar's body
 * into the value and yields `''` for an empty body, so the truthiness test
 * would catch this case on its own today. The checks pinned below are kept
 * anyway — they are what states the requirement, and re-deriving it from the
 * parser's current behaviour is how the hole reopens the next time that
 * simplification looks harmless.
 *
 * Nothing in the live corpus was broken this way when the hole was found
 * (measured 2026-09-11: 0 skills with an empty block scalar). That is precisely
 * why it needed closing on purpose rather than after an incident: a gate that
 * cannot see an empty description is a gate whose green means less than every
 * reader assumes, and the pre-push hook runs it as a blocking step
 * (`scripts/git-hooks/pre-push`, `run_gate skills`).
 *
 * Both directions are pinned. The red half (an empty block scalar FAILS) proves
 * the detector can fire at all; the green half (a block scalar with a body, an
 * inline description, a description containing a literal `|`) proves it did not
 * buy that by failing everything. A detector that cannot show a red proves
 * nothing when it is green — and one with no green half is just an outage.
 *
 * WHAT THIS FILE DOES NOT COVER, so a green here is not read as more than it is:
 *   - Description QUALITY. Whether a non-empty description is a good trigger
 *     surface is `scripts/ci/lint-skill-descriptions.js` and its own test; this
 *     gate only asks whether one exists.
 *   - Other frontmatter fields. `name` keeps the plain truthiness check, so a
 *     `name: |` with an empty body still passes. Left alone deliberately: `name`
 *     is never written as a block scalar in the corpus, and widening the fix
 *     beyond the measured defect is scope this task did not have.
 *   - YAML in general. The block-scalar reader here is a line scanner, not a
 *     parser. Flow scalars, anchors and multi-document files are out of scope,
 *     matching the parser it sits next to.
 *   - Non-breaking space as content. A body consisting only of U+00A0 is judged
 *     EMPTY here, because the reader uses JS `trim()`, which strips it. YAML
 *     would call that a one-character description. The two disagree; nothing in
 *     the corpus sits in the gap (0 skills, measured 2026-09-11), and the
 *     disagreement errs toward reporting a failure rather than hiding one.
 *
 * @module tests/ci/validate-skills
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  inspectBlockScalarDescription,
  validateSkillsDir,
} from '../../scripts/ci/validate-skills.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const LIVE_SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

/** The message that must distinguish "no description" from "empty description". */
const EMPTY_BLOCK_MESSAGE = 'Empty block scalar description';
const MISSING_FIELD_MESSAGE = 'Missing required field: description';

let sandbox;

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-validate-skills-'));
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

let counter = 0;

/**
 * Build a throwaway `skills/` tree and validate it.
 *
 * Every case gets its own directory so no test can depend on another's leftovers
 * or on ordering.
 *
 * @param {Record<string, string|null>} skills Skill name -> SKILL.md contents,
 *   or null to create the directory without a SKILL.md.
 * @param {{ crlf?: boolean }} [opts] Write the fixture with CRLF line endings.
 * @returns {ReturnType<typeof validateSkillsDir>}
 */
function validateFixture(skills, { crlf = false } = {}) {
  counter += 1;
  const skillsDir = path.join(sandbox, `case-${counter}`, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  for (const [name, content] of Object.entries(skills)) {
    mkdirSync(path.join(skillsDir, name), { recursive: true });
    if (content === null) continue;
    const body = crlf ? content.replace(/\n/g, '\r\n') : content;
    writeFileSync(path.join(skillsDir, name, 'SKILL.md'), body, 'utf8');
  }

  return validateSkillsDir(skillsDir);
}

/**
 * Errors reported for one skill in a fixture result.
 *
 * @param {ReturnType<typeof validateSkillsDir>} outcome
 * @param {string} skill
 * @returns {string[]}
 */
function errorsFor(outcome, skill) {
  const found = outcome.results.find((r) => r.skill === skill);
  if (!found) throw new Error(`fixture did not report on skill ${skill}`);
  return found.errors;
}

const INLINE = ['---', 'name: inline', 'description: Does a thing when asked.', '---', '', 'Body.', ''].join('\n');

const EMPTY_BLOCK = ['---', 'name: empty-block', 'description: |', '---', '', 'Body.', ''].join('\n');

const FILLED_BLOCK = [
  '---',
  'name: filled-block',
  'description: |',
  '  Use when the caller asks to do a thing.',
  '',
  '  Also fires on the second paragraph.',
  '---',
  '',
  'Body.',
  '',
].join('\n');

describe('empty block scalar descriptions', () => {
  it('fails a description written as an empty block scalar', () => {
    const outcome = validateFixture({ 'empty-block': EMPTY_BLOCK });
    const errors = errorsFor(outcome, 'empty-block');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(EMPTY_BLOCK_MESSAGE);
    expect(errors[0]).toContain('skills/empty-block/SKILL.md');
  });

  it('distinguishes an empty description from a missing one', () => {
    // Two different defects with two different repairs: one author has to write
    // a description, the other has to notice the body they thought they wrote is
    // not there. One shared message would hide the second case inside the first.
    const empty = errorsFor(validateFixture({ s: EMPTY_BLOCK }), 's');
    const missing = errorsFor(
      validateFixture({ s: ['---', 'name: s', '---', '', 'Body.', ''].join('\n') }),
      's',
    );

    expect(empty[0]).toContain(EMPTY_BLOCK_MESSAGE);
    expect(empty[0]).not.toContain(MISSING_FIELD_MESSAGE);
    expect(missing[0]).toContain(MISSING_FIELD_MESSAGE);
    expect(missing[0]).not.toContain(EMPTY_BLOCK_MESSAGE);
  });

  it('fails every chomping and folding spelling of an empty block', () => {
    // `|` is not the only header. A fix that pinned the one spelling would be a
    // deny-list of one, fail-open against the other five the moment an author
    // reached for `>-`.
    for (const indicator of ['|', '|-', '|+', '>', '>-', '>+', '|2']) {
      const content = ['---', 'name: s', `description: ${indicator}`, '---', '', 'Body.', ''].join('\n');
      const errors = errorsFor(validateFixture({ s: content }), 's');
      expect(errors.map((e) => e.replace(/^.*? - /, '')), `indicator ${indicator}`).toEqual([
        EMPTY_BLOCK_MESSAGE,
      ]);
    }
  });

  it('fails an empty block whose header carries a trailing comment', () => {
    // The comment used to make the header unrecognisable here while
    // `extractFrontmatter` still stored the truthy `"| # ..."`, so the skill
    // passed both checks with no description at all — the exact fail-open this
    // file exists to close, wearing one extra token. Since the 2026-09-11
    // parser repair both paths recognise this header and fold it to `''`; the
    // pin stays because agreement between the two is the property at stake.
    const content = [
      '---',
      'name: s',
      'description: | # TODO: write this',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    const errors = errorsFor(validateFixture({ s: content }), 's');
    expect(errors.map((e) => e.replace(/^.*? - /, ''))).toEqual([EMPTY_BLOCK_MESSAGE]);
  });

  it('fails a block whose only body line is whitespace', () => {
    const content = ['---', 'name: s', 'description: |', '   ', '', '---', '', 'Body.', ''].join('\n');
    expect(errorsFor(validateFixture({ s: content }), 's')[0]).toContain(EMPTY_BLOCK_MESSAGE);
  });

  it('fails a block terminated by the next key, not by the frontmatter fence', () => {
    // The body ends at column 0. Without that rule the following key would be
    // read as the description body and the empty block would pass.
    const content = [
      '---',
      'name: s',
      'description: |',
      'allowed-tools: Read, Bash',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    expect(errorsFor(validateFixture({ s: content }), 's')[0]).toContain(EMPTY_BLOCK_MESSAGE);
  });
});

describe('descriptions that must keep passing', () => {
  it('passes a block scalar with a body, including an embedded blank line', () => {
    // The blank line is the point: a body reader that stopped at the first blank
    // line would still pass this, but one that treated a blank line as the end
    // of the block would fail a real corpus shape.
    expect(errorsFor(validateFixture({ 'filled-block': FILLED_BLOCK }), 'filled-block')).toEqual([]);
  });

  it('passes an ordinary inline description', () => {
    expect(errorsFor(validateFixture({ inline: INLINE }), 'inline')).toEqual([]);
  });

  it('passes an inline description that merely contains a pipe character', () => {
    // Negative control for the header regex: `|` inside the value is not a block
    // scalar header, and a looser pattern would fail a legitimate skill.
    const content = [
      '---',
      'name: s',
      'description: Use for A | B | C routing decisions.',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    expect(errorsFor(validateFixture({ s: content }), 's')).toEqual([]);
  });

  it('passes a commented header whose block does have a body', () => {
    // The green half of the comment fix. Widening the header pattern must not
    // buy its red by failing a real skill that annotates its own frontmatter.
    const content = [
      '---',
      'name: s',
      'description: |  # keep in sync with the catalog',
      '  Use when the caller asks to do a thing.',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    expect(errorsFor(validateFixture({ s: content }), 's')).toEqual([]);
  });

  it('ignores a nested description under another key', () => {
    // Only the column-0 `description:` is the field `extractFrontmatter` sees,
    // so only that one is judged here. Judging a nested one would invent a
    // failure the gate has no basis to report.
    const content = [
      '---',
      'name: s',
      'description: Real description lives here.',
      'metadata:',
      '  description: |',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
    expect(errorsFor(validateFixture({ s: content }), 's')).toEqual([]);
  });
});

describe('CRLF files behave identically', () => {
  it('fails an empty block scalar written with CRLF line endings', () => {
    const errors = errorsFor(validateFixture({ s: EMPTY_BLOCK }, { crlf: true }), 's');
    expect(errors[0]).toContain(EMPTY_BLOCK_MESSAGE);
  });

  it('passes a filled block scalar written with CRLF line endings', () => {
    expect(errorsFor(validateFixture({ s: FILLED_BLOCK }, { crlf: true }), 's')).toEqual([]);
  });

  it('passes an inline description written with CRLF line endings', () => {
    expect(errorsFor(validateFixture({ s: INLINE }, { crlf: true }), 's')).toEqual([]);
  });
});

describe('pre-existing verdicts are unchanged', () => {
  it('still reports a missing SKILL.md', () => {
    expect(errorsFor(validateFixture({ hollow: null }), 'hollow')).toEqual([
      'skills/hollow/ - Missing SKILL.md',
    ]);
  });

  it('still reports missing frontmatter', () => {
    expect(errorsFor(validateFixture({ s: '# Just a heading\n' }), 's')).toEqual([
      'skills/s/SKILL.md - Missing YAML frontmatter',
    ]);
  });

  it('still reports a missing name field', () => {
    const content = ['---', 'description: Does a thing.', '---', '', 'Body.', ''].join('\n');
    expect(errorsFor(validateFixture({ s: content }), 's')).toEqual([
      'skills/s/SKILL.md - Missing required field: name',
    ]);
  });

  it('skips a directory that does not exist', () => {
    const outcome = validateSkillsDir(path.join(sandbox, 'absent', 'skills'));
    expect(outcome.skipped).toBe('No skills/ directory found. Skipping.');
    expect(outcome.total).toBe(0);
  });

  it('skips a skills directory with no skill directories', () => {
    const outcome = validateFixture({});
    expect(outcome.skipped).toBe('No skill directories found. Skipping.');
    expect(outcome.total).toBe(0);
  });
});

describe('detector self-check', () => {
  it('reads the block header only when it opens a block', () => {
    expect(inspectBlockScalarDescription(EMPTY_BLOCK)).toEqual({ indicator: '|', empty: true });
    expect(inspectBlockScalarDescription(FILLED_BLOCK)).toEqual({ indicator: '|', empty: false });
    expect(inspectBlockScalarDescription(INLINE)).toBeNull();
    expect(inspectBlockScalarDescription('no frontmatter at all\n')).toBeNull();
  });
});

describe('the live corpus', () => {
  it('validates clean, so this fix cannot be landing a red gate', () => {
    // The half that makes the rest safe to believe. Every assertion above runs
    // against fixtures; this one runs against the tree the pre-push hook checks.
    const outcome = validateSkillsDir(LIVE_SKILLS_DIR);
    const offenders = outcome.results.filter((r) => r.errors.length > 0);

    expect(offenders.flatMap((r) => r.errors)).toEqual([]);
    // Floor, not an exact count: 114 skills measured 2026-09-11, and pinning the
    // exact number would turn adding a skill into a failure here for no
    // detection gain. A collapse to a handful would still be caught.
    expect(outcome.total).toBeGreaterThan(100);
  });
});
