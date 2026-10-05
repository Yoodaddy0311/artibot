/**
 * Every shipped output style keeps the host coding instructions.
 *
 * Claude Code defaults `keep-coding-instructions` to false for custom output
 * styles, which drops the host's software-engineering guidance. The styles in
 * `output-styles/` only change how replies look, so each must say `true`.
 * Allowlist, not denylist: EVERY `.md` in the directory is required to carry the
 * flag unless its name is listed in NON_CODING_STYLES with a reason. A file with
 * no `name:` key is still checked (the host names a style after its file name),
 * and a file whose frontmatter cannot be parsed (none, BOM, unterminated) fails
 * closed rather than being skipped.
 *
 * Not covered: whether the host loads this directory (or sub-directories) as
 * selectable styles, and what it does with the flag (documented behavior, not
 * measured). Only top-level `*.md` files are enumerated.
 *
 * @module tests/output-styles/keep-coding-instructions
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'output-styles');
const KEY = 'keep-coding-instructions';

/** style name -> reason it is deliberately NOT keeping coding instructions. */
const NON_CODING_STYLES = Object.freeze({});

/** Split a style file into frontmatter lines and body; null when no frontmatter. */
export function splitStyle(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 1) return null;
  return { front: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

function listStyles(dir = DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, parts: splitStyle(readFileSync(join(dir, f), 'utf8')) }));
}

describe('output-styles keep-coding-instructions', () => {
  it('splitStyle reads CRLF and LF frontmatter (self-check)', () => {
    expect(splitStyle('---\r\nname: a\r\n---\r\nbody')).toEqual({ front: ['name: a'], body: 'body' });
    expect(splitStyle('---\nname: a\n---\nbody')).toEqual({ front: ['name: a'], body: 'body' });
    expect(splitStyle('no frontmatter')).toBeNull();
    expect(splitStyle('\uFEFF---\nname: a\n---\nbody')).toBeNull();
    expect(splitStyle('---\nname: a\nbody')).toBeNull();
  });

  it('enumerates the shipped styles (not vacuous)', () => {
    const styles = listStyles();
    expect(styles.length, `enumerated ${styles.length} styles in ${DIR}`).toBeGreaterThan(0);
  });

  it('every style has exactly one `keep-coding-instructions: true` in frontmatter and none in the body', () => {
    const styles = listStyles();
    expect(styles.length, `enumerated ${styles.length} styles`).toBeGreaterThan(0);
    for (const { file, parts } of styles) {
      expect(parts, `${file}: no parsable frontmatter (the host still loads it as a style under its file name)`).not.toBeNull();
      const nameLine = parts.front.find((l) => l.startsWith('name:'));
      const name = nameLine ? nameLine.slice(5).trim() : file.slice(0, -3);
      if (Object.hasOwn(NON_CODING_STYLES, name)) {
        expect(NON_CODING_STYLES[name], `${file}: exception needs a reason`).not.toBe('');
        continue;
      }
      expect(parts.front.filter((l) => l === `${KEY}: true`), `${file} (of ${styles.length})`).toHaveLength(1);
      // A conflicting second key would still leave one exact `true` line.
      expect(parts.front.filter((l) => l.startsWith(KEY)), `${file}: key count`).toHaveLength(1);
      expect(parts.body, `${file}: flag must not appear in body`).not.toContain(KEY);
    }
  });
});
