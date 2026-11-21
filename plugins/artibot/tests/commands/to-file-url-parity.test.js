/**
 * Every inline `toFileUrl` copy in commands/*.md returns what the canonical
 * `scripts/utils/index.js#toFileUrl` returns.
 *
 * -- What broke (2026-11-21, follow-up to review L2) ----------------------------
 * The canonical helper learned to encode `%` -> `%25`, `#` -> `%23` and
 * `?` -> `%3F` (a URL parser reads `#` as a fragment, `?` as a query and `%41`
 * as an escape). A slash command cannot import it, so six commands carry their
 * own copy, and those copies still only swapped backslashes: a plugin root such
 * as `C:\work\c#\artibot` became `file:///C:/work/c#/artibot/lib/...`, which
 * `import()` resolves to `C:/work/c` (fragment `#/artibot/...`). doctor.md
 * called `toFileUrl` without defining it and only said "build file:/// manually".
 *
 * -- How ----------------------------------------------------------------------
 * The `const toFileUrl = (p) => {` ... `};` block is cut out of each document,
 * evaluated, and fed the same inputs as the canonical function. The set of
 * documents that define it is exact (a new copy must be registered here), and a
 * command that CALLS `toFileUrl(` must either define it or be listed with the
 * place it borrows the definition from.
 *
 * -- What this gate cannot see -------------------------------------------------
 *  - Whether the model copies the snippet faithfully. Nothing here runs a model.
 *  - A real `import()` through a `#` directory: tests/scripts/utils-to-file-url
 *    .test.js does that for the canonical function; parity with it is what is
 *    proved here.
 *  - Copies outside commands/ (0 definitions in skills/, agents/, rules/,
 *    templates/, output-styles/, docs/ on 2026-11-21; those mention the
 *    canonical helper by name only).
 *
 * @module tests/commands/to-file-url-parity
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toFileUrl as canonical } from '../../scripts/utils/index.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');

/** Documents that carry their own copy. Exact set. */
const DEFINERS = [
  'commands/autopilot-queue.md',
  'commands/autopilot.md',
  'commands/doctor.md',
  'commands/go.md',
  'commands/install.md',
  'commands/plan.md',
  'commands/split.md',
];

/** Commands that call `toFileUrl(` without defining it, and where the definition comes from. */
const BORROWERS = new Map([
  ['commands/ultraplan.md', 'points at the commands/autopilot.md Step 1 toFileUrl/pluginRoot pattern'],
]);

const OPENER = /^\s*const toFileUrl = \(p\) => \{$/;

/**
 * Cut every `toFileUrl` definition out of a document.
 *
 * @param {string} text - Newline-normalised markdown.
 * @returns {string[]} The definitions, opener to closing `};` inclusive.
 */
export function extractToFileUrl(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!OPENER.test(line)) return;
    const end = lines.findIndex((l, j) => j > i && /^\s*\};\s*$/.test(l));
    if (end !== -1) out.push(lines.slice(i, end + 1).join('\n'));
  });
  return out;
}

/** Evaluate a cut definition and return the function. */
// eslint-disable-next-line no-new-func -- the snippet is repository text under test, not input
const compile = (code) => new Function(`${code}\nreturn toFileUrl;`)();

const INPUTS = [
  'C:\\Users\\me\\OneDrive\\바탕 화면\\AI\\artibot\\plugins\\artibot\\lib\\autopilot\\index.js',
  'C:\\work\\c#\\artibot\\lib\\core\\config.js',
  'C:\\work\\100%\\artibot\\lib\\x.js',
  'C:\\work\\what?\\artibot\\lib\\x.js',
  'C:\\a\\%23\\b#c?d%e.js',
  'D:/already/forward/lib.js',
  '/home/me/c#/artibot/lib/x.js',
  '/home/me/100%/a?b/x.js',
];

const files = (dir) => readdirSync(path.join(PLUGIN_ROOT, dir)).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`);

describe('commands/*.md: inline toFileUrl copies match scripts/utils/index.js#toFileUrl', () => {
  it('the set of documents that define toFileUrl is exact', () => {
    const definers = files('commands').filter((rel) => extractToFileUrl(read(rel)).length > 0).sort();
    expect(definers).toEqual([...DEFINERS].sort());
  });

  it.each(DEFINERS)('%s defines it exactly once and the copy returns the canonical URL for every input', (rel) => {
    const defs = extractToFileUrl(read(rel));
    expect(defs, `${rel}: definitions`).toHaveLength(1);
    const copy = compile(defs[0]);
    for (const input of INPUTS) {
      expect(copy(input), `${rel} on ${input}`).toBe(canonical(input));
    }
  });

  it('every command that calls toFileUrl( defines it or is a registered borrower', () => {
    const callers = files('commands').filter((rel) => /\btoFileUrl\(/.test(read(rel)));
    const unexplained = callers.filter((rel) => !DEFINERS.includes(rel) && !BORROWERS.has(rel));
    expect(unexplained).toEqual([]);
    for (const rel of BORROWERS.keys()) expect(callers, `${rel} is a stale borrower`).toContain(rel);
  });

  it('the canonical outputs are the encoded ones (self-check: the inputs reach the failure region)', () => {
    expect(canonical(INPUTS[1])).toBe('file:///C:/work/c%23/artibot/lib/core/config.js');
    expect(canonical(INPUTS[2])).toBe('file:///C:/work/100%25/artibot/lib/x.js');
    expect(canonical(INPUTS[3])).toBe('file:///C:/work/what%3F/artibot/lib/x.js');
    expect(canonical(INPUTS[4])).toBe('file:///C:/a/%2523/b%23c%3Fd%25e.js');
    expect(canonical(INPUTS[6])).toBe('file:///home/me/c%23/artibot/lib/x.js');
    // A backslash-only copy (the pre-fix text) must disagree, or this test proves nothing.
    const stale = compile("const toFileUrl = (p) => {\n  const f = p.replace(/\\\\/g, '/');\n  return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;\n};");
    expect(stale(INPUTS[1])).not.toBe(canonical(INPUTS[1]));
    expect(stale(INPUTS[0])).toBe(canonical(INPUTS[0]));
  });

  it('the extractor is not blind (self-check)', () => {
    const doc = '```js\n   const toFileUrl = (p) => {\n     return p;\n   };\n```';
    expect(extractToFileUrl(doc)).toEqual(['   const toFileUrl = (p) => {\n     return p;\n   };']);
    expect(extractToFileUrl('toFileUrl(x)')).toEqual([]);
  });
});
