/**
 * Firewall — the managed `info/exclude` block must list exactly the `.artibot`
 * runtime entries this repository's root `.gitignore` ignores.
 *
 * WHY. `lib/project-state/runtime-exclude.js#RUNTIME_EXCLUDE_ENTRIES` is what a
 * user's project gets; the root `.gitignore` is what this repository decided is
 * local-only. They are two hand-maintained lists of one fact. When a new runtime
 * path is added to the `.gitignore` (as `.artibot/scorecard.json` and
 * `.artibot/media/` were, each on its own day) and not to the block, every
 * marketplace user's `git add .` starts committing it while the repository that
 * wrote the hook sees nothing wrong. Nothing else compares them.
 *
 * DIRECTION. Equality, not just "the block includes every rule": an entry in
 * the block that the repository does not itself ignore is a path we hide from
 * users' commits on nobody's decision. Both directions are findings.
 *
 * CANONICAL FILES. `.artibot/missions/`, `.artibot/adr/`, `.artibot/project.md`
 * (and memory/, guides/) are meant to be TRACKED, so they must be in neither
 * list. The repository's `.gitignore` says so in its own words ("추적(정본, 규칙
 * 없음)"); this asserts it for the block too.
 *
 * WHAT THIS GATE CANNOT SEE — do not read a green run as more than it is:
 *   - Whether a pattern does what it looks like it does in git. The real-git
 *     cases in `tests/project-state/runtime-exclude.test.js` hide every entry and
 *     leave the canonical files visible; this file only compares two lists.
 *   - An ignore rule that does not start with `.artibot/` after normalisation
 *     (the any-depth prefix and a leading slash are stripped). A rule like
 *     `*.artibot-note` is not a runtime-path rule and is not compared.
 *   - Any ignore file other than the root `.gitignore` — a nested `.gitignore`,
 *     `.git/info/exclude`, a global excludes file.
 *   - A glob spelled differently on the two sides (`.artibot/*.json` against
 *     `.artibot/scorecard.json`). It is compared as written, so it fails closed
 *     as a mismatch instead of being understood.
 *
 * @module tests/firewall/runtime-exclude-drift
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderManagedBlock, RUNTIME_EXCLUDE_ENTRIES } from '../../lib/project-state/runtime-exclude.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT_GITIGNORE = path.resolve(PLUGIN_ROOT, '..', '..', '.gitignore');

/** Floor for the parsed census. The root `.gitignore` held 11 on 2026-09-30. */
const MIN_ARTIBOT_RULES = 8;

/** Paths meant to be tracked. A rule that hides any of them is a defect. */
const CANONICAL_PATHS = Object.freeze([
  '.artibot/missions/', '.artibot/adr/', '.artibot/project.md', '.artibot/memory/', '.artibot/guides/',
]);

/**
 * One ignore rule in comparable form: the any-depth prefix (double star, slash)
 * and a leading slash are dropped, because the root file spells the same rule
 * both ways — `.artibot/state.yaml` and its any-depth twin are both in it.
 *
 * @param {string} rule - A `.gitignore` pattern.
 * @returns {string} The pattern without the any-depth prefix or a leading slash.
 */
function normalizeRule(rule) {
  return rule.replace(/^\*\*\//, '').replace(/^\//, '');
}

/**
 * The `.artibot` runtime rules of a `.gitignore` text, normalised and de-duplicated.
 * Comments, blank lines and negations (`!`) are not rules for this purpose.
 *
 * @param {string} text - `.gitignore` content.
 * @returns {string[]} Sorted normalised rules that start with `.artibot/`.
 */
function artibotRules(text) {
  const rules = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
    .map(normalizeRule)
    .filter((rule) => rule.startsWith('.artibot/'));
  return [...new Set(rules)].sort();
}

/**
 * Both directions of the comparison.
 *
 * @param {string} gitignoreText - Root `.gitignore` content.
 * @param {ReadonlyArray<string>} managed - The block's entries.
 * @returns {{missingFromBlock: string[], notInGitignore: string[]}} Findings.
 */
function compare(gitignoreText, managed) {
  const root = artibotRules(gitignoreText);
  const block = [...new Set(managed.map(normalizeRule))].sort();
  return {
    missingFromBlock: root.filter((rule) => !block.includes(rule)),
    notInGitignore: block.filter((rule) => !root.includes(rule)),
  };
}

describe('managed runtime block vs the root .gitignore', () => {
  const text = readFileSync(ROOT_GITIGNORE, 'utf8');

  it('reads a root .gitignore with a real .artibot census (self-check)', () => {
    // A parser that found nothing would compare two empty sets and pass forever.
    expect(artibotRules(text).length).toBeGreaterThanOrEqual(MIN_ARTIBOT_RULES);
    expect(artibotRules(text)).toContain('.artibot/state.yaml');
    expect(artibotRules(text)).toContain('.artibot/runtime/');
  });

  it('the block includes every .artibot runtime rule the root .gitignore ignores', () => {
    expect(compare(text, RUNTIME_EXCLUDE_ENTRIES).missingFromBlock).toEqual([]);
  });

  it('the block hides nothing the root .gitignore does not (no entry on nobody\'s decision)', () => {
    expect(compare(text, RUNTIME_EXCLUDE_ENTRIES).notInGitignore).toEqual([]);
  });

  it('no canonical path is hidden — by the block or by the root .gitignore', () => {
    // A rule hides canonical content when it is the whole directory, or when it
    // and a canonical path overlap in either direction (a parent, or a file inside).
    const swallowed = (rule) => rule === '.artibot/' || rule === '.artibot'
      || CANONICAL_PATHS.some((canonical) => canonical.startsWith(rule) || rule.startsWith(canonical));
    expect(artibotRules(text).filter(swallowed)).toEqual([]);
    expect(RUNTIME_EXCLUDE_ENTRIES.map(normalizeRule).filter(swallowed)).toEqual([]);
  });

  it('the rendered block carries every entry', () => {
    const lines = renderManagedBlock().split('\n');
    for (const entry of RUNTIME_EXCLUDE_ENTRIES) expect(lines).toContain(entry);
  });
});

describe('the comparison can fail (scanner self-verification)', () => {
  const SAMPLE = [
    '# comment .artibot/ignored-comment/',
    '',
    '.artibot/state.yaml',
    '**/.artibot/runtime/',
    '/.artibot/handoffs/',
    '!.artibot/keep-me/',
    'plugins/artibot/_reports/',
    '*.artibot-note',
    '',
  ].join('\r\n');

  it('parses, normalises and filters the way the gate claims', () => {
    expect(artibotRules(SAMPLE)).toEqual(['.artibot/handoffs/', '.artibot/runtime/', '.artibot/state.yaml']);
  });

  it('reports a rule the block lacks (the drift this gate exists to catch)', () => {
    const drifted = `${SAMPLE}\n.artibot/brand-new-runtime-dir/\n`;
    expect(compare(drifted, ['**/.artibot/state.yaml', '**/.artibot/runtime/', '**/.artibot/handoffs/']))
      .toEqual({ missingFromBlock: ['.artibot/brand-new-runtime-dir/'], notInGitignore: [] });
  });

  it('reports an entry the .gitignore does not have', () => {
    expect(compare(SAMPLE, ['**/.artibot/state.yaml', '**/.artibot/runtime/', '**/.artibot/handoffs/', '**/.artibot/extra/']))
      .toEqual({ missingFromBlock: [], notInGitignore: ['.artibot/extra/'] });
  });

  it('reports nothing when the two agree, whichever spelling each side uses', () => {
    expect(compare(SAMPLE, ['.artibot/state.yaml', '/.artibot/runtime/', '**/.artibot/handoffs/']))
      .toEqual({ missingFromBlock: [], notInGitignore: [] });
  });
});
