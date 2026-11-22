/**
 * Self-checks for the lexical helpers in tests/helpers/no-egress.js — the gates that use them
 * (webfetch-cache, skill-discovery-inject, pre-compact-state) are only as good as these.
 *
 * Why a lexer at all: a plain regex over the file text sees comments and string contents as
 * code. Two real cases in the guarded hooks: the word "fetch" in a comment and in template text
 * (webfetch-cache-pre.js), and a regex literal holding quote characters
 * (pre-compact.js#FILE_PATH_PATTERN) that a naive quote scanner would take for the start of a
 * string and so blank everything after it — a fail-open.
 */
import { describe, expect, it } from 'vitest';

import { callLiterals, globalNetNames, importSpecifiers, lexBlank } from '../helpers/no-egress.js';

describe('lexBlank()', () => {
  it('keeps the length (and newlines) so an index in one view is an index in the other', () => {
    const src = "const a = 'x'; // c\n/* b\n */ const t = `t${a}t`;\n";
    const { noComments, codeOnly } = lexBlank(src);
    expect(noComments.length).toBe(src.length);
    expect(codeOnly.length).toBe(src.length);
    expect(codeOnly.split('\n').length).toBe(src.split('\n').length);
  });

  it('does not treat // inside a string as a comment (no code is cut after a URL)', () => {
    for (const q of ["'", '"', '`']) {
      expect(globalNetNames(`const u = ${q}https://example.com${q}; fetch(u);`)).toEqual(['fetch']);
    }
  });

  it('blanks comments, string text and template text, but keeps ${…} expressions', () => {
    expect(globalNetNames('// fetch(u)\n/* new WebSocket(x) */')).toEqual([]);
    expect(globalNetNames("const s = 'will populate after fetch.';")).toEqual([]);
    expect(globalNetNames('const s = `then fetch ${a}`;')).toEqual([]);
    expect(globalNetNames('const s = `x ${fetch(u)} y`;')).toEqual(['fetch']);
    expect(globalNetNames('const s = `a ${`b ${fetch(u)}`}`;')).toEqual(['fetch']);
  });

  it('is not derailed by a regex literal holding quotes, nor by division', () => {
    expect(globalNetNames('const R = /["\'`(]/g; fetch(u);')).toEqual(['fetch']);
    expect(globalNetNames('const x = a / b; fetch(u); const y = c / d;')).toEqual(['fetch']);
    expect(globalNetNames('if (ok) return /\\/\\//.test(s) && fetch(u);')).toEqual(['fetch']);
  });
});

describe('globalNetNames()', () => {
  it('catches the network globals however they are reached (lane D probe samples)', () => {
    expect(globalNetNames('const f = fetch; f(u);')).toEqual(['fetch']);
    expect(globalNetNames('fetch.call(null, u);')).toEqual(['fetch']);
    expect(globalNetNames('new WebSocket(u); new XMLHttpRequest();')).toEqual(['WebSocket', 'XMLHttpRequest']);
  });

  it('stays quiet on identifiers that only contain the word (fetchedAt, WebFetch, prefetch)', () => {
    expect(globalNetNames('const { fetchedAt } = m; WebFetch(); prefetch();')).toEqual([]);
  });
});

describe('importSpecifiers()', () => {
  it('collects static, side-effect, re-export, dynamic and require specifiers', () => {
    const src = [
      "import a from 'node:a';",
      "import { b, c } from './b.js';",
      "import * as d from 'd';",
      "import e, { f } from \"e\";",
      "import 'side-effect';",
      "import {\n  g,\n} from '../g.js';",
      "export { h } from './h.js';",
      "const i = await import('node:i');",
      'const j = require(`j`);',
    ].join('\n');
    expect(importSpecifiers(src)).toEqual([
      'node:a', './b.js', 'd', 'e', 'side-effect', '../g.js', './h.js', 'node:i', 'j',
    ]);
  });

  it('reports a computed dynamic import or require as <computed> (fail-closed)', () => {
    expect(importSpecifiers('await import(name); require(`x${y}`);')).toEqual(['<computed>', '<computed>']);
  });

  it('ignores imports inside comments and strings, and import.meta', () => {
    const src = "// import x from 'dns';\nconst s = \"import y from 'net'\";\nconst u = import.meta.url;";
    expect(importSpecifiers(src)).toEqual([]);
  });
});

describe('callLiterals()', () => {
  it('returns each call\'s first-argument literal, <computed> otherwise, and skips non-code', () => {
    const src = "execSync('git status');\nexecSync(\"git log\", {});\nexecSync(cmd);\n// execSync('curl x')\nconst s = \"execSync('rm')\";";
    expect(callLiterals(src, 'execSync')).toEqual(['git status', 'git log', '<computed>']);
  });
});
