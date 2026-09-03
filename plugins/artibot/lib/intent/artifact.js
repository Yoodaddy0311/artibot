/**
 * `intent.md` ↔ Mission Contract lossless projection (PRD 부록 A T-23).
 *
 * Design §3.1 rules this module implements:
 *
 *   - **디스크 정본은 `intent.md` 하나뿐이다.** `mission-contract.schema.json`
 *     (T-13) is *not* a disk artifact; it validates the object this parser
 *     produces, in memory. Nothing here writes a file — I/O belongs to the
 *     caller — and {@link assertIntentFilePath} exists so the caller's write
 *     site can stay fail-closed about the one allowed basename.
 *   - **파생 파일 금지.** `intent-v2.md` · `intent-final.md` ·
 *     `intent-agent-a.md` · `interpreted-intent.md` and every other variant are
 *     refused by an ALLOWLIST (`intent.md` and nothing else), not by a list of
 *     bad names — a denylist fails open on the next name somebody invents.
 *   - **개정은 제자리에서.** {@link serializeIntentMd} with `originalText`
 *     rewrites only the frontmatter keys and body sections whose value actually
 *     changed. Everything else — guidance comments, provenance, unknown keys,
 *     preamble, section prose — is carried through byte for byte.
 *
 * ## Losslessness
 *
 * Two properties, both fixed by `tests/intent/artifact.test.js`:
 *
 *   1. `serializeIntentMd(parseIntentMd(t).contract, { originalText: t }) === t`
 *      for any `t` the parser accepts. Comparison before rewriting is on
 *      *values*, not on rendered text, so a key whose value is unchanged is
 *      never re-rendered and rendering fidelity cannot cost bytes.
 *   2. `parse(serialize(parse(t))) ≡ parse(t)` — contract-level idempotence,
 *      which also holds for the from-scratch (no `originalText`) form.
 *
 * ## Why the parse result has a third field
 *
 * `parseIntentMd` returns `{ contract, warnings, source }`. The contract schema
 * is `additionalProperties: false` and has no home for `created_by` /
 * `updated_by` / `created_at` / `updated_at` / `actor`, nor for the prose of
 * `## Original Request`, `## Systemic Scope`, `## Intent Refinements`. Returning
 * only `{ contract, warnings }` would make the parser lossy by construction and
 * would leave {@link checkSpanConsistency} without the text the spans are
 * measured against. `source` is that text, kept out of `contract` precisely so
 * `contract` stays schema-clean.
 *
 * ## Parsing is not validation
 *
 * Findings here are STRUCTURAL only — a missing template section, frontmatter
 * that could not be read, a span that does not quote the original request, a
 * top-level key nothing maps to. Enum membership, patterns, `minItems`, and
 * `required` are the T-13 schema port's business; duplicating them here would
 * fork the vocabulary. A document that parses is not thereby valid, and this
 * module never claims it is. Each finding carries a `severity`, so `error`
 * entries can be failed on without waiting for the schema port.
 *
 * The one rule this module does enforce is the span binding, and it enforces
 * the SAME rule as the canonical checker
 * (`lib/mission/contract.js#verifyExplicitRequestSpans`): exact match, checked
 * early. See {@link checkSpanConsistency}.
 *
 * ## The YAML subset
 *
 * `js-yaml` is not a dependency of this package (measured 2026-09-02: no `yaml`
 * entry in `plugins/artibot/package.json` or the root `package.json`), so the
 * frontmatter reader here is a line-based parser covering exactly what
 * `schemas/intent-md.template.md` uses: scalars (string · integer · float ·
 * boolean · null), flow sequences (`[0, 0]`, `[]`), block sequences, block
 * mappings, and sequences of mappings, nested by indentation. Anchors, aliases,
 * multi-document streams, block scalars (`|`, `>`), and complex keys are NOT
 * supported and are reported as {@link WarningCode.FRONTMATTER_UNSUPPORTED}
 * rather than silently mis-read.
 *
 * @module lib/intent/artifact
 */

import { COMPLETION_EXPECTATIONS } from './interpreter.js';

const FENCE = '---';

/** The only basename an intent artifact may have inside a mission directory. */
export const INTENT_ARTIFACT_BASENAME = 'intent.md';

/**
 * Derived names the template calls out by hand (template lines 6-7). Kept for
 * error messages ONLY — the actual gate is the allowlist in
 * {@link isAllowedIntentFilePath}, so a name absent from this list is still
 * refused.
 */
export const KNOWN_DERIVED_INTENT_NAMES = Object.freeze([
  'intent-v2.md',
  'intent-final.md',
  'intent-agent-a.md',
  'interpreted-intent.md',
]);

/**
 * Completion expectation vocabulary (design 02, 7 kinds) — RE-EXPORTED, not
 * copied.
 *
 * This module originally carried its own array transcribed from
 * `schemas/intent-md.template.md`. That made it the THIRD definition of one
 * vocabulary, and a duplicated vocabulary drifts silently the moment one side
 * is edited — `lib/mission/mission-id.js` had already been bitten by exactly
 * that, carrying `'pr'` while the canon says `'PR'`. The single source is
 * `interpreter.js#COMPLETION_EXPECTATIONS`, which transcribes the canon
 * verbatim; `lib/planning/question-gate.js:40` and `lib/mission/mission-id.js:52`
 * already import from there, so this follows the established direction.
 *
 * Layer-safe: both modules are L2 and sit in this same directory, and
 * `interpreter.js` imports nothing at all (measured 2026-09-03), so this edge
 * cannot close a cycle.
 *
 * `tests/intent/artifact.test.js` asserts REFERENCE identity, not value
 * equality — a future re-introduced copy with identical contents would still
 * fail there.
 */
export const COMPLETION_ACTIONS = COMPLETION_EXPECTATIONS;

/**
 * Codes emitted by {@link parseIntentMd}. Each carries a severity from
 * {@link WARNING_SEVERITY}: `error` entries are contract-invalidating and a
 * caller that wants to fail closed checks
 * `warnings.some((w) => w.severity === 'error')`.
 */
export const WarningCode = Object.freeze({
  /** No `---` fenced frontmatter block at the top of the document. */
  FRONTMATTER_MISSING: 'FRONTMATTER_MISSING',
  /** Frontmatter used a YAML feature this minimal parser does not cover. */
  FRONTMATTER_UNSUPPORTED: 'FRONTMATTER_UNSUPPORTED',
  /** A top-level frontmatter key that is neither contract-owned nor preserved. */
  FRONTMATTER_UNMAPPED_KEY: 'FRONTMATTER_UNMAPPED_KEY',
  /** A canonical template section header is absent from the body. */
  SECTION_MISSING: 'SECTION_MISSING',
  /** `explicit_requests` was not a sequence. */
  EXPLICIT_REQUESTS_SHAPE: 'EXPLICIT_REQUESTS_SHAPE',
  /** An `explicit_requests` entry was a bare string (v1.0 shape), not an object. */
  EXPLICIT_REQUEST_LEGACY_STRING: 'EXPLICIT_REQUEST_LEGACY_STRING',
  /**
   * `span` was null. NOT permitted: a request whose position in the original
   * text cannot be pointed at is not an explicit request at all, and belongs
   * in `inferred_outcomes` instead.
   */
  SPAN_NULL: 'SPAN_NULL',
  /** `span` was neither `[start, end]` nor `{start, end}`. */
  SPAN_SHAPE: 'SPAN_SHAPE',
  /** `start > end`, or either bound is negative / non-integer. */
  SPAN_INVALID_RANGE: 'SPAN_INVALID_RANGE',
  /** `end` runs past the end of `## Original Request`. */
  SPAN_OUT_OF_BOUNDS: 'SPAN_OUT_OF_BOUNDS',
  /** `originalRequest.slice(start, end)` is not byte-identical to `text`. */
  SPAN_TEXT_MISMATCH: 'SPAN_TEXT_MISMATCH',
  /** A `## Completion` checkbox label outside the canonical seven. */
  COMPLETION_UNKNOWN_ACTION: 'COMPLETION_UNKNOWN_ACTION',
});

/**
 * Severity per code, in one auditable place rather than scattered across call
 * sites. `error` means the document is not a valid mission contract even though
 * it parsed; `warning` means it parsed and is structurally short of the
 * template but still usable.
 *
 * Every `explicit_requests` code is an error: the span binding is what makes
 * the Intent Fidelity Rule mechanical, so an entry that cannot be bound back to
 * the user's words has already lost the property the list exists to protect.
 */
export const WARNING_SEVERITY = Object.freeze({
  [WarningCode.FRONTMATTER_MISSING]: 'warning',
  [WarningCode.FRONTMATTER_UNSUPPORTED]: 'warning',
  [WarningCode.FRONTMATTER_UNMAPPED_KEY]: 'warning',
  [WarningCode.SECTION_MISSING]: 'warning',
  [WarningCode.COMPLETION_UNKNOWN_ACTION]: 'warning',
  [WarningCode.EXPLICIT_REQUESTS_SHAPE]: 'error',
  [WarningCode.EXPLICIT_REQUEST_LEGACY_STRING]: 'error',
  [WarningCode.SPAN_NULL]: 'error',
  [WarningCode.SPAN_SHAPE]: 'error',
  [WarningCode.SPAN_INVALID_RANGE]: 'error',
  [WarningCode.SPAN_OUT_OF_BOUNDS]: 'error',
  [WarningCode.SPAN_TEXT_MISMATCH]: 'error',
});

/**
 * Frontmatter keys this module projects into the mission contract. Anything
 * here is re-rendered by {@link serializeIntentMd} when its value changes.
 */
const CONTRACT_FRONTMATTER_KEYS = Object.freeze([
  'schema_version',
  'mission_id',
  'status',
  'intent_revision',
  'explicit_requests',
  'autonomy',
  'execution_profile',
  'review',
]);

/**
 * Frontmatter keys the contract schema has no field for but the artifact must
 * keep. They survive a revision untouched; they never enter `contract`.
 * `based_on` is deliberately absent — intent is the root of the artifact
 * dependency graph and the template forbids the key (template lines 39-43).
 */
const PRESERVED_FRONTMATTER_KEYS = Object.freeze([
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
  'actor',
]);

/**
 * The 15 canonical body sections, in template order.
 *
 * `kind` decides both extraction and rendering:
 *   - `raw`       — prose kept verbatim; no contract field (`path` is null).
 *   - `text`      — prose joined into one string.
 *   - `list`      — bullet (or bare line) items into an array of strings.
 *   - `checklist` — `- [x] name` checkboxes; only the CHECKED ones project.
 */
export const INTENT_SECTIONS = Object.freeze([
  { key: 'original_request', header: '## Original Request', kind: 'raw', path: null },
  { key: 'interpreted_goal', header: '## Interpreted Goal', kind: 'text', path: 'goal' },
  { key: 'explicit_scope', header: '## Explicit Scope', kind: 'list', path: 'scope.requested_target' },
  { key: 'bounded_blindspots', header: '### Bounded Blindspots', kind: 'list', path: 'scope.bounded_blindspots' },
  { key: 'excluded', header: '### Excluded', kind: 'list', path: 'scope.excluded' },
  { key: 'systemic_scope', header: '## Systemic Scope', kind: 'raw', path: null },
  { key: 'success_criteria', header: '## Success Criteria', kind: 'raw', path: null },
  { key: 'functional', header: '### Functional', kind: 'list', path: 'success.functional' },
  { key: 'behavioral', header: '### Behavioral', kind: 'list', path: 'success.behavioral' },
  { key: 'regression', header: '### Regression', kind: 'list', path: 'success.regression' },
  { key: 'evidence', header: '### Evidence', kind: 'list', path: 'success.evidence' },
  { key: 'completion', header: '## Completion', kind: 'checklist', path: 'completion.expected_actions' },
  { key: 'constraints', header: '## Constraints', kind: 'list', path: 'constraints' },
  { key: 'user_decisions', header: '## User Decisions', kind: 'list', path: 'user_decisions' },
  { key: 'intent_refinements', header: '## Intent Refinements', kind: 'raw', path: null },
]);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Structural deep equality. Used to decide whether a key or section changed, so
 * it must be insensitive to object key ORDER: the projected value is rebuilt
 * from scratch while the original comes off disk, and identical content built
 * in a different order must not read as a change.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Number of leading spaces. Tabs are not indentation in YAML and are counted as
 * content, which is what makes a tab-indented document fail loudly instead of
 * parsing into the wrong shape.
 *
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  return n;
}

/**
 * Index of the next line that is neither blank nor a whole-line `#` comment.
 *
 * @param {string[]} lines
 * @param {number} i
 * @returns {number}
 */
function nextSignificant(lines, i) {
  let k = i;
  while (k < lines.length) {
    const t = lines[k].trim();
    if (t !== '' && !t.startsWith('#')) return k;
    k += 1;
  }
  return lines.length;
}

/**
 * Read `a.b.c` off an object, returning undefined at the first missing hop.
 *
 * @param {object} obj
 * @param {string} path
 * @returns {unknown}
 */
function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), obj);
}

// ---------------------------------------------------------------------------
// Minimal YAML reader (frontmatter only)
// ---------------------------------------------------------------------------

/**
 * Unescape a double-quoted YAML scalar body. Only the three escapes
 * {@link renderScalar} can emit are recognised; anything else is left literal
 * rather than guessed at.
 *
 * @param {string} body
 * @returns {string}
 */
function unescapeDoubleQuoted(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\' || i === body.length - 1) {
      out += body[i];
      continue;
    }
    const next = body[i + 1];
    if (next === 'n') out += '\n';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else out += `\\${next}`;
    i += 1;
  }
  return out;
}

/**
 * Split a flow sequence body on top-level commas, respecting quotes and nesting.
 *
 * @param {string} inner
 * @returns {string[]}
 */
function splitFlowItems(inner) {
  const items = [];
  let depth = 0;
  let quote = '';
  let buf = '';
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '' || items.length > 0) items.push(buf);
  return items;
}

/**
 * Parse one scalar (or flow sequence) as it appears to the right of a `:` or a
 * `-`. Unquoted tokens are typed: `true`/`false` → boolean, `null`/`~`/empty →
 * null, integer and decimal literals → number, everything else → string.
 *
 * @param {string} raw
 * @returns {unknown}
 */
function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlowItems(inner).map((item) => parseScalar(item));
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?(?:\d+\.\d*|\.\d+)$/.test(s)) return Number(s);
  const hashAt = s.indexOf(' #');
  if (hashAt > 0) {
    const head = s.slice(0, hashAt).trim();
    if (head !== '') return parseScalar(head);
  }
  return s;
}

/**
 * True when the text after a `- ` opens a mapping rather than being a scalar.
 * A leading quote, `[` or `{` settles it as a scalar without looking further.
 *
 * @param {string} rest
 * @returns {boolean}
 */
function looksLikeMappingEntry(rest) {
  if (rest.startsWith('"') || rest.startsWith("'") || rest.startsWith('[') || rest.startsWith('{')) {
    return false;
  }
  const c = rest.indexOf(':');
  if (c <= 0) return false;
  return rest.length === c + 1 || rest[c + 1] === ' ';
}

/**
 * Parse a block mapping whose keys sit at exactly `indent`.
 *
 * `lines` is mutated in place by {@link parseSequence} when it rewrites a
 * `- key: value` header into `  key: value` — the replacement is the same
 * length, so every other index and indent stays valid.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} indent
 * @param {{unsupported: boolean}} flags
 * @returns {{ value: Record<string, unknown>, next: number }}
 */
function parseMapping(lines, start, indent, flags) {
  /** @type {Record<string, unknown>} */
  const obj = {};
  let cur = nextSignificant(lines, start);
  while (cur < lines.length) {
    const line = lines[cur];
    if (indentOf(line) !== indent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed === '-') break;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      flags.unsupported = true;
      break;
    }
    const key = trimmed.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const rest = trimmed.slice(colon + 1).trim();
    if (rest !== '') {
      if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
        flags.unsupported = true;
      }
      obj[key] = parseScalar(rest);
      cur = nextSignificant(lines, cur + 1);
      continue;
    }
    const look = nextSignificant(lines, cur + 1);
    if (look >= lines.length) {
      obj[key] = null;
      cur = look;
      continue;
    }
    const lookIndent = indentOf(lines[look]);
    const lookIsItem = lines[look].trim().startsWith('- ') || lines[look].trim() === '-';
    if (lookIndent > indent) {
      const child = parseBlock(lines, look, lookIndent, flags);
      obj[key] = child.value;
      cur = nextSignificant(lines, child.next);
      continue;
    }
    if (lookIndent === indent && lookIsItem) {
      const seq = parseSequence(lines, look, indent, flags);
      obj[key] = seq.value;
      cur = nextSignificant(lines, seq.next);
      continue;
    }
    obj[key] = null;
    cur = look;
  }
  return { value: obj, next: cur };
}

/**
 * Parse a block sequence whose `-` markers sit at exactly `indent`.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} indent
 * @param {{unsupported: boolean}} flags
 * @returns {{ value: unknown[], next: number }}
 */
function parseSequence(lines, start, indent, flags) {
  /** @type {unknown[]} */
  const arr = [];
  let cur = nextSignificant(lines, start);
  while (cur < lines.length) {
    const line = lines[cur];
    if (indentOf(line) !== indent) break;
    const trimmed = line.trim();
    if (trimmed !== '-' && !trimmed.startsWith('- ')) break;
    const afterDash = trimmed.slice(1);
    const rest = afterDash.trimStart();
    if (rest === '') {
      const look = nextSignificant(lines, cur + 1);
      if (look < lines.length && indentOf(lines[look]) > indent) {
        const child = parseBlock(lines, look, indentOf(lines[look]), flags);
        arr.push(child.value);
        cur = nextSignificant(lines, child.next);
      } else {
        arr.push(null);
        cur = look;
      }
      continue;
    }
    const itemIndent = indent + 1 + (afterDash.length - rest.length);
    if (looksLikeMappingEntry(rest)) {
      // Same-length rewrite: `- ` (or `-   `) becomes spaces, so the mapping
      // reader can treat the item's first line like any other key line.
      lines[cur] = ' '.repeat(itemIndent) + rest;
      const item = parseMapping(lines, cur, itemIndent, flags);
      arr.push(item.value);
      cur = nextSignificant(lines, item.next);
      continue;
    }
    arr.push(parseScalar(rest));
    cur = nextSignificant(lines, cur + 1);
  }
  return { value: arr, next: cur };
}

/**
 * Parse whichever of mapping or sequence starts at `start`.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} indent
 * @param {{unsupported: boolean}} flags
 * @returns {{ value: unknown, next: number }}
 */
function parseBlock(lines, start, indent, flags) {
  const i = nextSignificant(lines, start);
  if (i >= lines.length || indentOf(lines[i]) < indent) return { value: null, next: i };
  const trimmed = lines[i].trim();
  if (trimmed === '-' || trimmed.startsWith('- ')) return parseSequence(lines, i, indent, flags);
  return parseMapping(lines, i, indent, flags);
}

// ---------------------------------------------------------------------------
// Minimal YAML writer (frontmatter only)
// ---------------------------------------------------------------------------

/**
 * Render a scalar so that {@link parseScalar} reads back exactly this value.
 * Quoting is applied whenever a bare token would be re-typed as something else
 * (a number-looking string, `true`, `null`, the empty string) or would confuse
 * the reader (`: `, leading `-`/`[`/`#`, edge whitespace).
 *
 * @param {unknown} value
 * @returns {string}
 */
function renderScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  const needsQuote =
    s === ''
    || s !== s.trim()
    || /^(?:true|false|null|~)$/.test(s)
    || /^-?\d+$/.test(s)
    || /^-?(?:\d+\.\d*|\.\d+)$/.test(s)
    || /[:#]/.test(s)
    || /^[-?[\]{}&*!|>'"%@`]/.test(s)
    || s.includes('\n');
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * True when an array can be written as a flow sequence on one line. Numbers
 * only, which is exactly `explicit_requests[].span` — everything else gets a
 * block list so long strings stay readable.
 *
 * @param {unknown[]} arr
 * @returns {boolean}
 */
function isFlowArray(arr) {
  return arr.length > 0 && arr.every((v) => typeof v === 'number');
}

/**
 * Render `key: value` (and any nested block) as YAML lines at `indent`.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {number} indent
 * @returns {string[]}
 */
function renderYamlKey(key, value, indent) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return [`${pad}${key}:`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    if (isFlowArray(value)) return [`${pad}${key}: [${value.map(renderScalar).join(', ')}]`];
    return [`${pad}${key}:`, ...renderYamlSequence(value, indent + 2)];
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${pad}${key}: {}`];
    const out = [`${pad}${key}:`];
    for (const [k, v] of entries) out.push(...renderYamlKey(k, v, indent + 2));
    return out;
  }
  return [`${pad}${key}: ${renderScalar(value)}`];
}

/**
 * Render a block sequence at `indent`.
 *
 * @param {unknown[]} arr
 * @param {number} indent
 * @returns {string[]}
 */
function renderYamlSequence(arr, indent) {
  const pad = ' '.repeat(indent);
  /** @type {string[]} */
  const out = [];
  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.length === 0) {
        out.push(`${pad}- {}`);
        continue;
      }
      const [firstKey, firstVal] = entries[0];
      const firstLines = renderYamlKey(firstKey, firstVal, indent + 2);
      out.push(`${pad}- ${firstLines[0].slice(indent + 2)}`);
      out.push(...firstLines.slice(1));
      for (const [k, v] of entries.slice(1)) out.push(...renderYamlKey(k, v, indent + 2));
      continue;
    }
    if (Array.isArray(item)) {
      out.push(`${pad}- [${item.map(renderScalar).join(', ')}]`);
      continue;
    }
    out.push(`${pad}- ${renderScalar(item)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document splitting
// ---------------------------------------------------------------------------

/**
 * Split a document into frontmatter lines and body lines, recording the line
 * ranges so a revision can be applied surgically.
 *
 * @param {string[]} lines
 * @returns {{ hasFrontmatter: boolean, fmStart: number, fmEnd: number, bodyStart: number }}
 */
function locateFrontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== FENCE) {
    return { hasFrontmatter: false, fmStart: 0, fmEnd: 0, bodyStart: 0 };
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      return { hasFrontmatter: true, fmStart: 1, fmEnd: i, bodyStart: i + 1 };
    }
  }
  return { hasFrontmatter: false, fmStart: 0, fmEnd: 0, bodyStart: 0 };
}

/**
 * Record the line range of every top-level frontmatter key.
 *
 * A key's range runs from its own line to the line before the next top-level
 * key (or the closing fence), so nested lines and any comment lines sitting
 * between the key and its value travel with it.
 *
 * @param {string[]} lines Full document lines.
 * @param {number} fmStart
 * @param {number} fmEnd
 * @returns {{ key: string, start: number, end: number }[]}
 */
function locateFrontmatterKeys(lines, fmStart, fmEnd) {
  /** @type {{ key: string, start: number, end: number }[]} */
  const blocks = [];
  for (let i = fmStart; i < fmEnd; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (indentOf(line) !== 0) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    if (blocks.length > 0) blocks[blocks.length - 1].end = i;
    blocks.push({ key: trimmed.slice(0, colon).trim(), start: i, end: fmEnd });
  }
  // Trailing blank/comment lines inside a block are trimmed at rewrite time by
  // contentEndOfBlock, not here: the raw range is what tells that function how
  // far it may look.
  return blocks;
}

/**
 * Trim trailing blank and comment-only lines from a key block so the rewrite
 * boundary sits right after the key's own content.
 *
 * @param {string[]} lines
 * @param {{ key: string, start: number, end: number }} block
 * @returns {number}
 */
function contentEndOfBlock(lines, block) {
  let end = block.end;
  while (end > block.start + 1) {
    const t = lines[end - 1].trim();
    if (t === '' || t.startsWith('#')) end -= 1;
    else break;
  }
  return end;
}

/**
 * Record the line range of every markdown header section in the body.
 *
 * A section ends at the next header of ANY level, so `## Explicit Scope` does
 * not swallow `### Bounded Blindspots`.
 *
 * @param {string[]} lines
 * @param {number} bodyStart
 * @returns {{ header: string, start: number, contentStart: number, end: number }[]}
 */
function locateSections(lines, bodyStart) {
  /** @type {{ header: string, start: number, contentStart: number, end: number }[]} */
  const found = [];
  for (let i = bodyStart; i < lines.length; i += 1) {
    if (!/^#{1,6}\s+\S/.test(lines[i])) continue;
    if (found.length > 0) found[found.length - 1].end = i;
    found.push({ header: lines[i].trim(), start: i, contentStart: i + 1, end: lines.length });
  }
  return found;
}

/**
 * Strip HTML comment blocks. Template guidance lives in them and must never be
 * read as content, but the raw lines are still preserved on disk because
 * extraction and rewriting are separate steps.
 *
 * @param {string} text
 * @returns {string}
 */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Content lines of a section with comments removed and blanks dropped.
 *
 * @param {string[]} lines
 * @param {{ contentStart: number, end: number }} section
 * @returns {string[]}
 */
function sectionContentLines(lines, section) {
  const raw = lines.slice(section.contentStart, section.end).join('\n');
  return stripHtmlComments(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * Extract a section's value in the shape its `kind` implies.
 *
 * @param {string[]} lines
 * @param {{ contentStart: number, end: number }} section
 * @param {string} kind
 * @param {(code: string, message: string, path?: string) => void} warn
 * @returns {string | string[]}
 */
function extractSectionValue(lines, section, kind, warn) {
  const content = sectionContentLines(lines, section);
  if (kind === 'text' || kind === 'raw') return content.join('\n');
  if (kind === 'checklist') {
    /** @type {string[]} */
    const checked = [];
    for (const line of content) {
      const m = /^-\s*\[([ xX])\]\s*(.+)$/.exec(line);
      if (!m) continue;
      const label = m[2].trim();
      if (!COMPLETION_ACTIONS.includes(label)) {
        warn(
          WarningCode.COMPLETION_UNKNOWN_ACTION,
          `'## Completion' 체크박스 '${label}' 는 정본 7종(${COMPLETION_ACTIONS.join(', ')}) 밖이다.`,
          'completion.expected_actions',
        );
      }
      if (m[1] !== ' ') checked.push(label);
    }
    return checked;
  }
  return content
    .filter((l) => !/^-\s*\[[ xX]\]/.test(l))
    .map((l) => (l.startsWith('- ') ? l.slice(2).trim() : l))
    .filter((l) => l !== '');
}

// ---------------------------------------------------------------------------
// Frontmatter ↔ contract projection
// ---------------------------------------------------------------------------

/**
 * Normalise one `explicit_requests` entry from frontmatter shape to contract
 * shape. A null span is carried through as null and reported as an ERROR rather
 * than invented: filling in `{start:0,end:0}` would turn "we could not locate
 * this in the original text" into a claim that it sits at the head of the
 * document, and parsing stays non-throwing so the caller sees every problem at
 * once instead of only the first.
 *
 * @param {unknown} entry
 * @param {number} index
 * @param {(code: string, message: string, path?: string) => void} warn
 * @returns {{ text: string, span: { start: number, end: number } | null }}
 */
function normalizeExplicitRequest(entry, index, warn) {
  const at = `explicit_requests[${index}]`;
  if (typeof entry === 'string') {
    warn(
      WarningCode.EXPLICIT_REQUEST_LEGACY_STRING,
      `${at} 가 문자열이다. v1.0 형태이므로 span 을 복원할 수 없다.`,
      at,
    );
    return { text: entry, span: null };
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    warn(WarningCode.EXPLICIT_REQUESTS_SHAPE, `${at} 가 객체가 아니다.`, at);
    return { text: '', span: null };
  }
  const text = typeof entry.text === 'string' ? entry.text : '';
  const rawSpan = entry.span;
  if (rawSpan === null || rawSpan === undefined) {
    warn(
      WarningCode.SPAN_NULL,
      `${at}.span 이 null 이다. 허용하지 않는다 — 원문에서 위치를 짚을 수 없는 요구는 explicit_request 가 아니라 inferred_outcomes 소관이다.`,
      `${at}.span`,
    );
    return { text, span: null };
  }
  if (Array.isArray(rawSpan) && rawSpan.length === 2) {
    return { text, span: { start: rawSpan[0], end: rawSpan[1] } };
  }
  if (typeof rawSpan === 'object' && !Array.isArray(rawSpan)
    && Object.hasOwn(rawSpan, 'start') && Object.hasOwn(rawSpan, 'end')) {
    return { text, span: { start: rawSpan.start, end: rawSpan.end } };
  }
  warn(
    WarningCode.SPAN_SHAPE,
    `${at}.span 이 [start, end] 도 {start, end} 도 아니다.`,
    `${at}.span`,
  );
  return { text, span: null };
}

/**
 * Project one contract-owned key back into the shape frontmatter stores it in.
 * This is the comparison operand for in-place revision: a value is re-rendered
 * only when this projection differs from what the file already holds.
 *
 * @param {string} key
 * @param {object} contract
 * @returns {unknown}
 */
function contractToFrontmatterValue(key, contract) {
  if (key === 'explicit_requests') {
    const list = Array.isArray(contract.explicit_requests) ? contract.explicit_requests : [];
    return list.map((r) => ({
      text: typeof r?.text === 'string' ? r.text : '',
      span: r?.span === null || r?.span === undefined ? null : [r.span.start, r.span.end],
    }));
  }
  if (key === 'review') {
    if (contract.review === null || contract.review === undefined) return undefined;
    /** @type {Record<string, unknown>} */
    const out = {};
    // `review.independent` in the artifact is `review.required` in the
    // contract: the schema's review block mirrors state.yaml
    // `{required, model, status}` and has additionalProperties:false, so
    // `independent` has no field of its own. Dropping it instead would delete
    // the mission's own review requirement from the contract entirely.
    if (Object.hasOwn(contract.review, 'required')) out.independent = contract.review.required;
    if (Object.hasOwn(contract.review, 'model')) out.model = contract.review.model;
    if (Object.hasOwn(contract.review, 'status')) out.status = contract.review.status;
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return contract[key];
}

/**
 * Fold frontmatter into the contract.
 *
 * @param {Record<string, unknown>} fm
 * @param {object} contract
 * @param {(code: string, message: string, path?: string) => void} warn
 * @returns {void}
 */
function applyFrontmatterToContract(fm, contract, warn) {
  for (const key of Object.keys(fm)) {
    if (!CONTRACT_FRONTMATTER_KEYS.includes(key) && !PRESERVED_FRONTMATTER_KEYS.includes(key)) {
      warn(
        WarningCode.FRONTMATTER_UNMAPPED_KEY,
        `frontmatter 키 '${key}' 는 계약에도 보존 목록에도 없다. 계약에서 누락된다.`,
        key,
      );
    }
  }
  for (const key of CONTRACT_FRONTMATTER_KEYS) {
    if (!Object.hasOwn(fm, key)) continue;
    const value = fm[key];
    if (value === null || value === undefined) continue;
    if (key === 'explicit_requests') {
      if (!Array.isArray(value)) {
        warn(WarningCode.EXPLICIT_REQUESTS_SHAPE, 'explicit_requests 가 배열이 아니다.', key);
        continue;
      }
      contract.explicit_requests = value.map((e, i) => normalizeExplicitRequest(e, i, warn));
      continue;
    }
    if (key === 'review') {
      if (typeof value !== 'object' || Array.isArray(value)) continue;
      /** @type {Record<string, unknown>} */
      const review = {};
      if (Object.hasOwn(value, 'independent')) review.required = value.independent;
      if (Object.hasOwn(value, 'required')) review.required = value.required;
      if (Object.hasOwn(value, 'model')) review.model = value.model;
      if (Object.hasOwn(value, 'status')) review.status = value.status;
      if (Object.keys(review).length > 0) contract.review = review;
      continue;
    }
    contract[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True when `p` names the one intent artifact a mission directory may hold.
 *
 * ALLOWLIST, not denylist: exactly `intent.md` passes and every other basename
 * fails, so a name nobody has thought of yet is refused by default rather than
 * slipping through a list of known-bad names.
 *
 * Scope note: this judges a *mission artifact* path. The T-12 template at
 * `schemas/intent-md.template.md` is not a mission artifact and is correctly
 * refused by this function; callers apply it to `.artibot/missions/<id>/…`.
 *
 * @param {string} p Path or bare filename, `/` or `\` separated.
 * @returns {boolean}
 */
export function isAllowedIntentFilePath(p) {
  if (typeof p !== 'string' || p.trim() === '') return false;
  const base = p.replace(/\\/g, '/').split('/').filter((s) => s !== '').pop();
  return base === INTENT_ARTIFACT_BASENAME;
}

/**
 * Throw unless `p` is the one allowed intent artifact path.
 *
 * The module performs no I/O, so this is the hook a write site calls before
 * touching the disk — keeping "파생 파일 금지" enforceable without dragging
 * `fs` into a pure module.
 *
 * @param {string} p
 * @returns {void}
 * @throws {Error} When the basename is anything but `intent.md`.
 */
export function assertIntentFilePath(p) {
  if (isAllowedIntentFilePath(p)) return;
  throw new Error(
    `파생 intent 파일 금지: '${p}' — 한 Mission 에는 '${INTENT_ARTIFACT_BASENAME}' 하나만 존재한다. `
    + `Intent 가 바뀌면 새 파일을 만들지 말고 이 파일을 고친 뒤 intent_revision 을 올려라. `
    + `(알려진 위반 예: ${KNOWN_DERIVED_INTENT_NAMES.join(' · ')})`,
  );
}

/**
 * Check `explicit_requests[].span` against the preserved original request text.
 *
 * Spans are offsets into `## Original Request` **after** HTML comment removal
 * and trimming — the same string {@link parseIntentMd} returns as
 * `source.originalRequest`, so caller and parser measure against one operand.
 *
 * The rule is EXACT MATCH: `originalRequest.slice(start, end)` must be
 * byte-identical to `text`. Summarising, normalising or translating a request
 * into `text` is a violation, not a convenience — an entry that no longer
 * quotes the user is exactly the substitution the fidelity rule forbids
 * (design 3.1, owner ruling 2026-09-02 overriding the template's `:46`
 * wording, which T-12 is correcting).
 *
 * **The canonical checker is `lib/mission/contract.js#verifyExplicitRequestSpans`.**
 * This function exists for EARLY DETECTION at parse time, so a bad span is
 * reported next to the text it came from rather than several stages later. The
 * two apply one rule; if they ever disagree, contract.js is right and this is
 * the bug. What is added here is the range diagnosis (null · malformed shape ·
 * inverted · past the end) that tells an author WHY the match failed.
 *
 * @param {object} contract Mission contract (or anything with `explicit_requests`).
 * @param {string} originalRequest
 * @returns {{ ok: boolean, issues: { code: string, severity: string,
 *   message: string, path: string }[] }}
 */
export function checkSpanConsistency(contract, originalRequest) {
  /** @type {{ code: string, severity: string, message: string, path: string }[]} */
  const issues = [];
  const push = (code, message, path) => {
    issues.push({ code, severity: WARNING_SEVERITY[code], message, path });
  };
  const text = typeof originalRequest === 'string' ? originalRequest : '';
  const list = Array.isArray(contract?.explicit_requests) ? contract.explicit_requests : [];
  list.forEach((req, i) => {
    const at = `explicit_requests[${i}].span`;
    const span = req?.span;
    if (span === null || span === undefined) {
      push(
        WarningCode.SPAN_NULL,
        `${at} 이 null 이다. 원문에서 위치를 짚을 수 없는 요구는 explicit_request 가 아니라 inferred_outcomes 소관이다.`,
        at,
      );
      return;
    }
    const { start, end } = span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      push(
        WarningCode.SPAN_INVALID_RANGE,
        `${at} = [${start}, ${end}] 는 0 이상 정수이고 start <= end 여야 한다.`,
        at,
      );
      return;
    }
    if (end > text.length) {
      push(
        WarningCode.SPAN_OUT_OF_BOUNDS,
        `${at}.end = ${end} 가 '## Original Request' 길이 ${text.length} 를 넘는다.`,
        at,
      );
      return;
    }
    const expected = typeof req.text === 'string' ? req.text : '';
    const actual = text.slice(start, end);
    if (actual !== expected) {
      push(
        WarningCode.SPAN_TEXT_MISMATCH,
        `${at} 이 가리키는 원문은 ${JSON.stringify(actual)} 인데 text 는 ${JSON.stringify(expected)} 다. `
        + '원문을 그대로 잘라야 하며 요약·정규화·번역은 금지다.',
        at,
      );
    }
  });
  return { ok: issues.length === 0, issues };
}

/**
 * Parse an `intent.md` document into a mission contract.
 *
 * Pure: no file is read or written. Never throws on malformed input — a
 * document that cannot be fully understood parses as far as it can and reports
 * the rest through `warnings`, because the caller's next step is the T-13
 * schema port, which is where fail-closed judgement belongs.
 *
 * @param {string} text Full `intent.md` text.
 * @returns {{
 *   contract: object,
 *   warnings: { code: string, severity: string, message: string, path?: string }[],
 *   source: {
 *     hasFrontmatter: boolean,
 *     frontmatter: Record<string, unknown>,
 *     sections: Record<string, string | string[]>,
 *     originalRequest: string,
 *     eol: string,
 *   },
 * }}
 */
export function parseIntentMd(text) {
  /** @type {{ code: string, severity: string, message: string, path?: string }[]} */
  const warnings = [];
  const warn = (code, message, path) => {
    const severity = WARNING_SEVERITY[code];
    warnings.push(path === undefined
      ? { code, severity, message }
      : { code, severity, message, path });
  };

  const raw = typeof text === 'string' ? text : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  const { hasFrontmatter, fmStart, fmEnd, bodyStart } = locateFrontmatter(lines);

  /** @type {Record<string, unknown>} */
  let frontmatter = {};
  if (!hasFrontmatter) {
    warn(
      WarningCode.FRONTMATTER_MISSING,
      "문서 앞머리에 '---' 로 닫힌 frontmatter 블록이 없다. frontmatter 유래 계약 필드는 전부 비게 된다.",
    );
  } else {
    const flags = { unsupported: false };
    // Work on a copy: parseSequence rewrites `- key:` item headers in place.
    const fmLines = lines.slice(fmStart, fmEnd);
    const parsed = parseBlock(fmLines, 0, 0, flags);
    frontmatter = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? parsed.value
      : {};
    if (flags.unsupported) {
      warn(
        WarningCode.FRONTMATTER_UNSUPPORTED,
        'frontmatter 에 이 최소 파서가 다루지 않는 YAML 기능(블록 스칼라 · 앵커 · 복합 키)이 있다. 해당 값은 신뢰할 수 없다.',
      );
    }
  }

  /** @type {object} */
  const contract = {};
  applyFrontmatterToContract(frontmatter, contract, warn);

  const sectionBlocks = locateSections(lines, bodyStart);
  /** @type {Record<string, string | string[]>} */
  const sections = {};
  for (const spec of INTENT_SECTIONS) {
    const block = sectionBlocks.find((s) => s.header === spec.header);
    if (!block) {
      warn(
        WarningCode.SECTION_MISSING,
        `템플릿 절 '${spec.header}' 가 없다. 빈 절과 없는 절은 다른 정보다 — 빈 절은 "아직 안 채웠다", 없는 절은 "이 축을 생각하지 않았다".`,
        spec.header,
      );
      sections[spec.key] = spec.kind === 'text' || spec.kind === 'raw' ? '' : [];
      continue;
    }
    sections[spec.key] = extractSectionValue(lines, block, spec.kind, warn);
  }

  // Success and scope are always present as objects: the contract marks both
  // required, and an absent container reads as "not parsed" where an empty one
  // reads as "parsed, nothing there".
  contract.goal = /** @type {string} */ (sections.interpreted_goal);
  contract.scope = {
    requested_target: sections.explicit_scope,
    bounded_blindspots: sections.bounded_blindspots,
    excluded: sections.excluded,
  };
  contract.success = {
    functional: sections.functional,
    behavioral: sections.behavioral,
    regression: sections.regression,
    evidence: sections.evidence,
  };
  contract.constraints = sections.constraints;
  contract.completion = { expected_actions: sections.completion };
  contract.user_decisions = sections.user_decisions;

  const originalRequest = /** @type {string} */ (sections.original_request);
  // normalizeExplicitRequest already reported some of these while reading the
  // frontmatter. Dedupe on (code, path) rather than skipping SPAN_NULL by name:
  // a legacy string entry reports LEGACY there and still carries a null span, so
  // a blanket skip would drop the span finding for exactly the entries that need
  // it most.
  const reported = new Set(warnings.map((w) => [w.code, w.path].join('|')));
  for (const issue of checkSpanConsistency(contract, originalRequest).issues) {
    const key = [issue.code, issue.path].join('|');
    if (reported.has(key)) continue;
    reported.add(key);
    warn(issue.code, issue.message, issue.path);
  }

  return {
    contract,
    warnings,
    source: { hasFrontmatter, frontmatter, sections, originalRequest, eol },
  };
}

/**
 * Render section content back to markdown lines.
 *
 * @param {string} kind
 * @param {string | string[]} value
 * @returns {string[]}
 */
function renderSectionContent(kind, value) {
  if (kind === 'text' || kind === 'raw') {
    const s = typeof value === 'string' ? value : '';
    return s === '' ? [] : s.split('\n');
  }
  if (kind === 'checklist') {
    const checked = Array.isArray(value) ? value : [];
    const extras = checked.filter((a) => !COMPLETION_ACTIONS.includes(a));
    return [
      ...COMPLETION_ACTIONS.map((a) => `- [${checked.includes(a) ? 'x' : ' '}] ${a}`),
      ...extras.map((a) => `- [x] ${a}`),
    ];
  }
  const items = Array.isArray(value) ? value : [];
  return items.map((i) => `- ${i}`);
}

/**
 * Build a complete `intent.md` from a contract alone.
 *
 * Used when there is no prior file. The template's guidance comments are NOT
 * reproduced — they belong to `schemas/intent-md.template.md`, and copying them
 * into every mission would fork the guidance. All 15 sections are emitted even
 * when empty, because a missing section and an empty one say different things.
 *
 * `## Systemic Scope` and `## Intent Refinements` come out empty: both accrue
 * during a mission and the contract has no field to rebuild them from, so a
 * first write legitimately has nothing to put there.
 *
 * @param {object} contract
 * @param {string} originalRequest Raw user text for `## Original Request`.
 * @returns {string[]}
 */
function renderFreshDocument(contract, originalRequest) {
  /** @type {string[]} */
  const out = [FENCE];
  for (const key of CONTRACT_FRONTMATTER_KEYS) {
    const value = contractToFrontmatterValue(key, contract);
    if (value === undefined) continue;
    out.push(...renderYamlKey(key, value, 0));
  }
  for (const key of PRESERVED_FRONTMATTER_KEYS) {
    if (key === 'actor') out.push('actor:', '  type:', '  id:');
    else out.push(`${key}:`);
  }
  out.push(FENCE, '', '# Intent', '');
  for (const spec of INTENT_SECTIONS) {
    out.push(spec.header, '');
    let value = '';
    if (spec.key === 'original_request') value = originalRequest;
    else if (spec.path !== null) value = projectSectionValue(spec, contract);
    const body = renderSectionContent(spec.kind, value);
    if (body.length > 0) out.push(...body, '');
  }
  return out;
}

/**
 * The value a section should hold given the contract.
 *
 * @param {{ kind: string, path: string | null }} spec
 * @param {object} contract
 * @returns {string | string[]}
 */
function projectSectionValue(spec, contract) {
  if (spec.path === null) return spec.kind === 'raw' || spec.kind === 'text' ? '' : [];
  const value = getPath(contract, spec.path);
  if (spec.kind === 'text' || spec.kind === 'raw') return typeof value === 'string' ? value : '';
  return Array.isArray(value) ? value : [];
}

/**
 * Serialize a mission contract back to `intent.md`.
 *
 * Two modes:
 *
 *   - **제자리 revision** (`options.originalText` given). The original document
 *     is the base. Only frontmatter keys and body sections whose value actually
 *     changed are re-rendered; comments, provenance, preamble, unknown keys and
 *     untouched prose survive byte for byte. With an unmodified contract the
 *     output is byte-identical to the input.
 *   - **from scratch** (no `originalText`). A complete 15-section skeleton.
 *
 * Sections with no contract field (`## Original Request`, `## Systemic Scope`,
 * `## Success Criteria`, `## Intent Refinements`) are never rewritten in
 * revision mode — the contract holds nothing to rewrite them from, so touching
 * them could only lose text.
 *
 * `options.originalRequest` supplies `## Original Request` on a FIRST write,
 * where there is no prior file to carry it over from and every
 * `explicit_requests[].span` would otherwise point into an empty string. It is
 * REFUSED in revision mode: the template's own rule is that editing that section
 * breaks every span, so accepting the argument and quietly ignoring it would be
 * worse than saying no.
 *
 * @param {object} contract
 * @param {{ originalText?: string, originalRequest?: string, targetPath?: string }} [options]
 * @returns {string}
 * @throws {Error} When `options.targetPath` is not the allowed artifact path, or
 *   when `originalRequest` is combined with `originalText`.
 */
export function serializeIntentMd(contract, options = {}) {
  const { originalText, originalRequest, targetPath } = options;
  if (targetPath !== undefined) assertIntentFilePath(targetPath);
  if (contract === null || typeof contract !== 'object') {
    throw new TypeError('serializeIntentMd: contract 는 객체여야 한다.');
  }

  const hasOriginalText = typeof originalText === 'string' && originalText !== '';
  if (originalRequest !== undefined && hasOriginalText) {
    throw new Error(
      'serializeIntentMd: originalRequest 는 최초 작성에만 쓴다. 제자리 개정에서 '
      + "'## Original Request' 를 다시 쓰면 explicit_requests[].span 이 전부 깨진다.",
    );
  }
  if (!hasOriginalText) {
    return renderFreshDocument(
      contract,
      typeof originalRequest === 'string' ? originalRequest : '',
    ).join('\n');
  }

  const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
  const lines = originalText.replace(/\r\n/g, '\n').split('\n');
  const { hasFrontmatter, fmStart, fmEnd, bodyStart } = locateFrontmatter(lines);
  const prior = parseIntentMd(originalText);

  /** @type {{ start: number, end: number, lines: string[] }[]} */
  const edits = [];

  if (hasFrontmatter) {
    const keyBlocks = locateFrontmatterKeys(lines, fmStart, fmEnd);
    /** @type {string[]} */
    const appended = [];
    for (const key of CONTRACT_FRONTMATTER_KEYS) {
      const next = contractToFrontmatterValue(key, contract);
      if (next === undefined) continue;
      const block = keyBlocks.find((b) => b.key === key);
      if (!block) {
        appended.push(...renderYamlKey(key, next, 0));
        continue;
      }
      if (deepEqual(next, prior.source.frontmatter[key])) continue;
      edits.push({
        start: block.start,
        end: contentEndOfBlock(lines, block),
        lines: renderYamlKey(key, next, 0),
      });
    }
    if (appended.length > 0) edits.push({ start: fmEnd, end: fmEnd, lines: appended });
  }

  const sectionBlocks = locateSections(lines, bodyStart);
  for (const spec of INTENT_SECTIONS) {
    if (spec.path === null) continue;
    const block = sectionBlocks.find((s) => s.header === spec.header);
    if (!block) continue;
    const next = projectSectionValue(spec, contract);
    if (deepEqual(next, prior.source.sections[spec.key])) continue;
    // Keep one blank line after the header and one before the next section, so
    // a rewritten section reads like the ones around it.
    const body = renderSectionContent(spec.kind, next);
    edits.push({
      start: block.contentStart,
      end: block.end,
      lines: body.length > 0 ? ['', ...body, ''] : [''],
    });
  }

  edits.sort((a, b) => b.start - a.start);
  const out = lines.slice();
  for (const edit of edits) out.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return out.join(eol);
}
