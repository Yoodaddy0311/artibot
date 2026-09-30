import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveTimeoutScale,
  scaleTimeoutMs,
  spawnHook,
} from '../../scripts/hooks/_dispatcher-utils.js';

/**
 * scripts/hooks/_dispatcher-utils.js -- the TEST-ONLY hook-budget multiplier
 * (`ARTIBOT_DISPATCH_TIMEOUT_SCALE`) and the security envelope around it.
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
 * SECURITY ENVELOPE (each line below is pinned by a case in this file).
 *   - It can only LENGTHEN a budget. A value below 1 is floored to 1, so it can
 *     never make every hook "time out" and silently disable them.
 *   - It is capped at 10. A larger value is clamped, and the product is clamped
 *     to what setTimeout can hold: Node turns a delay beyond 2^31-1 ms into 1 ms.
 *   - It is read from a strict decimal syntax and nothing else. Anything that
 *     does not parse falls back to 1, i.e. the shipped budgets, byte for byte.
 *   - Exactly one production module references it (see the last case), so no
 *     second reader can apply the value without the clamp.
 *
 * WHAT THIS FILE DOES NOT SEE.
 *   - tests/firewall/hook-timeout-budget.test.js gates the DECLARED budgets
 *     against the host's slot timeout in hooks/hooks.json. A runtime multiplier
 *     is invisible to it: at 10x, post-edit-format's 10 s becomes 100 s, longer
 *     than the 30 s the host gives the PostToolUse dispatcher, so a child that
 *     really hangs would get the dispatcher killed (its merged output lost)
 *     before the child's own timer fired. That is why the value is a test knob.
 *   - Nothing here can stop an operator from exporting the variable in a real
 *     session. The envelope bounds the damage to "slower to give up".
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
 * posttooluse-dispatcher.test.js, whose scaled budget is 30 s.
 *
 * @param {number} timeoutMs declared budget handed to spawnHook
 * @returns {Promise<number[]>} every setTimeout delay armed during the call
 */
async function armedTimerDelays(timeoutMs) {
  const armed = [];
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    armed.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  });
  const pending = spawnHook(script('instant', INSTANT), {}, { timeoutMs, name: 'instant', dispatcherName: 'dtest' });
  spy.mockRestore();
  await pending;
  return armed;
}

describe('spawnHook budget', () => {
  it('arms the DECLARED budget when the variable is unset (the shipped path)', async () => {
    delete process.env[ENV];
    expect(await armedTimerDelays(3000)).toEqual([3000]);
  });

  it('arms the SCALED budget when the variable is set', async () => {
    process.env[ENV] = '10';
    expect(await armedTimerDelays(3000)).toEqual([30000]);
  });

  it('rounds a fractional product up', async () => {
    process.env[ENV] = '1.5';
    expect(await armedTimerDelays(2001)).toEqual([3002]);
  });

  it('never arms a SHORTER timer: a sub-1 scale leaves the declared budget alone', async () => {
    // With the floor missing this would arm ceil(15000 x 0.0001) = 2 ms, and no
    // node child boots in 2 ms, so a healthy hook would be reported as `timeout`.
    process.env[ENV] = '0.0001';
    expect(await armedTimerDelays(15000)).toEqual([15000]);
  });

  it('caps a huge scale at 10x instead of letting the product overflow setTimeout to 1 ms', async () => {
    // Uncapped this is 15000 x 1e11 = 1.5e15 ms, which Node would fire after 1 ms.
    process.env[ENV] = '99999999999';
    expect(await armedTimerDelays(15000)).toEqual([150000]);
  });

  it('leaves a value that is not a plain decimal on the declared budget', async () => {
    process.env[ENV] = '3x';
    expect(await armedTimerDelays(3000)).toEqual([3000]);
  });

  it('kills a hung child at the DECLARED budget with the historical stderr line (variable unset)', async () => {
    delete process.env[ENV];
    const watch = watchStderr('dtest');
    const res = await spawnHook(script('hang', HANG), {}, { timeoutMs: 300, name: 'hang', dispatcherName: 'dtest' });
    // HANG cannot exit inside the test, so `timeout` is certain, not a race.
    expect(res.status).toBe('timeout');
    expect(watch.lines()).toEqual(['[artibot:dtest] hang timed out after 300ms\n']);
  });

  it('kills a hung child at the SCALED budget and names both budgets on stderr', async () => {
    process.env[ENV] = '5';
    const watch = watchStderr('dtest');
    const res = await spawnHook(script('hang', HANG), {}, { timeoutMs: 300, name: 'hang', dispatcherName: 'dtest' });
    expect(res.status).toBe('timeout');
    expect(watch.lines()).toEqual(['[artibot:dtest] hang timed out after 1500ms (declared 300ms x 5)\n']);
  });
});

describe('ownership of the variable', () => {
  // Matches the NAME anywhere in the file, comments included, so a bare mention
  // in a second module also turns this red. That friction is deliberate: a
  // second mention is the moment to decide whether it needs the clamp.
  it('is referenced by exactly one production module, so no second reader can skip the clamp', () => {
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
          if (readFileSync(full, 'utf-8').includes(ENV)) {
            readers.push(path.relative(PLUGIN_ROOT, full).split(path.sep).join('/'));
          }
        }
      }
    };
    for (const root of ['scripts', 'lib', 'bin', 'server', 'hooks']) visit(path.join(PLUGIN_ROOT, root));

    // Scanner self-check: a walk that found nothing would pass this case forever.
    expect(scanned).toBeGreaterThan(300);
    expect(readers).toEqual(['scripts/hooks/_dispatcher-utils.js']);
  });
});
