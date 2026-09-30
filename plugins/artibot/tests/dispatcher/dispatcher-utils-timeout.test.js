import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPATCHER_HEADROOM_MS,
  resolveTimeoutScale,
  scaledBudgetCeilingMs,
  scaleTimeoutMs,
  spawnHook,
} from '../../scripts/hooks/_dispatcher-utils.js';

/**
 * scripts/hooks/_dispatcher-utils.js -- the TEST-ONLY hook-budget multiplier
 * (`ARTIBOT_DISPATCH_TIMEOUT_SCALE`), the opt-in that limits it to one
 * dispatcher, and the security envelope around both.
 *
 * WHY THE SEAM EXISTS. `spawnHook` starts a handler's timer the moment it calls
 * spawn(), so the budget covers process creation + node cold start + import,
 * not just the hook's own work. Under machine load a cold start alone outruns
 * the tightest budget on the Edit route (post-write-tdd, hooks/dispatch-table.json),
 * the handler is recorded as `timeout`, and any test asserting
 * `hook.fired.data.failed` is `[]` fails for a reason unrelated to the code
 * under test. Loosening that assertion would throw away what it proves, so the
 * budget is what gets a multiplier, and the assertion stays strict.
 *
 * WHY IT IS OPT-IN. A dispatcher waits for every child and writes ONE merged
 * stdout after the last one settles, and hooks/hooks.json gives it a host
 * timeout. One that outlives that timeout is cancelled and writes nothing, so a
 * stretched child budget can lose the slot's whole output. On Stop that output
 * carries dev-verify-gate's decision:'block' (30 s slot, stop-review-gate
 * declared 15 s, so the host limit is reached from 2x): the gate would stop
 * blocking. SubagentStop (15 s slot, agent-evaluator 8 s, from 1.875x) has no
 * decision-emitting handler today and would lose its `message` and its
 * `hook.fired` row. SessionStart and SessionEnd (30 s slot, 15 s swarm-download
 * / swarm-sync, from 2x) have the same shape. So `spawnHook` reads the variable
 * only for a caller passing the literal `allowTimeoutScale: true`, and
 * PostToolUse is the only dispatcher that does. The numbers and the reasoning
 * are in `resolveTimeoutScale`'s JSDoc.
 *
 * SECURITY ENVELOPE (each line below is pinned by a case in this file, or where
 * noted by the dispatcher suites).
 *   - It can only LENGTHEN a budget. A value below 1 is floored to 1, so it can
 *     never make every hook "time out" and silently disable them.
 *   - It is capped at 10. A larger value is clamped, and the product is clamped
 *     to what setTimeout can hold: Node turns a delay beyond 2^31-1 ms into 1 ms.
 *   - A SCALED budget never outlasts the host slot minus the dispatcher headroom
 *     (27 s for PostToolUse), however large the scale, and is never shortened
 *     below its declared value. A caller that names no usable slot gets no stretch
 *     at all. Pinned here per budget ('scaleTimeoutMs with a ceiling', 'headroom
 *     ceiling inside the host slot'); that the PostToolUse dispatcher names the
 *     slot hooks/hooks.json gives it is pinned end to end in
 *     posttooluse-dispatcher.test.js.
 *   - It is read from a strict decimal syntax and nothing else. Anything that
 *     does not parse falls back to 1, i.e. the shipped budgets, byte for byte.
 *   - It is read only for a caller that passes the literal `allowTimeoutScale: true`
 *     (an allowlist, default off), and exactly one production module does: the
 *     PostToolUse dispatcher (see 'who may opt in'). The Stop and SubagentStop
 *     dispatchers are also pinned end to end, with the variable at its cap, by a
 *     timer-spy case in stop-dispatcher.test.js and subagentstop-dispatcher.test.js.
 *   - Exactly one production module references the VARIABLE (see 'ownership of
 *     the variable'), so no second reader can apply the value without the clamp.
 *
 * WHAT THIS FILE DOES NOT SEE.
 *   - tests/firewall/hook-timeout-budget.test.js gates the DECLARED budgets
 *     against the host's slot timeout in hooks/hooks.json, so a runtime
 *     multiplier is invisible to it. The ceiling above is what covers that gap
 *     for PostToolUse (30 s slot, post-edit-format declared 10 s: unbounded, the
 *     3 s headroom that gate reserves ran out above 2.7x and 10x was 100 s). What
 *     it does not cover: the 3 s headroom is that gate's conservative budget, not
 *     a measurement, so a dispatcher whose own cold start and merge take longer
 *     than that under load can still lose a slot whose slowest child ran to the
 *     ceiling. PostToolUse handlers are advisory except quality-gate, whose
 *     hardcoded-secret guard can emit decision:'block' (after the write, so the
 *     loss is feedback, not a gate on it). That residual is why the value is a
 *     test knob.
 *   - DISPATCHER_HEADROOM_MS equals the firewall gate's private HEADROOM_MS by
 *     convention only: the gate does not export it and nothing here reads its
 *     source, so the two can drift apart unseen.
 *   - Nothing here can stop an operator from exporting the variable in a real
 *     session. With the opt-in it reaches the PostToolUse dispatcher and no
 *     other, and what it can cost there is bounded by the ceiling: a real hang
 *     can take up to 27 s of the 30 s slot before it is cut.
 *   - How the host enforces the hooks.json `timeout` is not observed anywhere in
 *     this repo; "cancelled" above is the contract those files assume.
 *   - SessionStart and SessionEnd are covered by the opt-in allowlist case (no
 *     other dispatcher can name the option) but have no timer-spy case of their
 *     own, so their end-to-end budgets are not measured here.
 *   - The dispatchers' own stdout/exit behaviour is covered by the per-dispatcher
 *     suites, not here; this file drives `spawnHook` directly.
 */

const ENV = 'ARTIBOT_DISPATCH_TIMEOUT_SCALE';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const OUTER_SCALE = process.env[ENV];

/** Children are plain scripts in a throwaway dir; nothing here touches the repo. */
let TMP;

const INSTANT = 'process.exit(0);';
const HANG = 'setTimeout(() => process.exit(0), 60000);';

/** The PostToolUse host slot (hooks/hooks.json: 30 s) in ms, and the most a SCALED budget may be inside it. */
const SLOT_MS = 30000;
const CEILING_MS = 27000;

/**
 * What the PostToolUse dispatcher passes: the literal opt-in AND the host slot it
 * runs in. Both are needed to receive the scale (see 'headroom ceiling').
 */
const OPT_IN = { allowTimeoutScale: true, slotTimeoutMs: SLOT_MS };

/**
 * The same opt-in in a slot so wide that the headroom ceiling never binds. The
 * cases that pin the MULTIPLIER (rounding, the floor, the cap of 10, the opt-in
 * allowlist) use it, so the ceiling cannot hide a regression in them: at the real
 * 30 s slot, 10x of a 15 s budget and 1e11 x of it would both read 27000.
 */
const SLOT_WIDE = { slotTimeoutMs: 1000000 };
const OPT_IN_WIDE = { allowTimeoutScale: true, ...SLOT_WIDE };

// Non-ASCII digits, built from code points so this file stays pure ASCII. JS `\d`
// is already ASCII-only, so these cannot catch a regression to `\d` itself; they
// guard a later swap to `\p{Nd}`, which would accept them and yield NaN.
const ARABIC_INDIC_THREE = String.fromCharCode(0x0663);
const FULLWIDTH_THREE = String.fromCharCode(0xFF13);

beforeAll(() => {
  TMP = mkdtempSync(path.join(os.tmpdir(), 'artibot-timeout-seam-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (OUTER_SCALE === undefined) delete process.env[ENV];
  else process.env[ENV] = OUTER_SCALE;
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function script(name, body) {
  const file = path.join(TMP, `${name}.js`);
  writeFileSync(file, body, 'utf8');
  return file;
}

/** Collect what spawnHook writes to stderr, keeping only its own tagged lines. */
function watchStderr(tag) {
  const seen = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    seen.push(String(chunk));
    return true;
  });
  return { lines: () => seen.filter((l) => l.startsWith(`[artibot:${tag}]`)) };
}

describe('resolveTimeoutScale', () => {
  it('is exactly 1 when the variable is not set (the shipped default)', () => {
    expect(resolveTimeoutScale({})).toBe(1);
    expect(resolveTimeoutScale({ [ENV]: undefined })).toBe(1);
  });

  it('reads process.env when no environment is passed', () => {
    process.env[ENV] = '4';
    expect(resolveTimeoutScale()).toBe(4);
  });

  it('tolerates a missing environment object instead of throwing', () => {
    expect(resolveTimeoutScale(null)).toBe(1);
  });

  it.each([
    ['1', 1], ['1.0', 1], ['2', 2], ['2.5', 2.5], ['10', 10], ['10.0', 10],
  ])('takes an in-range decimal %j as written -> %s', (raw, expected) => {
    expect(resolveTimeoutScale({ [ENV]: raw })).toBe(expected);
  });

  it.each([
    ['10.0001', '10.0001'],
    ['11', '11'],
    ['1000', '1000'],
    ['a 20-digit number', '99999999999999999999'],
    ['a 400-digit number (Number() reads it as Infinity)', '9'.repeat(400)],
  ])('caps %s at 10', (_label, raw) => {
    expect(resolveTimeoutScale({ [ENV]: raw })).toBe(10);
  });

  it.each([
    ['0'], ['0.0'], ['00'], ['0.5'], ['0.999'],
  ])('floors %j to 1 so a budget is never shortened', (raw) => {
    expect(resolveTimeoutScale({ [ENV]: raw })).toBe(1);
  });

  it.each([
    [''], [' '], [' 3'], ['3 '], ['3\n'], ['-1'], ['-0'], ['+3'], ['NaN'], ['Infinity'],
    ['-Infinity'], ['abc'], ['3x'], ['x3'], ['0x10'], ['1e1'], ['1e9'], ['.5'], ['5.'],
    ['3,5'], ['1_0'], ['true'], ['[3]'], ['{}'],
    [ARABIC_INDIC_THREE], // \d must stay ASCII-only
    [FULLWIDTH_THREE],
  ])('falls back to 1 for %j (not a plain non-negative decimal)', (raw) => {
    expect(resolveTimeoutScale({ [ENV]: raw })).toBe(1);
  });

  it.each([
    [3], [true], [{}], [[]], [() => 3], [null],
  ])('ignores a non-string value %j', (value) => {
    expect(resolveTimeoutScale({ [ENV]: value })).toBe(1);
  });

  it('never leaves [1, 10] and never returns a non-finite number, whatever it is fed', () => {
    const fed = ['', 'NaN', 'Infinity', '-5', 'abc', '9'.repeat(400), '1e999', '0x1F', ARABIC_INDIC_THREE];
    for (let i = 0; i <= 400; i += 1) fed.push(String(i / 8));
    for (const raw of fed) {
      const scale = resolveTimeoutScale({ [ENV]: raw });
      expect(Number.isFinite(scale), `${JSON.stringify(raw)} -> ${scale}`).toBe(true);
      expect(scale, JSON.stringify(raw)).toBeGreaterThanOrEqual(1);
      expect(scale, JSON.stringify(raw)).toBeLessThanOrEqual(10);
    }
  });
});

describe('scaleTimeoutMs', () => {
  it.each([[2000], [2500.5], [1], [15000]])('is the identity at scale 1 (%s)', (declared) => {
    expect(scaleTimeoutMs(declared, 1)).toBe(declared);
  });

  it.each([
    [2000, 1.5, 3000], [1000, 10, 10000], [333, 1.5, 500], [2000, 2, 4000],
  ])('multiplies %s by %s and rounds up -> %s', (declared, scale, expected) => {
    expect(scaleTimeoutMs(declared, scale)).toBe(expected);
  });

  it('is never shorter than the declared budget, even for a scale that should not reach it', () => {
    for (const declared of [1, 2000, 15000]) {
      for (const scale of [0, 0.0001, 0.5, 0.999, -3, NaN, undefined, Infinity]) {
        expect(scaleTimeoutMs(declared, scale), `${declared} x ${scale}`).toBeGreaterThanOrEqual(declared);
      }
    }
  });

  it('stays inside what setTimeout can hold (Node turns a longer delay into 1 ms)', () => {
    expect(scaleTimeoutMs(3e8, 10)).toBe(2 ** 31 - 1);
    expect(scaleTimeoutMs(15000, 1e15)).toBe(2 ** 31 - 1);
  });

  it('without a ceiling is the plain product, as it was before the ceiling existed', () => {
    expect(scaleTimeoutMs(10000, 10)).toBe(100000);
    expect(scaleTimeoutMs(3000, 10, undefined)).toBe(30000);
  });
});

describe('scaledBudgetCeilingMs', () => {
  it('is the host slot minus the dispatcher headroom', () => {
    // 3 s is the figure tests/firewall/hook-timeout-budget.test.js reserves
    // (HEADROOM_MS, a conservative budget, not a measurement). It is a literal here
    // on purpose: a silent change of the headroom must show up as a red line.
    expect(DISPATCHER_HEADROOM_MS).toBe(3000);
    expect(scaledBudgetCeilingMs(SLOT_MS)).toBe(CEILING_MS);
    expect(scaledBudgetCeilingMs(SLOT_MS)).toBe(SLOT_MS - DISPATCHER_HEADROOM_MS);
    expect(scaledBudgetCeilingMs(15000)).toBe(12000);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a numeric string', '30000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['a negative slot', -30000],
    ['a slot equal to the headroom', 3000],
    ['a slot smaller than the headroom', 2000],
    ['an object', {}],
    ['an array', [30000]],
  ])('has no ceiling for %s, so nothing may be stretched', (_label, slot) => {
    expect(scaledBudgetCeilingMs(slot)).toBeNull();
  });
});

describe('scaleTimeoutMs with a ceiling', () => {
  it.each([
    [10000, 10, CEILING_MS], // post-edit-format at the cap: 100000 -> the ceiling
    [8000, 10, CEILING_MS], // quality-gate at the cap: 80000
    [3000, 10, CEILING_MS], // post-write-tdd at the cap: 30000, three seconds past the ceiling
    [10000, 2.8, CEILING_MS], // just past the point where the 3 s headroom runs out (2.7x)
  ])('clamps %s x %s to the ceiling -> %s', (declared, scale, expected) => {
    expect(scaleTimeoutMs(declared, scale, CEILING_MS)).toBe(expected);
  });

  it.each([
    [3000, 2, 6000],
    [5000, 5, 25000],
    [10000, 2.6, 26000],
    [10000, 2.7, CEILING_MS], // exactly the ceiling: kept as it is
  ])('keeps the plain product %s x %s when it fits under the ceiling -> %s', (declared, scale, expected) => {
    expect(scaleTimeoutMs(declared, scale, CEILING_MS)).toBe(expected);
  });

  it('never goes below the declared budget: a ceiling under it is not a licence to shorten', () => {
    // A declared budget above the ceiling is a problem for the firewall gate that
    // compares DECLARED budgets with the slot, not something a test-only knob may
    // "repair" by shortening a shipped budget.
    expect(scaleTimeoutMs(28000, 10, CEILING_MS)).toBe(28000);
    expect(scaleTimeoutMs(10000, 10, 5000)).toBe(10000);
  });

  it('is the identity at scale 1 whatever the ceiling holds', () => {
    expect(scaleTimeoutMs(10000, 1, 5000)).toBe(10000);
    expect(scaleTimeoutMs(10000, 1, CEILING_MS)).toBe(10000);
  });

  it.each([
    ['NaN', Number.NaN], ['null', null], ['zero', 0], ['a negative number', -5],
  ])('leaves the declared budget when the ceiling is unusable (%s): fail closed, not unclamped', (_label, ceiling) => {
    expect(scaleTimeoutMs(3000, 10, ceiling)).toBe(3000);
  });

  it('keeps every budget of the PostToolUse table inside slot minus headroom at every scale in [1, 10]', () => {
    // The table's declared budgets (hooks/dispatch-table.json): 3, 5, 8 and 10 s.
    // The invariant the ceiling exists for: the slowest child timer, plus the
    // headroom the dispatcher keeps for itself, fits in the slot - at the cap of
    // 10 and at every step below it, where the old code broke it above 2.7x.
    const declared = [3000, 5000, 8000, 10000];
    for (let tenths = 10; tenths <= 100; tenths += 1) {
      const scale = tenths / 10;
      const budgets = declared.map((ms) => scaleTimeoutMs(ms, scale, CEILING_MS));
      budgets.forEach((budget, i) => {
        expect(budget, `${declared[i]} x ${scale}`).toBeLessThanOrEqual(CEILING_MS);
        expect(budget, `${declared[i]} x ${scale}`).toBeGreaterThanOrEqual(declared[i]);
      });
      expect(Math.max(...budgets) + DISPATCHER_HEADROOM_MS, `scale ${scale}`).toBeLessThanOrEqual(SLOT_MS);
    }
  });
});

/**
 * The delay `spawnHook` hands to its kill timer, read from the setTimeout call it
 * makes SYNCHRONOUSLY while arming it (the Promise executor runs before
 * `spawnHook` returns, so the spy can be lifted straight away).
 *
 * Asserting on the armed value, not on when a real child happens to be killed,
 * keeps these cases free of boot-time and scheduling noise. A node child's cold
 * start under load is measured in seconds (a whole dispatch took ~9-11 s under
 * the 16-parallel harness), so "a slow child finished inside the scaled budget"
 * would itself be a load-coupled claim at this level. The end-to-end proof that
 * the scaled budget governs a slow child is the delay-injection pair in
 * posttooluse-dispatcher.test.js, whose scaled budget is 27 s (3 s x 10, held
 * to the slot minus headroom).
 *
 * @param {number} timeoutMs declared budget handed to spawnHook
 * @param {object} [callerOpts] extra spawnHook options; the scaled cases pass OPT_IN
 * @returns {Promise<number[]>} every setTimeout delay armed during the call
 */
async function armedTimerDelays(timeoutMs, callerOpts = {}) {
  const armed = [];
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    armed.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  });
  const pending = spawnHook(script('instant', INSTANT), {}, {
    timeoutMs, name: 'instant', dispatcherName: 'dtest', ...callerOpts,
  });
  spy.mockRestore();
  await pending;
  return armed;
}

describe('spawnHook budget', () => {
  it('arms the DECLARED budget when the variable is unset (the shipped path)', async () => {
    delete process.env[ENV];
    expect(await armedTimerDelays(3000, OPT_IN)).toEqual([3000]);
  });

  it('arms the SCALED budget when the variable is set and the caller opted in', async () => {
    process.env[ENV] = '10';
    // A wide slot: this case is about the multiplier. The ceiling has its own block below.
    expect(await armedTimerDelays(3000, OPT_IN_WIDE)).toEqual([30000]);
  });

  it('rounds a fractional product up', async () => {
    process.env[ENV] = '1.5';
    expect(await armedTimerDelays(2001, OPT_IN)).toEqual([3002]);
  });

  it('never arms a SHORTER timer: a sub-1 scale leaves the declared budget alone', async () => {
    // With the floor missing this would arm ceil(15000 x 0.0001) = 2 ms, and no
    // node child boots in 2 ms, so a healthy hook would be reported as `timeout`.
    process.env[ENV] = '0.0001';
    expect(await armedTimerDelays(15000, OPT_IN)).toEqual([15000]);
  });

  it('caps a huge scale at 10x instead of letting the product overflow setTimeout to 1 ms', async () => {
    // Uncapped this is 15000 x 1e11 = 1.5e15 ms, which Node would fire after 1 ms.
    process.env[ENV] = '99999999999';
    // A wide slot, or the 27 s ceiling would read the same and this case could not tell 10x from 1e11x.
    expect(await armedTimerDelays(15000, OPT_IN_WIDE)).toEqual([150000]);
  });

  it('leaves a value that is not a plain decimal on the declared budget', async () => {
    process.env[ENV] = '3x';
    expect(await armedTimerDelays(3000, OPT_IN)).toEqual([3000]);
  });

  // NEGATIVE CONTROLS for the opt-in. Every case above passes OPT_IN, so on their
  // own they would stay green if the default flipped to "scaled unless told
  // otherwise". These are the cases that go red then.
  it('arms the DECLARED budget for a caller that did not opt in, even at the cap of 10', async () => {
    // 3000 x 10 = 30000 is what a leaking scale would arm; the shipped budget is 3000.
    // The slot is named so the ONLY thing withheld is the opt-in: without a slot
    // the budget stays declared anyway (see 'headroom ceiling') and this could not go red.
    process.env[ENV] = '10';
    expect(await armedTimerDelays(3000, SLOT_WIDE)).toEqual([3000]);
  });

  it.each([
    ['false', false],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['the string "yes"', 'yes'],
    ['an object', {}],
    ['an array', [true]],
    ['null', null],
    ['undefined', undefined],
  ])('only the literal true opts in: %s stays on the declared budget', async (_label, flag) => {
    process.env[ENV] = '10';
    // The slot is named for the reason above: the flag must be the only thing missing.
    expect(await armedTimerDelays(3000, { ...SLOT_WIDE, allowTimeoutScale: flag })).toEqual([3000]);
  });

  it('kills a hung child at the DECLARED budget with the historical stderr line (variable unset)', async () => {
    delete process.env[ENV];
    const watch = watchStderr('dtest');
    const res = await spawnHook(script('hang', HANG), {}, { timeoutMs: 300, name: 'hang', dispatcherName: 'dtest' });
    // HANG cannot exit inside the test, so `timeout` is certain, not a race.
    expect(res.status).toBe('timeout');
    expect(watch.lines()).toEqual(['[artibot:dtest] hang timed out after 300ms\n']);
  });

  it('kills a hung child at the DECLARED budget when the caller did not opt in, even with the variable set', async () => {
    process.env[ENV] = '5';
    const watch = watchStderr('dtest');
    const res = await spawnHook(script('hang', HANG), {}, {
      timeoutMs: 300, name: 'hang', dispatcherName: 'dtest', ...SLOT_WIDE,
    });
    expect(res.status).toBe('timeout');
    // No "(declared ... x ...)" suffix: the scale was never applied.
    expect(watch.lines()).toEqual(['[artibot:dtest] hang timed out after 300ms\n']);
  });

  it('kills a hung child at the SCALED budget and names both budgets on stderr', async () => {
    process.env[ENV] = '5';
    const watch = watchStderr('dtest');
    const res = await spawnHook(script('hang', HANG), {}, {
      timeoutMs: 300, name: 'hang', dispatcherName: 'dtest', ...OPT_IN,
    });
    expect(res.status).toBe('timeout');
    expect(watch.lines()).toEqual(['[artibot:dtest] hang timed out after 1500ms (declared 300ms x 5)\n']);
  });
});

/**
 * The headroom ceiling: a SCALED budget never outlasts the host slot minus the
 * dispatcher's own headroom. Without it a stretched child timer could fire after
 * the host had already cancelled the dispatcher, and the merged output - a
 * quality-gate decision:'block' included - went with it (see resolveTimeoutScale).
 *
 * What these cases pin, all through the delay `spawnHook` hands to setTimeout:
 *   - the clamp itself, at the real PostToolUse slot (30 s -> 27 s);
 *   - that the ceiling is the slot the CALLER names, not a constant in the helper;
 *   - that an opt-in without a usable slot gets NO stretch (fail closed): the
 *     helper cannot keep headroom inside a slot it was not told about;
 *   - that scale 1 is untouched, which is the only path production takes.
 */
describe('headroom ceiling inside the host slot', () => {
  it('arms a scaled budget no later than slot minus headroom: 10000 x 10 is 27000, not 100000', async () => {
    process.env[ENV] = '10';
    expect(await armedTimerDelays(10000, OPT_IN)).toEqual([CEILING_MS]);
  });

  it('clamps the tight budgets too: 3000 x 10 is 27000, not 30000', async () => {
    process.env[ENV] = '10';
    expect(await armedTimerDelays(3000, OPT_IN)).toEqual([CEILING_MS]);
  });

  it('leaves a scaled budget that fits under the ceiling on the plain product', async () => {
    process.env[ENV] = '2';
    expect(await armedTimerDelays(8000, OPT_IN)).toEqual([16000]);
  });

  it('takes the ceiling from the slot it is given: a 15 s slot arms 12 s', async () => {
    process.env[ENV] = '10';
    expect(await armedTimerDelays(3000, { allowTimeoutScale: true, slotTimeoutMs: 15000 })).toEqual([12000]);
  });

  it('never shortens a declared budget that is already over the ceiling', async () => {
    process.env[ENV] = '10';
    expect(await armedTimerDelays(28000, OPT_IN)).toEqual([28000]);
  });

  it('stays on the declared budget when the caller opts in but names no slot (fail closed)', async () => {
    // 3000 x 10 = 30000 is what an unbounded opt-in would arm.
    process.env[ENV] = '10';
    expect(await armedTimerDelays(3000, { allowTimeoutScale: true })).toEqual([3000]);
  });

  it.each([
    ['a numeric string', '30000'],
    ['a slot equal to the headroom', 3000],
    ['NaN', Number.NaN],
  ])('stays on the declared budget when the slot is %s (fail closed)', async (_label, slot) => {
    process.env[ENV] = '10';
    expect(await armedTimerDelays(3000, { allowTimeoutScale: true, slotTimeoutMs: slot })).toEqual([3000]);
  });

  it('arms the declared budget at scale 1 in any slot, which is the only path production takes', async () => {
    delete process.env[ENV];
    expect(await armedTimerDelays(3000, OPT_IN)).toEqual([3000]);
    expect(await armedTimerDelays(10000, OPT_IN)).toEqual([10000]);
  });

  it('names the cap on stderr when a budget was clamped, next to both budgets', async () => {
    // A 4 s slot leaves a 1 s ceiling: 300 x 5 = 1500 is clamped to 1000, and HANG
    // cannot exit inside the test, so `timeout` is certain, not a race.
    process.env[ENV] = '5';
    const watch = watchStderr('dtest');
    const res = await spawnHook(script('hang', HANG), {}, {
      timeoutMs: 300, name: 'hang', dispatcherName: 'dtest', allowTimeoutScale: true, slotTimeoutMs: 4000,
    });
    expect(res.status).toBe('timeout');
    expect(watch.lines()).toEqual([
      '[artibot:dtest] hang timed out after 1000ms (declared 300ms x 5, capped by the 4000ms slot)\n',
    ]);
  });
});

/**
 * Every production module whose text contains `needle`, as sorted plugin-relative
 * POSIX paths, plus how many files the walk looked at (for the scanner self-check).
 *
 * @param {string} needle
 * @returns {{ scanned: number, readers: string[] }}
 */
function productionModulesMentioning(needle) {
  let scanned = 0;
  const readers = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (/\.(?:m?js|cjs|json)$/.test(entry.name)) {
        scanned += 1;
        if (readFileSync(full, 'utf-8').includes(needle)) {
          readers.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
        }
      }
    }
  };
  for (const root of ['scripts', 'lib', 'bin', 'server', 'hooks']) visit(path.join(PLUGIN_ROOT, root));
  return { scanned, readers: readers.sort() };
}

describe('ownership of the variable', () => {
  // Matches the NAME anywhere in the file, comments included, so a bare mention
  // in a second module also turns this red. That friction is deliberate: a
  // second mention is the moment to decide whether it needs the clamp.
  it('is referenced by exactly one production module, so no second reader can skip the clamp', () => {
    const { scanned, readers } = productionModulesMentioning(ENV);

    // Scanner self-check: a walk that found nothing would pass this case forever.
    expect(scanned).toBeGreaterThan(300);
    expect(readers).toEqual(['scripts/hooks/_dispatcher-utils.js']);
  });
});

describe('who may opt in to the scale', () => {
  // The same friction one level up, and for the same reason: `spawnHook` reads
  // the variable only for a caller that names the option, so the set of modules
  // that name it IS the set of dispatchers the variable can reach. Stop,
  // SubagentStop, SessionStart and SessionEnd must not be in it (see the header),
  // and a dispatcher added later must not join it without someone deciding that
  // a stretched budget cannot outlive its host slot. The pin is an allowlist, so
  // a new mention, comments included, is red until it is registered here.
  it('is named by exactly the defining module and the PostToolUse dispatcher', () => {
    const { scanned, readers } = productionModulesMentioning('allowTimeoutScale');

    // Scanner self-check, twice over: the walk must have looked at a real tree,
    // and it must have found BOTH expected names. A scan that saw neither would
    // otherwise be a scan of nothing.
    expect(scanned).toBeGreaterThan(300);
    expect(readers).toEqual([
      'scripts/hooks/_dispatcher-utils.js',
      'scripts/hooks/_posttooluse-dispatcher.js',
    ]);
  });
});
