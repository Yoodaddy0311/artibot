/**
 * Firewall gate — every ledger event a HOOK can emit is classified, and a new
 * emitter that nobody classified is RED.
 *
 * THE RULE BEING ENFORCED lives in
 * `lib/observability/decision-events.js`'s header ("LEGITIMATE-EMITTER RULE"):
 * a hook may append to the run ledger under `source:'hook'` only when it is
 * (1) the first-hand witness of the fact and (2) able to fill every required
 * field of that event's contract from its own payload. Otherwise the record
 * belongs in the decisions side-channel under a name of its own. This file is
 * the gate on that rule, so the rule stops being a paragraph one module's
 * author happened to read.
 *
 * FIVE PATTERNS ARE DEFINED, and the point of the gate is that every collected
 * emission falls into one of them by NAME rather than by a reader's judgement:
 *   (A) ledger append, `source:'hook'`, on an event whose allowlist `sources`
 *       includes `hook`. The compliant case.
 *   (B) a call into `lib/observability/decision-events.js`. The side-channel —
 *       the destination the rule sends a failing case to.
 *   (C) a hook-reachable append that names the ROLE of the actor it relays
 *       (`gate`, `reviewer`, `human`, `supervisor`) rather than `hook`. This is criterion
 *       (3) of the rule OBEYED, not an exception to it: `source` is a role,
 *       decided 2026-09-22 (V5-BACKLOG §4-d (4)). Listed in `ROLE_SOURCED`,
 *       and each role is re-checked against that event's allowlist `sources`.
 *   (D) a hook that deliberately binds NO ledger writer and records the gap
 *       instead. Listed in `NON_EMITTERS`, and asserted to stay silent.
 *   (E) an append whose event name or source cannot be read statically at all
 *       (resolved at runtime, or injected by the caller). `EXCEPTIONS` is the
 *       table for these, and it is EMPTY and pinned empty since SH-30
 *       (2026-09-28): the last two entries, `mission-ledger.js` (event name
 *       through a lookup map) and `state-manager.js` (caller-injected source),
 *       were rewritten as one literal envelope per value. A new non-literal
 *       emitter is made literal first; listing it here is not the fix. What
 *       still keeps those two honest is pinned below: the map's values and the
 *       allowed-source list must equal the literals the scan collects.
 *
 * THE STORE-OPENER CENSUS (SH-30 N2) pins the CALLER of the one emitter above
 * that takes its source from outside. `createStateStore` defaults `source` to
 * 'supervisor', a role this table admits, so a hook that opened a store and
 * forgot `source` was recorded as a supervisor while every check above stayed
 * green. Every hook-reachable `createStateStore` call must therefore spell
 * `source: 'hook'`, bar the openers in `READ_ONLY_OPENERS`, which omit it
 * because the port they bind refuses every event (what that listing proves,
 * and what it does not, is stated under "WHAT THIS GATE CANNOT SEE").
 * What the census cannot read (an alias, a spread, a computed source) is a
 * fault, never a skip. The default itself stays: 3 shipped read-only openers
 * and 13 test call sites in 8 files omit `source` or spread options over it
 * (measured 2026-09-29, 27 `createStateStore(` call sites in plugins/artibot).
 *
 * WHY AN AST SCAN AND NOT grep. The emitters do not look alike: some build the
 * envelope inline at the `appendLedgerEvent` call, some return it from a
 * builder in another module (`verify-writer.js` never imports the writer at
 * all), some name the event through a lookup table, and several reach the
 * writer through `await import()` or a `loadLibModule(...)` helper rather than
 * a static import. A text match for `event:` also hits every JSDoc block that
 * documents an envelope — `scripts/hooks/tool-used-record.js` alone carries two
 * such comments. So the scan resolves the module graph from the REGISTERED hook
 * entry points (`hooks/hooks.json` + `hooks/dispatch-table.json`, never a
 * directory listing) and reads envelope literals only out of modules that a
 * writer-importing module actually pulls in.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ────────────────────────────────────
 *   - RUNTIME EMISSIONS. This is a static read. Three loader shapes ARE
 *     resolved: a literal `await import()`, `loadLibModule(root, ...segments)`,
 *     and a root-join helper (`const load = (...rel) => import(toFileUrl(
 *     path.join(pluginRoot, ...rel)))`) — the last one added 2026-09-22 after
 *     `scripts/hooks/session-end.js` was found emitting `session.ended` and
 *     `usage.receipt` through it, invisible to all three earlier paths. What
 *     remains invisible: a specifier whose SEGMENTS are computed (pinned by a
 *     negative control below), a spawned child process, and a port injected at
 *     call time. Absence from the table below is not evidence an emitter does
 *     not exist. The live distribution is the Existence Audit's measurement,
 *     not this file's.
 *   - WHETHER A CLASSIFICATION IS RIGHT. The gate checks that every emission is
 *     classified and that no exception is stale. It cannot tell a correct
 *     `source` from a plausible one — that is what the reason strings, and a
 *     reader, are for.
 *   - ONE HOP OF BUILDER DEPTH. An envelope literal is read out of a writer
 *     importer or a module it imports DIRECTLY. A builder two modules away from
 *     the append would be missed; none exists today (verified by the known-
 *     emitter floor below), and a new one would surface as an unclassified
 *     append in the importer rather than silently.
 *   - SCOPE OF A NAMED CONSTANT. There is no scope analysis, so a name is read
 *     only when its module binds it exactly ONCE (any scope, any binding form)
 *     as `const NAME = '<literal>'`. A second binding, a parameter, a `let` or
 *     an imported name is unreadable and leaves the emission unclassified —
 *     deliberately over-strict, instead of a guess about which binding a use
 *     site sees. A constant imported from another module is not followed.
 *   - STORE OPENERS OUTSIDE THE HOOK GRAPH, AND NAME-BLIND ACCESS. The census
 *     reads `createStateStore` by name inside the hook-reachable graph only.
 *     The /split task feed, `resume-report.mjs` and `state-version-port.js` sit
 *     outside it (measured 2026-09-29) and are not pinned here; a factory
 *     reached as `ns['createStateStore']` or through a computed specifier is as
 *     invisible as any other emitter under "RUNTIME EMISSIONS".
 *   - WHAT THE READ-ONLY LISTING PROVES. Only this: calling the listed export
 *     with ONE argument yields a store whose commit is refused and writes no
 *     journal or snapshot (one mission shape, once per test run, on the
 *     platform running it); and no call in the hook graph, through an alias
 *     too, gives a listed opener a second argument. It does NOT prove what the
 *     export does when handed a ports object (its `ports.appendEvent ??
 *     NO_LEDGER_WRITER` seam can bind a live writer, by design, for tests),
 *     that no other function in that file opens a store, or anything about a
 *     call the scan cannot follow (`.call`, `ns['name']`, a spawned child). The
 *     stronger fix is to spell `source: 'hook'` at the opener and delete the
 *     listing — a follow-up row, not done here.
 *   - espree's AVAILABILITY. The parser resolves in this checkout only as an
 *     eslint transitive and is declared in no package.json — the same footing
 *     as ajv in `ledger-vocab-allowlist.test.js`. If eslint drops it this file
 *     goes RED with a module error, which is the correct loud failure; the fix
 *     is a devDependency, not a softer scan here.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'espree';
import { createStateStore } from '../../lib/project-state/state-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');
const ESPREE_OPTS = Object.freeze({ ecmaVersion: 2024, sourceType: 'module', loc: true });

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

/** Resolve a RELATIVE specifier to a file on disk. Bare specifiers are out of scope. */
function resolveSpecifier(fromFile, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Names of ROOT-JOIN LOADER helpers declared in this module: a function taking
 * one rest parameter and importing `path.join(<root>, ...rest)`. Two hooks are
 * written that way, and `scripts/hooks/session-end.js` reaches the ledger
 * through one — so without this its `session.ended` append, and the
 * `usage.receipt` envelope it pulls in, were invisible to the scan: a
 * fail-open, not a known gap. Shape-matched rather than name-matched, because
 * the helper is a local `const` with no naming convention behind it.
 */
function rootJoinLoaderNames(ast) {
  const names = new Set();
  walk(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return;
    const fn = n.init;
    if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return;
    const rest = fn.params.length === 1 && fn.params[0].type === 'RestElement'
      && fn.params[0].argument.type === 'Identifier' ? fn.params[0].argument.name : null;
    if (!rest) return;
    let joinsRest = false;
    walk(fn.body, (m) => {
      if (m.type !== 'CallExpression') return;
      if (!(m.callee.type === 'MemberExpression' && m.callee.property.type === 'Identifier'
        && m.callee.property.name === 'join')) return;
      if (m.arguments.some((a) => a.type === 'SpreadElement'
        && a.argument.type === 'Identifier' && a.argument.name === rest)) joinsRest = true;
    });
    if (joinsRest) names.add(n.id.name);
  });
  return names;
}

/** The store factory whose openers the census pins, by export name. */
const STORE_FACTORY = 'createStateStore';
/** A `createStateStore` call whose options name no `source` at all: the store takes its own default. */
const ABSENT = '<absent>';
/** A `source` (or a call shape) the scan cannot read down to one string. */
const OPAQUE = '<opaque>';

/** Every name a binding pattern introduces: `a`, `{ a, b: c, ...d }`, `[a, ...r]`, `a = 1`. */
function patternNames(pattern, out = []) {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    for (const p of pattern.properties) patternNames(p.type === 'Property' ? p.value : p, out);
  } else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e) => patternNames(e, out));
  else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
  else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
  return out;
}

const FUNCTION_NODES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const IMPORT_BINDINGS = new Set(['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier']);

/**
 * A module's string constants that the scan may TRUST, and how often it binds
 * each name. A name is readable only when the module binds it exactly once — in
 * ANY scope, by ANY form (declaration, parameter, destructuring, catch binding,
 * import, function or class name) — and that one binding is
 * `const NAME = '<string literal>'`. A second binding might be the one a use
 * site sees, and a `let`/`var` might have been reassigned, so both are read as
 * unreadable (null): the emission then stays unclassified and the gate is RED.
 * Deliberately conservative — the scan has no scope analysis to say which
 * binding a given use resolves to, and guessing "the first" was the fail-open.
 *
 * @returns {{ consts: Map<string, string>, bound: Map<string, number> }}
 */
function trustedStringConsts(ast) {
  const bound = new Map();
  const literals = new Map();
  const bind = (pattern) => {
    for (const name of patternNames(pattern)) bound.set(name, (bound.get(name) ?? 0) + 1);
  };
  walk(ast, (n) => {
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        bind(d.id);
        if (n.kind === 'const' && d.id.type === 'Identifier' && d.init?.type === 'Literal'
            && typeof d.init.value === 'string') literals.set(d.id.name, d.init.value);
      }
    } else if (FUNCTION_NODES.has(n.type)) {
      n.params.forEach(bind);
      if (n.id) bind(n.id);
    } else if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) bind(n.id);
    else if (n.type === 'CatchClause' && n.param) bind(n.param);
    else if (IMPORT_BINDINGS.has(n.type)) bind(n.local);
  });
  return { consts: new Map([...literals].filter(([name]) => bound.get(name) === 1)), bound };
}

/**
 * Parse one module: its resolvable dependencies and its module-level string
 * constants. Constants matter because almost no emitter writes the event name
 * inline — `TOOL_USED_EVENT`, `LEDGER_SOURCE` and friends are the normal shape.
 */
function analyzeModule(root, file) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = parse(text, ESPREE_OPTS);
  const deps = new Set();
  const { consts, bound } = trustedStringConsts(ast);
  const loaders = rootJoinLoaderNames(ast);
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration') {
      const target = resolveSpecifier(file, n.source.value);
      if (target) deps.add(target);
    }
    if (n.type === 'ImportExpression' && n.source.type === 'Literal') {
      const target = resolveSpecifier(file, n.source.value);
      if (target) deps.add(target);
    }
    // Repo-specific loader: `loadLibModule(pluginRoot, 'observability', 'x.js')`
    // resolves under lib/. Without this, runtime-prompt.js's whole side-channel
    // usage is invisible — which the self-check below pins.
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'loadLibModule') {
      const segments = n.arguments.slice(1).map((a) => (a.type === 'Literal' ? a.value : null));
      if (segments.length > 0 && segments.every((s) => typeof s === 'string')) {
        const target = path.join(root, 'lib', ...segments);
        if (fs.existsSync(target) && fs.statSync(target).isFile()) deps.add(target);
      }
    }
    // Root-join loader call: the segments are joined onto the PACKAGE root, so
    // they already carry their own leading directory ('lib', 'runtime', ...).
    // Only all-literal segments resolve; a computed one stays invisible, which
    // the negative control below pins so the limit is stated rather than assumed.
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && loaders.has(n.callee.name)) {
      const segments = n.arguments.map((a) => (a.type === 'Literal' ? a.value : null));
      if (segments.length > 0 && segments.every((s) => typeof s === 'string')) {
        const target = path.join(root, ...segments);
        if (fs.existsSync(target) && fs.statSync(target).isFile()) deps.add(target);
      }
    }
  });
  return { file, text, ast, deps, consts, bound, loaders };
}

function literalValue(node, consts) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'Identifier' && consts.has(node.name)) return consts.get(node.name);
  if (node.type === 'TemplateLiteral' && node.quasis.length === 1 && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function callName(node) {
  if (node.callee.type === 'Identifier') return node.callee.name;
  if (node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier') {
    return node.callee.property.name;
  }
  return null;
}

/** The CallExpression `call` when `callee` is exactly its callee, else null. */
function callOf(call, callee) {
  return call?.type === 'CallExpression' && call.callee === callee ? call : null;
}

/** The call an Identifier is the callee of — `name(...)` or `ns.name(...)` — else null. */
function calleeCallOf(id, parent, grand) {
  if (parent.type === 'MemberExpression' && parent.property === id && !parent.computed) return callOf(grand, parent);
  return callOf(parent, id);
}

/**
 * Depth-first walk that also hands the visitor each node's parent, its
 * grandparent and the nearest enclosing NAMED function ('<module>' outside one).
 * A node reachable by two keys (a shorthand property, `export { a }`) is visited
 * once per key, so callers that record findings key them by position.
 */
function walkScoped(ast, visit) {
  const step = (node, parent, grand, fn) => {
    if (!node || typeof node.type !== 'string') return;
    let scope = fn;
    if (node.type === 'FunctionDeclaration' && node.id) scope = node.id.name;
    else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
        && FUNCTION_NODES.has(node.init?.type)) scope = node.id.name;
    visit(node, parent, grand, scope);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) step(child, node, parent, scope);
      else if (value) step(value, node, parent, scope);
    }
  };
  step(ast, null, null, '<module>');
}

/**
 * The `source` an options literal hands `createStateStore`: the string it names,
 * {@link ABSENT} when it names none (the store then takes its own default), or
 * {@link OPAQUE} for anything the scan cannot read to one string — options that
 * are not built in place, a spread or computed key (either may carry `source`),
 * or a value that is not a trusted literal.
 */
function storeSourceOf(arg, consts) {
  if (arg?.type !== 'ObjectExpression') return OPAQUE;
  let source = ABSENT;
  for (const prop of arg.properties) {
    if (prop.type !== 'Property' || prop.computed) source = OPAQUE;
    else if ((prop.key.type === 'Identifier' ? prop.key.name : prop.key.value) === 'source') {
      source = literalValue(prop.value, consts) ?? OPAQUE;
    }
  }
  return source;
}

/**
 * Every place one module reaches `createStateStore`, read by NAME. A direct
 * call (`createStateStore({...})`, `ns.createStateStore({...})`) yields the
 * `source` it names. The import specifier and a plain destructured binding are
 * only bindings and yield nothing. EVERY OTHER mention — an `as` rename, an
 * alias, a `new`, a re-export, a computed call — yields an {@link OPAQUE}
 * opener, because a store opened through it could name any source unseen.
 * `fn` is the nearest enclosing named function, so a listing can be tied to the
 * exact function that was proven read-only.
 *
 * @returns {Array<{site: string, file: string, fn: string, source: string}>}
 */
function storeOpenersOf(info, rel) {
  const found = new Map();
  const record = (node, fn, source) => {
    const key = `${node.loc.start.line}:${node.loc.start.column}`;
    if (!found.has(key)) found.set(key, { site: `${rel}:${node.loc.start.line}`, file: rel, fn, source });
  };
  walkScoped(info.ast, (id, parent, grand, fn) => {
    if (id.type !== 'Identifier' || id.name !== STORE_FACTORY) return;
    const call = calleeCallOf(id, parent, grand);
    if (call) record(call, fn, storeSourceOf(call.arguments[0], info.consts));
    else if (parent.type === 'ImportSpecifier' && parent.local.name === STORE_FACTORY) return;
    else if (parent.type === 'Property' && grand?.type === 'ObjectPattern'
        && parent.value.type === 'Identifier' && parent.value.name === STORE_FACTORY) return;
    else record(id, fn, OPAQUE);
  });
  return [...found.values()];
}

/**
 * How one mention of a WATCHED name sits in the code, for {@link watchedCallsOf}.
 * True when it only BINDS the name (its declaration, a parameter, an import or
 * export under the same name) or ALIASES it (a default parameter, a variable, a
 * destructuring or import rename — the alias name is added to `aliases`). False
 * for every other mention: there the function escapes into code the scan does
 * not follow.
 */
function bindsOrAliases(id, parent, grand, aliases) {
  const alias = (name) => {
    aliases.add(name);
    return true;
  };
  switch (parent.type) {
    case 'FunctionDeclaration':
      return parent.id === id || parent.params.includes(id);
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return parent.params.includes(id);
    case 'ImportSpecifier':
      return parent.imported === id ? alias(parent.local.name) : true;
    case 'ExportSpecifier':
      return parent.local.name === parent.exported.name;
    case 'AssignmentPattern':
      return parent.left === id || (parent.left.type === 'Identifier' && alias(parent.left.name));
    case 'VariableDeclarator':
      return parent.id === id || (parent.id.type === 'Identifier' && alias(parent.id.name));
    case 'Property':
      if (grand?.type !== 'ObjectPattern' || parent.computed) return false;
      if (parent.value === id) return true;
      if (parent.value.type === 'Identifier') return alias(parent.value.name);
      return parent.value.type === 'AssignmentPattern' && parent.value.left.name === id.name;
    default:
      return false;
  }
}

/**
 * Every use one module makes of a WATCHED read-only opener: by its own name, by
 * a name it is aliased to inside the module, or as `ns.name(...)`. A call yields
 * its argument count; a spread, and any mention the scan cannot follow (passed
 * as a value, `.call`/`.bind`, a renamed or exported alias), yields `null` —
 * whatever receives the function may hand it a ports object. Aliases are
 * followed to a fixed point, so `const b = a` after `const a = watched` is seen.
 * An alias is followed only inside its own module; exporting one is therefore
 * itself a use the scan cannot follow.
 *
 * @returns {Array<{site: string, file: string, fn: string, callee: string, args: number|null}>}
 */
function watchedCallsOf(info, rel, watched) {
  if (!watched.some((name) => info.text.includes(name))) return [];
  const pass = (names) => {
    const found = new Map();
    const aliases = new Set();
    const use = (node, fn, callee, args) => {
      const key = `${node.loc.start.line}:${node.loc.start.column}`;
      if (!found.has(key)) found.set(key, { site: `${rel}:${node.loc.start.line}`, file: rel, fn, callee, args });
    };
    walkScoped(info.ast, (id, parent, grand, fn) => {
      if (id.type !== 'Identifier' || !names.has(id.name)) return;
      const call = calleeCallOf(id, parent, grand);
      if (call) use(call, fn, id.name, call.arguments.some((a) => a.type === 'SpreadElement') ? null : call.arguments.length);
      else if (!bindsOrAliases(id, parent, grand, aliases)) use(id, fn, id.name, null);
    });
    return { found, aliases, use };
  };
  let names = new Set(watched);
  let last = pass(names);
  while ([...last.aliases].some((a) => !names.has(a))) {
    names = new Set([...names, ...last.aliases]);
    last = pass(names);
  }
  walk(info.ast, (n) => {
    if (n.type !== 'ExportNamedDeclaration' && n.type !== 'ExportDefaultDeclaration') return;
    const exported = [
      ...(n.declaration?.declarations ?? []).flatMap((d) => patternNames(d.id)),
      ...(n.specifiers ?? []).map((s) => s.local.name),
      ...(n.declaration?.type === 'Identifier' ? [n.declaration.name] : []),
    ];
    const leaked = exported.find((name) => names.has(name) && !watched.includes(name));
    if (leaked) last.use(n, '<module>', leaked, null);
  });
  return [...last.found.values()];
}

/** Registered hook entry points — from the two config files, never from `ls`. */
function hookEntryPoints(root) {
  const entries = new Set();
  const table = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'dispatch-table.json'), 'utf8'));
  for (const slot of Object.values(table.slots ?? {})) {
    for (const handler of slot.handlers ?? []) {
      entries.add(path.join(root, 'scripts', 'hooks', handler.script));
    }
    if (typeof slot.singleHookCommand === 'string') {
      const m = slot.singleHookCommand.match(/scripts\/hooks\/([A-Za-z0-9._-]+)/);
      if (m) entries.add(path.join(root, 'scripts', 'hooks', m[1]));
    }
  }
  const hooksJson = fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8');
  for (const m of hooksJson.matchAll(/scripts\/hooks\/([A-Za-z0-9._-]+)/g)) {
    entries.add(path.join(root, 'scripts', 'hooks', m[1]));
  }
  return [...entries].filter((f) => fs.existsSync(f));
}

/**
 * @param {string} root - package root to scan
 * @param {string[]} [watched] - names of read-only openers whose every use in the
 *   graph is recorded in `readOnlyCalls` (the table lives further down; the scan
 *   itself knows no names)
 */
function scanHookEmitters(root, watched = []) {
  const eventWriter = path.join(root, 'lib', 'runtime', 'event-writer.js');
  const ledgerFacade = path.join(root, 'lib', 'runtime', 'ledger.js');
  const decisionEvents = path.join(root, 'lib', 'observability', 'decision-events.js');

  // The recorder names are read off the side-channel module's own exports, so a
  // recorder added there is covered without editing this file.
  const recorders = new Set(
    [...fs.readFileSync(decisionEvents, 'utf8')
      .matchAll(/^export (?:async )?function (record\w+|measure\w+)/gm)].map((m) => m[1]),
  );

  const entries = hookEntryPoints(root);
  const modules = new Map();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (modules.has(file)) continue;
    modules.set(file, analyzeModule(root, file));
    for (const dep of modules.get(file).deps) if (!modules.has(dep)) queue.push(dep);
  }

  // A module that imports the writer appends; a module it imports directly may
  // BUILD the envelope for it (verify-writer.js does exactly that). The writer
  // and its facade are excluded — they are the writer, not emitters.
  const appenders = new Set();
  for (const [file, info] of modules) {
    if (file === eventWriter || file === ledgerFacade) continue;
    if (info.deps.has(eventWriter) || info.deps.has(ledgerFacade)) appenders.add(file);
  }
  const surfaces = new Set(appenders);
  for (const file of appenders) {
    for (const dep of modules.get(file).deps) {
      if (modules.has(dep) && dep !== eventWriter && dep !== ledgerFacade) surfaces.add(dep);
    }
  }

  const ledgerEmissions = [];
  const sideChannelCalls = [];
  const storeOpeners = [];
  const readOnlyCalls = [];
  const stateManager = path.join(root, 'lib', 'project-state', 'state-manager.js');
  for (const [file, info] of modules) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    // The factory's own module DEFINES `createStateStore`; every other module
    // that mentions it is an opener the census must read.
    if (file !== stateManager) storeOpeners.push(...storeOpenersOf(info, rel));
    readOnlyCalls.push(...watchedCallsOf(info, rel, watched));
    if (surfaces.has(file)) {
      walk(info.ast, (n) => {
        if (n.type !== 'ObjectExpression') return;
        let hasEvent = false;
        let hasSource = false;
        let event = null;
        let source = null;
        for (const prop of n.properties) {
          if (prop.type !== 'Property' || prop.key.type !== 'Identifier') continue;
          if (prop.key.name === 'event') { hasEvent = true; event = literalValue(prop.value, info.consts); }
          if (prop.key.name === 'source') { hasSource = true; source = literalValue(prop.value, info.consts); }
        }
        if (hasEvent && hasSource) ledgerEmissions.push({ site: `${rel}:${n.loc.start.line}`, file: rel, event, source });
      });
    }
    if (info.deps.has(decisionEvents)) {
      walk(info.ast, (n) => {
        if (n.type !== 'CallExpression') return;
        const name = callName(n);
        if (name && recorders.has(name)) sideChannelCalls.push({ site: `${rel}:${n.loc.start.line}`, file: rel, fn: name });
      });
    }
  }
  return { root, entries, modules, ledgerEmissions, sideChannelCalls, storeOpeners, readOnlyCalls, recorders };
}

// ---------------------------------------------------------------------------
// The classification table. Adding an emitter without adding a line here is the
// failure this file exists to produce.
// ---------------------------------------------------------------------------

/**
 * (C) Hook-reachable appends that name the ROLE of the actor being relayed.
 * Criterion (3) of the rule, applied — NOT a waiver: each `source` here must
 * also appear in that event's allowlist `sources`, which the test below
 * re-checks. Keyed by `<path>:<line>` so a moved emitter is re-examined rather
 * than inherited. Every entry must match a collected emission; a stale one is
 * RED.
 */
const ROLE_SOURCED = Object.freeze({
  'lib/verification/verify-writer.js:345': {
    event: 'verify.completed',
    source: 'gate',
    reason: 'The verification gate, not the hook process, is the witness, and '
      + 'criterion (3) puts the gate\'s ROLE in `source`; the allowlist '
      + 'registers this event with sources:["gate"] only, which is that same '
      + 'decision written on the event.',
  },
  'lib/review/verdict-writer.js:271': {
    event: 'review.completed',
    source: 'reviewer',
    reason: 'The reviewer subagent produced the verdict; the SubagentStop hook '
      + 'relays it, so criterion (1) puts the record on the reviewer.',
  },
  'lib/review/verdict-writer.js:381': {
    event: 'review.claim_audit',
    source: 'reviewer',
    reason: 'Same relay as review.completed — the audit is the reviewer\'s claim '
      + 'census, not the hook\'s observation.',
  },
  'lib/runtime/human-asked-record.js:572': {
    event: 'human.resolved',
    source: 'human',
    reason: 'A person answered and the hook is relaying it. The allowlist '
      + 'permits both spellings, so the source line is the only thing that says '
      + 'which one a reader sees; the paired human.asked IS the hook\'s own '
      + 'observation and stays source:hook.',
  },
  'lib/project-state/state-manager.js:409': {
    event: 'state.updated',
    source: 'supervisor',
    reason: 'Collected because lib/runtime/middleware/tasks.js (an appender) imports '
      + 'the store module directly; the hook path (tasks.js#openMissionStore) opens '
      + 'its store with source:hook and takes the other branch, collected as (A). '
      + 'A store whose opener names no source lands HERE, so a hook that forgot one '
      + 'would stay classified: the store-opener census below closes that at the '
      + 'caller (every hook-reachable opener spells source:hook, bar the read-only '
      + 'post-compact-rehydrate opener, whose one-argument call must refuse a commit). '
      + 'The writer-bound caller that takes THIS branch on purpose is the /split task '
      + 'feed (scripts/split/task-feed.mjs), a supervisor process outside the hook '
      + 'graph and not pinned by this gate. '
      + 'state.updated declares no sources list, so the role is admitted.',
  },
});

/**
 * (E) Appends whose event name or source is not a literal anywhere in the
 * source, so the scan cannot read it. EMPTY, and pinned empty below: the fix
 * for a non-literal emitter is to write it as literals (SH-30), not to list it.
 * Kept as a table so the classifier reads the same way if an entry is ever
 * argued for — which then has to get past that pin first.
 */
const EXCEPTIONS = Object.freeze({});

/** (D) Hooks that deliberately bind no ledger writer. Asserted to stay silent. */
const NON_EMITTERS = Object.freeze({
  'scripts/hooks/post-compact-rehydrate.js': {
    reason: 'Binds no ledger writer on purpose (`writer: null` in reportReceipt) '
      + 'and records the gap in the Context Receipt instead: criterion (2) fails '
      + 'because context.compiled\'s required cache.* numbers have another '
      + 'declared writer.',
  },
});

/**
 * Hook-reachable `createStateStore` openers that may omit `source` because the
 * ledger port they bind refuses every event when the export is called as
 * `fn(projectRoot)`. Keyed by file; `fn` is the exported function the opener
 * lives in.
 *
 * PROVEN: the test below calls `fn(projectRoot)` with ONE argument and requires
 * a refused commit that writes no journal or snapshot, and the census fails any
 * hook-graph call that gives `fn` (or an alias of it) a second argument.
 * NOT PROVEN: what `fn` does when handed a ports object — its seam can bind a
 * live writer — or anything about a call the scan cannot follow.
 *
 * Every other hook-reachable opener must spell `source: 'hook'`. Empty is a
 * valid state: an opener that spells `source: 'hook'` needs no entry, and an
 * entry with no opener behind it is RED. Preferred end state: spell
 * `source: 'hook'` at the opener and delete this list (a follow-up row).
 */
const READ_ONLY_OPENERS = Object.freeze({
  'scripts/hooks/post-compact-rehydrate.js': {
    fn: 'openMissionStoreReadOnly',
    reason: 'The PostCompact hook only READS the mission store, for its Context Receipt. '
      + 'It names no source, so the store would default it to supervisor, but called as '
      + 'fn(projectRoot) the port it binds (NO_LEDGER_WRITER) refuses every event, so no '
      + 'state.updated is written under any source. The test below calls this export with '
      + 'one argument and requires a refused commit; the census fails any hook-graph call '
      + 'that passes a second (ports) argument, the seam that could bind a live writer. '
      + "Spelling source:'hook' there would make this entry unnecessary.",
  },
});

/** The function names in {@link READ_ONLY_OPENERS}: what the scan watches for. */
const READ_ONLY_FNS = Object.freeze([...new Set(Object.values(READ_ONLY_OPENERS).map((e) => e.fn))]);

/**
 * Why a hook-graph use of a listed read-only opener is not acceptable, or `null`
 * when it is. `args` is the argument count of a call, `null` for a spread or a
 * mention the scan cannot follow. A second argument is the `ports` seam, which
 * can bind a live ledger writer; only the one-argument call is proven read-only.
 */
function readOnlyCallFault(c) {
  if (c.args !== null && c.args <= 1) return null;
  const how = c.args === null ? 'in a way the scan cannot follow (spread, escape or rename)' : `with ${c.args} arguments`;
  return `${c.site} (${c.fn}) uses read-only opener ${c.callee} ${how} — its second argument is the ports seam, `
    + 'which can bind a live ledger writer, and only the one-argument call is proven read-only';
}

/** Why a hook-reachable StateStore opener is not acceptable, or `null` when it is. */
function storeOpenerFault(o) {
  if (o.source === 'hook') return null;
  const listed = Object.hasOwn(READ_ONLY_OPENERS, o.file) ? READ_ONLY_OPENERS[o.file] : null;
  if (listed && o.fn === listed.fn && o.source === ABSENT) return null;
  return `${o.site} (${o.fn}) opens the StateStore with source ${o.source} — spell source:'hook', `
    + 'or list a read-only opener that binds a refusing ledger port';
}

/** Floor for the scanner self-check: emitters that must be found, or the scan is blind. */
const KNOWN_EMITTER_FLOOR = Object.freeze([
  ['hook.fired', 'scripts/hooks/_hook-fired-record.js'],
  ['tool.used', 'scripts/hooks/tool-used-record.js'],
  ['mission.created', 'scripts/hooks/intent-observe-pre.js'],
  ['route.selected', 'scripts/hooks/route-observe-pre.js'],
  ['plan.revised', 'scripts/hooks/_plan-observe-record.js'],
  ['mission.completed', 'scripts/hooks/mission-complete-record.js'],
  ['verify.completed', 'lib/verification/verify-writer.js'],
  // Reached ONLY through the root-join loader in session-end.js. Both were
  // missing from every earlier version of this scan; they are the floor
  // entries that keep that resolution from being quietly dropped again.
  ['session.ended', 'scripts/hooks/session-end.js'],
  ['usage.receipt', 'lib/economics/receipt-envelope.js'],
  // Reached only through `tasks.js#recordQuestionGate`, and appended through a
  // LOCAL ALIAS (`const append = deps.appendLedgerEvent ?? appendLedgerEvent`).
  // The scan keys on the envelope literal in a writer-importing module, not on
  // the callee name, so the alias is seen — measured 2026-09-23 by planting
  // `source: 'scheduler'` there, which turned both classification tests RED at
  // `lib/runtime/question-gate-record.js:149`. Pinned so that stays true.
  ['adr.question_gate_evaluated', 'lib/runtime/question-gate-record.js'],
  // The two SH-30 emitters, readable only since they were written as literal
  // envelopes. Losing them here would put them back where EXCEPTIONS used to.
  ['mission.created', 'lib/runtime/middleware/mission-ledger.js'],
  ['mission.candidate_deferred', 'lib/runtime/middleware/mission-ledger.js'],
  ['state.updated', 'lib/project-state/state-manager.js'],
]);

// ---------------------------------------------------------------------------

const allowlist = JSON.parse(
  fs.readFileSync(path.join(PKG_ROOT, 'schemas', 'ledger-events.allowlist.json'), 'utf8'),
);
const scan = scanHookEmitters(PKG_ROOT, READ_ONLY_FNS);

function hookPermitted(eventName) {
  const spec = allowlist.events?.[eventName];
  if (!spec) return false;
  // `sources: null` means unrestricted, not "no source allowed".
  return spec.sources === null || spec.sources === undefined || spec.sources.includes('hook');
}

const MISSION_LEDGER_REL = 'lib/runtime/middleware/mission-ledger.js';
const STATE_MANAGER_REL = 'lib/project-state/state-manager.js';

/**
 * The values of `const <name> = Object.freeze({...})` or `Object.freeze([...])`,
 * read off the AST of a scanned module.
 *
 * @returns {Array<string|null>|null|undefined} `undefined` when no such
 *   declaration exists, `null` when it is not a `const` holding a frozen
 *   object/array literal or the module binds the name more than once (no single
 *   final declaration to trust), and otherwise one entry per value — `null` for
 *   any value that is not a string literal, so the caller can refuse it.
 */
function frozenLiteralValues(relFile, name, from = scan) {
  const info = from.modules.get(path.join(from.root, ...relFile.split('/')));
  if (!info) return undefined;
  if ((info.bound.get(name) ?? 0) > 1) return null;
  let found;
  walk(info.ast, (n) => {
    if (found !== undefined || n.type !== 'VariableDeclaration') return;
    const declarator = n.declarations.find((d) => d.id.type === 'Identifier' && d.id.name === name);
    if (!declarator) return;
    // Bound once is not final: a `let`/`var` can be reassigned after the freeze,
    // and then the list read here is not the list that runs.
    if (n.kind !== 'const') { found = null; return; }
    const init = declarator.init;
    const arg = init?.type === 'CallExpression' && init.callee.type === 'MemberExpression'
      && init.callee.object.type === 'Identifier' && init.callee.object.name === 'Object'
      && init.callee.property.type === 'Identifier' && init.callee.property.name === 'freeze'
      ? init.arguments[0] : null;
    const str = (v) => (v?.type === 'Literal' && typeof v.value === 'string' ? v.value : null);
    if (arg?.type === 'ObjectExpression') {
      found = arg.properties.map((p) => (p.type === 'Property' ? str(p.value) : null));
    } else if (arg?.type === 'ArrayExpression') {
      found = arg.elements.map(str);
    } else {
      found = null;
    }
  });
  return found;
}

/** Sorted, de-duplicated values of one field over the emissions collected in one file. */
function collectedIn(relFile, field) {
  return [...new Set(scan.ledgerEmissions.filter((e) => e.file === relFile).map((e) => e[field]))].sort();
}

/**
 * A scratch package root holding the least a hook scan needs — the dispatch
 * table, stubs for the writer, its facade, the side-channel and the store module
 * — plus the given hook scripts, each registered as a handler. `files` adds or
 * replaces any other path (e.g. the real `state-manager.js` text).
 *
 * @param {Record<string, string>} hooks - script name → source
 * @param {Record<string, string>} [files] - root-relative path → source
 * @returns {string} the root; the caller removes it
 */
function plantHookRoot(hooks, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-emitter-plant-'));
  const put = {
    'hooks/dispatch-table.json': JSON.stringify({
      slots: { Stop: { handlers: Object.keys(hooks).map((script) => ({ name: script, script })) } },
    }),
    'hooks/hooks.json': JSON.stringify({ hooks: {} }),
    'lib/runtime/event-writer.js': 'export function writeEvent() { return { ok: true }; }\n',
    'lib/runtime/ledger.js': "import { writeEvent } from './event-writer.js';\n"
      + 'export function appendLedgerEvent(root, ev) { return writeEvent(root, ev); }\n',
    'lib/observability/decision-events.js': 'export function recordSomething() { return null; }\n',
    'lib/project-state/state-manager.js': 'export function createStateStore() { return {}; }\n',
    ...Object.fromEntries(Object.entries(hooks).map(([script, body]) => [`scripts/hooks/${script}`, body])),
    ...files,
  };
  for (const [rel, body] of Object.entries(put)) {
    const dest = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
  }
  return root;
}

/** Scan a planted root and always remove it. */
function scanPlanted(hooks, files) {
  const root = plantHookRoot(hooks, files);
  try {
    return scanHookEmitters(root, READ_ONLY_FNS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('scanner self-check — the collector is not blind', () => {
  it('reports its denominators', () => {
    const line = `hook entry points=${scan.entries.length} modules parsed=${scan.modules.size} `
      + `ledger emissions=${scan.ledgerEmissions.length} side-channel calls=${scan.sideChannelCalls.length} `
      + `recorders=${scan.recorders.size}`;
    expect(line).toMatch(/hook entry points=\d+/);
    // Measured 2026-09-22 in this worktree: 64 / 206 / 17 / 6 / 8. The same
    // scan without the root-join loader resolution gives 204 / 15, so the two
    // modules and two emissions that resolution adds are exactly session-end.js
    // and receipt-envelope.js. (An earlier revision of this comment claimed 17
    // against a scanner that collected 15; the number was right about the code
    // and wrong about the scanner.) Floors, not pins — the table below is what
    // must stay exact.
    expect(scan.entries.length).toBeGreaterThanOrEqual(40);
    expect(scan.modules.size).toBeGreaterThanOrEqual(150);
    expect(scan.recorders.size).toBeGreaterThanOrEqual(6);
  });

  it('finds every known emitter', () => {
    const found = scan.ledgerEmissions.map((e) => `${e.event}@${e.file}`);
    for (const [event, file] of KNOWN_EMITTER_FLOOR) expect(found).toContain(`${event}@${file}`);
  });

  it('finds the side-channel calls that the T-37 pair is routed through', () => {
    const fns = new Set(scan.sideChannelCalls.map((c) => c.fn));
    expect(fns.has('recordTopologyRecommended')).toBe(true);
    expect(fns.has('recordMemoryInjection')).toBe(true);
    expect(scan.sideChannelCalls.length).toBeGreaterThanOrEqual(4);
  });

  it('collects a planted non-hook emitter and refuses a look-alike (positive + negative control)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-emitter-scan-'));
    try {
      const write = (rel, body) => {
        const dest = path.join(root, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body, 'utf8');
      };
      write('hooks/dispatch-table.json', JSON.stringify({
        slots: {
          Stop: {
            handlers: [
              { name: 'planted', script: 'planted.js' },
              { name: 'silent', script: 'silent.js' },
              { name: 'computed', script: 'computed.js' },
              { name: 'computed-miss', script: 'computed-miss.js' },
            ],
          },
        },
      }));
      write('hooks/hooks.json', JSON.stringify({ hooks: {} }));
      write('lib/runtime/event-writer.js', 'export function writeEvent() { return { ok: true }; }\n');
      write('lib/runtime/ledger.js',
        "import { writeEvent } from './event-writer.js';\n"
        + 'export function appendLedgerEvent(root, ev) { return writeEvent(root, ev); }\n');
      write('lib/observability/decision-events.js',
        'export function recordSomething() { return null; }\n');
      // POSITIVE CONTROL: a new emitter borrowing a non-hook source. The same
      // words also appear here in a JSDoc block and in a string literal — a
      // grep would take all three, the scan must take only the real one.
      write('scripts/hooks/planted.js',
        "import { appendLedgerEvent } from '../../lib/runtime/ledger.js';\n"
        + "/** Documented envelope: { event: 'tool.used', source: 'hook' } */\n"
        + "const doc = \"event: 'mission.created', source: 'hook'\";\n"
        + 'export function run(root) {\n'
        + "  return [doc, appendLedgerEvent(root, { event: 'budget.warning', source: 'scheduler' })];\n"
        + '}\n');
      // NEGATIVE CONTROL: a real event/source object in a module that neither
      // binds a writer nor is imported by one. It must not be collected.
      write('scripts/hooks/silent.js',
        "import { unrelated } from './unrelated.js';\n"
        + 'export function run() { return unrelated(); }\n');
      write('scripts/hooks/unrelated.js',
        "export function unrelated() { return { event: 'hook.fired', source: 'hook' }; }\n");
      // POSITIVE CONTROL for the root-join loader: the writer is reached only
      // through `load(...)`, the shape session-end.js uses. Before that
      // resolution existed this emission was collected by nothing at all.
      write('scripts/hooks/computed.js',
        "import path from 'node:path';\n"
        + "const pluginRoot = process.cwd();\n"
        + "const load = (...rel) => import(toFileUrl(path.join(pluginRoot, ...rel)));\n"
        + 'export async function run(root) {\n'
        + "  const { appendLedgerEvent } = await load('lib', 'runtime', 'ledger.js');\n"
        + "  return appendLedgerEvent(root, { event: 'hook.fired', source: 'scheduler' });\n"
        + '}\n');
      // NEGATIVE CONTROL: same helper shape, but a SEGMENT is computed. It must
      // stay unresolved, so this module is not an appender and its envelope is
      // not collected. This is the residual blind spot, pinned rather than
      // described.
      write('scripts/hooks/computed-miss.js',
        "import path from 'node:path';\n"
        + "const load = (...rel) => import(path.join(process.cwd(), ...rel));\n"
        + "const which = process.env.WHICH;\n"
        + 'export async function run(root) {\n'
        + "  const { appendLedgerEvent } = await load('lib', 'runtime', which);\n"
        + "  return appendLedgerEvent(root, { event: 'tool.used', source: 'worker' });\n"
        + '}\n');

      const planted = scanHookEmitters(root);
      expect(planted.ledgerEmissions).toEqual([
        { site: 'scripts/hooks/planted.js:5', file: 'scripts/hooks/planted.js', event: 'budget.warning', source: 'scheduler' },
        { site: 'scripts/hooks/computed.js:6', file: 'scripts/hooks/computed.js', event: 'hook.fired', source: 'scheduler' },
      ]);
      // And the classifier calls it out rather than shrugging.
      const unclassified = planted.ledgerEmissions.filter(
        (e) => !(e.source === 'hook' && hookPermitted(e.event))
          && !(e.site in EXCEPTIONS) && !(e.site in ROLE_SOURCED),
      );
      expect(unclassified.map((e) => e.site)).toEqual([
        'scripts/hooks/planted.js:5', 'scripts/hooks/computed.js:6',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the SH-30 literals out of the REAL emitter text, and turns a planted source RED', () => {
    // The two emitters are copied verbatim into a scratch root behind one
    // appender hook, then re-scanned after single-token text mutations. This is
    // the scanner self-check for the literalization: were the literals ever
    // read as null (the pre-SH-30 shape), a mutated source would pass unseen.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-emitter-sh30-'));
    const realText = (rel) => fs.readFileSync(path.join(PKG_ROOT, ...rel.split('/')), 'utf8');
    try {
      const write = (rel, body) => {
        const dest = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body, 'utf8');
      };
      write('hooks/dispatch-table.json', JSON.stringify({
        slots: {
          Stop: {
            handlers: [
              { name: 'appender', script: 'appender.js' },
              { name: 'ternary', script: 'ternary.js' },
            ],
          },
        },
      }));
      write('hooks/hooks.json', JSON.stringify({ hooks: {} }));
      write('lib/runtime/event-writer.js', 'export function writeEvent() { return { ok: true }; }\n');
      write('lib/runtime/ledger.js',
        "import { writeEvent } from './event-writer.js';\n"
        + 'export function appendLedgerEvent(root, ev) { return writeEvent(root, ev); }\n');
      write('lib/observability/decision-events.js', 'export function recordSomething() { return null; }\n');
      write('scripts/hooks/appender.js',
        "import { appendLedgerEvent } from '../../lib/runtime/ledger.js';\n"
        + "import { appendMissionEvent } from '../../lib/runtime/middleware/mission-ledger.js';\n"
        + "import { createStateStore } from '../../lib/project-state/state-manager.js';\n"
        + 'export { appendLedgerEvent, appendMissionEvent, createStateStore };\n');
      // NEGATIVE CONTROL: the shape SH-30 removed — an event name chosen at
      // runtime. It must be collected with event null, and so stay unclassified.
      write('scripts/hooks/ternary.js',
        "import { appendLedgerEvent } from '../../lib/runtime/ledger.js';\n"
        + 'export function run(root, flag) {\n'
        + "  return appendLedgerEvent(root, { event: flag ? 'mission.created' : 'mission.candidate_deferred', source: 'hook' });\n"
        + '}\n');

      const unclassifiedOf = (rows) => rows.filter(
        (e) => !(e.source === 'hook' && hookPermitted(e.event))
          && !(e.site in EXCEPTIONS) && !(e.site in ROLE_SOURCED),
      ).map((e) => e.site);
      // Sorted by site: collection order follows module traversal order, which
      // differs between the repository graph and this one-hook scratch graph.
      const rowsOf = (result) => result.ledgerEmissions.filter(
        (e) => e.file === MISSION_LEDGER_REL || e.file === STATE_MANAGER_REL,
      ).sort((a, b) => a.site.localeCompare(b.site));
      const realRows = rowsOf(scan);
      const siteOf = (file, event, source) => realRows
        .find((e) => e.file === file && e.event === event && e.source === source)?.site;
      const deferredSite = siteOf(MISSION_LEDGER_REL, 'mission.candidate_deferred', 'hook');
      const storeHookSite = siteOf(STATE_MANAGER_REL, 'state.updated', 'hook');
      expect(deferredSite).toMatch(/^lib\/runtime\/middleware\/mission-ledger\.js:\d+$/);
      expect(storeHookSite).toMatch(/^lib\/project-state\/state-manager\.js:\d+$/);

      // POSITIVE CONTROL: the unmutated text yields the same four literal rows
      // the repository scan does, all classified.
      write(MISSION_LEDGER_REL, realText(MISSION_LEDGER_REL));
      write(STATE_MANAGER_REL, realText(STATE_MANAGER_REL));
      const original = scanHookEmitters(root);
      expect(rowsOf(original)).toEqual(realRows);
      expect(realRows.map((e) => `${e.event}/${e.source}`).sort()).toEqual([
        'mission.candidate_deferred/hook', 'mission.created/hook',
        'state.updated/hook', 'state.updated/supervisor',
      ]);
      expect(unclassifiedOf(rowsOf(original))).toEqual([]);
      const ternary = original.ledgerEmissions.filter((e) => e.file === 'scripts/hooks/ternary.js');
      expect(ternary).toEqual([
        { site: 'scripts/hooks/ternary.js:3', file: 'scripts/hooks/ternary.js', event: null, source: 'hook' },
      ]);
      expect(unclassifiedOf(ternary)).toEqual(['scripts/hooks/ternary.js:3']);

      /** Replace the `source` literal of exactly one envelope; RED unless it matched once. */
      const mutate = (text, event, from, to) => {
        const pattern = new RegExp(
          `(event: '${event.replace(/\./g, '\\.')}',\\s+mission_id: missionId,\\s+session_id: sessionId,\\s+source: )'${from}'`,
          'g',
        );
        expect(text.match(pattern), `${event} source:'${from}' must occur exactly once`).toHaveLength(1);
        return text.replace(pattern, `$1'${to}'`);
      };

      // MUTATION 1: the deferred branch borrows a source its event does not admit.
      write(MISSION_LEDGER_REL, mutate(realText(MISSION_LEDGER_REL), 'mission.candidate_deferred', 'hook', 'scheduler'));
      expect(unclassifiedOf(rowsOf(scanHookEmitters(root)))).toEqual([deferredSite]);
      write(MISSION_LEDGER_REL, realText(MISSION_LEDGER_REL));

      // MUTATION 2: the store's hook branch is relabelled with an unlisted role.
      write(STATE_MANAGER_REL, mutate(realText(STATE_MANAGER_REL), 'state.updated', 'hook', 'worker'));
      expect(unclassifiedOf(rowsOf(scanHookEmitters(root)))).toEqual([storeHookSite]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scanner named constants — read only when the module binds the name once (SH-30 residual)', () => {
  // The scan used to keep the FIRST string declaration of a name anywhere in the
  // module, ignoring scope. A second binding of the name (an inner const, a
  // parameter, a destructured local, a catch binding) or a `let` that can be
  // reassigned was therefore read as the first value: the emission looked
  // compliant while the code sent something else. Every case below was read as
  // 'hook' / 'tool.used' before the fix; each must now be unreadable (null),
  // which leaves the emission unclassified and the gate RED.
  const HEAD = "import { appendLedgerEvent } from '../../lib/runtime/ledger.js';\n";
  const send = (fields) => `appendLedgerEvent(root, { ${fields} })`;
  const bySrc = "event: 'tool.used', source: SRC";
  /** The `field` of every emission a one-hook scratch graph yields, in source order. */
  const read = (body, field = 'source') => scanPlanted({ 'planted.js': HEAD + body })
    .ledgerEmissions.map((e) => e[field]);

  it('still reads a constant that is bound exactly once (positive control)', () => {
    expect(read(`const SRC = 'hook';\nexport const run = (root) => ${send(bySrc)};\n`)).toEqual(['hook']);
    expect(read(`const EVT = 'tool.used';\nexport const run = (root) => ${send("event: EVT, source: 'hook'")};\n`, 'event'))
      .toEqual(['tool.used']);
  });

  it.each([
    ['an inner const of the same name', 'source', [null],
      `const SRC = 'hook';\nexport function run(root) {\n  const SRC = 'scheduler';\n  return ${send(bySrc)};\n}\n`],
    ['two functions each declaring the same name', 'source', [null, null],
      `export function a(root) {\n  const SRC = 'hook';\n  return ${send(bySrc)};\n}\n`
      + `export function b(root) {\n  const SRC = 'scheduler';\n  return ${send(bySrc)};\n}\n`],
    ['a parameter that shadows the constant', 'source', [null],
      `const SRC = 'hook';\nexport function run(root, SRC) {\n  return ${send(bySrc)};\n}\n`],
    ['a destructured local that shadows the constant', 'source', [null],
      `const SRC = 'hook';\nexport function run(root, opts) {\n  const { SRC } = opts;\n  return ${send(bySrc)};\n}\n`],
    ['a catch binding that shadows the constant', 'source', [null],
      `const SRC = 'hook';\nexport function run(root) {\n  try {\n    return null;\n  } catch (SRC) {\n    return ${send(bySrc)};\n  }\n}\n`],
    ['a let that is reassigned', 'source', [null],
      `let SRC = 'hook';\nSRC = process.env.WHO;\nexport function run(root) {\n  return ${send(bySrc)};\n}\n`],
    ['a shadowed event-name constant', 'event', [null],
      `const EVT = 'tool.used';\nexport function run(root) {\n  const EVT = 'mission.created';\n  return ${send("event: EVT, source: 'hook'")};\n}\n`],
  ])('reads %s as unreadable, leaving the emission unclassified', (_label, field, expected, body) => {
    expect(read(body, field)).toEqual(expected);
  });

  // The store module's REAL text, planted behind an appender hook and read back
  // through `frozenLiteralValues`.
  const storeText = fs.readFileSync(path.join(PKG_ROOT, ...STATE_MANAGER_REL.split('/')), 'utf8');
  const frozenFrom = (text) => frozenLiteralValues(
    STATE_MANAGER_REL, 'STATE_UPDATED_SOURCES',
    scanPlanted(
      { 'appender.js': "import { createStateStore } from '../../lib/project-state/state-manager.js';\nexport { createStateStore };\n" },
      { [STATE_MANAGER_REL]: text },
    ),
  );

  it('reads a frozen list only from a name bound once, so a shadow turns the pin RED', () => {
    // `frozenLiteralValues` had the same first-declaration reading: a parameter
    // named STATE_UPDATED_SOURCES inside the store module left the gate comparing
    // the emitted sources with a list the code no longer uses.
    const shadow = '\nexport function shadow(STATE_UPDATED_SOURCES) { return STATE_UPDATED_SOURCES; }\n';
    expect(frozenFrom(storeText)).toEqual(['hook', 'supervisor']);
    expect(frozenFrom(storeText + shadow)).toBeNull();
  });

  it.each(['let', 'var'])('reads a frozen list only from a const, so a %s reassigned on the same line turns the pin RED', (kind) => {
    // Bound once, but not final: a `let`/`var` lets the list be replaced after the
    // freeze, so what the gate reads is no longer what runs. The reviewer's mutant
    // added 'worker' exactly this way and the gate stayed green.
    const declared = "export const STATE_UPDATED_SOURCES = Object.freeze(['hook', 'supervisor']);";
    expect(storeText.split(declared), 'the declaration must occur exactly once').toHaveLength(2);
    const mutant = storeText.replace(declared, () => `export ${kind} STATE_UPDATED_SOURCES = Object.freeze(['hook', 'supervisor']);`
      + " STATE_UPDATED_SOURCES = Object.freeze(['hook', 'supervisor', 'worker']);");
    expect(frozenFrom(mutant)).toBeNull();
  });
});

describe('hook-reachable StateStore openers name their source (SH-30 N2)', () => {
  // WHY THIS EXISTS. `createStateStore` defaults `source` to 'supervisor'. A hook
  // that opens a store and forgets `source` was therefore recorded as a
  // supervisor, which lands on the one `state.updated` branch this file already
  // classifies as legitimate (ROLE_SOURCED): the emission classification stayed
  // green for exactly the mistake the rule exists to catch. The default cannot
  // simply be removed — 3 shipped read-only openers and 13 test call sites omit
  // `source` (measured 2026-09-29) — so the rule is pinned at the CALLER instead.
  const STORE = "import { createStateStore } from '../../lib/project-state/state-manager.js';\n";
  const opts = (fields) => `{ projectRoot: root, sessionId: 's', appendEvent: () => ({ ok: true })${fields} }`;
  const openersOf = (body) => scanPlanted({ 'planted.js': body }).storeOpeners;
  const faultsOf = (body) => openersOf(body).map(storeOpenerFault).filter(Boolean);
  const dynamic = (call) => 'export async function open(root) {\n'
    + "  const { createStateStore } = await import('../../lib/project-state/state-manager.js');\n"
    + `  return ${call};\n}\n`;
  const namespaced = (call) => "import * as sm from '../../lib/project-state/state-manager.js';\n"
    + `export const open = (root) => sm.${call};\n`;

  it('finds the openers it is meant to pin (the census is not blind)', () => {
    const seen = scan.storeOpeners.map((o) => `${o.file}#${o.fn}=${o.source}`);
    expect(seen).toContain('lib/runtime/middleware/tasks.js#openMissionStore=hook');
    expect(seen).toContain('scripts/hooks/post-compact-rehydrate.js#openMissionStoreReadOnly=<absent>');
  });

  it('holds every hook-reachable opener to source:hook, bar a listed read-only one', () => {
    expect(scan.storeOpeners.map(storeOpenerFault).filter(Boolean)).toEqual([]);
  });

  it.each([
    ['spells source:hook', `${STORE}export const open = (root) => createStateStore(${opts(", source: 'hook'")});\n`],
    ['spells source:hook on a namespace import', namespaced(`createStateStore(${opts(", source: 'hook'")})`)],
    ['spells source:hook on a dynamically imported binding', dynamic(`createStateStore(${opts(", source: 'hook'")})`)],
    ['spells source:hook through a constant bound once',
      `${STORE}const WHO = 'hook';\nexport const open = (root) => createStateStore(${opts(', source: WHO')});\n`],
  ])('accepts an opener that %s (positive control)', (_label, body) => {
    expect(openersOf(body)).toHaveLength(1);
    expect(faultsOf(body)).toEqual([]);
  });

  it.each([
    ['omits source, so the store defaults it to supervisor', `${STORE}export const open = (root) => createStateStore(${opts('')});\n`, '<absent>'],
    ['omits source on a namespace import', namespaced(`createStateStore(${opts('')})`), '<absent>'],
    ['omits source on a dynamically imported binding', dynamic(`createStateStore(${opts('')})`), '<absent>'],
    ['spells source:supervisor', `${STORE}export const open = (root) => createStateStore(${opts(", source: 'supervisor'")});\n`, 'supervisor'],
    ['computes its source', `${STORE}export const open = (root) => createStateStore(${opts(', source: process.env.WHO')});\n`, '<opaque>'],
    ['spreads options that may carry the source',
      `${STORE}export const open = (root, extra) => createStateStore({ ...extra, projectRoot: root, sessionId: 's', appendEvent: () => ({ ok: true }) });\n`, '<opaque>'],
    ['passes options it does not build in place', `${STORE}export const open = (root, options) => createStateStore(options);\n`, '<opaque>'],
    ['names a source constant that a parameter shadows',
      `${STORE}const WHO = 'hook';\nexport const open = (root, WHO) => createStateStore(${opts(', source: WHO')});\n`, '<opaque>'],
    ['aliases the factory', `${STORE}const open = createStateStore;\nexport const run = (root) => open(${opts(", source: 'hook'")});\n`, '<opaque>'],
    ['constructs the factory', `${STORE}export const open = (root) => new createStateStore(${opts(", source: 'hook'")});\n`, '<opaque>'],
    ['re-exports the factory', "export { createStateStore } from '../../lib/project-state/state-manager.js';\n", '<opaque>'],
  ])('flags an opener that %s', (_label, body, source) => {
    const faults = faultsOf(body);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain(`with source ${source}`);
  });

  it('ties a read-only listing to its file, its function and an omitted source (it is not a waiver)', () => {
    for (const [file, entry] of Object.entries(READ_ONLY_OPENERS)) {
      const at = { file, fn: entry.fn, site: `${file}:1` };
      expect(storeOpenerFault({ ...at, source: ABSENT })).toBeNull();
      for (const other of [
        { fn: 'anotherOpener', source: ABSENT },
        { source: 'supervisor' },
        { source: OPAQUE },
        { file: 'scripts/hooks/other.js', source: ABSENT },
      ]) expect(storeOpenerFault({ ...at, ...other })).toContain('opens the StateStore');
    }
  });

  it('flags an omitting hook that the emission classification alone waves through (the N2 defect)', () => {
    // The store module is the REAL text, so its two `state.updated` literals are
    // collected exactly as in the repository scan; the hook binds a live writer.
    const realText = fs.readFileSync(path.join(PKG_ROOT, ...STATE_MANAGER_REL.split('/')), 'utf8');
    const hook = "import { appendLedgerEvent } from '../../lib/runtime/ledger.js';\n"
      + `${STORE}export const open = (root, sid) => createStateStore({ projectRoot: root, sessionId: sid,\n`
      + '  appendEvent: (event) => appendLedgerEvent(root, event) });\n';
    const planted = scanPlanted({ 'planted.js': hook }, { [STATE_MANAGER_REL]: realText });
    expect(planted.ledgerEmissions.filter((e) => e.file === STATE_MANAGER_REL)).toHaveLength(2);
    // Emission side: every literal the store can write is classified — GREEN.
    expect(planted.ledgerEmissions.filter(
      (e) => !(e.source === 'hook' && hookPermitted(e.event)) && !(e.site in ROLE_SOURCED),
    )).toEqual([]);
    // Caller side: the hook never said which role it is — RED.
    expect(planted.storeOpeners.map(storeOpenerFault).filter(Boolean)).toHaveLength(1);
  });

  it('lists only read-only openers that are live and refuse a commit when called with one argument', async () => {
    const probeId = 'M-20260929-001';
    const probe = () => ({
      title: 'gate-probe',
      status: 'executing',
      intent: { path: `missions/${probeId}/intent.md`, revision: 1 },
      plan: { path: `missions/${probeId}/plan.md`, revision: 1 },
    });
    const commit = (store) => store.updateMission(probeId, probe, { reason: 'gate-probe' });
    const inTmp = async (run) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-opener-'));
      try {
        return await run(root);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };

    // POSITIVE CONTROL: the probe mission commits through an accepting port, so a
    // refusal below can only come from the port the listed opener itself binds.
    await inTmp((root) => {
      const store = createStateStore({
        projectRoot: root, sessionId: 'gate-probe', source: 'hook', renderProjectionFile: false,
        appendEvent: () => ({ ok: true }),
      });
      expect(commit(store).ok).toBe(true);
    });

    for (const [file, entry] of Object.entries(READ_ONLY_OPENERS)) {
      expect(
        scan.storeOpeners.some((o) => o.file === file && o.fn === entry.fn),
        `stale listing: no StateStore opener in ${file}#${entry.fn}`,
      ).toBe(true);
      expect(entry.reason.length, `${file} needs a reason`).toBeGreaterThan(40);
      const mod = await import(pathToFileURL(path.join(PKG_ROOT, ...file.split('/'))).href);
      expect(typeof mod[entry.fn], `${file} must export ${entry.fn} for this gate to drive it`).toBe('function');
      await inTmp((root) => {
        const store = mod[entry.fn](root);
        const out = commit(store);
        expect(out.ok, `${file}#${entry.fn} committed a write`).toBe(false);
        expect(out.errors.join(' ')).toMatch(/ledger refused state\.updated/);
        expect(fs.existsSync(store.paths.journal), `${file}#${entry.fn} wrote a journal`).toBe(false);
        expect(fs.existsSync(store.paths.snapshot), `${file}#${entry.fn} wrote a snapshot`).toBe(false);
      });
    }
  });
});

describe('read-only openers are only ever called with one argument (SH-30 N2 seam)', () => {
  // WHY THIS EXISTS. `openMissionStoreReadOnly(projectRoot, ports = {})` binds
  // `ports.appendEvent ?? NO_LEDGER_WRITER`, so the refusal proven above holds
  // for the ONE-argument call only. A caller that hands it a ports object turns
  // the "read-only" store into a writer, and the proof says nothing about that.
  // The seam has to stay (tests use it), so PRODUCTION use is what is forbidden:
  // no call in the hook graph, through any alias, may give a listed opener a
  // second argument. The reviewer's mutant did that from `readMissionContext`,
  // which reaches the opener through a parameter default (`openStore = ...`), so
  // a check on the opener's own name alone would have missed it.
  const HOOK_REL = 'scripts/hooks/post-compact-rehydrate.js';
  const hookText = fs.readFileSync(path.join(PKG_ROOT, ...HOOK_REL.split('/')), 'utf8');
  const IMPORT = "import { openMissionStoreReadOnly } from './post-compact-rehydrate.js';\n";
  const PORTS = '{ appendEvent: () => ({ ok: true }) }';
  const usesOf = (body) => scanPlanted({ 'planted.js': body }).readOnlyCalls;
  const faultsOf = (uses) => uses.map(readOnlyCallFault).filter(Boolean);
  const shape = (c) => `${c.fn}:${c.callee}/${c.args}`;

  it('sees the production call through its parameter-default alias (the census is not blind to it)', () => {
    expect(scan.readOnlyCalls.map((c) => `${c.file}#${shape(c)}`))
      .toContain(`${HOOK_REL}#readMissionContext:openStore/1`);
  });

  it('holds every hook-graph use of a listed read-only opener to one argument', () => {
    expect(faultsOf(scan.readOnlyCalls)).toEqual([]);
  });

  it("flags the reviewer's mutant: readMissionContext handing the opener a live ports object", () => {
    const call = 'openStore(projectRoot)';
    expect(hookText.split(call), 'the production call must occur exactly once').toHaveLength(2);
    const planted = (text) => scanPlanted({ 'post-compact-rehydrate.js': text }).readOnlyCalls;
    // POSITIVE CONTROL: the real text is clean, and its alias call IS seen.
    expect(planted(hookText).map(shape)).toEqual(['readMissionContext:openStore/1']);
    expect(faultsOf(planted(hookText))).toEqual([]);
    // MUTANT: the same call gains a ports object that binds an accepting writer.
    const faults = faultsOf(planted(hookText.replace(call, () => `openStore(projectRoot, ${PORTS})`)));
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('readMissionContext');
    expect(faults[0]).toContain('with 2 arguments');
  });

  it.each([
    ['calls it directly with a ports object',
      `${IMPORT}export const open = (root) => openMissionStoreReadOnly(root, ${PORTS});\n`, 'open:openMissionStoreReadOnly/2'],
    ['calls it through a namespace import with a ports object',
      `import * as hook from './post-compact-rehydrate.js';\nexport const open = (root) => hook.openMissionStoreReadOnly(root, ${PORTS});\n`,
      'open:openMissionStoreReadOnly/2'],
    ['calls it through a parameter-default alias with a ports object',
      `${IMPORT}export function read(root, open = openMissionStoreReadOnly) { return open(root, ${PORTS}); }\n`, 'read:open/2'],
    ['calls it through a variable alias with a ports object',
      `${IMPORT}const open = openMissionStoreReadOnly;\nexport const run = (root) => open(root, ${PORTS});\n`, 'run:open/2'],
    ['calls it through an alias of an alias with a ports object',
      `${IMPORT}const a = openMissionStoreReadOnly;\nconst b = a;\nexport const run = (root) => b(root, ${PORTS});\n`, 'run:b/2'],
    ['calls it through a destructuring rename with a ports object',
      `export async function run(root) {\n  const { openMissionStoreReadOnly: open } = await import('./post-compact-rehydrate.js');\n  return open(root, ${PORTS});\n}\n`,
      'run:open/2'],
    ['calls it through an import rename with a ports object',
      `import { openMissionStoreReadOnly as open } from './post-compact-rehydrate.js';\nexport const run = (root) => open(root, ${PORTS});\n`,
      'run:open/2'],
  ])('flags a hook that %s', (_label, body, expected) => {
    const uses = usesOf(body);
    expect(uses.map(shape)).toEqual([expected]);
    expect(faultsOf(uses)).toHaveLength(1);
  });

  it.each([
    ['spreads its arguments', `${IMPORT}export const run = (root, ...rest) => openMissionStoreReadOnly(root, ...rest);\n`],
    ['hands it on as a value', `${IMPORT}export const run = () => start(openMissionStoreReadOnly);\n`],
    ['borrows it with .call', `${IMPORT}export const run = (root) => openMissionStoreReadOnly.call(null, root, ${PORTS});\n`],
    ['stores it in an object', `${IMPORT}export const table = { open: openMissionStoreReadOnly };\n`],
    ['re-exports it under another name', "export { openMissionStoreReadOnly as openIt } from './post-compact-rehydrate.js';\n"],
    ['exports an alias of it', `${IMPORT}export const open = openMissionStoreReadOnly;\n`],
  ])('flags a hook that %s (the scan cannot follow it)', (_label, body) => {
    const faults = faultsOf(usesOf(body));
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('cannot follow');
  });

  it.each([
    ['calls it with the project root only',
      `${IMPORT}export const open = (root) => openMissionStoreReadOnly(root);\n`, ['open:openMissionStoreReadOnly/1']],
    ['calls it through a parameter-default alias with the project root only',
      `${IMPORT}export function read(root, open = openMissionStoreReadOnly) { return open(root); }\n`, ['read:open/1']],
    ['re-exports it under its own name', "export { openMissionStoreReadOnly } from './post-compact-rehydrate.js';\n", []],
  ])('accepts a hook that %s (positive control)', (_label, body, expected) => {
    const uses = usesOf(body);
    expect(uses.map(shape)).toEqual(expected);
    expect(faultsOf(uses)).toEqual([]);
  });
});

describe('hook emitter sources rule', () => {
  it('classifies every collected ledger emission as (A), (C) or a listed (E)', () => {
    const unclassified = scan.ledgerEmissions
      .filter((e) => !(e.source === 'hook' && hookPermitted(e.event)))
      .filter((e) => !(e.site in EXCEPTIONS))
      .filter((e) => !(e.site in ROLE_SOURCED))
      .map((e) => `${e.site} event=${e.event} source=${e.source}`);
    expect(unclassified).toEqual([]);
  });

  it('holds every (A) emission to source:hook on a hook-permitted event', () => {
    const compliant = scan.ledgerEmissions.filter(
      (e) => !(e.site in EXCEPTIONS) && !(e.site in ROLE_SOURCED),
    );
    expect(compliant.length).toBeGreaterThanOrEqual(11);
    for (const e of compliant) {
      expect(e.source, `${e.site} must declare source:'hook'`).toBe('hook');
      expect(hookPermitted(e.event), `${e.site} emits ${e.event}, which the allowlist does not permit from a hook`).toBe(true);
    }
  });

  it('keeps every listed site live, matching, and reasoned', () => {
    const bySite = new Map(scan.ledgerEmissions.map((e) => [e.site, e]));
    for (const [site, entry] of [...Object.entries(ROLE_SOURCED), ...Object.entries(EXCEPTIONS)]) {
      const found = bySite.get(site);
      expect(found, `stale listing: no emission at ${site}`).toBeDefined();
      expect(found.event, `${site} event drifted`).toBe(entry.event);
      expect(found.source, `${site} source drifted`).toBe(entry.source);
      expect(entry.reason.length, `${site} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('registers every (C) role in the allowlist sources of its event', () => {
    // Criterion (3) is only meaningful if the role is a role the event admits.
    // Without this, ROLE_SOURCED would be a waiver list wearing a new name.
    for (const [site, entry] of Object.entries(ROLE_SOURCED)) {
      const spec = allowlist.events?.[entry.event];
      expect(spec, `${site}: ${entry.event} is not in the allowlist at all`).toBeDefined();
      expect(
        spec.sources === null || spec.sources === undefined || spec.sources.includes(entry.source),
        `${site} writes source:${entry.source}, which ${entry.event} does not register`,
      ).toBe(true);
    }
  });

  it('keeps EXCEPTIONS empty', () => {
    expect(
      Object.keys(EXCEPTIONS),
      'a new non-literal emitter is made literal first (SH-30) — do not list it here',
    ).toEqual([]);
  });

  it('matches every mapped event name of mission-ledger.js to a literal envelope, and back', () => {
    // The map normalizes compiler spellings; the envelope literals are what the
    // scan can read. A map value with no branch would be skipped at runtime by
    // the null return and never seen here; a branch with no map value would be
    // dead. Both directions are RED.
    const values = frozenLiteralValues(MISSION_LEDGER_REL, 'LEDGER_EVENT_BY_COMPILER_NAME');
    expect(values, 'LEDGER_EVENT_BY_COMPILER_NAME moved — re-read the emitter').toBeDefined();
    expect(values, 'LEDGER_EVENT_BY_COMPILER_NAME is no longer a const Object.freeze({...}) literal, bound once').not.toBeNull();
    expect(values, 'every mapped event name must be a string literal').not.toContain(null);
    const mapped = [...new Set(values)].sort();
    expect(collectedIn(MISSION_LEDGER_REL, 'event')).toEqual(mapped);
    expect(collectedIn(MISSION_LEDGER_REL, 'source')).toEqual(['hook']);
    for (const name of mapped) expect(hookPermitted(name), `${name} is not hook-permitted`).toBe(true);
  });

  it('matches STATE_UPDATED_SOURCES in state-manager.js to its literal envelopes, and back', () => {
    const values = frozenLiteralValues(STATE_MANAGER_REL, 'STATE_UPDATED_SOURCES');
    expect(values, 'STATE_UPDATED_SOURCES moved — re-read the emitter').toBeDefined();
    expect(values, 'STATE_UPDATED_SOURCES is no longer a const Object.freeze([...]) literal, bound once').not.toBeNull();
    expect(values, 'every allowed source must be a string literal').not.toContain(null);
    expect(collectedIn(STATE_MANAGER_REL, 'source')).toEqual([...new Set(values)].sort());
    expect(collectedIn(STATE_MANAGER_REL, 'event')).toEqual(['state.updated']);
  });

  it('keeps the (D) non-emitters silent', () => {
    for (const file of Object.keys(NON_EMITTERS)) {
      expect(fs.existsSync(path.join(PKG_ROOT, file)), `${file} vanished`).toBe(true);
      const rows = scan.ledgerEmissions.filter((e) => e.file === file);
      expect(rows.map((r) => r.site), `${file} is listed as binding no ledger writer`).toEqual([]);
    }
  });

  it('keeps the rule itself written down where the side-channel lives', () => {
    const header = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'observability', 'decision-events.js'), 'utf8')
      .split('\nimport ')[0];
    expect(header).toContain('LEGITIMATE-EMITTER RULE');
    expect(header).toContain('FIRST-HAND WITNESS');
    expect(header).toContain('HONEST PAYLOAD');
    expect(header).toContain('THE T-37 PAIR, JUDGED BY THAT RULE');
    expect(header).toContain('tests/firewall/hook-emitter-sources-rule.test.js');
  });
});
