/**
 * Gate for the `--fast` / `-fast` alias contract.
 *
 * ── What this gate CANNOT catch (게이트 옆에 못 보는 것을 적는다) ──────────────
 *
 * The thing that actually translates `-fast` into `options.fast = true` is not
 * JavaScript. `/autopilot` is a markdown prompt, and the flag is read by the
 * model, not by an argv parser — there is no argv parser for autopilot flags
 * anywhere in the repo:
 *
 *     grep -rn "['\"]--fast['\"]\|['\"]-fast['\"]" lib scripts tests --include=*.js
 *     → exit 1 (0 hits; measured 2026-08-26T02:11Z at 26e4bd87)
 *
 * So this file CANNOT verify that the model performs the translation. A unit
 * test cannot execute a prompt, and nothing here should be read as evidence
 * that it does. What the file does close is exactly two regressions:
 *
 *   (a) the documented contract disappearing from `commands/autopilot.md` —
 *       someone drops the `-fast` alias sentence in a doc cleanup and the only
 *       place the contract lives is gone, and
 *   (b) `fast-profile`'s public API quietly starting to reinterpret alias
 *       strings itself, so `fast: '-fast'` would enable fan-out — splitting
 *       normalization across two layers that can then disagree.
 *
 * The gap between the two — a model that reads the doc and translates it
 * wrongly — stays uncovered, and no unit test can cover it.
 *
 * Not duplicated here: `makeInitialState`'s strict-boolean narrowing of
 * `options.fast` is already asserted in `engine-helpers.test.js:17-19`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Imported through the barrel on purpose: the contract being pinned is the
// PUBLIC API's, and `fast-profile.test.js:12` establishes that convention.
import { buildFastFanoutPlan } from '../../lib/autopilot/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const AUTOPILOT_MD = path.join(PLUGIN_ROOT, 'commands/autopilot.md');

/** `-fast` standing on its own, never the tail of `--fast`. */
const BARE_ALIAS = /(?<![-\w])-fast\b/;
const LONG_FLAG = /--fast\b/;

let docLines = [];

beforeAll(async () => {
  // No try/catch and no skip guard on purpose: a missing or unreadable
  // commands/autopilot.md must turn this suite red. A silently skipped
  // docs-as-contract gate is worse than no gate — it reports green while the
  // contract it guards no longer exists.
  const content = await readFile(AUTOPILOT_MD, 'utf-8');
  docLines = content.split(/\r?\n/);
});

describe('anchor A — commands/autopilot.md carries the alias contract', () => {
  it('mentions both spellings of the flag', () => {
    expect(docLines.some((line) => LONG_FLAG.test(line))).toBe(true);
    expect(docLines.some((line) => BARE_ALIAS.test(line))).toBe(true);
  });

  // Deliberately >= 1 rather than an exact count: the contract currently
  // appears on three lines (:46, :60, :236), and a gate that pins the count
  // would go red on harmless doc additions. Core tokens are required, spacing
  // and markdown emphasis around them are not.
  it('states on at least one line that both spellings normalize to options.fast = true', () => {
    const matches = docLines.filter((line) => LONG_FLAG.test(line)
      && BARE_ALIAS.test(line)
      && /options\.fast\s*=\s*true/.test(line)
      && /정규화|normaliz/i.test(line));

    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('states that the fast-profile public API consumes the boolean only', () => {
    const matches = docLines.filter((line) => /fast-profile/.test(line)
      && /boolean/i.test(line)
      && /(만\s*소비|only\s+consum)/i.test(line));

    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

/** Shape used by `fast-profile.test.js`'s own `task()` helper. */
function task(id, affectedPaths) {
  return { id, independent: true, affectedPaths, risk: 'low', worktreeEligible: true };
}

/**
 * Two non-conflicting eligible tasks — the minimum that can reach
 * `enabled: true`, since `fast-profile.js:305` demotes anything with fewer
 * than two eligible tasks to `fewer-than-two-eligible-tasks`. Rebuilt per call
 * so no test can observe another test's task objects.
 */
function eligiblePair() {
  return [task('alpha', ['src/alpha.js']), task('beta', ['src/beta.js'])];
}

describe('anchor B — buildFastFanoutPlan consumes the boolean and nothing else', () => {
  it('enables fan-out for the canonical boolean true', () => {
    const plan = buildFastFanoutPlan({ fast: true, cpuCount: 8, tasks: eligiblePair() });

    expect(plan.enabled).toBe(true);
    expect(plan.fallbackReason).toBeNull();
  });

  // Each row would enable fan-out if the API ever started parsing flags. The
  // alias strings are the ones the command prompt is responsible for
  // translating; the truthy non-booleans are the "be lenient" drift that
  // usually arrives with them.
  it.each([
    { label: "the '-fast' alias string", fast: '-fast' },
    { label: "the '--fast' flag string", fast: '--fast' },
    { label: "the stringly-typed 'true'", fast: 'true' },
    { label: 'the truthy number 1', fast: 1 },
    { label: "the affirmative 'yes'", fast: 'yes' },
  ])('refuses $label', ({ fast }) => {
    const plan = buildFastFanoutPlan({ fast, cpuCount: 8, tasks: eligiblePair() });

    expect(plan.enabled).toBe(false);
    expect(plan.fallbackReason).toBe('fast-not-requested');
  });
});
