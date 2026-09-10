/**
 * Unit contract for `scripts/bench/hook-latency.mjs` — its PURE surface only.
 *
 * WHY THIS FILE EXISTS
 *
 *   1. `scripts/hooks/stop-review-gate.js#checkMissingTests` flags a changed
 *      source file with no `tests/**\/<stem>.test.*` sibling as "Code without
 *      tests". A `.bench.js` sibling does not satisfy it — the gate matches on
 *      the `.test.` infix — so the runner needs a file at exactly this path or
 *      every edit to it trips Stop.
 *   2. The runner's pure functions carry contracts nothing else pins: the
 *      percentile method `summarize()` uses, the 19-entry slot registry and
 *      its two cross-file agreements (budget vs `hooks/hooks.json`, child
 *      count vs `hooks/dispatch-table.json`), and the shape and harmlessness
 *      of every synthetic payload. Drift in any of those changes what the
 *      bench REPORTS without changing whether it runs, which is the failure
 *      mode a bench cannot detect about itself.
 *
 * SIBLING FILE. The guard contract — `snapshotGuards()`, `compareGuards()`,
 * and the `--writers strict|tolerate` matrix — lives in
 * `tests/bench/hook-latency-guards.test.js`. It was split out when the two
 * together passed the 800-line cap; the division is by subject, since
 * everything there answers "did a bench run touch a store it should not
 * have" and nothing here does. Neither file imports the other.
 *
 * NO SPAWN AT ALL, NO REAL-PATH TOUCH
 *
 * Nothing here starts a child process of any kind — not Node, not `git`. That
 * is a hard requirement: this file lands in `npm test`, and
 * `tests/firewall/dispatcher-cwd-sandbox-required.test.js` scans every
 * `*.test.js` for a `process.execPath` spawn. The sibling file has one
 * deliberate `git` exception for its sandbox control; this file has none.
 * Every write goes inside one `mkdtemp` root that `afterAll` removes, and the
 * payload suite asserts that root is still empty afterwards.
 *
 * WHAT THIS FILE CANNOT SEE — do not read a green run as more than it is
 *
 *   - **Any latency number.** Nothing is timed. `runOnce`, `benchSlot` and the
 *     child-count probe are untested here because each spawns Node. Whether a
 *     hook fits its budget, and whether a dispatcher spawns as many children
 *     as the table configures, only the runner and
 *     `tests/bench/hook-latency.bench.js` can answer.
 *   - **Whether a payload is ACCEPTED by the hook it targets.** Well-formed,
 *     sandbox-scoped, serializable, and carrying only an allowlisted `echo`
 *     command, is all that is checked. A hook could still reject it as
 *     semantically wrong and exit early, and the bench would measure that
 *     early-return path while looking identical here.
 *   - **Whether that allowlist agrees with any risk classifier.** The command
 *     shape is asserted directly rather than delegated to a risk-classifier
 *     module owned by another branch, so nothing here breaks when such a
 *     module changes its level strings or signature. The two could disagree;
 *     only the local claim is made, and it is the stronger of the two. Do not
 *     reintroduce the delegation to shorten this file.
 *   - **Anything about the guards.** No guard verdict is exercised here at
 *     all; that whole contract moved to the sibling file named above.
 *   - **Import-time isolation beyond two proxies.** "main() did not run" is
 *     inferred from an unset `process.exitCode` plus a source scan showing one
 *     `main()` call site behind the `isMainEntry` guard. Neither proves the
 *     absence of some other import-time effect.
 *
 * @module tests/bench/hook-latency
 */

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
} from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDispatchTable } from '../../lib/dispatcher/dispatch-table-loader.js';
import { SLOTS, summarize } from '../../scripts/bench/hook-latency.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** plugins/artibot/tests/bench -> plugins/artibot */
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

const RUNNER_PATH = path.join(PLUGIN_ROOT, 'scripts', 'bench', 'hook-latency.mjs');
const HOOKS_JSON_PATH = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');

/** Assembled at runtime so this file's own source cannot be mistaken for a spawner. */
const HOOKS_COMMAND_PREFIX = `/scripts/${'hooks'}/`;

const HOOKS_JSON = JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf-8'));

/**
 * Every declared `timeout` (SECONDS) whose command ends with a given tail.
 *
 * Deliberately a DIFFERENT traversal from the runner's own
 * `readDeclaredBudgets()`, which slices at the first `/scripts/hooks/` and
 * keys a map by the remainder. Sharing that method would make both readings
 * fail together and the cross-check would prove nothing. Returning EVERY hit
 * also surfaces multiply-registered commands (`workflow-status.js
 * teammate-update` appears in three slots) instead of keeping the last one.
 *
 * @param {string} tail e.g. "pre-write.js" or "subagent-handler.js start"
 * @returns {number[]} one entry per registration, in file order
 */
function declaredTimeoutsSeconds(tail) {
  const suffix = HOOKS_COMMAND_PREFIX + tail;
  const hits = [];
  for (const entries of Object.values(HOOKS_JSON.hooks || {})) {
    for (const entry of entries || []) {
      for (const hook of entry.hooks || []) {
        if (String(hook.command || '').endsWith(suffix)) hits.push(hook.timeout);
      }
    }
  }
  return hits;
}

/**
 * The command tail a slot is registered under: script basename plus arguments,
 * which distinguishes `subagent-handler.js start` from a bare basename.
 * @param {{script: string, args: string[]}} slot
 * @returns {string}
 */
function commandTail(slot) {
  const file = slot.script.split('/').pop();
  const args = slot.args || [];
  return args.length > 0 ? `${file} ${args.join(' ')}` : file;
}

/**
 * How each dispatcher slot's `staticChildren` is expected to be derived. An
 * ALLOWLIST, not a denylist: a dispatcher slot added to the runner without an
 * entry here goes red instead of passing unchecked, which is the whole point.
 * @type {Record<string, {tableSlot?: string, tool?: string, fixed?: number, why?: string}>}
 */
const DISPATCHER_CHILD_SOURCES = {
  SessionStart: { tableSlot: 'SessionStart' },
  UserPromptSubmit: {
    fixed: 1,
    why: 'dispatch-table marks this slot in-process-import: its 7 handlers are '
      + 'imported, not spawned, and the only child process is git-autopilot-save',
  },
  'PostToolUse:Write': { tableSlot: 'PostToolUse', tool: 'Write' },
  'PostToolUse:Bash': { tableSlot: 'PostToolUse', tool: 'Bash' },
  Stop: { tableSlot: 'Stop' },
  SessionEnd: { tableSlot: 'SessionEnd' },
  SubagentStop: { tableSlot: 'SubagentStop' },
};

/**
 * Handlers a dispatch-table slot would spawn, with PostToolUse's tool routing
 * applied when a tool name is given.
 * @param {string} tableSlot
 * @param {string} [tool]
 * @returns {number}
 */
function configuredChildCount(tableSlot, tool) {
  const handlers = loadDispatchTable(tableSlot);
  if (!tool) return handlers.length;
  return handlers.filter(
    (h) => Array.isArray(h.tools) && (h.tools.includes('*') || h.tools.includes(tool)),
  ).length;
}

// ---------------------------------------------------------------------------

describe('summarize() — descriptive statistics contract', () => {
  it('returns every statistic null for an empty sample array', () => {
    expect(summarize([])).toEqual({
      p50: null, p95: null, max: null, min: null, mean: null,
    });
  });

  it('returns every statistic null when samples is omitted', () => {
    expect(summarize(undefined)).toEqual({
      p50: null, p95: null, max: null, min: null, mean: null,
    });
  });

  it('reports a lone sample as every statistic', () => {
    expect(summarize([5])).toEqual({
      p50: 5, p95: 5, max: 5, min: 5, mean: 5,
    });
  });

  it('takes p95 of n=20 as the 19th ascending value (nearest rank)', () => {
    // ceil(0.95 * 20) - 1 = 18, so p95 is sorted[18] = 19, NOT the maximum.
    // Asserting p95 !== max is what makes this non-vacuous: a percentile that
    // degraded to "largest sample" passes any check that only bounds p95.
    const stats = summarize([...Array(20).keys()].map((i) => i + 1));
    expect(stats).toEqual({
      p50: 10, p95: 19, max: 20, min: 1, mean: 10.5,
    });
    expect(stats.p95).not.toBe(stats.max);
  });

  it('takes p50 of n=3 as the middle ascending value regardless of input order', () => {
    expect(summarize([3, 1, 2]).p50).toBe(2);
    expect(summarize([2, 3, 1]).p50).toBe(2);
  });

  it('drops non-numeric entries before computing anything', () => {
    // Strings, null and undefined are filtered by `typeof value === 'number'`,
    // so the statistics describe [1, 3, 2] alone — the mean in particular is
    // 2, not 1.2, because the discarded entries do not enter the denominator.
    expect(summarize([1, 'a', 3, null, 2, undefined])).toEqual({
      p50: 2, p95: 3, max: 3, min: 1, mean: 2,
    });
  });

  it('rounds every statistic to two decimals', () => {
    expect(summarize([1.234, 5.678])).toEqual({
      p50: 1.23, p95: 5.68, max: 5.68, min: 1.23, mean: 3.46,
    });
  });

  it('lets NaN through the numeric filter and yields NaN, not null', () => {
    // Pinned as CURRENT behaviour, not as desirable: `typeof NaN === 'number'`
    // so NaN survives the filter and propagates through round2. JSON
    // serializes it as `null`, making it indistinguishable in a report from
    // the genuine empty-sample case above. Changing this is the runner
    // owner's call; changing it SILENTLY should turn this test red.
    const stats = summarize([Number.NaN]);
    expect(Number.isNaN(stats.p50)).toBe(true);
    expect(Number.isNaN(stats.mean)).toBe(true);
  });
});

describe('SLOTS — registry shape', () => {
  const names = Object.keys(SLOTS);

  it('registers 19 slots', () => {
    expect(names).toHaveLength(19);
  });

  it('gives every slot a complete, well-typed descriptor', () => {
    for (const name of names) {
      const slot = SLOTS[name];
      expect(['dispatcher', 'direct'], name).toContain(slot.kind);
      expect(slot.script, name).toMatch(/^scripts\/hooks\/[\w.-]+\.js$/);
      expect(Array.isArray(slot.args), name).toBe(true);
      expect(typeof slot.payload, name).toBe('function');
      expect(Number.isInteger(slot.staticChildren), name).toBe(true);
      expect(slot.staticChildren, name).toBeGreaterThanOrEqual(0);
      expect(typeof slot.budgetMs, name).toBe('number');
      expect(slot.budgetMs, name).toBeGreaterThan(0);
    }
  });

  it('points every slot at a script that exists on disk', () => {
    for (const name of names) {
      const full = path.join(PLUGIN_ROOT, ...SLOTS[name].script.split('/'));
      expect(existsSync(full), `${name} -> ${SLOTS[name].script}`).toBe(true);
    }
  });

  it('covers both dispatcher and direct kinds', () => {
    // Otherwise a registry that lost every direct hook would still satisfy
    // the per-slot shape checks above.
    const kinds = new Set(names.map((n) => SLOTS[n].kind));
    expect([...kinds].sort()).toEqual(['direct', 'dispatcher']);
  });
});

describe('SLOTS — declared budgets agree with hooks.json', () => {
  const names = Object.keys(SLOTS);

  it('matches every slot budget to its registration, converting seconds to ms', () => {
    const mismatches = [];
    for (const name of names) {
      const slot = SLOTS[name];
      const seconds = declaredTimeoutsSeconds(commandTail(slot));
      if (seconds.length === 0) {
        mismatches.push(`${name}: no hooks.json registration for "${commandTail(slot)}"`);
        continue;
      }
      const distinct = [...new Set(seconds)];
      if (distinct.length !== 1) {
        mismatches.push(`${name}: registered with conflicting timeouts ${distinct.join('/')}`);
        continue;
      }
      if (slot.budgetMs !== distinct[0] * 1000) {
        mismatches.push(`${name}: budgetMs ${slot.budgetMs} != ${distinct[0]}s * 1000`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('finds a registration for every slot (the lookup is not vacuous)', () => {
    // A helper that matched nothing would make the test above pass by finding
    // no mismatches at all, so the hit count is asserted separately.
    const found = names.filter((n) => declaredTimeoutsSeconds(commandTail(SLOTS[n])).length > 0);
    expect(found).toHaveLength(names.length);
  });

  it('returns nothing for a command tail that is not registered', () => {
    expect(declaredTimeoutsSeconds('no-such-hook.js')).toEqual([]);
  });

  it('distinguishes a command by its arguments, not just its script', () => {
    // `subagent-handler.js start` and `workflow-status.js teammate-update` are
    // registered with arguments; the bare basenames are not registered at all.
    // If the tail dropped args, two different slots would collapse into one.
    expect(declaredTimeoutsSeconds('subagent-handler.js start').length).toBeGreaterThan(0);
    expect(declaredTimeoutsSeconds('subagent-handler.js')).toEqual([]);
  });
});

describe('SLOTS — configured child counts agree with the dispatch table', () => {
  const dispatcherNames = Object.keys(SLOTS).filter((n) => SLOTS[n].kind === 'dispatcher');

  it('has a declared child source for every dispatcher slot (allowlist ratchet)', () => {
    expect(dispatcherNames.sort()).toEqual(Object.keys(DISPATCHER_CHILD_SOURCES).sort());
  });

  it('matches each dispatcher slot to its dispatch-table handler count', () => {
    const mismatches = [];
    for (const name of dispatcherNames) {
      const source = DISPATCHER_CHILD_SOURCES[name];
      const expected = typeof source.fixed === 'number'
        ? source.fixed
        : configuredChildCount(source.tableSlot, source.tool);
      if (SLOTS[name].staticChildren !== expected) {
        mismatches.push(`${name}: staticChildren ${SLOTS[name].staticChildren} != ${expected}`);
      }
      expect(expected, `${name} resolved to zero children`).toBeGreaterThan(0);
    }
    expect(mismatches).toEqual([]);
  });

  it('applies PostToolUse tool routing rather than the whole handler list', () => {
    // Without this the two PostToolUse slots would pass with a filter that
    // returned every handler: the counts would still be equal to each other
    // and to the table length, and the routing bug would be invisible.
    const all = configuredChildCount('PostToolUse');
    expect(SLOTS['PostToolUse:Write'].staticChildren).toBeLessThan(all);
    expect(SLOTS['PostToolUse:Bash'].staticChildren).toBeLessThan(all);
    expect(SLOTS['PostToolUse:Write'].staticChildren)
      .not.toBe(SLOTS['PostToolUse:Bash'].staticChildren);
  });

  it('gives every direct hook zero configured children', () => {
    for (const name of Object.keys(SLOTS)) {
      if (SLOTS[name].kind !== 'direct') continue;
      expect(SLOTS[name].staticChildren, name).toBe(0);
    }
  });
});

describe('SLOTS — payload builders are sandbox-scoped, serializable and harmless', () => {
  let root;
  let sandbox;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'artibot-hlt-payload-'));
    sandbox = { home: path.join(root, 'home'), cwd: path.join(root, 'cwd') };
    mkdirSync(sandbox.home);
    mkdirSync(sandbox.cwd);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('builds a bench-prefixed, sandbox-scoped payload for every slot', () => {
    for (const name of Object.keys(SLOTS)) {
      const payload = SLOTS[name].payload(sandbox);
      expect(payload.session_id, name).toMatch(/^bench-/);
      expect(payload.cwd, name).toBe(sandbox.cwd);
      expect(typeof payload.hook_event_name, name).toBe('string');
      expect(payload.hook_event_name.length, name).toBeGreaterThan(0);
      expect(payload.transcript_path.startsWith(sandbox.cwd), name).toBe(true);
    }
  });

  it('survives a JSON round trip for every slot (it is written to child stdin)', () => {
    for (const name of Object.keys(SLOTS)) {
      const payload = SLOTS[name].payload(sandbox);
      expect(JSON.parse(JSON.stringify(payload)), name).toEqual(payload);
    }
  });

  it('mints a distinct session id per slot and per call', () => {
    const first = Object.keys(SLOTS).map((n) => SLOTS[n].payload(sandbox).session_id);
    expect(new Set(first).size).toBe(first.length);
    const a = SLOTS.SessionStart.payload(sandbox).session_id;
    const b = SLOTS.SessionStart.payload(sandbox).session_id;
    expect(a).not.toBe(b);
  });

  it('carries only an allowlisted echo command in any tool_input', () => {
    // An ALLOWLIST, checked here rather than delegated to a risk classifier.
    //
    // Delegating was the first design and it was wrong twice over. It made
    // this suite fail whenever another branch changed that classifier's level
    // strings or signature, and — worse — it stated the weaker claim. "No
    // rule in some catalogue matched" is not "this string is harmless": a
    // command can be destructive and simply not be enumerated yet, and the
    // delegated check would pass. Naming the exact shape a bench payload may
    // carry is the claim actually worth making, and it cannot rot.
    //
    // The shape is `echo` plus one whitespace-free argument. Anything a slot
    // grows later — a redirect, a pipe, a second word, a different program —
    // turns this red and gets read by a person.
    const ALLOWED_COMMAND = /^echo\s+\S+$/;
    const commands = [];
    for (const name of Object.keys(SLOTS)) {
      const payload = SLOTS[name].payload(sandbox);
      const command = payload.tool_input && payload.tool_input.command;
      if (typeof command !== 'string') continue;
      commands.push(command);
      expect(command, `${name} carries a non-allowlisted command`).toMatch(ALLOWED_COMMAND);
    }
    // Non-vacuousness: at least the two Bash-tool slots must have been checked.
    expect(commands.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a command outside the allowlist (control for the check above)', () => {
    // Proves the pattern above discriminates rather than matching everything.
    // Both rejects are shapes a payload could plausibly drift into; neither is
    // a destructive string, which has no place in a test literal.
    const ALLOWED_COMMAND = /^echo\s+\S+$/;
    expect('echo bench').toMatch(ALLOWED_COMMAND);
    expect('echo bench > out.txt').not.toMatch(ALLOWED_COMMAND);
    expect('node script.js').not.toMatch(ALLOWED_COMMAND);
  });

  it('writes nothing to disk while building payloads', () => {
    // The builders are called during a timing run for every sample; a stray
    // write would both perturb the measurement and escape the guard snapshots,
    // which are taken once before and once after the whole run.
    for (const name of Object.keys(SLOTS)) SLOTS[name].payload(sandbox);
    expect(readdirSync(sandbox.cwd)).toEqual([]);
    expect(readdirSync(sandbox.home)).toEqual([]);
  });
});

describe('importing the runner does not run it', () => {
  it('leaves process.exitCode unset', () => {
    // main() sets process.exitCode on every path it can take — 0, 1 or 2 — so
    // an unset value is evidence it did not run. Weak evidence on its own,
    // which is why the source check below sits next to it.
    expect(process.exitCode).toBeUndefined();
  });

  it('calls main() from exactly one site, behind the isMainEntry guard', () => {
    const src = readFileSync(RUNNER_PATH, 'utf-8');
    const calls = [...src.matchAll(/(?<!function\s)(?<![\w.$])main\(\)/g)];
    expect(calls).toHaveLength(1);
    const guardAt = src.indexOf('if (isMainEntry(import.meta.url))');
    expect(guardAt).toBeGreaterThan(-1);
    expect(calls[0].index).toBeGreaterThan(guardAt);
  });

  it('exposes the pure surface this suite pins', () => {
    // A rename that dropped one of these would otherwise surface as an
    // undefined-is-not-a-function failure somewhere above, with no hint that
    // the export contract itself moved. The guard exports are pinned the same
    // way in `tests/bench/hook-latency-guards.test.js`, not here, so that each
    // file names exactly what it uses.
    expect(typeof summarize).toBe('function');
    expect(SLOTS).toBeTypeOf('object');
  });
});
