/**
 * Gate: no SKILL.md / agent / command frontmatter declares the same top-level
 * key twice.
 *
 * Why this exists: `scripts/ci/ci-utils.js#extractFrontmatter` parses line by
 * line into a plain object, so a repeated key silently keeps the LAST value and
 * discards the first. Every validator built on it therefore reports green on a
 * file whose frontmatter contradicts itself. Two skills carried a duplicated
 * `platforms:` that way (measured 2026-09-11: `git-unified` lines 9/91 and
 * `lang-reference` lines 9/209, identical values, so the damage was latent
 * rather than live). The fix is two deleted lines; this gate is what stops the
 * third one.
 *
 * Deliberately NOT built on `extractFrontmatter`: that parser is exactly the
 * component that cannot see the defect (last value wins, so the object it
 * returns looks clean). The scan below reads the raw frontmatter lines.
 *
 * What this gate does NOT see: duplicates below the first `---`…`---` block,
 * keys that differ only in indentation (an indented `key:` is a nested field,
 * not a top-level one, and is not counted), and semantic conflicts between
 * DIFFERENT keys. It also says nothing about which value a host would honour —
 * the corpus has no duplicate with differing values to measure that against.
 *
 * @module tests/ci/frontmatter-duplicate-keys
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
 * Find top-level frontmatter keys declared more than once.
 *
 * Uses the same column-0 `^(\w[\w-]*):` shape as
 * `ci-utils.js#extractFrontmatter`, so a key this reports is a key that parser
 * would have overwritten. Line numbers are absolute within the file (the
 * opening `---` is line 1).
 *
 * @param {string} content - Raw Markdown file content (CRLF tolerated).
 * @returns {Array<{key: string, lines: number[]}>} One entry per repeated key.
 */
export function findDuplicateFrontmatterKeys(content) {
  const normalized = String(content).replace(/\r\n/g, '\n');
  const matched = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!matched) return [];

  const seen = new Map();
  const lines = matched[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const kv = lines[i].match(/^(\w[\w-]*):/);
    if (!kv) continue;
    // +2: the frontmatter body starts on the line after the opening `---`,
    // and file lines are 1-based.
    const at = seen.get(kv[1]) || [];
    at.push(i + 2);
    seen.set(kv[1], at);
  }

  return [...seen.entries()]
    .filter(([, at]) => at.length > 1)
    .map(([key, at]) => ({ key, lines: at }));
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

describe('frontmatter duplicate-key scanner (self-verification)', () => {
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
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'fm-dupe-'));
    const file = path.join(tmpRoot, 'SKILL.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf-8');
    return readFileSync(file, 'utf-8');
  }

  it('reports the key and both line numbers when a key is planted twice', () => {
    const found = findDuplicateFrontmatterKeys(
      fixture('---\nname: demo\nplatforms: [a]\ndescription: d\nplatforms: [a]\n---\n\nbody\n'),
    );
    expect(found).toEqual([{ key: 'platforms', lines: [3, 5] }]);
  });

  it('reports every repeated key, not just the first', () => {
    const found = findDuplicateFrontmatterKeys(
      fixture('---\nname: a\nname: b\nmodel: x\nmodel: y\nmodel: z\n---\n'),
    );
    expect(found.map((d) => d.key).sort()).toEqual(['model', 'name']);
    expect(found.find((d) => d.key === 'name').lines).toEqual([2, 3]);
    expect(found.find((d) => d.key === 'model').lines).toEqual([4, 5, 6]);
  });

  it('reports nothing for a clean frontmatter', () => {
    const found = findDuplicateFrontmatterKeys(
      fixture('---\nname: demo\ndescription: d\nplatforms: [a]\n---\n\nbody\n'),
    );
    expect(found).toEqual([]);
  });

  it('does not count indented keys, list items, or block-scalar body lines', () => {
    const found = findDuplicateFrontmatterKeys(
      fixture(
        '---\nname: demo\ndescription: |\n  name: not a key\n  name: still not a key\nmeta:\n  name: nested\n  name: nested again\nallowed:\n  - name: one\n  - name: two\n---\n',
      ),
    );
    expect(found).toEqual([]);
  });

  it('does not count a repeated key that appears only in the body', () => {
    const found = findDuplicateFrontmatterKeys(
      fixture('---\nname: demo\n---\n\nplatforms: [a]\n\nplatforms: [a]\n'),
    );
    expect(found).toEqual([]);
  });

  it('detects duplicates in CRLF files', () => {
    const found = findDuplicateFrontmatterKeys(
      fixture('---\r\nname: demo\r\nplatforms: [a]\r\nplatforms: [a]\r\n---\r\n'),
    );
    expect(found).toEqual([{ key: 'platforms', lines: [3, 4] }]);
  });

  it('reports nothing for a file with no frontmatter at all', () => {
    expect(findDuplicateFrontmatterKeys(fixture('# Title\n\nplatforms: [a]\n'))).toEqual([]);
  });
});

describe('live corpus has no duplicate frontmatter keys', () => {
  for (const kind of ['skills', 'agents', 'commands']) {
    it(`finds no duplicate top-level key in any ${kind} frontmatter`, () => {
      const files = listEntityFiles(kind);
      // Fail-closed: an empty or short scan must not read as a pass.
      expect(assertEntityFloors(kind, countByRoot(files))).toEqual([]);

      const offenders = [];
      for (const { key, file } of files) {
        for (const dupe of findDuplicateFrontmatterKeys(readFileSync(file, 'utf-8'))) {
          offenders.push(`${key}: '${dupe.key}' declared at lines ${dupe.lines.join(', ')}`);
        }
      }
      expect(offenders, `duplicate frontmatter keys in ${files.length} ${kind} file(s)`).toEqual([]);
    });
  }
});
