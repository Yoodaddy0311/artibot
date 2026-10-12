/**
 * `scripts/validate-agent-frontmatter.js` reads a block-list item such as
 * `  - api-design  # core` the way YAML does: the trailing comment is not part of the
 * value (`lib/core/agent-registry.js#stripTrailingComment` is the shared rule).
 *
 * The script runs `main()` the moment it is loaded and ends the process, and it reads
 * `agents/` next to its own `scripts/` directory, so it cannot be imported or pointed at a
 * fixture. These cases therefore run a COPY of it, inside a throwaway plugin root that
 * holds fixture agents, as a real child process, and read the table it prints.
 *
 * What the verdict shows: the validator never prints an item's text, only whether the
 * frontmatter is valid. A comment that stays in the value used to flip a verdict - `- ""  # none`
 * read as the non-empty text `"  # none` and passed as valid - so the cases below are written
 * as verdict flips. What this file does not see: `tools` entries are not validated at all, so a
 * comment left in a tool name is invisible here (the registry tests cover that side).
 *
 * @module tests/scripts/validate-agent-frontmatter
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The script and the part of lib/core it loads. If the script gains an import, add the file
 * here: the child process then fails with "Cannot find module", not with a wrong verdict.
 */
const COPIED_FILES = [
  'scripts/validate-agent-frontmatter.js',
  'lib/core/agent-frontmatter-schema.js',
  'lib/core/agent-registry.js',
  'lib/core/platform.js',
];

/** name -> the capabilities/tools lines after the fixed `name`/`description`/`lifecycle` lines. */
const FIXTURES = {
  'comments-after-values': [
    'capabilities:',
    '  - api-design  # core',
    '  - "testing"  # quoted',
    "  - 'review'\t# tab, single quotes",
    'tools:',
    '  - Read  # why',
  ],
  'hash-is-data': [
    'capabilities:',
    '  - " # kept"',
    '  - "#kept"',
    '  - \'it\'\'s # kept\'  # real comment',
  ],
  'empty-string-then-comment': ['capabilities:', '  - ""  # none'],
  'comment-only-item': ['capabilities:', '  - # nothing here yet'],
  'bare-dash': ['capabilities:', '  - api-design', '  -'],
  'no-comments': ['capabilities:', '  - api-design', '  - testing'],
};

let sandbox;
/** @type {Map<string, { lifecycle: string, valid: string, errors: string }>} */
let rows;
let stdout;

function parseRows(text) {
  const parsed = new Map();
  for (const line of text.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Agent ') || line.startsWith('| --- ')) continue;
    const [file, lifecycle, valid, ...errors] = line.slice(2, -2).split(' | ');
    parsed.set(file, { lifecycle, valid, errors: errors.join(' | ') });
  }
  return parsed;
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'artibot-validate-agents-'));
  writeFileSync(path.join(sandbox, 'package.json'), '{"type":"module"}\n', 'utf-8');
  for (const rel of COPIED_FILES) {
    mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
    copyFileSync(path.join(PLUGIN_ROOT, rel), path.join(sandbox, rel));
  }
  mkdirSync(path.join(sandbox, 'agents'), { recursive: true });
  for (const [name, lines] of Object.entries(FIXTURES)) {
    const frontmatter = [`name: ${name}`, 'description: fixture agent', 'lifecycle: build', ...lines];
    writeFileSync(
      path.join(sandbox, 'agents', `${name}.md`),
      `---\n${frontmatter.join('\n')}\n---\nbody\n`,
      'utf-8',
    );
  }
  stdout = execFileSync(
    process.execPath,
    [path.join(sandbox, 'scripts', 'validate-agent-frontmatter.js')],
    { encoding: 'utf-8' },
  );
  rows = parseRows(stdout);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('validate-agent-frontmatter block-list trailing comments', () => {
  // Without this the verdict cases below could all pass against an empty table.
  it('reads every fixture agent', () => {
    expect([...rows.keys()].sort()).toEqual(Object.keys(FIXTURES).map((name) => `${name}.md`).sort());
    expect(stdout).toContain(`Total: ${Object.keys(FIXTURES).length} |`);
  });

  it.each(['comments-after-values', 'hash-is-data', 'no-comments'])('passes %s', (name) => {
    expect(rows.get(`${name}.md`)).toMatchObject({ valid: 'yes', errors: '-' });
  });

  it.each([
    { name: 'empty-string-then-comment', what: 'an empty quoted string followed by a comment' },
    { name: 'comment-only-item', what: 'an item that is only a comment' },
  ])('rejects $what as an empty capability', ({ name }) => {
    expect(rows.get(`${name}.md`)).toMatchObject({
      valid: 'no',
      errors: 'capabilities: all entries must be non-empty strings',
    });
  });

  // The established reading of a null list item, which a comment-only item now shares.
  it('rejects a bare dash the same way', () => {
    expect(rows.get('bare-dash.md')).toMatchObject({
      valid: 'no',
      errors: 'capabilities: all entries must be non-empty strings',
    });
  });
});
