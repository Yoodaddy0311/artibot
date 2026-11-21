/**
 * `output-styles/` holds output styles and nothing else.
 *
 * -- What broke (review L16, 2026-11-21) ----------------------------------------
 * `output-styles/tokens.md` is a shared reference document (the design-token
 * table the other styles cite), but it lived in the styles directory with
 * frontmatter `name: artibot-tokens`, so the host offered "artibot-tokens" as a
 * selectable output style. A user who picked it got a token table as their
 * whole system prompt. It now lives at `docs/design-tokens.md` (user-facing doc,
 * linked from both READMEs) and the styles cite that path.
 *
 * Allowlist, not denylist: the directory must hold EXACTLY the styles below.
 * Adding a style means adding it here on purpose; dropping a reference doc into
 * the directory is RED.
 *
 * -- What this gate cannot see --------------------------------------------------
 *  - Whether the host scans sub-directories of output-styles/ (unmeasured), so
 *    sub-directories are refused outright rather than assumed safe.
 *  - The host's handling of non-.md files there (none exist; also refused).
 *  - Whether docs/design-tokens.md is tracked: plugins/artibot/docs/* is
 *    gitignored with per-file re-includes (.gitignore). This test runs on the
 *    working tree; CI only sees the file if it was committed.
 *
 * @module tests/output-styles/style-set
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const DIR = path.join(PLUGIN_ROOT, 'output-styles');
const TOKENS_DOC = 'docs/design-tokens.md';

const STYLES = [
  'artibot-compressed.md',
  'artibot-default.md',
  'artibot-intelligence.md',
  'artibot-mentor.md',
  'artibot-narrative.md',
  'artibot-report.md',
  'artibot-team-dashboard.md',
];

const read = (abs) => readFileSync(abs, 'utf-8');

describe('output-styles/: the exact style set', () => {
  it('holds exactly the registered styles: no reference doc, no sub-directory, no other file', () => {
    const entries = readdirSync(DIR, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    expect(entries).toEqual([...STYLES].sort());
  });

  it('every style names itself after its file (the host lists it under that name)', () => {
    for (const file of STYLES) {
      const m = read(path.join(DIR, file)).match(/^---\r?\n[\s\S]*?^name:\s*(\S+)\s*$/m);
      expect(m?.[1], `${file}: name`).toBe(file.slice(0, -3));
    }
  });
});

describe('the design-token reference document', () => {
  it(`lives at ${TOKENS_DOC} and is not an output style (no frontmatter name)`, () => {
    const abs = path.join(PLUGIN_ROOT, TOKENS_DOC);
    expect(existsSync(abs)).toBe(true);
    const text = read(abs);
    expect(text).toContain('## Status Tokens');
    expect(text).not.toMatch(/^---\r?\n/);
    expect(text).not.toMatch(/^name:\s*\S/m);
  });

  it('every document that cites the token table cites the new path, never output-styles/tokens.md', () => {
    const citing = [
      path.join(DIR, 'artibot-intelligence.md'),
      path.join(DIR, 'artibot-narrative.md'),
      path.join(PLUGIN_ROOT, 'README.md'),
      path.join(REPO_ROOT, 'README.md'),
    ];
    for (const abs of citing) {
      const text = read(abs);
      expect(text, `${path.relative(REPO_ROOT, abs)} must cite ${TOKENS_DOC}`).toContain(TOKENS_DOC);
      // A bare `tokens.md` (not part of design-tokens.md) is the stale citation.
      expect(text.match(/(?<![\w-])tokens\.md/g) ?? [], `${path.relative(REPO_ROOT, abs)}: stale tokens.md`).toEqual([]);
    }
  });

  it('the stale-citation matcher is not blind (self-check)', () => {
    const stale = (s) => (s.match(/(?<![\w-])tokens\.md/g) ?? []).length;
    expect(stale('from `tokens.md`:')).toBe(1);
    expect(stale('output-styles/tokens.md')).toBe(1);
    expect(stale('from `docs/design-tokens.md`:')).toBe(0);
  });
});
