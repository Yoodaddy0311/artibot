/**
 * Source-text checks for network egress (DATA POLICY: a hook makes no external request).
 *
 * Three layers, strongest first — a guarded hook's test should use all three:
 *   1. {@link importSpecifiers} against a per-file ALLOW-list of module specifiers (the caller
 *      declares the set it really uses). This is the fail-closed layer: any new module — dns,
 *      ws, a fresh HTTP client — is outside the set and goes red, whatever its name.
 *   2. {@link globalNetNames}: the network globals (`fetch`, `WebSocket`, `XMLHttpRequest`,
 *      `EventSource`) as whole words in CODE — comments and string/template text are blanked by
 *      {@link lexBlank} first — so `const f = fetch; f(u)` and `fetch.call(…)` are caught too.
 *   3. {@link findEgress}: a DENY-list of six patterns over the raw text. It forbids only what
 *      it names; anything outside those six passes it (measured 2026-11-22 by lane D:
 *      `node:dns`, `const f = fetch; f(u)`, `fetch.call(…)`, 'ws' / 'ky' / 'request' all passed).
 *      Kept as a readable second opinion, not as the gate.
 * `allow` on findEgress exempts named pattern ids for ONE caller (pre-compact.js runs git through
 * child_process) and must be justified at the call site; an unknown id throws, so a typo cannot
 * pass for a working allowance.
 *
 * WHAT THESE CHECKS CANNOT SEE (they read ONE file's own text):
 *   - transitive imports: an allowed module that itself makes the request;
 *   - computed access to a global or module — `globalThis['fe' + 'tch']`, `eval`, `new Function`,
 *     `process.binding` (a computed `import(x)` / `require(x)` IS reported, as `<computed>`);
 *   - network I/O through an allowed API (e.g. child_process running `curl`) — pin the arguments
 *     at the call site, as pre-compact-state.test.js does with {@link callLiterals};
 *   - the lexer's limits: regex-vs-division is decided by the preceding token (the usual
 *     heuristic), so contrived code such as `x = a\n/re/g` can be misread.
 *
 * @module tests/helpers/no-egress
 */

/** Specifier quote: ' " or ` (a template literal is a valid `import()` argument). */
const Q = '[\'"`]';

/** @type {ReadonlyArray<{ id: string, name: string, re: RegExp }>} */
export const EGRESS_PATTERNS = Object.freeze([
  { id: 'fetch', name: 'fetch() call', re: /\bfetch\s*\(/ },
  { id: 'http', name: 'http / https / http2 module', re: new RegExp(`${Q}(?:node:)?https?2?${Q}`) },
  { id: 'socket', name: 'raw socket module (net / tls / dgram)', re: new RegExp(`${Q}(?:node:)?(?:net|tls|dgram)${Q}`) },
  { id: 'child_process', name: 'child_process module', re: new RegExp(`${Q}(?:node:)?child_process${Q}`) },
  { id: 'http-client', name: 'HTTP client package', re: new RegExp(`${Q}(?:axios|undici|node-fetch|got)${Q}`) },
  { id: 'browser-net', name: 'XMLHttpRequest / WebSocket', re: /\b(?:XMLHttpRequest|WebSocket)\b/ },
]);

/**
 * Layer 3 — the deny-list. See the module header for what it does not catch.
 * @param {string} source - file text
 * @param {{ allow?: string[] }} [options] - pattern `id`s this caller may use (default: none)
 * @returns {string[]} names of the patterns that match (empty = none of the six found)
 */
export function findEgress(source, { allow = [] } = {}) {
  const unknown = allow.filter((id) => !EGRESS_PATTERNS.some((p) => p.id === id));
  if (unknown.length > 0) throw new TypeError(`unknown egress pattern id(s): ${unknown.join(', ')}`);
  return EGRESS_PATTERNS
    .filter(({ id, re }) => !allow.includes(id) && re.test(source))
    .map(({ name }) => name);
}

// ---------------------------------------------------------------------------
// Lexer: blank comments (both views) and literal BODIES (code view only)
// ---------------------------------------------------------------------------

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/** @param {string[]} arr @param {number} from @param {number} to */
function blank(arr, from, to) {
  for (let k = from; k < to; k += 1) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
}

/** Index just past a quoted string starting at `i` (the quote char), or end of line if unterminated. */
function quoteEnd(src, i) {
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === '\\') j += 1;
    else if (src[j] === src[i]) return j + 1;
    else if (src[j] === '\n') return j;
  }
  return src.length;
}

/** Index just past a regex literal starting at `i` (the `/`), flags included. */
function regexEnd(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j];
    if (c === '\\') j += 1;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '\n') return j;
    else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k])) k += 1;
      return k;
    }
  }
  return src.length;
}

/** True when the `/` at `i` begins a regex literal (judged from the code before it). */
function startsRegex(noComments, i) {
  const head = noComments.slice(Math.max(0, i - 40), i).join('').trimEnd();
  if (head === '') return true;
  return REGEX_AFTER.has(head[head.length - 1]) || REGEX_AFTER_WORD.test(head);
}

/**
 * Template text from `i` up to the closing backtick or a `${`; blanks the text in `code`.
 * @returns {{ end: number, expr: boolean }} `end` is past the backtick, or past `${`
 */
function templateText(src, i, code) {
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '`') return { end: j + 1, expr: false };
    if (src[j] === '$' && src[j + 1] === '{') return { end: j + 2, expr: true };
    const width = src[j] === '\\' ? 2 : 1; // an escape blanks the escaped char with it
    blank(code, j, j + width);
    j += width - 1;
  }
  return { end: src.length, expr: false };
}

/** Handle the literal or comment starting at `i`, if any; returns the next index or -1. */
function skipNonCode(src, i, nc, co) {
  const c = src[i];
  const n = src[i + 1];
  if (c === '/' && n === '/') {
    const end = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    blank(nc, i, end); blank(co, i, end); return end;
  }
  if (c === '/' && n === '*') {
    const close = src.indexOf('*/', i + 2);
    const end = close === -1 ? src.length : close + 2;
    blank(nc, i, end); blank(co, i, end); return end;
  }
  if (c === '\'' || c === '"') { const end = quoteEnd(src, i); blank(co, i + 1, end - 1); return end; }
  if (c === '/' && startsRegex(nc, i)) { const end = regexEnd(src, i); blank(co, i + 1, end - 1); return end; }
  return -1;
}

/**
 * Two views of `source`, both the SAME LENGTH (an index in one is an index in the other):
 *   - `noComments`: comments blanked (newlines kept), everything else verbatim;
 *   - `codeOnly`: additionally the bodies of string, template and regex literals blanked —
 *     `${…}` template expressions stay, they are code.
 * @param {string} source
 * @returns {{ noComments: string, codeOnly: string }}
 */
export function lexBlank(source) {
  const nc = source.split('');
  const co = source.split('');
  const exprDepth = []; // one brace counter per open `${`
  let i = 0;
  while (i < source.length) {
    const skipped = skipNonCode(source, i, nc, co);
    if (skipped !== -1) { i = skipped; continue; }
    const c = source[i];
    const top = exprDepth.length - 1;
    if (c === '`' || (c === '}' && top >= 0 && exprDepth[top] === 0)) {
      if (c === '}') exprDepth.pop();
      const t = templateText(source, i + 1, co);
      if (t.expr) exprDepth.push(0);
      i = t.end;
      continue;
    }
    if (top >= 0 && c === '{') exprDepth[top] += 1;
    if (top >= 0 && c === '}') exprDepth[top] -= 1;
    i += 1;
  }
  return { noComments: nc.join(''), codeOnly: co.join('') };
}

// ---------------------------------------------------------------------------
// Queries over the two views
// ---------------------------------------------------------------------------

/** Network globals reached by NAME in code. */
const NET_GLOBALS = /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource)\b/g;

/**
 * Layer 2 — network globals used in code (comments and literal text excluded).
 * @param {string} source
 * @returns {string[]} distinct names, in order of first use
 */
export function globalNetNames(source) {
  const found = lexBlank(source).codeOnly.match(NET_GLOBALS) ?? [];
  return [...new Set(found)];
}

/**
 * The literal value of the argument text `arg` (`'x'`, `"x"`, or a backtick string with no
 * `${`), or `<computed>`.
 * @param {string} arg
 * @returns {string}
 */
function literalOrComputed(arg) {
  const m = /^(['"`])([^'"`\n]*)\1$/.exec(arg.trim());
  return m && !(m[1] === '`' && m[2].includes('${')) ? m[2] : '<computed>';
}

/**
 * Layer 1 input — every module specifier the file names: static `import … from`, side-effect
 * `import '…'`, `export … from`, dynamic `import(…)` and `require(…)`. A non-literal dynamic
 * argument is reported as `<computed>`, which no allow-list contains (fail-closed). Matches in
 * comments or inside strings are ignored; `import.meta` is not an import.
 * @param {string} source
 * @returns {string[]} in source order
 */
export function importSpecifiers(source) {
  const { noComments, codeOnly } = lexBlank(source);
  const inCode = (idx) => codeOnly[idx] === noComments[idx];
  const found = [];
  const re = /\b(?:import|export)\s+(?:[\w$*{}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\1|\b(import|require)\s*\(([^)]*)\)/g;
  for (const m of noComments.matchAll(re)) {
    if (!inCode(m.index)) continue;
    if (m[2] !== undefined) found.push(m[2]);
    else found.push(literalOrComputed(m[4]));
  }
  return found;
}

/**
 * The first argument of every CODE call `fnName(…)`: its literal value, or `<computed>`.
 * @param {string} source
 * @param {string} fnName - a plain identifier
 * @returns {string[]} in source order
 */
export function callLiterals(source, fnName) {
  const { noComments, codeOnly } = lexBlank(source);
  const re = new RegExp(`\\b${fnName}\\s*\\(\\s*((['"\`])[^'"\`\\n]*\\2|[^,)]*)`, 'g');
  const out = [];
  for (const m of noComments.matchAll(re)) {
    if (codeOnly[m.index] === noComments[m.index]) out.push(literalOrComputed(m[1]));
  }
  return out;
}
