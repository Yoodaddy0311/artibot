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
 * FOUR PATTERNS EXIST TODAY, and the point of the gate is that every collected
 * emission falls into one of them by NAME rather than by a reader's judgement:
 *   (A) ledger append, `source:'hook'`, on an event whose allowlist `sources`
 *       includes `hook`. The compliant case.
 *   (B) a call into `lib/observability/decision-events.js`. The side-channel —
 *       the destination the rule sends a failing case to.
 *   (C) a hook-reachable append that writes a ROLE source (`gate`, `reviewer`,
 *       `human`) instead of `hook`. Left as-is: whether a `source` names a
 *       process or a role is an open design question and this gate does not
 *       pre-empt it. Each one is listed in `EXCEPTIONS` with its reason.
 *   (D) a hook that deliberately binds NO ledger writer and records the gap
 *       instead. Listed in `NON_EMITTERS`, and asserted to stay silent.
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
 *   - RUNTIME EMISSIONS. This is a static read. An emitter reached only through
 *     a computed specifier, a spawned child process, or a port injected at call
 *     time is invisible here, and its absence from the table below is not
 *     evidence it does not exist. The live distribution is the Existence
 *     Audit's measurement, not this file's.
 *   - WHETHER A CLASSIFICATION IS RIGHT. The gate checks that every emission is
 *     classified and that no exception is stale. It cannot tell a correct
 *     `source` from a plausible one — that is what the reason strings, and a
 *     reader, are for.
 *   - ONE HOP OF BUILDER DEPTH. An envelope literal is read out of a writer
 *     importer or a module it imports DIRECTLY. A builder two modules away from
 *     the append would be missed; none exists today (verified by the known-
 *     emitter floor below), and a new one would surface as an unclassified
 *     append in the importer rather than silently.
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
import { fileURLToPath } from 'node:url';
import { parse } from 'espree';

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
 * Parse one module: its resolvable dependencies and its module-level string
 * constants. Constants matter because almost no emitter writes the event name
 * inline — `TOOL_USED_EVENT`, `LEDGER_SOURCE` and friends are the normal shape.
 */
function analyzeModule(root, file) {
  const ast = parse(fs.readFileSync(file, 'utf8'), ESPREE_OPTS);
  const deps = new Set();
  const consts = new Map();
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
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init
        && n.init.type === 'Literal' && typeof n.init.value === 'string'
        && !consts.has(n.id.name)) {
      consts.set(n.id.name, n.init.value);
    }
  });
  return { file, ast, deps, consts };
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

function scanHookEmitters(root) {
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
  for (const [file, info] of modules) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
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
  return { entries, modules, ledgerEmissions, sideChannelCalls, recorders };
}

// ---------------------------------------------------------------------------
// The classification table. Adding an emitter without adding a line here is the
// failure this file exists to produce.
// ---------------------------------------------------------------------------

/**
 * (C) Hook-reachable appends that write a ROLE source rather than `hook`.
 * Keyed by `<path>:<line>` so a moved emitter is re-examined rather than
 * inherited. Every entry must match a collected emission — a stale one is RED.
 */
const EXCEPTIONS = Object.freeze({
  'lib/verification/verify-writer.js:345': {
    event: 'verify.completed',
    source: 'gate',
    reason: 'The verification gate, not the hook process, is the witness; the '
      + 'allowlist registers this event with sources:["gate"] only. Whether '
      + '`gate` is a process identity or a role is the undecided question.',
  },
  'lib/review/verdict-writer.js:187': {
    event: 'review.completed',
    source: 'reviewer',
    reason: 'The reviewer subagent produced the verdict; the SubagentStop hook '
      + 'relays it, so criterion (1) puts the record on the reviewer.',
  },
  'lib/review/verdict-writer.js:256': {
    event: 'review.claim_audit',
    source: 'reviewer',
    reason: 'Same relay as review.completed — the audit is the reviewer\'s claim '
      + 'census, not the hook\'s observation.',
  },
  'lib/runtime/human-asked-record.js:505': {
    event: 'human.resolved',
    source: 'human',
    reason: 'A person answered and the hook is relaying it. The allowlist '
      + 'permits both spellings, so the source line is the only thing that says '
      + 'which one a reader sees; the paired human.asked IS the hook\'s own '
      + 'observation and stays source:hook.',
  },
  'lib/runtime/middleware/tasks.js:341': {
    event: null,
    source: 'hook',
    reason: 'Event name resolved at runtime through LEDGER_EVENT_BY_COMPILER_NAME. '
      + 'The source is hook and both reachable names are hook-permitted — pinned '
      + 'below in `RUNTIME_NAMED_EVENTS` so a name added to that map is checked.',
    runtimeNamedEvents: ['mission.created', 'mission.candidate_deferred'],
  },
  'lib/project-state/state-manager.js:333': {
    event: 'state.updated',
    source: null,
    reason: 'Source is injected by the caller (`ctx.source`), and the allowlist '
      + 'registers state.updated with `sources: null` — unrestricted by design, '
      + 'because the paired write can come from any writer of project state.',
  },
});

/** (D) Hooks that deliberately bind no ledger writer. Asserted to stay silent. */
const NON_EMITTERS = Object.freeze({
  'scripts/hooks/post-compact-rehydrate.js': {
    reason: 'Binds no ledger writer on purpose (`writer: null` in reportReceipt) '
      + 'and records the gap in the Context Receipt instead: criterion (2) fails '
      + 'because context.compiled\'s required cache.* numbers have another '
      + 'declared writer.',
  },
});

/** Floor for the scanner self-check: emitters that must be found, or the scan is blind. */
const KNOWN_EMITTER_FLOOR = Object.freeze([
  ['hook.fired', 'scripts/hooks/_hook-fired-record.js'],
  ['tool.used', 'scripts/hooks/tool-used-record.js'],
  ['mission.created', 'scripts/hooks/intent-observe-pre.js'],
  ['route.selected', 'scripts/hooks/route-observe-pre.js'],
  ['plan.revised', 'scripts/hooks/_plan-observe-record.js'],
  ['mission.completed', 'scripts/hooks/mission-complete-record.js'],
  ['verify.completed', 'lib/verification/verify-writer.js'],
]);

// ---------------------------------------------------------------------------

const allowlist = JSON.parse(
  fs.readFileSync(path.join(PKG_ROOT, 'schemas', 'ledger-events.allowlist.json'), 'utf8'),
);
const scan = scanHookEmitters(PKG_ROOT);

function hookPermitted(eventName) {
  const spec = allowlist.events?.[eventName];
  if (!spec) return false;
  // `sources: null` means unrestricted, not "no source allowed".
  return spec.sources === null || spec.sources === undefined || spec.sources.includes('hook');
}

describe('scanner self-check — the collector is not blind', () => {
  it('reports its denominators', () => {
    const line = `hook entry points=${scan.entries.length} modules parsed=${scan.modules.size} `
      + `ledger emissions=${scan.ledgerEmissions.length} side-channel calls=${scan.sideChannelCalls.length} `
      + `recorders=${scan.recorders.size}`;
    expect(line).toMatch(/hook entry points=\d+/);
    // Measured 2026-09-22 at 3da220c8: 64 / 204 / 17 / 6 / 8. Floors, not pins —
    // the table below is what must stay exact.
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

      const planted = scanHookEmitters(root);
      expect(planted.ledgerEmissions).toEqual([
        { site: 'scripts/hooks/planted.js:5', file: 'scripts/hooks/planted.js', event: 'budget.warning', source: 'scheduler' },
      ]);
      // And the classifier calls it out rather than shrugging.
      const unclassified = planted.ledgerEmissions.filter(
        (e) => !(e.source === 'hook' && hookPermitted(e.event)) && !(e.site in EXCEPTIONS),
      );
      expect(unclassified.map((e) => e.site)).toEqual(['scripts/hooks/planted.js:5']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hook emitter sources rule', () => {
  it('classifies every collected ledger emission as (A) or a listed exception', () => {
    const unclassified = scan.ledgerEmissions
      .filter((e) => !(e.source === 'hook' && hookPermitted(e.event)))
      .filter((e) => !(e.site in EXCEPTIONS))
      .map((e) => `${e.site} event=${e.event} source=${e.source}`);
    expect(unclassified).toEqual([]);
  });

  it('holds every (A) emission to source:hook on a hook-permitted event', () => {
    const compliant = scan.ledgerEmissions.filter((e) => !(e.site in EXCEPTIONS));
    expect(compliant.length).toBeGreaterThanOrEqual(9);
    for (const e of compliant) {
      expect(e.source, `${e.site} must declare source:'hook'`).toBe('hook');
      expect(hookPermitted(e.event), `${e.site} emits ${e.event}, which the allowlist does not permit from a hook`).toBe(true);
    }
  });

  it('keeps every exception live, matching, and reasoned', () => {
    const bySite = new Map(scan.ledgerEmissions.map((e) => [e.site, e]));
    for (const [site, entry] of Object.entries(EXCEPTIONS)) {
      const found = bySite.get(site);
      expect(found, `stale exception: no emission at ${site}`).toBeDefined();
      expect(found.event, `${site} event drifted`).toBe(entry.event);
      expect(found.source, `${site} source drifted`).toBe(entry.source);
      expect(entry.reason.length, `${site} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('pins the runtime-named events of the table-driven emitter', () => {
    const entry = EXCEPTIONS['lib/runtime/middleware/tasks.js:341'];
    const src = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'runtime', 'middleware', 'tasks.js'), 'utf8');
    const map = src.match(/LEDGER_EVENT_BY_COMPILER_NAME\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
    expect(map, 'LEDGER_EVENT_BY_COMPILER_NAME moved — re-read the emitter').not.toBeNull();
    const names = [...new Set([...map[1].matchAll(/:\s*'([a-z][a-z0-9.]*_?[a-z0-9_]*)'/g)].map((m) => m[1]))];
    expect(names.sort()).toEqual([...entry.runtimeNamedEvents].sort());
    for (const name of names) expect(hookPermitted(name), `${name} is not hook-permitted`).toBe(true);
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
