import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WIRING GATE for the `hook.fired` carrier (SH-29, owner decision O8=a1).
 *
 * The six dispatchers each append ONE `hook.fired` ledger row per dispatch by
 * calling `scripts/hooks/_hook-fired-record.js#recordHookFired`. The
 * round-trip suites next to this one prove the row ARRIVES for each slot; this
 * file proves the call is SHAPED correctly in all six at once, which the
 * round-trips cannot: they exercise one slot each, and a sixth dispatcher that
 * silently lost its call would leave every one of them green.
 *
 * STATIC ON PURPOSE — this file spawns NOTHING.
 * `tests/firewall/dispatcher-cwd-sandbox-required.test.js:98-106` ratchets the
 * exact list of suites that spawn `process.execPath` with a dispatcher path.
 * A seventh spawner here would turn that gate red, and this limb does not own
 * it. Reading the sources costs nothing and answers the question directly.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules section 9 — write it beside the gate) ──
 *   - WHETHER A ROW IS EVER WRITTEN. Every assertion here is on source text.
 *     `recordHookFired` could return `{ok:false}` on every call and this file
 *     would stay green; the per-slot round-trips are what measure the ledger.
 *   - WHETHER `results` NAMES THE RIGHT HANDLERS. The shape is checked, the
 *     contents are not. A dispatcher mapping the wrong array into `results`
 *     passes here and fails the round-trip.
 *   - THE ORDER TWO WRITES REACH THE OS. The ordering assertion compares
 *     SOURCE OFFSETS, which is the ordering that matters (the carrier must be
 *     written after the stdout statement, so a carrier fault cannot precede or
 *     corrupt the slot's JSON document) — not a runtime flush order.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS_DIR = path.join(PLUGIN_ROOT, 'scripts', 'hooks');
const CARRIER_BASENAME = '_hook-fired-record.js';

/**
 * The six dispatchers, and the one difference between them.
 *
 * `tool` is PostToolUse-only: the five other slots have no tool name, and the
 * allowlist declares `fields.tool.type = "string"`, so passing `null` there
 * would turn the row into a `type-violation:tool` rejection rather than a row
 * without one field. An omitted key is the honest record — which makes "only
 * PostToolUse passes `tool:`" an assertion, not a style preference.
 */
const DISPATCHERS = [
  { file: '_posttooluse-dispatcher.js', slot: 'PostToolUse', tool: true },
  { file: '_sessionstart-dispatcher.js', slot: 'SessionStart', tool: false },
  { file: '_stop-dispatcher.js', slot: 'Stop', tool: false },
  { file: '_sessionend-dispatcher.js', slot: 'SessionEnd', tool: false },
  { file: '_subagentstop-dispatcher.js', slot: 'SubagentStop', tool: false },
  { file: '_userprompt-dispatcher.js', slot: 'UserPromptSubmit', tool: false },
];

/** The stdout statement every dispatcher writes its merged document with. */
const STDOUT_WRITE = 'process.stdout.write(JSON.stringify(merged))';

/**
 * The carrier call, from `try {` to the closing `} catch`.
 *
 * A bare `recordHookFired(` search would also match the import line, so the
 * `try {` prefix is load-bearing: it is simultaneously the "call exists" and
 * the "call is guarded" probe.
 */
const GUARDED_CALL = /try\s*\{\s*recordHookFired\(\{[\s\S]*?\}\);\s*\}\s*catch\s*\{/;

const IMPORT_LINE = /import\s*\{\s*recordHookFired\s*\}\s*from\s*'\.\/_hook-fired-record\.js'/;

function read(rel) {
  return fsSync.readFileSync(path.join(HOOKS_DIR, rel), 'utf-8');
}

/**
 * Every way one dispatcher's wiring can be wrong, as a list of strings.
 *
 * Returned rather than asserted inline so the SAME function can be run against
 * a deliberately broken copy at the bottom of this file. A scanner that has
 * never been shown to go red is not evidence — it is a green light of unknown
 * provenance (rules section 10).
 *
 * @param {string} src dispatcher source text
 * @param {{file: string, slot: string, tool: boolean}} spec
 * @returns {string[]} empty when the wiring is correct
 */
export function wiringProblems(src, spec) {
  const problems = [];

  if (!IMPORT_LINE.test(src)) problems.push('missing import of recordHookFired');

  const call = src.match(GUARDED_CALL);
  if (!call) {
    problems.push('missing recordHookFired call guarded by try/catch');
    return problems;
  }
  const callText = call[0];
  const callAt = call.index;

  if (!/slot:\s*EVENT_NAME\b/.test(callText)) {
    problems.push('call does not pass slot: EVENT_NAME');
  }
  if (!new RegExp(`EVENT_NAME\\s*=\\s*'${spec.slot}'`).test(src)) {
    problems.push(`EVENT_NAME is not '${spec.slot}'`);
  }
  if (!/\bpayload\b/.test(callText)) problems.push('call does not pass payload');
  if (!/results:/.test(callText)) problems.push('call does not pass results');

  const passesTool = /\btool:/.test(callText);
  if (passesTool !== spec.tool) {
    problems.push(passesTool ? 'passes tool: but must not' : 'must pass tool: but does not');
  }

  const stdoutAt = src.indexOf(STDOUT_WRITE);
  if (stdoutAt < 0) problems.push('no merged-stdout write found');
  else if (callAt < stdoutAt) problems.push('carrier call precedes the stdout write');

  return problems;
}

describe('hook.fired carrier wiring (all six dispatchers)', () => {
  it.each(DISPATCHERS)('$file records hook.fired after stdout, inside try/catch', (spec) => {
    expect(wiringProblems(read(spec.file), spec)).toEqual([]);
  });

  /**
   * The carrier is a LEAF's caller, never a leaf's dependency.
   *
   * `_dispatcher-utils.js` is imported by every dispatcher AND by hooks that
   * are not dispatchers. Importing the carrier from there would give the whole
   * hook tree a ledger-writing dependency it did not ask for, and would make
   * "which processes can append to the ledger" unanswerable by reading the six
   * call sites.
   */
  it('keeps _dispatcher-utils.js free of the carrier', () => {
    expect(read('_dispatcher-utils.js')).not.toContain(CARRIER_BASENAME);
  });

  /**
   * The carrier is MUTE and is NOT a hook.
   *
   * Mute: the dispatcher has already written a complete JSON document to
   * stdout by the time the carrier runs, so one byte from here would be
   * appended after it and corrupt the slot's response.
   *
   * Not a hook: no `isMainEntry` main means importing it runs nothing, so it
   * needs no direct-run guard and never appears in its own `data.hooks`.
   */
  it('keeps the carrier module mute and entry-point-free', () => {
    const src = read(CARRIER_BASENAME);
    expect(src).not.toMatch(/process\.stdout/);
    expect(src).not.toMatch(/isMainEntry/);
  });

  /**
   * DRIFT GUARD for the one slot whose handler names are not a loaded table.
   *
   * The five spawn-based dispatchers map `results` out of the same `HOOKS`
   * array they spawned, so their names cannot drift. UserPromptSubmit imports
   * its handlers as ESM named exports and names them in a hand-written
   * constant, which CAN drift — silently, because a stale name still produces
   * a well-formed row. So every name in the constant must also appear at a
   * call site in the same file, and the counts must agree.
   */
  it('pins the UserPromptSubmit handler list to its actual call sites', () => {
    const src = read('_userprompt-dispatcher.js');
    const block = src.match(/HOOK_FIRED_HANDLERS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const names = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names).toHaveLength(7);
    expect(new Set(names).size).toBe(7);

    for (const name of names) {
      if (name === 'git-autopilot-save') {
        // Not a safeRun call — a child process, referenced by script path.
        expect(src).toMatch(/GIT_AUTOPILOT_SAVE = path\.join\(HERE, 'git-autopilot-save\.js'\)/);
        continue;
      }
      expect(src).toMatch(new RegExp(`, '${name}',\\s*noteThrow`));
    }
    // And no in-process handler is awaited without being recorded: six
    // `safeRun(` call sites, six names above minus the spawned one.
    const callSites = [...src.matchAll(/safeRun\(\s*[A-Za-z_$][\w$]*,\s*payload,\s*'([a-z0-9-]+)'/g)]
      .map((m) => m[1]);
    expect(new Set(callSites)).toEqual(new Set(names.filter((n) => n !== 'git-autopilot-save')));
  });

  /**
   * SCANNER SELF-CHECK (rules section 10).
   *
   * Delete the carrier call from a real source IN MEMORY — no file is written,
   * so nothing else in the repository can see this mutation — and prove the
   * scanner reports it. Without this, every green above could equally mean
   * "the wiring is correct" or "the regex matches nothing anywhere".
   */
  it('goes red when the carrier call is removed (mutation probe)', () => {
    const spec = DISPATCHERS.find((d) => d.file === '_stop-dispatcher.js');
    const src = read(spec.file);
    expect(wiringProblems(src, spec)).toEqual([]);

    const mutated = src.replace(GUARDED_CALL, '/* carrier removed */ if (false) { }');
    expect(mutated).not.toBe(src);
    expect(wiringProblems(mutated, spec))
      .toContain('missing recordHookFired call guarded by try/catch');
  });

  /**
   * Second mutation, on the axis a "call exists" probe would miss: moving the
   * call ABOVE the stdout write keeps every other assertion satisfied.
   */
  it('goes red when the carrier call is moved before stdout (mutation probe)', () => {
    const spec = DISPATCHERS.find((d) => d.file === '_sessionend-dispatcher.js');
    const src = read(spec.file);
    const call = src.match(GUARDED_CALL)[0];
    const moved = src.replace(call, '').replace(
      /const merged = mergeResults/,
      `${call}\n  const merged = mergeResults`,
    );
    expect(wiringProblems(moved, spec)).toContain('carrier call precedes the stdout write');
  });
});
