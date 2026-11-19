/**
 * Orca read-verb allowlist gate (DESIGN §4.1-4, §4.1-6, §11.2).
 *
 * THE RULE: the `/orca` scripts under `scripts/orca/` may EXECUTE only Orca
 * verbs that read — status · repo list · agent-context · worktree show|list|ps
 * · orchestration worker-list|task-list|worker-show|inbox · orchestration check
 * (only with `--peek`) · terminal read. Everything that changes Orca
 * (run-create, task-create, worker-start, send, reply, task-update,
 * worker-release, worktree create|rm, terminal close, ...) is typed by the
 * leader, one line at a time, where the hooks and the host permission prompt
 * can see it — a script that started a worker would be permission laundering.
 * A bare `check` would take the leader's mail, and Orca's wake-up goes with it.
 *
 * HOW: the files are PARSED (espree), not grepped. Every call that reaches the
 * Orca binary is found and its argv must be a literal array whose verb path is
 * on the allowlist. A call that reaches Orca with an argv this scan cannot read
 * (a variable, a spread, a computed verb) is a violation too — unreadable is not
 * allowed. Allowlist, not denylist: a verb Orca adds tomorrow is refused today.
 *
 * WHAT THIS GATE CANNOT SEE (read this before trusting a green):
 *   - PRINTED command text. `close.mjs` and `bind.mjs` print `orca orchestration
 *     worker-release ...` for the leader; those are strings and are not scanned —
 *     that is the design, and the scanner's self-test proves it distinguishes them.
 *   - The printing helpers (`cmdLine`, `tryCmd`) and the path builders (`scriptPath`,
 *     `path.join` / `resolve`) are skipped BY NAME: a redefinition that executes would hide
 *     behind the name. Their definitions are in `status.mjs` and only join strings.
 *   - Orca reached by another route: an alias of the wrapper (`const run =
 *     callOrcaJson`), `.call` / `.apply`, a first argument that is not the literal
 *     `'orca'` (an env var, a path, `'orca.exe'` is covered but `process.env.X` is not),
 *     a child script that calls Orca (`worktree-setup.mjs`, `land.mjs` are outside this
 *     folder and this gate), or `lib/` code other than the `lib/git/orca-*.js` pair.
 *   - Files this scan does not read: anything under `scripts/orca/` that is not a
 *     `.mjs` file is itself a violation (no silent hole), but a script placed in
 *     another folder is not looked at.
 *   - Whether the allowlisted verbs are truly read-only inside Orca. `check --peek`,
 *     `terminal read` and `inbox` are documented as non-consuming in the schema
 *     (`orca agent-context --json`); P0 used `check --peek` once (receipt
 *     check-6-peek.json) and never ran `terminal read`. Documentation, not measurement.
 *   - The host permission layer and HG-14 (`lib/security/human-gates.js`): a separate
 *     gate on the same property, from the other side.
 *   - espree's AVAILABILITY. It resolves in this checkout only as an eslint transitive
 *     and is declared in no package.json — the same footing as
 *     `hook-emitter-sources-rule.test.js`. If eslint drops it this file goes RED with a
 *     module error, which is the correct loud failure; the fix is a devDependency, not
 *     a softer scan here.
 *
 * The scanner itself is proven below on synthetic sources that plant each
 * violation and each look-alike, and a mutation of the REAL `status.mjs` source
 * must turn it red — a gate that was never seen red proves nothing.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'espree';

import {
  assertReadOnlyOrcaArgv, callOrcaJson, cmdLine, orcaVerbOf, READ_ONLY_ORCA_VERBS as RUNTIME_ALLOWLIST, shellQuote, toPosix,
} from '../../scripts/orca/status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const RECEIPTS = path.join(PLUGIN_ROOT, 'tests', 'orca', 'fixtures', 'receipts');
const RUN_ID = 'run_3c01547fc37f';
const ORCA_SCRIPTS = path.join(PLUGIN_ROOT, 'scripts', 'orca');
const LIB_GIT = path.join(PLUGIN_ROOT, 'lib', 'git');
const ESPREE_OPTS = Object.freeze({ ecmaVersion: 2024, sourceType: 'module', loc: true });

/** DESIGN §11.2 — the one canonical list. The runtime guard in status.mjs must equal it. */
const ALLOWED_VERBS = Object.freeze([
  'status', 'repo list', 'agent-context', 'worktree show', 'worktree list', 'worktree ps',
  'orchestration worker-list', 'orchestration task-list', 'orchestration worker-show', 'orchestration inbox',
  'orchestration check', 'terminal read',
]);

// ── the scanner ─────────────────────────────────────────────────────────────

/** Calls that are "run this Orca argv" wrappers by name (`callOrcaJson`, `runOrca`, `orcaRead`, ...). */
const WRAPPER_NAME = /^(?:(?:call|run|exec|invoke|spawn)Orca[A-Za-z0-9]*|orca(?:Json|Read|Exec|Call)[A-Za-z0-9]*)$/;
const ORCA_BINARY = /^orca(?:\.exe|\.cmd)?$/i;
const SHELL_IMPORTS = new Set(['exec', 'execSync']);
/** The variadic helpers the scripts use to PRINT a command line (`cmdLine('orca', 'orchestration', ...)`, and `tryCmd`, its non-throwing twin) — they join strings, run nothing. Skipped by name (a blind spot, listed above). */
const PRINT_HELPERS = new Set(['cmdLine', 'tryCmd']);
/** Path builders: `'orca'` as their first argument is the FOLDER name (`scripts/orca`), not the binary. */
const PATH_HELPERS = new Set(['scriptPath', 'join', 'resolve']);

const stringValue = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
  return null;
};

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  return null;
}

function functionName(node, parent) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator') return parent.id?.name ?? '<anonymous>';
  if (parent?.type === 'Property' || parent?.type === 'MethodDefinition') return parent.key?.name ?? '<anonymous>';
  if (parent?.type === 'AssignmentExpression') return parent.left?.name ?? '<anonymous>';
  return '<anonymous>';
}

const FUNCTION_NODES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function walk(node, parent, fnStack, visit) {
  if (!node || typeof node.type !== 'string') return;
  const stack = FUNCTION_NODES.has(node.type) ? [...fnStack, functionName(node, parent)] : fnStack;
  visit(node, stack);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, node, stack, visit));
    else if (value && typeof value === 'object') walk(value, node, stack, visit);
  }
}

/**
 * The verb path of a literal argv: leading literal non-flag words (at most 2), or `null` when it cannot be read.
 * The first flag ends the verb path, so everything after it (ids, paths) may be a variable; a variable BEFORE
 * the first flag could be a verb word and makes the argv unreadable.
 */
function verbPathOf(elements) {
  const words = [];
  for (const el of elements) {
    const text = el ? stringValue(el) : null;
    if (text === null) return null;
    if (text.startsWith('-')) break;
    words.push(text);
    if (words.length === 2) break;
  }
  return words.length > 0 ? words : null;
}

function classifyArgv(arrayNode, line) {
  const verbs = verbPathOf(arrayNode.elements);
  if (verbs === null) return { violation: { line, rule: 'unclassifiable', detail: 'argv verb is not a readable literal (variable, spread or computed)' } };
  const verb = verbs.join(' ');
  if (!ALLOWED_VERBS.includes(verb)) return { violation: { line, rule: 'mutating-verb', detail: `"orca ${verb}" is not on the read-only allowlist` } };
  const peeked = arrayNode.elements.some((el) => el && stringValue(el) === '--peek');
  if (verb === 'orchestration check' && !peeked) return { violation: { line, rule: 'check-without-peek', detail: '"orca orchestration check" without --peek consumes the leader mail' } };
  return { invocation: { line, verb } };
}

/**
 * Scan one source text.
 * @returns {{ invocations: Array<{ line: number, verb: string }>, violations: Array<{ line: number, rule: string, detail: string }>, sinks: Array<{ line: number, enclosing: string }> }}
 */
export function scanSource(source) {
  const ast = parse(source, ESPREE_OPTS);
  const invocations = [];
  const violations = [];
  const sinks = [];
  walk(ast, null, [], (node, fnStack) => {
    const line = node.loc?.start.line ?? 0;
    if (node.type === 'ImportDeclaration' && /^(?:node:)?child_process$/.test(String(node.source.value))) {
      for (const spec of node.specifiers) {
        const imported = spec.type === 'ImportSpecifier' ? spec.imported.name : null;
        if (imported === null || SHELL_IMPORTS.has(imported)) violations.push({ line, rule: 'shell-import', detail: `child_process ${imported ?? 'namespace/default'} import (shell-capable or untraceable)` });
      }
    }
    if (node.type === 'Property' && !node.computed && (node.key.name === 'shell' || node.key.value === 'shell')) {
      const off = node.value.type === 'Literal' && node.value.value === false;
      if (!off) violations.push({ line, rule: 'shell-option', detail: 'a `shell` option other than literal false' });
    }
    if (node.type !== 'CallExpression') return;
    const name = calleeName(node.callee);
    if (name === 'execSync') violations.push({ line, rule: 'shell-import', detail: 'execSync runs through a shell' });
    if (name !== null && (PRINT_HELPERS.has(name) || PATH_HELPERS.has(name))) return;
    const first = stringValue(node.arguments[0]);
    const toOrcaBinary = first !== null && ORCA_BINARY.test(first);
    const wrapper = name !== null && WRAPPER_NAME.test(name);
    if (!toOrcaBinary && !wrapper) return;
    const array = node.arguments.find((arg) => arg.type === 'ArrayExpression');
    const second = node.arguments[1];
    if (toOrcaBinary && second?.type !== 'ArrayExpression') {
      if (second !== undefined && stringValue(second) !== null) {
        violations.push({ line, rule: 'unclassifiable', detail: `${name}('orca', 'word', ...) is a variadic call that is not the printing helper` });
      } else if (second === undefined) {
        violations.push({ line, rule: 'unclassifiable', detail: `${name}('orca') runs orca without a readable argv` });
      } else {
        sinks.push({ line, enclosing: fnStack[fnStack.length - 1] ?? '<module>' });
      }
      return;
    }
    if (!array) {
      violations.push({ line, rule: 'unclassifiable', detail: `${name}(...) reaches Orca with an argv that is not a literal array` });
      return;
    }
    const verdict = classifyArgv(array, line);
    if (verdict.violation) violations.push(verdict.violation);
    else invocations.push(verdict.invocation);
  });
  if (sinks.length > 1) violations.push({ line: sinks[1].line, rule: 'multiple-sinks', detail: `${sinks.length} places spawn orca with a variable argv; route every call through ONE wrapper` });
  for (const sink of sinks) {
    if (!/orca/i.test(sink.enclosing)) violations.push({ line: sink.line, rule: 'sink-outside-wrapper', detail: `orca is spawned with a variable argv inside "${sink.enclosing}", which is not an Orca wrapper` });
  }
  return { invocations, violations, sinks };
}

// ── the files ───────────────────────────────────────────────────────────────

const orcaScriptEntries = fs.readdirSync(ORCA_SCRIPTS, { withFileTypes: true });
const orcaScriptFiles = orcaScriptEntries.filter((e) => e.isFile() && e.name.endsWith('.mjs')).map((e) => e.name).sort();
const libOrcaFiles = fs.readdirSync(LIB_GIT).filter((f) => /^orca-.*\.js$/.test(f)).sort();
const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf-8');
const scanFile = (dir, name) => scanSource(read(dir, name));

/** Exact read-verb sets of OUR files. A new call — even an allowed read verb — must be registered here on purpose. */
const EXPECTED_VERBS = Object.freeze({
  'bind.mjs': ['worktree show'],
  'status.mjs': ['orchestration task-list', 'orchestration worker-list'],
  'close.mjs': [],
  'mark.mjs': [],
});

const verbSet = (scan) => [...new Set(scan.invocations.map((i) => i.verb))].sort();

/** What is wrong with a script module READ_ONLY_ORCA_VERBS export ([] = fine). A missing export is a problem, never a skip. */
function verbExportProblems(mod) {
  if (!Array.isArray(mod?.READ_ONLY_ORCA_VERBS)) return ['READ_ONLY_ORCA_VERBS is not exported as an array'];
  return mod.READ_ONLY_ORCA_VERBS.filter((verb) => !ALLOWED_VERBS.includes(verb)).map((verb) => `"${verb}" is not on the allowlist`);
}

// ── 1. the real tree ────────────────────────────────────────────────────────

describe('scripts/orca/*.mjs — 실제 파일은 읽기 verb 허용 목록 안이다', () => {
  it('스캔 대상이 비어 있지 않고 우리 파일 4개를 포함한다 (아무것도 안 읽고 통과하는 길 차단)', () => {
    for (const name of Object.keys(EXPECTED_VERBS)) expect(orcaScriptFiles).toContain(name);
    expect(orcaScriptFiles.length).toBeGreaterThanOrEqual(6); // + preflight / plan (lane L4) at the time of writing
  });

  it('scripts/orca/ 에는 .mjs 가 아닌 것도, 하위 폴더도 없다 — 스캔이 못 읽는 파일은 구멍이다', () => {
    const strangers = orcaScriptEntries.filter((e) => !(e.isFile() && e.name.endsWith('.mjs'))).map((e) => e.name);
    expect(strangers).toEqual([]);
  });

  it.each(orcaScriptFiles)('%s — 위반 0', (name) => {
    const scan = scanFile(ORCA_SCRIPTS, name);
    expect(scan.violations).toEqual([]);
    for (const inv of scan.invocations) expect(ALLOWED_VERBS).toContain(inv.verb);
  });

  it.each(Object.entries(EXPECTED_VERBS))('%s — 호출하는 verb 집합이 등록된 것과 정확히 같다', (name, expected) => {
    expect(verbSet(scanFile(ORCA_SCRIPTS, name))).toEqual(expected);
  });

  it('우리 파일의 호출은 전부 래퍼를 거치고 변수 argv 로 orca 를 여는 곳은 파일당 많아야 1개(래퍼 안)다', () => {
    for (const name of Object.keys(EXPECTED_VERBS)) {
      const { sinks } = scanFile(ORCA_SCRIPTS, name);
      expect(sinks.length).toBeLessThanOrEqual(1);
      for (const sink of sinks) expect(sink.enclosing).toMatch(/orca/i);
    }
  });

  it('양성 대조군: 스캐너는 실제 코드에서 호출을 실제로 본다 (status ≥ 2, bind ≥ 1, preflight ≥ 1 — 파일이 없으면 읽기 실패로 RED)', () => {
    expect(scanFile(ORCA_SCRIPTS, 'status.mjs').invocations.length).toBeGreaterThanOrEqual(2);
    expect(scanFile(ORCA_SCRIPTS, 'bind.mjs').invocations.length).toBeGreaterThanOrEqual(1);
    expect(scanFile(ORCA_SCRIPTS, 'preflight.mjs').invocations.length).toBeGreaterThanOrEqual(1);
  });

  it('lib/git/orca-*.js 는 Orca 를 전혀 부르지 않는다 (순수 판정 + 상태 파일 입출력)', () => {
    expect(libOrcaFiles).toEqual(expect.arrayContaining(['orca-plan.js', 'orca-run-file.js']));
    for (const name of libOrcaFiles) {
      const scan = scanFile(LIB_GIT, name);
      expect([name, scan.invocations, scan.sinks, scan.violations]).toEqual([name, [], [], []]);
    }
  });
});

describe('런타임 guard 와 이 게이트는 같은 목록을 쓴다', () => {
  it('status.mjs 의 READ_ONLY_ORCA_VERBS 는 §11.2 목록과 정확히 같다 (한쪽만 넓어지면 빨개진다)', () => {
    expect([...RUNTIME_ALLOWLIST].sort()).toEqual([...ALLOWED_VERBS].sort());
  });

  it('L4 preflight 는 READ_ONLY_ORCA_VERBS 를 배열로 내보내고 그것은 허용 목록의 부분집합이다 — 파일·export 부재는 건너뜀이 아니라 RED (QR-2)', async () => {
    expect(orcaScriptFiles).toContain('preflight.mjs');
    expect(verbExportProblems(await import('../../scripts/orca/preflight.mjs'))).toEqual([]);
  });

  it('verbExportProblems 자기검증 — export 가 없거나 배열이 아니거나 허용 밖 verb 가 있으면 문제로 잡는다 (위 단언이 공허하지 않다는 증명)', () => {
    expect(verbExportProblems({})).toHaveLength(1);
    expect(verbExportProblems({ READ_ONLY_ORCA_VERBS: 'status' })).toHaveLength(1);
    expect(verbExportProblems({ READ_ONLY_ORCA_VERBS: ['status', 'orchestration worker-start'] })).toEqual(['"orchestration worker-start" is not on the allowlist']);
    expect(verbExportProblems({ READ_ONLY_ORCA_VERBS: ['status', 'repo list'] })).toEqual([]);
  });

  it('실제 코드에서 읽어 낸 argv 는 런타임 guard 도 통과시킨다 (정적 판정과 동적 판정의 교차 확인)', () => {
    for (const verb of ALLOWED_VERBS) {
      const argv = [...verb.split(' '), ...(verb === 'orchestration check' ? ['--peek'] : []), '--json'];
      expect(() => assertReadOnlyOrcaArgv(argv)).not.toThrow();
    }
  });
});

// ── 1b. the runtime guard, unit by unit (the same list, enforced before the executor is reached) ──

const receipt = (name) => JSON.parse(fs.readFileSync(path.join(RECEIPTS, name), 'utf-8'));
const okEnvelope = (doc) => ({ ok: true, status: 0, stdout: JSON.stringify(doc), stderr: '', error: null });

describe('assertReadOnlyOrcaArgv — 변경 verb 는 실행 경로에 못 들어온다', () => {
  it.each(RUNTIME_ALLOWLIST.map((verb) => [verb]))('허용 목록의 %s 는 통과', (verb) => {
    const argv = [...verb.split(' '), ...(verb === 'orchestration check' ? ['--peek'] : []), '--json'];
    expect(() => assertReadOnlyOrcaArgv(argv)).not.toThrow();
  });

  it.each([
    [['orchestration', 'run-create', '--objective', 'x']],
    [['orchestration', 'task-create', '--spec-file', 'p.md']],
    [['orchestration', 'worker-start', '--task', 't']],
    [['orchestration', 'worker-release', '--dispatch', 'd']],
    [['orchestration', 'task-update', '--id', 't', '--status', 'failed']],
    [['orchestration', 'send', '--to', 'dispatch:d']],
    [['orchestration', 'reply', '--id', 'm']],
    [['orchestration', 'reset']],
    [['worktree', 'create', '--name', 'x']],
    [['worktree', 'rm', '--worktree', 'id:x']],
    [['terminal', 'close', '--terminal', 't']],
    [['agent', 'launch']],
    [[]],
    [['--json']],
  ])('거부(P0 에서 실제로 쓴 변경 verb 포함): %j', (argv) => {
    expect(() => assertReadOnlyOrcaArgv(argv)).toThrow(/refused/);
  });

  it('check 는 --peek 없이는 거부 — 소비하는 check 는 리더만 한다', () => {
    expect(() => assertReadOnlyOrcaArgv(['orchestration', 'check', '--run', RUN_ID, '--json'])).toThrow(/--peek/);
    expect(() => assertReadOnlyOrcaArgv(['orchestration', 'check', '--run', RUN_ID, '--peek', '--json'])).not.toThrow();
  });

  it('argv 가 문자열 배열이 아니면 TypeError, orcaVerbOf 는 앞의 비-플래그 단어 최대 2개', () => {
    expect(() => assertReadOnlyOrcaArgv('status')).toThrow(TypeError);
    expect(() => assertReadOnlyOrcaArgv(['status', 1])).toThrow(TypeError);
    expect(orcaVerbOf(['status', '--json'])).toBe('status');
    expect(orcaVerbOf(['orchestration', 'worker-list', '--run', 'r'])).toBe('orchestration worker-list');
    expect(orcaVerbOf(['repo', 'list', 'extra', '--json'])).toBe('repo list');
  });

  it('callOrcaJson — 거부된 verb 는 실행기를 한 번도 부르지 않는다', () => {
    const calls = [];
    const exec = (...args) => {
      calls.push(args);
      return okEnvelope({});
    };
    expect(() => callOrcaJson(exec, ['orchestration', 'worker-start', '--task', 't'])).toThrow(/refused/);
    expect(calls).toEqual([]);
  });

  it('callOrcaJson — 실제 ok:false 영수증(worktree rm 실패)의 메시지를 전달하고, 종료코드 0 의 ok:false 봉투와 JSON 아님도 실패로 읽는다', () => {
    const failing = () => ({ ok: false, status: 1, stdout: JSON.stringify(receipt('wt-a-rm-force.json')), stderr: '', error: 'exit 1' });
    const res = callOrcaJson(failing, ['worktree', 'show', '--worktree', 'id:x', '--json']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Permission denied');
    expect(callOrcaJson(() => okEnvelope({ ok: false, error: { code: 'x', message: 'nope' } }), ['status', '--json'])).toEqual({ ok: false, error: 'nope' });
    const notJson = () => ({ ok: true, status: 0, stdout: 'plain text', stderr: '', error: null });
    expect(callOrcaJson(notJson, ['status', '--json']).error).toContain('not JSON');
  });
});

describe('명령 줄 출력 — shellQuote / cmdLine', () => {
  it('제어문자(CR · LF · NUL · ESC)와 유니코드 따옴표(U+2018-U+201F)가 든 값은 거부한다 — 명령 줄을 쪼개거나 속일 수 있다 (SR-4)', () => {
    for (const bad of ['a\rb', 'a\nb', 'a\0b', 'a\u{1B}[31mb', 'a\u{2018}b', 'a\u{201C}b', 'a\u{201F}b']) {
      expect(() => shellQuote(bad)).toThrow(/control character or a typographic quote/);
      expect(() => cmdLine('orca', 'status', bad)).toThrow(/control character or a typographic quote/);
    }
    for (const fine of ['a\u{2017}b', 'a\u{2020}b']) expect(() => shellQuote(fine)).not.toThrow(); // the range is exact: one code point either side is allowed
  });

  it('안전한 토큰은 그대로, 공백·특수문자는 따옴표, 따옴표로 못 감싸면 거부 — cmdLine 은 이어 붙인다', () => {
    expect(shellQuote('ctx_bba48a83896e')).toBe('ctx_bba48a83896e');
    expect(shellQuote('id:abc::C:/a b/c')).toBe('"id:abc::C:/a b/c"');
    expect(shellQuote('<model>')).toBe('"<model>"');
    expect(shellQuote('a$b')).toBe("'a$b'");
    expect(shellQuote('')).toBe('""');
    expect(() => shellQuote('a$b\'c')).toThrow(/cannot quote/);
    expect(cmdLine('orca', 'orchestration', 'send', '--to', 'dispatch:ctx_1', '--body', '<message>')).toBe('orca orchestration send --to dispatch:ctx_1 --body "<message>"');
    expect(toPosix('C:\\a\\b')).toBe('C:/a/b');
  });
});

// ── 2. the scanner proves itself ────────────────────────────────────────────

const WRAPPER = `
function callOrcaJson(exec, argv) {
  const res = exec('orca', argv, {});
  return res;
}
`;

const rulesOf = (source) => scanSource(source).violations.map((v) => v.rule);

describe('스캐너 자기검증 — 합성 소스에 위반을 심으면 반드시 빨개진다', () => {
  it.each([
    ['worker-start', "callOrcaJson(exec, ['orchestration', 'worker-start', '--task', t]);"],
    ['task-create', "callOrcaJson(exec, ['orchestration', 'task-create', '--spec-file', p]);"],
    ['worktree rm', "callOrcaJson(exec, ['worktree', 'rm', '--worktree', sel]);"],
    ['send', "callOrcaJson(exec, ['orchestration', 'send', '--to', d]);"],
    ['terminal close', "callOrcaJson(exec, ['terminal', 'close', '--terminal', h]);"],
    ['미래의 verb (허용 목록이라서 막힌다)', "callOrcaJson(exec, ['orchestration', 'brand-new-verb']);"],
  ])('래퍼 호출의 변경 verb — %s', (_label, call) => {
    expect(rulesOf(`${WRAPPER}\n${call}`)).toEqual(['mutating-verb']);
  });

  it("'orca' 를 직접 여는 호출의 변경 verb", () => {
    expect(rulesOf("exec('orca', ['orchestration', 'worker-start', '--task', t]);")).toEqual(['mutating-verb']);
    expect(rulesOf("execFileSync('orca', ['worktree', 'create', '--name', n]);")).toEqual(['mutating-verb']);
    expect(rulesOf("spawnSync(\"orca.exe\", ['orchestration', 'send']);")).toEqual(['mutating-verb']);
  });

  it('여러 줄에 걸친 배열 · 템플릿 리터럴 · 중첩 대괄호도 읽는다', () => {
    expect(rulesOf(`callOrcaJson(exec, [\n  'orchestration',\n  'worker-release',\n  '--dispatch',\n  id,\n]);`)).toEqual(['mutating-verb']);
    expect(rulesOf('callOrcaJson(exec, [`orchestration`, `reply`, `--id`, m]);')).toEqual(['mutating-verb']);
    expect(rulesOf("callOrcaJson(exec, ['orchestration', 'worker-list', '--run', pick([1, 2][0]), '--json']);")).toEqual([]);
  });

  it('check 는 --peek 없으면 위반, 있으면 통과', () => {
    expect(rulesOf("callOrcaJson(exec, ['orchestration', 'check', '--run', id, '--json']);")).toEqual(['check-without-peek']);
    expect(rulesOf("callOrcaJson(exec, ['orchestration', 'check', '--run', id, '--peek', '--json']);")).toEqual([]);
  });

  it('argv 를 읽을 수 없으면 허용이 아니라 위반이다 (변수 · spread · 계산된 verb · 배열이 아닌 인자)', () => {
    expect(rulesOf('callOrcaJson(exec, buildArgs());')).toEqual(['unclassifiable']);
    expect(rulesOf("callOrcaJson(exec, ['orchestration', ...rest]);")).toEqual(['unclassifiable']);
    expect(rulesOf("callOrcaJson(exec, ['orchestration', verb, '--json']);")).toEqual(['unclassifiable']);
    expect(rulesOf('callOrcaJson(exec, [verb, "list"]);')).toEqual(['unclassifiable']);
    expect(rulesOf("callOrcaJson(exec, [...prefix, 'worker-list']);")).toEqual(['unclassifiable']);
  });

  it("출력용 cmdLine 이 아닌 가변 인자 호출이나 인자 없는 'orca' 호출은 읽을 수 없으니 위반", () => {
    expect(rulesOf("run('orca', 'orchestration', 'worker-start', '--task', t);")).toEqual(['unclassifiable']);
    expect(rulesOf("execFileSync('orca');")).toEqual(['unclassifiable']);
  });

  it('래퍼 밖에서 변수 argv 로 orca 를 여는 코드, 그리고 두 번째 sink 는 위반', () => {
    expect(rulesOf('function helper(exec, a) { return exec("orca", a); }')).toEqual(['sink-outside-wrapper']);
    expect(rulesOf(`${WRAPPER}\nfunction another(exec, a) { return exec('orca', a); }`).sort()).toEqual(['multiple-sinks', 'sink-outside-wrapper']);
    expect(rulesOf(`${WRAPPER}\nconst runOrcaAgain = (exec, a) => exec('orca', a);`)).toEqual(['multiple-sinks']);
  });

  it('셸을 타는 실행은 위반 — execSync · exec import · shell 옵션 · namespace import', () => {
    expect(rulesOf("import { execSync } from 'node:child_process';\nexecSync('orca status');")).toEqual(['shell-import', 'shell-import']);
    expect(rulesOf("import { exec } from 'child_process';")).toEqual(['shell-import']);
    expect(rulesOf("import * as cp from 'node:child_process';")).toEqual(['shell-import']);
    expect(rulesOf("spawn('git', ['status'], { shell: true });")).toEqual(['shell-option']);
    expect(rulesOf("spawn('git', ['status'], { shell: opts.shell });")).toEqual(['shell-option']);
  });

  it('읽기 verb 는 통과하고 호출로 센다 — 단어 하나짜리 verb 도, 플래그 앞에서 끊기는 verb 도', () => {
    const scan = scanSource(`${WRAPPER}
callOrcaJson(exec, ['status', '--json']);
callOrcaJson(exec, ['agent-context', '--json']);
callOrcaJson(exec, ['repo', 'list', '--json']);
callOrcaJson(exec, ['worktree', 'show', '--worktree', selector, '--json']);
callOrcaJson(exec, ['orchestration', 'worker-list', '--run', runId, '--json']);
callOrcaJson(exec, ['terminal', 'read', '--terminal', handle, '--json']);
`);
    expect(scan.violations).toEqual([]);
    expect(scan.invocations.map((i) => i.verb)).toEqual(['status', 'agent-context', 'repo list', 'worktree show', 'orchestration worker-list', 'terminal read']);
    expect(scan.sinks).toEqual([{ line: 3, enclosing: 'callOrcaJson' }]);
  });

  it('모양만 닮은 코드는 위반이 아니다 — 주석 · 출력용 문자열 · git argv · 래퍼 정의 자체', () => {
    const lookalikes = `${WRAPPER}
// callOrcaJson(exec, ['orchestration', 'worker-start']);
/* exec('orca', ['worktree', 'rm']); */
const printed = 'orca orchestration worker-start --task x';
const printedToo = \`orca worktree rm --worktree \${sel} --delete-branch\`;
const line = cmdLine('orca', 'orchestration', 'send', '--to', d);
const hint = tryCmd('orca', 'orchestration', 'reply', '--id', m);
const here = scriptPath('orca', 'close.mjs');
const there = path.join('orca', 'status.mjs');
git(['worktree', 'remove', '--force', wt]);
exec('git', ['status', '--porcelain'], { cwd });
execFileSync(process.execPath, [script, '--teardown']);
checkOrcaVerbs(schema);
readOrcaRun(root);
`;
    const scan = scanSource(lookalikes);
    expect(scan.violations).toEqual([]);
    expect(scan.invocations).toEqual([]);
  });
});

describe('실제 status.mjs 소스를 변이하면 스캐너가 빨개진다', () => {
  const original = read(ORCA_SCRIPTS, 'status.mjs');

  it('worker-list → worker-start 로 바꾼 소스는 mutating-verb', () => {
    const mutated = original.replace("['orchestration', 'worker-list', '--run', runId, '--json']", "['orchestration', 'worker-start', '--run', runId, '--json']");
    expect(mutated).not.toBe(original);
    expect(scanSource(mutated).violations.map((v) => v.rule)).toEqual(['mutating-verb']);
  });

  it('task-list 호출에서 verb 를 변수로 바꾸면 unclassifiable', () => {
    const mutated = original.replace("['orchestration', 'task-list', '--run', runId, '--json']", "['orchestration', pickVerb, '--run', runId, '--json']");
    expect(mutated).not.toBe(original);
    expect(scanSource(mutated).violations.map((v) => v.rule)).toEqual(['unclassifiable']);
  });

  it('원본은 깨끗하다 (변이의 기준선)', () => {
    expect(scanSource(original).violations).toEqual([]);
  });
});
