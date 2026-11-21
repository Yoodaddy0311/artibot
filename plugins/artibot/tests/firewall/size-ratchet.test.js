/**
 * Size ratchet: file length (max-lines 800) and function length
 * (max-lines-per-function 50) may only go DOWN (2026-11-21 PRD M9).
 *
 * WHY A RATCHET AND NOT A LINT RULE: the 800/50 standard (.artibot/project.md, CONTRIBUTING.md
 * "Functions > 50 lines") was never enforced by eslint.config.js, and the tree already
 * violates it, so turning the rules on would make `npm run lint` red on day one. The
 * baseline (fixtures/size-ratchet-baseline.json) records every current violation with its
 * measured size; this gate is red when a violation is NEW or an existing one GROWS.
 * Shrinking is green — tighten the baseline afterwards (see "UPDATING" below) so the
 * slack cannot be spent again.
 *
 * MEASUREMENT (decisions, with reasons)
 *  - Engine: eslint's own `max-lines` / `max-lines-per-function` through the Node API
 *    (`ESLint` class, the repo's installed eslint — 10.2.1 when written). The gate does
 *    not count lines itself, so "the standard" and "what eslint reports" cannot drift.
 *  - Config: `overrideConfigFile: true` with a config declared here, NOT eslint.config.js.
 *    The repo config's other rules would only add time and failure modes; the scope is
 *    stated below instead of being inherited.
 *  - `allowInlineConfig: false`: an `eslint-disable max-lines` comment in a source file
 *    cannot exempt it from this gate (self-tested below).
 *  - Scope: lib/, scripts/, bin/ (.js/.mjs) and server/ (.js) — the shipped source that
 *    eslint.config.js lints. hooks/ holds only JSON. tests/ is OUT of scope: every
 *    `describe` callback is a function far over 50 lines, so the function rule is
 *    meaningless there, and a file ratchet on tests would make "add a regression test to
 *    an existing long test file" red — friction on exactly the work TDD asks for.
 *    (Measured 2026-11-21: tests/ has 56 files over 800 lines of 973 files.)
 *  - File lines: RAW (no skipBlankLines / skipComments). Every 800-line measurement in this
 *    repo's history (.artibot/guides/v5-design/V5-BACKLOG.md) is `wc -l`, and eslint's
 *    max-lines drops a trailing empty line, so the number equals `wc -l` for a file that
 *    ends in a newline (self-tested below).
 *  - Function lines: skipComments + skipBlankLines. This codebase documents decisions in
 *    comments INSIDE function bodies; counting them would make adding an explanation to an
 *    over-long function red, i.e. the gate would push toward deleting documentation.
 *    `IIFEs: true` so an immediately-invoked function is measured instead of skipped
 *    (eslint's default skips it).
 *
 * FUNCTION IDENTITY: a key, not a line number (line numbers move with unrelated edits).
 *   key = `<file>#<seg>[><seg>...]` — the chain of enclosing named scopes, outermost first:
 *   functions (declared name; method/property/class-field key; variable or assignment
 *   target; `default` for export default; `callee('first string arg')` for a callback;
 *   `<iife>`; `<anonymous>` otherwise), named classes, and variable/property names that
 *   wrap a non-function initializer (`const x = memo(() => ...)` -> `x>memo()`).
 *   Two functions with the same chain in one file get `~2`, `~3`... in source order.
 *   Limits of the key:
 *    - Renaming a function (or an enclosing scope) changes its key: the gate then reports
 *      a NEW violation and the old baseline entry as resolved. Rename = update baseline.
 *    - The `~N` ordinal depends on order: inserting an over-limit function with the same
 *      chain ABOVE an existing one swaps their ordinals, and a swap can read as growth.
 *    - Computed keys collapse to `[computed]`, non-literal callees to `[expr]`, so such
 *      functions are distinguished by ordinal only.
 *
 * WHAT THIS GATE CANNOT SEE
 *  1. Anything outside the scope above (tests/, .cjs files, cowork plugin, root scripts).
 *  2. Growth that stays under the limit: a 700-line file growing to 799 is green.
 *  3. Growth inside an existing violation up to its recorded number after it shrank, until
 *     the baseline is tightened (the ratchet only moves when someone tightens it).
 *  4. Lines moved out of a function into a new helper that is itself just under 50, or a
 *     file split into two 799-line files — the gate measures length, not design.
 *  5. Comment-only and blank lines inside functions (by decision, see above).
 *  6. A violation whose key changes (rename/ordinal swap) AND shrinks at the same time is
 *     still reported as new — the gate errs red, not green, there.
 *
 * FAIL-CLOSED: red when eslint cannot be loaded, the baseline is missing / unparsable /
 * measured with different limits or options, the scope matches fewer files than
 * MIN_FILES, or any max-lines-per-function report cannot be given a key.
 *
 * UPDATING (env var, never in CI):
 *   SIZE_RATCHET_UPDATE=tighten    lower recorded sizes / drop resolved entries. Never
 *                                  adds or raises an entry — new or grown stays red.
 *   SIZE_RATCHET_UPDATE=bootstrap  write the full measurement, ONLY if the baseline file
 *                                  does not exist.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL('./fixtures/size-ratchet-baseline.json', import.meta.url));

const LIMITS = Object.freeze({ fileMaxLines: 800, functionMaxLines: 50 });
const FN_OPTIONS = Object.freeze({ skipComments: true, skipBlankLines: true, IIFEs: true });
const FILE_OPTIONS = Object.freeze({ skipComments: false, skipBlankLines: false });
const SCOPE = Object.freeze(['lib/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'bin/**/*.{js,mjs}', 'server/**/*.js']);
/** Measured 2026-11-21: 622 files in SCOPE. A large drop means the scope broke, not that code vanished. */
const MIN_FILES = 500;

/**
 * Load eslint's ESLint class. Rejects (fail-closed) when the module cannot be imported.
 * @param {string} specifier
 */
async function loadEslint(specifier) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (err) {
    throw new Error(`size-ratchet: cannot import ${specifier} (${err.message}) — the gate cannot measure, so it fails.`, { cause: err });
  }
  if (typeof mod.ESLint !== 'function') throw new Error(`size-ratchet: ${specifier} has no ESLint class.`);
  return mod.ESLint;
}

// ---------------------------------------------------------------------------
// Function keys (companion rule)
// ---------------------------------------------------------------------------

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function propName(key, computed) {
  if (computed) return '[computed]';
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  if (key.type === 'Literal') return String(key.value);
  return '[key]';
}

function memberText(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Super') return 'super';
  if (node.type === 'MemberExpression') return `${memberText(node.object)}.${propName(node.property, node.computed)}`;
  return '[expr]';
}

function callSegment(call, fn) {
  if (call.callee === fn) return '<iife>';
  const first = call.arguments[0];
  const label = first && first !== fn && first.type === 'Literal' && typeof first.value === 'string'
    ? `'${first.value.slice(0, 40)}'`
    : '';
  return `${memberText(call.callee)}(${label})`;
}

/** Name of one function node, from the function itself or from where it sits. */
function functionSegment(fn) {
  const p = fn.parent;
  if (fn.id) return fn.id.name;
  if (['MethodDefinition', 'Property', 'PropertyDefinition'].includes(p.type) && p.value === fn) {
    const name = propName(p.key, p.computed);
    return p.kind === 'get' || p.kind === 'set' ? `${p.kind} ${name}` : name;
  }
  if (p.type === 'VariableDeclarator' && p.init === fn && p.id.type === 'Identifier') return p.id.name;
  if ((p.type === 'AssignmentExpression' || p.type === 'AssignmentPattern') && p.right === fn) return memberText(p.left);
  if (p.type === 'ExportDefaultDeclaration') return 'default';
  if (p.type === 'CallExpression' || p.type === 'NewExpression') return callSegment(p, fn);
  return '<anonymous>';
}

/** Segment contributed by a non-function ancestor, or null when it names nothing. */
function scopeSegment(node) {
  if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id) return node.id.name;
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && !FUNCTION_TYPES.has(node.init?.type)) return node.id.name;
  if ((node.type === 'Property' || node.type === 'PropertyDefinition') && !FUNCTION_TYPES.has(node.value?.type)) {
    return propName(node.key, node.computed);
  }
  return null;
}

/** `outer>inner` chain for a function node (outermost first). */
function functionChain(fn) {
  const segs = [];
  for (let n = fn; n; n = n.parent) {
    const seg = FUNCTION_TYPES.has(n.type) ? functionSegment(n) : scopeSegment(n);
    if (seg !== null) segs.unshift(seg);
  }
  return segs.join('>');
}

/** Same node selection as eslint's max-lines-per-function#isEmbedded (it reports on the method). */
function reportNodeOf(fn) {
  const p = fn.parent;
  const embedded = p && p.value === fn && (p.type === 'MethodDefinition'
    || (p.type === 'Property' && (p.method === true || p.kind === 'get' || p.kind === 'set')));
  return embedded ? p : fn;
}

/**
 * Reports a key for every function whose RAW span exceeds the limit — a superset of what
 * max-lines-per-function reports (its count skips lines, never adds them), joined to it
 * by report location.
 */
const fnKeyRule = {
  meta: { type: 'suggestion', schema: [] },
  create(context) {
    const check = (fn) => {
      const node = reportNodeOf(fn);
      if (node.loc.end.line - node.loc.start.line + 1 <= LIMITS.functionMaxLines) return;
      context.report({ node, message: functionChain(fn) });
    };
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
};

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function createLinter(ESLint) {
  return new ESLint({
    cwd: PLUGIN_ROOT,
    overrideConfigFile: true,
    allowInlineConfig: false,
    overrideConfig: [{
      files: ['**/*.{js,mjs}'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { 'size-ratchet': { rules: { 'fn-key': fnKeyRule } } },
      rules: {
        'max-lines': ['error', { max: LIMITS.fileMaxLines, ...FILE_OPTIONS }],
        'max-lines-per-function': ['error', { max: LIMITS.functionMaxLines, ...FN_OPTIONS }],
        'size-ratchet/fn-key': 'error',
      },
    }],
  });
}

const COUNT_RE = /\((\d+)\)\. Maximum allowed is \d+\.$/;
const locKey = (m) => `${m.line}:${m.column}:${m.endLine}:${m.endColumn}`;

function countOf(message) {
  const m = COUNT_RE.exec(message.message);
  if (!m) throw new Error(`size-ratchet: unparsable ${message.ruleId} message: ${message.message}`);
  return Number(m[1]);
}

/** One eslint result -> { file: n|undefined, functions: {chain: n} }. Throws on a keyless report. */
function measureResult(rel, result) {
  const fatal = result.messages.find((m) => m.fatal);
  if (fatal) throw new Error(`size-ratchet: ${rel} did not parse: ${fatal.message}`);
  const keys = new Map(result.messages.filter((m) => m.ruleId === 'size-ratchet/fn-key').map((m) => [locKey(m), m.message]));
  const reports = result.messages
    .filter((m) => m.ruleId === 'max-lines-per-function')
    .sort((a, b) => a.line - b.line || a.column - b.column);
  const functions = {};
  for (const m of reports) {
    const chain = keys.get(locKey(m));
    if (chain === undefined) throw new Error(`size-ratchet: no key for the function at ${rel}:${m.line}:${m.column}`);
    let key = chain;
    for (let n = 2; key in functions; n++) key = `${chain}~${n}`;
    functions[key] = countOf(m);
  }
  const fileMsg = result.messages.find((m) => m.ruleId === 'max-lines');
  return { file: fileMsg ? countOf(fileMsg) : undefined, functions };
}

/** Fold eslint results into `{ fileCount, files, functions }` keyed by plugin-relative POSIX path. */
function collect(results) {
  const out = { fileCount: results.length, files: {}, functions: {} };
  for (const r of results) {
    const rel = path.relative(PLUGIN_ROOT, r.filePath).split(path.sep).join('/');
    const { file, functions } = measureResult(rel, r);
    if (file !== undefined) out.files[rel] = file;
    if (Object.keys(functions).length > 0) out.functions[rel] = functions;
  }
  return out;
}

function assertDenominator(fileCount) {
  if (!(fileCount >= MIN_FILES)) {
    throw new Error(`size-ratchet: measured ${fileCount} files, expected at least ${MIN_FILES} — the scope is broken, a green result would be vacuous.`);
  }
}

// ---------------------------------------------------------------------------
// Baseline + comparison
// ---------------------------------------------------------------------------

function readBaseline(file) {
  if (!existsSync(file)) throw new Error(`size-ratchet: baseline missing at ${file}`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`size-ratchet: baseline unparsable (${err.message})`, { cause: err });
  }
  const sameOptions = JSON.stringify(data?.limits) === JSON.stringify(LIMITS)
    && JSON.stringify(data?.functionOptions) === JSON.stringify(FN_OPTIONS)
    && JSON.stringify(data?.fileOptions) === JSON.stringify(FILE_OPTIONS)
    && JSON.stringify(data?.scope) === JSON.stringify(SCOPE);
  if (!sameOptions) throw new Error('size-ratchet: baseline was measured with different limits/options/scope — re-measure, do not mix.');
  if (typeof data.files !== 'object' || typeof data.functions !== 'object' || !data.files || !data.functions) {
    throw new Error('size-ratchet: baseline lacks files/functions maps');
  }
  return data;
}

/** Flatten `{file: {chain: n}}` to `{"file#chain": n}`. */
const flatFunctions = (fns) => Object.fromEntries(
  Object.entries(fns).flatMap(([file, m]) => Object.entries(m).map(([k, n]) => [`${file}#${k}`, n])),
);

function diffMaps(base, now) {
  const out = { added: [], grown: [], shrunk: [], resolved: [] };
  for (const [k, n] of Object.entries(now)) {
    if (!(k in base)) out.added.push(`${k} = ${n}`);
    else if (n > base[k]) out.grown.push(`${k}: ${base[k]} -> ${n}`);
    else if (n < base[k]) out.shrunk.push(`${k}: ${base[k]} -> ${n}`);
  }
  for (const k of Object.keys(base)) if (!(k in now)) out.resolved.push(k);
  return out;
}

/** Ratchet verdict: red entries are `added` + `grown`; `shrunk` + `resolved` are tightening hints. */
function compareRatchet(baseline, measured) {
  const files = diffMaps(baseline.files, measured.files);
  const fns = diffMaps(flatFunctions(baseline.functions), flatFunctions(measured.functions));
  const red = [
    ...files.added.map((s) => `NEW file over ${LIMITS.fileMaxLines}: ${s}`),
    ...files.grown.map((s) => `GREW file: ${s}`),
    ...fns.added.map((s) => `NEW function over ${LIMITS.functionMaxLines}: ${s}`),
    ...fns.grown.map((s) => `GREW function: ${s}`),
  ];
  const slack = [...files.shrunk, ...files.resolved, ...fns.shrunk, ...fns.resolved];
  return { red, slack };
}

function baselineDoc(measured) {
  return {
    note: 'Generated by tests/firewall/size-ratchet.test.js (SIZE_RATCHET_UPDATE). Entries may only go down.',
    measuredAt: new Date().toISOString().slice(0, 10),
    limits: LIMITS, fileOptions: FILE_OPTIONS, functionOptions: FN_OPTIONS, scope: SCOPE,
    measuredFileCount: measured.fileCount,
    files: measured.files,
    functions: measured.functions,
  };
}

/** min-merge: keep only entries still present, at min(recorded, measured). Never adds or raises. */
function tighten(baseline, measured) {
  const files = {};
  for (const [k, n] of Object.entries(baseline.files)) if (k in measured.files) files[k] = Math.min(n, measured.files[k]);
  const functions = {};
  for (const [file, m] of Object.entries(baseline.functions)) {
    for (const [k, n] of Object.entries(m)) {
      const now = measured.functions[file]?.[k];
      if (now !== undefined) (functions[file] ??= {})[k] = Math.min(n, now);
    }
  }
  return { ...baselineDoc({ ...measured, files, functions }) };
}

const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const lines = (n, make) => Array.from({ length: n }, (_, i) => make(i)).join('\n');
/** A function whose eslint count (header + body + closing brace) is exactly `n`. */
const fnOfLength = (name, n) => `export function ${name}() {\n${lines(n - 2, (i) => `  void ${i};`)}\n}\n`;

describe('size ratchet: self-checks on synthetic input', () => {
  let linter;
  beforeAll(async () => {
    linter = createLinter(await loadEslint('eslint'));
  });

  const measureText = async (code, rel = 'lib/__size_probe__/probe.js') => {
    const results = await linter.lintText(code, { filePath: path.join(PLUGIN_ROOT, rel) });
    return collect(results);
  };

  it('reports a file of 801 lines and not one of 800 (wc -l semantics, trailing newline)', async () => {
    const at = (n) => `${lines(n, (i) => `export const v${i} = ${i};`)}\n`;
    expect((await measureText(at(801))).files).toEqual({ 'lib/__size_probe__/probe.js': 801 });
    expect((await measureText(at(800))).files).toEqual({});
  });

  it('reports a 51-line function and not a 50-line one', async () => {
    expect((await measureText(fnOfLength('big', 51))).functions).toEqual({ 'lib/__size_probe__/probe.js': { big: 51 } });
    expect((await measureText(fnOfLength('ok', 50))).functions).toEqual({});
  });

  it('does not count comment and blank lines inside a function (by decision)', async () => {
    const body = `${lines(48, (i) => `  void ${i};`)}\n${lines(20, () => '  // why')}\n\n\n`;
    expect((await measureText(`export function documented() {\n${body}}\n`)).functions).toEqual({});
  });

  it('an inline eslint-disable cannot exempt a file or function', async () => {
    const code = `/* eslint-disable max-lines, max-lines-per-function */\n${fnOfLength('hidden', 60)}${lines(800, (i) => `export const v${i} = ${i};`)}\n`;
    const m = await measureText(code);
    expect(Object.keys(m.files)).toEqual(['lib/__size_probe__/probe.js']);
    expect(m.functions['lib/__size_probe__/probe.js']).toEqual({ hidden: 60 });
  });

  it('keys are stable under unrelated edits above and name methods, callbacks, nesting and duplicates', async () => {
    const big = lines(55, (i) => `    void ${i};`);
    const code = [
      'export class Engine {', `  run() {\n${big}\n  }`, '}',
      `export const handlers = { onEvent: wrap(() => {\n${big}\n}) };`,
      `register('alpha', () => {\n${big}\n});`,
      `register('alpha', () => {\n${big}\n});`,
      `export function outer() {\n  const inner = () => {\n${big}\n  };\n  return inner;\n}`,
      `(() => {\n${big}\n})();`,
    ].join('\n');
    const keysOf = async (src) => Object.keys((await measureText(src)).functions['lib/__size_probe__/probe.js']).sort();
    const keys = await keysOf(code);
    expect(keys).toEqual([
      '<iife>', 'Engine>run', "handlers>onEvent>wrap()", 'outer', 'outer>inner',
      "register('alpha')", "register('alpha')~2",
    ].sort());
    expect(await keysOf(`// header\n\n\nimport x from 'y';\nvoid x;\n${code}`)).toEqual(keys);
  });

  it('a parse error is red, not a silent zero', async () => {
    await expect(measureText('export function (')).rejects.toThrow(/did not parse/);
  });
});

describe('size ratchet: fail-closed paths', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'size-ratchet-'));
    return () => rmSync(dir, { recursive: true, force: true });
  });
  const good = () => baselineDoc({ fileCount: 600, files: { 'lib/a.js': 900 }, functions: { 'lib/a.js': { f: 70 } } });

  it('an unimportable eslint rejects', async () => {
    await expect(loadEslint('eslint-size-ratchet-does-not-exist')).rejects.toThrow(/cannot import/);
  });

  it('a missing, unparsable, or differently-measured baseline throws', () => {
    expect(() => readBaseline(path.join(dir, 'absent.json'))).toThrow(/baseline missing/);
    writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    expect(() => readBaseline(path.join(dir, 'bad.json'))).toThrow(/unparsable/);
    writeJson(path.join(dir, 'other.json'), { ...good(), limits: { fileMaxLines: 900, functionMaxLines: 50 } });
    expect(() => readBaseline(path.join(dir, 'other.json'))).toThrow(/different limits/);
    writeJson(path.join(dir, 'ok.json'), good());
    expect(readBaseline(path.join(dir, 'ok.json')).files).toEqual({ 'lib/a.js': 900 });
  });

  it('a too-small denominator throws (no vacuous green)', () => {
    expect(() => assertDenominator(0)).toThrow(/vacuous/);
    expect(() => assertDenominator(MIN_FILES - 1)).toThrow(/vacuous/);
    expect(() => assertDenominator(MIN_FILES)).not.toThrow();
  });

  it('new and grown violations are red; shrunk and resolved are slack, not red', () => {
    const base = good();
    const same = compareRatchet(base, { files: { 'lib/a.js': 900 }, functions: { 'lib/a.js': { f: 70 } } });
    expect(same).toEqual({ red: [], slack: [] });
    const worse = compareRatchet(base, {
      files: { 'lib/a.js': 901, 'lib/b.js': 801 },
      functions: { 'lib/a.js': { f: 71, g: 51 } },
    });
    expect(worse.red).toEqual([
      'NEW file over 800: lib/b.js = 801', 'GREW file: lib/a.js: 900 -> 901',
      'NEW function over 50: lib/a.js#g = 51', 'GREW function: lib/a.js#f: 70 -> 71',
    ]);
    const better = compareRatchet(base, { files: { 'lib/a.js': 850 }, functions: {} });
    expect(better.red).toEqual([]);
    expect(better.slack).toEqual(['lib/a.js: 900 -> 850', 'lib/a.js#f']);
  });

  it('tighten only lowers and drops — it never adds or raises an entry', () => {
    const t = tighten(good(), { fileCount: 600, files: { 'lib/a.js': 950, 'lib/new.js': 900 }, functions: { 'lib/a.js': { f: 60, g: 99 } } });
    expect(t.files).toEqual({ 'lib/a.js': 900 });
    expect(t.functions).toEqual({ 'lib/a.js': { f: 60 } });
  });
});

describe('size ratchet: the real tree', () => {
  let measured;
  beforeAll(async () => {
    const linter = createLinter(await loadEslint('eslint'));
    measured = collect(await linter.lintFiles([...SCOPE]));
    const mode = process.env.SIZE_RATCHET_UPDATE;
    if (mode === 'bootstrap' && !existsSync(BASELINE_PATH)) writeJson(BASELINE_PATH, baselineDoc(measured));
    if (mode === 'tighten') writeJson(BASELINE_PATH, tighten(readBaseline(BASELINE_PATH), measured));
  }, 120_000);

  it(`measures at least ${MIN_FILES} files`, () => {
    assertDenominator(measured.fileCount);
  });

  it('has no new or grown size violation against the baseline', () => {
    const { red, slack } = compareRatchet(readBaseline(BASELINE_PATH), measured);
    if (slack.length > 0) {
      process.stderr.write(`size-ratchet: ${slack.length} baseline entr${slack.length === 1 ? 'y' : 'ies'} shrank or resolved — `
        + `tighten with SIZE_RATCHET_UPDATE=tighten:\n  ${slack.join('\n  ')}\n`);
    }
    expect(red, 'Split the file/function, or (only for a reviewed, deliberate exception) edit the baseline by hand.').toEqual([]);
  });
});
