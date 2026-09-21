/**
 * Pins the SPELLING that makes the `autopilot` vitest project run its test
 * files one at a time.
 *
 * Why a gate at all: `tests/autopilot/**` performs real `git worktree
 * add/remove` against the shared `.git/worktrees/` namespace. Two files doing
 * that at once race on the index lock (v4.5.8 symptom: `engine.execute-
 * worktree.test.js` case 3 flaking with `expected true to be false` only in
 * full-suite parallel runs).
 *
 * Why the spelling is load-bearing: vitest 4 accepts a project entry shaped
 * `{ extends, test: { ... } }`. A TEST-LEVEL option parked NEXT TO `test:`
 * is not a project option — vitest drops it WITHOUT WARNING. This is
 * specifically about test-level options; Vite-level keys such as `plugins` or
 * `resolve` are legitimate siblings, because `UserWorkspaceConfig extends
 * UserConfig$1`. The config carried `pool: 'forks'` +
 * `poolOptions.forks.singleFork` — both test-level — in exactly that dead
 * position from the vitest 4 upgrade until 2026-09-21, and the whole autopilot
 * project ran fully parallel the entire time while the comment above it
 * claimed a single fork. A silent no-op is the failure mode this file exists
 * to catch, so the check is an ALLOWLIST of legal sibling keys rather than a
 * denylist of known-bad ones: a future misplaced key is caught on arrival
 * instead of failing open. The allowlist is therefore NARROWER than what
 * vitest accepts. If a Vite-level key is ever genuinely needed beside `test:`,
 * widen the allowlist deliberately rather than deleting the check. That
 * Vite-level keys do work in that position is read off the types; it was not
 * measured by running one.
 *
 * Measured 2026-09-21 on vitest 4.0.18, `vitest run --project autopilot`,
 * 71 test files, via a probe setup file that recorded (file, pid, start, end)
 * per file:
 *   - old spelling (`poolOptions` beside `test:`): 71 distinct pids, and up
 *     to 31 test files in flight at the same instant, 43.5s wall. A pair
 *     count from the same single run was 1333 overlapping pairs; that figure
 *     is one sample and moves run to run (an independent control run counted
 *     1292 under the same definition), while the concurrency ceiling of 31
 *     is the stable reading.
 *   - new spelling (`fileParallelism: false` under `test:`): 0 overlapping
 *     pairs and a concurrency ceiling of 1 on both of two runs, still 71
 *     distinct pids (a fresh fork per file, not one long-lived process),
 *     98.9s and 105.5s wall.
 * Serial execution costs 2.3-2.4x the wall time of this one project
 * (2.27x and 2.43x measured here, 2.43x on the independent control); the
 * repo-wide CI figure was not measured.
 *
 * Why `isolate` is deliberately NOT set to false here: vitest's `groupSpecs`
 * (node_modules/vitest/dist/chunks/cli-api.*.js) routes a spec into its own
 * trailing `sequential` group only when `isolate === true && groupOrder === 0
 * && maxWorkers === 1`. A spec that misses that branch falls through to the
 * shared group, where a project whose `maxWorkers` differs from a sibling
 * project at the same `sequence.groupOrder` makes vitest throw
 * `Projects "a" and "b" have different 'maxWorkers' but same
 * 'sequence.groupOrder'`. Turning isolation off for `autopilot` would
 * therefore risk breaking every run that also includes `main`.
 *
 * WHAT THIS GATE CANNOT SEE
 * - Runtime serialism. It reads the config OBJECT only. It cannot tell you
 *   that two files actually stopped overlapping; only the probe run above can,
 *   and that measurement is a point in time, not a standing guarantee.
 * - A vitest upgrade that keeps the key name but changes its meaning, or that
 *   moves the live position again. The pin would stay green while the
 *   behaviour regressed. Re-measure on every vitest major.
 * - Anything about the OTHER project beyond the two leak checks below.
 * - Whether `tests/autopilot/**` is still the set of files that touch git
 *   worktrees. A worktree-touching test written outside that glob is invisible
 *   here.
 * - Runs that never load this config at all. The repository root carries its
 *   own delegating `vitest.config.js` with `test.root: 'plugins/artibot'`,
 *   `test.include: ['tests/**\/*.test.js']` and NO `projects` array (read
 *   2026-09-21), so a bare `npx vitest` from the root collects the autopilot
 *   files with no autopilot project and none of this serialisation. CI is
 *   unaffected because it runs with `working-directory: plugins/artibot`.
 */
import { describe, expect, it } from 'vitest';

import vitestConfig from '../../vitest.config.js';

/**
 * Sibling keys this gate accepts on a project entry in `projects[]`.
 * Allowlist, not denylist: see the header for why, and for why it is
 * deliberately narrower than what vitest itself accepts there.
 */
const LEGAL_PROJECT_ENTRY_KEYS = new Set(['extends', 'test']);

/** @param {string} key - the offending sibling key. @returns {string} */
const siblingViolation = (key) =>
  `autopilot entry has "${key}" beside "test:" — not on this gate's sibling ` +
  'allowlist; a test-level option parked there is dropped by vitest 4 ' +
  'without warning';

/**
 * Pure judgement. Takes a config object, returns violation strings.
 * Kept free of disk and of vitest internals so the self-verification block
 * below can feed it hand-built fixtures.
 *
 * @param {object} config - a vitest config object with `test.projects[]`.
 * @returns {string[]} one string per violation; empty means compliant.
 */
export function findAutopilotSerialViolations(config) {
  const violations = [];
  const projects = config?.test?.projects;

  if (!Array.isArray(projects)) {
    return ['test.projects is not an array'];
  }

  const autopilot = projects.find((p) => p?.test?.name === 'autopilot');
  if (!autopilot) {
    return ['no project entry with test.name === "autopilot"'];
  }

  for (const key of Object.keys(autopilot)) {
    if (!LEGAL_PROJECT_ENTRY_KEYS.has(key)) {
      violations.push(siblingViolation(key));
    }
  }

  if (autopilot.test.poolOptions !== undefined) {
    violations.push('autopilot test.poolOptions is not a vitest 4 option');
  }

  if (autopilot.test.fileParallelism !== false) {
    violations.push('autopilot test.fileParallelism must be false');
  }

  if (autopilot.test.isolate === false) {
    violations.push('autopilot test.isolate must not be false (groupSpecs)');
  }

  const main = projects.find((p) => p?.test?.name === 'main');
  if (!main) {
    violations.push('no project entry with test.name === "main"');
  } else if (main.test.fileParallelism === false) {
    violations.push('fileParallelism:false leaked into the main project');
  }

  if (config.test.fileParallelism === false) {
    violations.push('fileParallelism:false leaked into the top-level test block');
  }

  return violations;
}

describe('vitest autopilot project runs files serially', () => {
  it('pins the live spelling in the real config', () => {
    expect(findAutopilotSerialViolations(vitestConfig)).toEqual([]);
  });

  it('keeps the autopilot glob pointed at the worktree-touching suite', () => {
    const autopilot = vitestConfig.test.projects.find(
      (p) => p?.test?.name === 'autopilot',
    );
    expect(autopilot.test.include).toEqual(['tests/autopilot/**/*.test.{js,mjs}']);
  });
});

describe('scanner self-verification', () => {
  // A scanner that reads nothing passes forever. Every control below is a
  // hand-built object, so nothing touches disk.
  const compliant = () => ({
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'autopilot',
            include: ['tests/autopilot/**/*.test.{js,mjs}'],
            fileParallelism: false,
          },
        },
        { extends: true, test: { name: 'main' } },
      ],
    },
  });

  it('passes the compliant control', () => {
    expect(findAutopilotSerialViolations(compliant())).toEqual([]);
  });

  it('catches poolOptions parked beside test:', () => {
    const cfg = compliant();
    cfg.test.projects[0].poolOptions = { forks: { singleFork: true } };
    expect(findAutopilotSerialViolations(cfg)).toContain(
      'autopilot entry has "poolOptions" beside "test:" — not on this gate\'s ' +
        'sibling allowlist; a test-level option parked there is dropped by ' +
        'vitest 4 without warning',
    );
  });

  it('catches pool parked beside test:', () => {
    const cfg = compliant();
    cfg.test.projects[0].pool = 'forks';
    expect(findAutopilotSerialViolations(cfg)).toContain(
      'autopilot entry has "pool" beside "test:" — not on this gate\'s ' +
        'sibling allowlist; a test-level option parked there is dropped by ' +
        'vitest 4 without warning',
    );
  });

  it('catches fileParallelism parked beside test:', () => {
    const cfg = compliant();
    delete cfg.test.projects[0].test.fileParallelism;
    cfg.test.projects[0].fileParallelism = false;
    const found = findAutopilotSerialViolations(cfg);
    expect(found).toContain(
      'autopilot entry has "fileParallelism" beside "test:" — not on this ' +
        "gate's sibling allowlist; a test-level option parked there is " +
        'dropped by vitest 4 without warning',
    );
    expect(found).toContain('autopilot test.fileParallelism must be false');
  });

  it('catches poolOptions moved under test:', () => {
    const cfg = compliant();
    cfg.test.projects[0].test.poolOptions = { forks: { singleFork: true } };
    expect(findAutopilotSerialViolations(cfg)).toContain(
      'autopilot test.poolOptions is not a vitest 4 option',
    );
  });

  it('catches fileParallelism flipped back to true', () => {
    const cfg = compliant();
    cfg.test.projects[0].test.fileParallelism = true;
    expect(findAutopilotSerialViolations(cfg)).toContain(
      'autopilot test.fileParallelism must be false',
    );
  });

  it('catches isolate:false, which would break runs that include main', () => {
    const cfg = compliant();
    cfg.test.projects[0].test.isolate = false;
    expect(findAutopilotSerialViolations(cfg)).toContain(
      'autopilot test.isolate must not be false (groupSpecs)',
    );
  });

  it('catches a missing autopilot project', () => {
    const cfg = compliant();
    cfg.test.projects.shift();
    expect(findAutopilotSerialViolations(cfg)).toEqual([
      'no project entry with test.name === "autopilot"',
    ]);
  });

  it('catches a missing main project', () => {
    const cfg = compliant();
    cfg.test.projects.pop();
    expect(findAutopilotSerialViolations(cfg)).toEqual([
      'no project entry with test.name === "main"',
    ]);
  });

  it('catches the serial flag leaking into main', () => {
    const cfg = compliant();
    cfg.test.projects[1].test.fileParallelism = false;
    expect(findAutopilotSerialViolations(cfg)).toContain(
      'fileParallelism:false leaked into the main project',
    );
  });

  it('catches the serial flag leaking into the top-level test block', () => {
    const cfg = compliant();
    cfg.test.fileParallelism = false;
    expect(findAutopilotSerialViolations(cfg)).toContain(
      'fileParallelism:false leaked into the top-level test block',
    );
  });

  it('catches a config with no projects array', () => {
    expect(findAutopilotSerialViolations({ test: {} })).toEqual([
      'test.projects is not an array',
    ]);
  });
});
