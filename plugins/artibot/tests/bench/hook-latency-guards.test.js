/**
 * Guard contract for `scripts/bench/hook-latency.mjs` — `snapshotGuards()` and
 * `compareGuards()`, in both `--writers` modes.
 *
 * SPLIT FROM `tests/bench/hook-latency.test.js`, which keeps the rest of the
 * runner's pure surface: `summarize()`, the `SLOTS` registry and its two
 * cross-file agreements, the payload builders, and import-time inertness. That
 * file is where the Stop gate's `<stem>.test.*` coverage requirement is met;
 * this one is a `<stem>-<suffix>.test.js` sibling, which
 * `stop-review-gate.js#checkMissingTests` also accepts. The two were one file
 * until the guard block plus the `--writers` matrix pushed it past the
 * 800-line cap, so the split is by SUBJECT, not by size alone: everything here
 * answers "did a bench run touch a store it should not have".
 *
 * WHAT THE GUARDS CLAIM, AND ON WHICH AXIS
 *
 * Two independent axes, and conflating them is the bug this suite exists to
 * prevent:
 *
 *   - **Generated values** — session ids and sandbox directory names this
 *     process minted, each carrying a random suffix nothing else can produce.
 *     Presence in a guarded store is a violation, in every writers mode, with
 *     no before/after subtraction. This axis decides the verdict.
 *   - **Prefix markers** — `artibot-bench-`, `bench-`, `bench-agent`: fixed
 *     strings the bench USES but did not invent. Counted and reported, never
 *     fatal. Two measured false positives put them on this side of the line,
 *     and both are pinned below as negative controls.
 *
 * `--writers tolerate` is a third, orthogonal thing: it is about a CONCURRENT
 * WRITER, not about attribution. A live session writing its own rows into a
 * guarded tree during a bench run makes the digest move for reasons that have
 * nothing to do with the bench. Strict calls that a violation; tolerate
 * records who wrote the new rows, reports `strictWouldFail`, and does not fail
 * the run. A generated value still fails under tolerate — the mode narrows one
 * claim, it does not relax the gate.
 *
 * NO NODE SPAWN, NO REAL-PATH TOUCH
 *
 * Nothing here starts a Node child process, so no dispatcher and no hook ever
 * runs: this file lands in `npm test`, and
 * `tests/firewall/dispatcher-cwd-sandbox-required.test.js` scans every
 * `*.test.js` for a `process.execPath` spawn. ONE deliberate exception to "no
 * child process at all" — the sandbox-basename positive control calls
 * `createSandbox()`, which runs `git init/add/commit` inside two `mkdtemp`
 * directories with HOME and USERPROFILE redirected into the sandbox. Not a
 * Node spawn, no real path touched, and the test removes both directories and
 * asserts they are gone. Every guard target is inside this suite's own
 * `mkdtemp` root, which `afterAll` removes. `defaultGuardSpecs()` is CALLED in
 * one block ("spec inventory") but never snapshotted: calling it only shells
 * out to `git rev-parse` and joins strings, so the real `USERPROFILE` and the
 * real git dir are read as NAMES and never opened.
 *
 * WHAT THIS FILE CANNOT SEE
 *
 *   - **Whether the guards protect the REAL stores.** Every verdict is pinned
 *     against throwaway directories. That `defaultGuardSpecs()` names the right
 *     real paths is not asserted beyond the spec-inventory block at the end,
 *     which checks one spec's NAME shape without opening it — asserting more
 *     means reading the real stores.
 *   - **Whether a concurrent writer is correctly identified in practice.**
 *     `unattributedRows` is pinned against rows this suite wrote itself. A real
 *     session's rows may omit `session_id`, `ts` or `event` entirely, and the
 *     row indexer records `null` for each missing field without complaint.
 *   - **Anything outside a `.json`/`.jsonl`/`.ndjson` file.** The leak scan
 *     reads those three extensions only; a control below pins that limit.
 *
 * @module tests/bench/hook-latency-guards
 */

import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import {
  compareGuards, createSandbox, defaultGuardSpecs, SLOTS, snapshotGuards,
} from '../../scripts/bench/hook-latency.mjs';

/**
 * A clean leak-scan verdict, matched as a pattern rather than as a literal.
 * The denominator is the size of the generated-value set at comparison time,
 * and that set grows whenever anything in this process mints a session id or a
 * sandbox directory. A literal would pin a number that depends on test
 * execution order, which breaks for reasons unrelated to the contract.
 */
const CLEAN_VERDICT = /^clean \(0 of \d+ generated values found\)$/;

describe('snapshotGuards() / compareGuards() — verdict contract', () => {
  let root;
  let counter = 0;

  /** A fresh, empty directory under the suite's temp root. @returns {string} */
  function freshDir() {
    counter += 1;
    const dir = path.join(root, `g${counter}`);
    mkdirSync(dir);
    return dir;
  }

  /**
   * Snapshot one spec, mutate, snapshot again, and return the single verdict.
   * @param {string|{path: string, mode?: string}} spec
   * @param {() => void} mutate
   * @returns {Promise<object>}
   */
  async function verdictAfter(spec, mutate) {
    const before = await snapshotGuards([spec]);
    mutate();
    const after = await snapshotGuards([spec]);
    return compareGuards(before, after)[0];
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'artibot-hlt-guard-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('only ever guards throwaway temp paths in this suite (self-check)', () => {
    // The real stores are never snapshotted here. If this suite were ever
    // pointed at `<home>/.artibot` or `<home>/.claude/artibot`, a guard FAIL
    // would be reporting on the developer's live session, not on the code.
    expect(root.startsWith(os.tmpdir())).toBe(true);
    expect(root).not.toContain('.artibot');
    expect(root).not.toContain('.claude');
  });

  it('treats a bare string spec as a tree guard', async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf-8');
    const [snap] = await snapshotGuards([dir]);
    expect(snap.mode).toBe('tree');
    expect(snap.state).toMatch(/^tree:1f:/);
  });

  it('returns an empty array when given no specs', async () => {
    expect(await snapshotGuards(undefined)).toEqual([]);
  });

  it('digests a single file as file:<sha256> rather than as a tree', async () => {
    const dir = freshDir();
    const file = path.join(dir, 'ledger.jsonl');
    writeFileSync(file, 'one\n', 'utf-8');
    const [snap] = await snapshotGuards([{ path: file, mode: 'tree' }]);
    expect(snap.state).toMatch(/^file:[0-9a-f]{64}$/);
  });

  it('reports an untouched tree as unchanged', async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf-8');
    const guard = await verdictAfter({ path: dir, mode: 'tree' }, () => {});
    expect(guard.verdict).toBe('unchanged');
    expect(guard.violation).toBe(false);
  });

  it('reports a path absent before and after as absent/absent', async () => {
    const missing = path.join(freshDir(), 'never-created');
    const guard = await verdictAfter({ path: missing, mode: 'tree' }, () => {});
    expect(guard.verdict).toBe('absent/absent');
    expect(guard.violation).toBe(false);
    expect(guard.before).toBe('absent');
  });

  // The common-dir ledger spec (defaultGuardSpecs #5) names a FILE that does
  // not exist yet, so these two pin the pair of outcomes it can produce. The
  // fixture mirrors the real shape — `<common dir>/artibot/ledger.jsonl` — but
  // lives entirely under this suite's temp root; nothing here reads the real
  // git dir.
  it('skips a common-dir ledger that does not exist yet, rather than passing it', async () => {
    const commonDir = path.join(freshDir(), '.git');
    const ledger = path.join(commonDir, 'artibot', 'ledger.jsonl');
    const guard = await verdictAfter({ path: ledger, mode: 'tree' }, () => {});
    expect(guard.verdict).toBe('absent/absent');
    expect(guard.skipped).toBe(true);
    expect(guard.violation).toBe(false);
    // A skip must not read as a strict pass either.
    expect(guard.strictWouldFail).toBe(false);
  });

  it('fails a common-dir ledger that exists and then changes', async () => {
    const commonDir = path.join(freshDir(), '.git');
    const ledger = path.join(commonDir, 'artibot', 'ledger.jsonl');
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, '{"event":"seed"}\n', 'utf-8');
    const guard = await verdictAfter(
      { path: ledger, mode: 'tree' },
      () => appendFileSync(ledger, '{"event":"appended"}\n', 'utf-8'),
    );
    expect(guard.verdict).toBe('CHANGED');
    expect(guard.violation).toBe(true);
    // An evaluated guard is never `skipped`, whichever way it went.
    expect(guard.skipped).toBe(false);
    // A single-file target is digested as a file, not walked as a tree.
    expect(guard.before).toMatch(/^file:/);
  });

  it('marks skipped false on an evaluated guard', async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf-8');
    const guard = await verdictAfter({ path: dir, mode: 'tree' }, () => {});
    expect(guard.verdict).toBe('unchanged');
    expect(guard.skipped).toBe(false);
  });

  it('fails a tree guard when a file is added', async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'tree' },
      () => writeFileSync(path.join(dir, 'b.txt'), 'y', 'utf-8'),
    );
    expect(guard.verdict).toBe('CHANGED');
    expect(guard.violation).toBe(true);
  });

  it('fails a tree guard when an existing file gains bytes', async () => {
    // Distinct from the case above: the file COUNT is unchanged, so a digest
    // that only covered the listing rather than the contents would miss this.
    const dir = freshDir();
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'x', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'tree' },
      () => appendFileSync(file, 'more', 'utf-8'),
    );
    expect(guard.verdict).toBe('CHANGED');
    expect(guard.violation).toBe(true);
    expect(guard.entries.before).toEqual([{ path: 'a.txt', size: 1 }]);
    expect(guard.entries.after).toEqual([{ path: 'a.txt', size: 5 }]);
  });

  it('records an informational change without calling it a violation', async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'informational' },
      () => writeFileSync(path.join(dir, 'b.txt'), 'y', 'utf-8'),
    );
    expect(guard.verdict).toMatch(/^CHANGED \(informational/);
    expect(guard.violation).toBe(false);
  });

  it('records an observe change without calling it a violation', async () => {
    const dir = freshDir();
    const file = path.join(dir, 'ledger.jsonl');
    writeFileSync(file, 'unrelated\n', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'observe' },
      () => appendFileSync(file, 'written by another session\n', 'utf-8'),
    );
    expect(guard.verdict).toMatch(/^CHANGED \(observe/);
    expect(guard.violation).toBe(false);
    // The listing is what makes an observe change actionable: it must carry
    // the size delta, not just an opaque digest change.
    expect(guard.entries.before[0].size).toBeLessThan(guard.entries.after[0].size);
  });

  it('fails an observe guard on an emitted session id, digest change or not', async () => {
    // The strongest available marker: an id this process handed to a payload
    // builder. The runner records each at emission time, so a store holding
    // one cannot be explained by anything but this process.
    const dir = freshDir();
    const emitted = SLOTS.SessionStart.payload({ home: dir, cwd: dir }).session_id;
    const file = path.join(dir, 'ledger.jsonl');
    writeFileSync(file, 'unrelated\n', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'observe' },
      () => appendFileSync(file, `{"session_id":"${emitted}"}\n`, 'utf-8'),
    );
    expect(guard.verdict).toMatch(/^LEAK:/);
    expect(guard.verdict).toContain('ledger.jsonl');
    expect(guard.violation).toBe(true);
  });

  it('passes a leak-scan guard when a jsonl file changes without a fingerprint', async () => {
    const dir = freshDir();
    const file = path.join(dir, 'store.jsonl');
    writeFileSync(file, 'unrelated\n', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'leak-scan' },
      () => appendFileSync(file, 'still unrelated\n', 'utf-8'),
    );
    expect(guard.verdict).toMatch(CLEAN_VERDICT);
    expect(guard.violation).toBe(false);
  });

  it('reports the size of the exact-match set the verdict was decided against', async () => {
    // "clean because nothing leaked" and "clean because the set was empty so
    // nothing COULD match" are different claims. The count tells them apart:
    // a clean verdict means something only next to a non-zero denominator.
    //
    // The id is minted HERE rather than relied upon from an earlier test. The
    // runner's generated-value set is module-global and grows as tests run, so
    // asserting a non-zero denominator without minting one would make this
    // test pass or fail on declaration order.
    const dir = freshDir();
    SLOTS.PostCompact.payload({ home: dir, cwd: dir });
    writeFileSync(path.join(dir, 'store.jsonl'), 'unrelated\n', 'utf-8');
    const guard = await verdictAfter({ path: dir, mode: 'leak-scan' }, () => {});
    expect(guard.exactMarkerCount).toBeGreaterThan(0);
    expect(guard.verdict).toBe(`clean (0 of ${guard.exactMarkerCount} generated values found)`);
  });

  it('does not flag a sandbox-shaped string this run did not generate', async () => {
    // `artibot-bench-cwd-XYZ` is the shape a REAL leak takes — a cwd field —
    // carrying a value nothing here minted. A detector keyed on the PREFIX
    // calls it a leak; one keyed on generated VALUES does not. Prefix matching
    // produced two measured false positives against stores this bench never
    // wrote to, so the prefix is now counted, not fatal.
    const dir = freshDir();
    writeFileSync(path.join(dir, 'store.jsonl'), 'unrelated\n', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'leak-scan' },
      () => writeFileSync(path.join(dir, 'new.jsonl'), '{"cwd":"/tmp/artibot-bench-cwd-XYZ"}\n', 'utf-8'),
    );
    expect(guard.verdict).toMatch(CLEAN_VERDICT);
    expect(guard.violation).toBe(false);
    // Not a violation, but not invisible either: it must still be counted.
    expect(guard.informational).toMatch(/^prefix markers: [1-9]\d* occurrence\(s\)/);
    expect(guard.informational).toContain('grew in new.jsonl');
  });

  it('does not flag the synthetic agent id, which this run did not invent', async () => {
    // `bench-agent` is a fixed string the bench USES but did not generate, so
    // any process could have written it. Same axis as the case above.
    const dir = freshDir();
    writeFileSync(path.join(dir, 'store.jsonl'), 'unrelated\n', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'leak-scan' },
      () => writeFileSync(path.join(dir, 'new.jsonl'), '{"agent_id":"bench-agent"}\n', 'utf-8'),
    );
    expect(guard.verdict).toMatch(CLEAN_VERDICT);
    expect(guard.violation).toBe(false);
    expect(guard.informational).toContain('grew in new.jsonl');
  });

  it('does not flag an unrelated id that merely contains the substring bench-', async () => {
    // Regression control for the first measured false positive: this bench
    // runs from a worktree named `split-artibot-hook-latency-bench`, so the
    // live session's own routing rows carry ids containing the literal
    // `bench-` while the bench has written nothing.
    const dir = freshDir();
    writeFileSync(path.join(dir, 'store.jsonl'), 'unrelated\n', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'leak-scan' },
      () => writeFileSync(
        path.join(dir, 'routing.jsonl'),
        '{"agent":"split-artibot-hook-latency-bench-019GEYNS-runner"}\n',
        'utf-8',
      ),
    );
    expect(guard.verdict).toMatch(CLEAN_VERDICT);
    expect(guard.violation).toBe(false);
    expect(guard.informational).toContain('grew in routing.jsonl');
  });

  it('does not flag another session\'s typed command that names a bench-shaped path', async () => {
    // The 2026-09-11T00:38 KST false positive, in the shape it actually took:
    // a SIBLING session typed a command naming a bench-shaped directory and
    // its store logged that command verbatim as a `human.asked` row. Both
    // giveaways that the row is someone else's are present — an interactive
    // session id rather than a `bench-` one, and a path suffix a person typed
    // rather than one mkdtemp minted. Only the prefix matches, so the verdict
    // must be clean while the count stays visible.
    const dir = freshDir();
    writeFileSync(path.join(dir, 'store.jsonl'), 'unrelated\n', 'utf-8');
    const row = JSON.stringify({
      session_id: '019GEYNS-4c1e-7a20-b3d9-2f6081ac54e7',
      event: 'human.asked',
      text: 'cat /c/Users/dev/AppData/Local/Temp/artibot-bench-cwd-XYZ12/bench.txt',
    });
    const guard = await verdictAfter(
      { path: dir, mode: 'leak-scan' },
      () => writeFileSync(path.join(dir, 'asked.jsonl'), `${row}\n`, 'utf-8'),
    );
    expect(guard.verdict).toMatch(CLEAN_VERDICT);
    expect(guard.violation).toBe(false);
    expect(guard.informational).toMatch(/^prefix markers: [1-9]\d* occurrence\(s\)/);
    expect(guard.informational).toContain('grew in asked.jsonl');
  });

  it('fails a leak-scan guard when a real sandbox basename appears', async () => {
    // POSITIVE CONTROL for every negative one above. Without it they could all
    // pass because the detector never fires at all. This value is minted by
    // createSandbox() and carries mkdtemp's random suffix, so it is
    // attributable to this process and nothing else. createSandbox() runs
    // `git init/add/commit` in two mkdtemp directories with HOME/USERPROFILE
    // redirected into the sandbox: no Node spawn, no real path touched, and
    // the guard target below stays inside this suite's own mkdtemp root.
    const sandbox = createSandbox();
    try {
      const basename = path.basename(sandbox.cwd);
      expect(basename).toMatch(/^artibot-bench-cwd-/);
      const dir = freshDir();
      writeFileSync(path.join(dir, 'store.jsonl'), 'unrelated\n', 'utf-8');
      const guard = await verdictAfter(
        { path: dir, mode: 'leak-scan' },
        () => writeFileSync(path.join(dir, 'leaked.jsonl'), `{"cwd":"/tmp/${basename}"}\n`, 'utf-8'),
      );
      expect(guard.verdict).toMatch(/^LEAK: values generated by this run appeared in/);
      expect(guard.verdict).toContain('leaked.jsonl');
      expect(guard.violation).toBe(true);
    } finally {
      sandbox.cleanup();
    }
    expect(existsSync(sandbox.cwd)).toBe(false);
    expect(existsSync(sandbox.home)).toBe(false);
  });

  it('attributes an exact marker on presence alone, with no before/after growth', async () => {
    // An exact marker carries a random suffix this process minted, so its
    // presence is attributable on its own — it need not have APPEARED during
    // the window. Seeded before the first snapshot, it is in both and must
    // still be a leak. A detector that subtracted before from after, as an
    // earlier revision did, would call this clean.
    const dir = freshDir();
    const emitted = SLOTS.Stop.payload({ home: dir, cwd: dir }).session_id;
    writeFileSync(path.join(dir, 'store.jsonl'), `{"session_id":"${emitted}"}\n`, 'utf-8');
    const guard = await verdictAfter({ path: dir, mode: 'leak-scan' }, () => {});
    expect(guard.verdict).toMatch(/^LEAK:/);
    expect(guard.violation).toBe(true);
  });

  it('reports pre-existing prefix markers as informational with no growth', async () => {
    // The counterpart on the informational axis: a prefix marker already in
    // the store is reported, said not to have grown, and never fails the run.
    const dir = freshDir();
    writeFileSync(
      path.join(dir, 'store.jsonl'),
      '{"agent_id":"bench-agent","from":"a previous run"}\n',
      'utf-8',
    );
    const guard = await verdictAfter({ path: dir, mode: 'leak-scan' }, () => {});
    expect(guard.violation).toBe(false);
    expect(guard.informational).toMatch(/^prefix markers: [1-9]\d* occurrence\(s\), no growth$/);
  });

  it('ignores non-jsonl files during a leak scan', async () => {
    // Pinned as a KNOWN LIMIT, not a desirable property: the scan reads
    // `.json`, `.jsonl` and `.ndjson` only, so even a generated value — the
    // one thing that WOULD fail a run inside a .jsonl — is invisible at any
    // other extension. A genuinely emitted id is what makes the limit visible;
    // an unattributable string would be clean regardless and prove nothing.
    const dir = freshDir();
    const emitted = SLOTS.PreCompact.payload({ home: dir, cwd: dir }).session_id;
    writeFileSync(path.join(dir, 'store.jsonl'), 'unrelated\n', 'utf-8');
    const guard = await verdictAfter(
      { path: dir, mode: 'leak-scan' },
      () => writeFileSync(path.join(dir, 'notes.txt'), `${emitted}\n`, 'utf-8'),
    );
    expect(guard.verdict).toMatch(CLEAN_VERDICT);
    expect(guard.violation).toBe(false);
  });

  it('marks a missing after-snapshot rather than silently passing it', async () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf-8');
    const before = await snapshotGuards([{ path: dir, mode: 'tree' }]);
    const [guard] = compareGuards(before, []);
    expect(guard.after).toBe('missing-snapshot');
    expect(guard.violation).toBe(true);
  });

  it('compares pairwise by index and returns one verdict per before-entry', async () => {
    const stable = freshDir();
    const moving = freshDir();
    writeFileSync(path.join(stable, 'a.txt'), 'x', 'utf-8');
    writeFileSync(path.join(moving, 'a.txt'), 'x', 'utf-8');
    const specs = [{ path: stable, mode: 'tree' }, { path: moving, mode: 'tree' }];
    const before = await snapshotGuards(specs);
    appendFileSync(path.join(moving, 'a.txt'), 'y', 'utf-8');
    const guards = compareGuards(before, await snapshotGuards(specs));
    expect(guards).toHaveLength(2);
    expect(guards.map((g) => g.violation)).toEqual([false, true]);
    expect(guards.map((g) => g.path)).toEqual([stable, moving]);
  });

  it('returns an empty verdict list when there is nothing to compare', () => {
    expect(compareGuards(undefined, undefined)).toEqual([]);
  });
});

describe('compareGuards() — --writers strict vs tolerate', () => {
  let root;
  let counter = 0;

  /** A fresh, empty directory under this describe's temp root. @returns {string} */
  function freshDir() {
    counter += 1;
    const dir = path.join(root, `w${counter}`);
    mkdirSync(dir);
    return dir;
  }

  /**
   * Judge ONE before/after pair under both writers modes.
   *
   * The same pair, not two runs: a mode comparison built from two separate
   * mutations would differ in the input as well as the mode, and could not
   * show that the MODE is what changed the verdict.
   *
   * @param {string|{path: string, mode?: string}} spec
   * @param {() => void} mutate
   * @returns {Promise<{strict: object, tolerate: object}>}
   */
  async function bothModes(spec, mutate) {
    const before = await snapshotGuards([spec]);
    mutate();
    const after = await snapshotGuards([spec]);
    return {
      strict: compareGuards(before, after)[0],
      tolerate: compareGuards(before, after, { writers: 'tolerate' })[0],
    };
  }

  /** One JSONL row, newline-terminated. @param {object} row @returns {string} */
  function jsonl(row) {
    return `${JSON.stringify(row)}\n`;
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'artibot-hlt-writers-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it('lets an unattributed row pass under tolerate while strict fails the same pair', async () => {
    // The scenario the mode exists for: a live session appends its own row to
    // a guarded ledger while the bench is running. Nothing about the row is
    // the bench's — the session id is the host's interactive format, not a
    // generated one — so strict blames this process for a write it did not
    // make, and tolerate records the writer instead.
    const dir = freshDir();
    const file = path.join(dir, 'ledger.jsonl');
    writeFileSync(file, jsonl({ session_id: 'seed-0000', ts: '2026-09-11T00:00:00Z', event: 'seed' }), 'utf-8');
    const row = {
      session_id: '019GEYNS-4c1e-7a20-b3d9-2f6081ac54e7',
      ts: '2026-09-11T01:20:00Z',
      event: 'human.asked',
    };

    const { strict, tolerate } = await bothModes(
      { path: dir, mode: 'tree' },
      () => appendFileSync(file, jsonl(row), 'utf-8'),
    );

    // Side by side, on one pair. This is the whole claim of the mode split.
    expect(strict.verdict).toBe('CHANGED');
    expect(strict.violation).toBe(true);
    expect(strict.strictWouldFail).toBe(true);

    expect(tolerate.violation).toBe(false);
    expect(tolerate.verdict).toMatch(/strict would FAIL/);
    expect(tolerate.strictWouldFail).toBe(true);
    // `019GEYNS` is the first 8 characters of the row's session id: enough to
    // name the writer, short of copying an identifier into the report whole.
    expect(tolerate.unattributedRows).toEqual([
      { file: 'ledger.jsonl', session_id: '019GEYNS', ts: row.ts, event: row.event },
    ]);
  });

  it('fails on a generated value under tolerate too', async () => {
    // Tolerate narrows ONE claim — "a digest moved" — and leaves attribution
    // fail-closed. Without this the mode would be an escape hatch: anyone
    // hitting a guard failure could pass `--writers tolerate` and proceed.
    const dir = freshDir();
    const file = path.join(dir, 'ledger.jsonl');
    writeFileSync(file, jsonl({ session_id: 'seed-0000', ts: '2026-09-11T00:00:00Z', event: 'seed' }), 'utf-8');
    const emitted = SLOTS.Stop.payload({ home: dir, cwd: dir }).session_id;

    const { strict, tolerate } = await bothModes(
      { path: dir, mode: 'tree' },
      () => appendFileSync(file, jsonl({ session_id: emitted, ts: '2026-09-11T01:21:00Z', event: 'leaked' }), 'utf-8'),
    );

    expect(strict.violation).toBe(true);
    expect(tolerate.violation).toBe(true);
    expect(tolerate.verdict).toMatch(/^LEAK: values generated by this run appeared in/);
    expect(tolerate.verdict).toContain('ledger.jsonl');
    expect(tolerate.strictWouldFail).toBe(true);
  });

  it('reports an untouched tree as unchanged in both modes', async () => {
    // The control that keeps the two above from being explained by "tolerate
    // reports something for every guard": with no change there is nothing to
    // attribute, so the row evidence must be absent rather than empty-but-
    // present, and strictWouldFail must be false.
    const dir = freshDir();
    writeFileSync(
      path.join(dir, 'ledger.jsonl'),
      jsonl({ session_id: 'seed-0000', ts: '2026-09-11T00:00:00Z', event: 'seed' }),
      'utf-8',
    );

    const { strict, tolerate } = await bothModes({ path: dir, mode: 'tree' }, () => {});

    expect(strict.verdict).toBe('unchanged');
    expect(strict.violation).toBe(false);
    expect(strict.strictWouldFail).toBe(false);

    expect(tolerate.verdict).toBe('unchanged');
    expect(tolerate.violation).toBe(false);
    expect(tolerate.strictWouldFail).toBe(false);
    expect(tolerate.unattributedRows).toBeUndefined();
  });

  it('exposes the guard surface this suite pins', () => {
    // A rename that dropped one of these would surface as an
    // undefined-is-not-a-function failure somewhere above, with no hint that
    // the export contract itself moved. `summarize` is pinned the same way in
    // `tests/bench/hook-latency.test.js`, so each file names what it uses.
    expect(typeof snapshotGuards).toBe('function');
    expect(typeof compareGuards).toBe('function');
    expect(typeof createSandbox).toBe('function');
    expect(SLOTS).toBeTypeOf('object');
  });

  it('treats any writers value other than tolerate as strict', async () => {
    // The runner normalizes with `options.writers === 'tolerate' ? ... : ...`,
    // so a typo'd or absent mode falls back to the stricter side. Pinned
    // because the opposite default would silently weaken every caller.
    const dir = freshDir();
    const file = path.join(dir, 'ledger.jsonl');
    writeFileSync(file, jsonl({ session_id: 'seed-0000', ts: '2026-09-11T00:00:00Z', event: 'seed' }), 'utf-8');
    const before = await snapshotGuards([{ path: dir, mode: 'tree' }]);
    appendFileSync(file, jsonl({ session_id: 'other-1111', ts: '2026-09-11T01:22:00Z', event: 'noted' }), 'utf-8');
    const after = await snapshotGuards([{ path: dir, mode: 'tree' }]);

    for (const options of [{}, { writers: 'Tolerate' }, { writers: 'lenient' }]) {
      const [guard] = compareGuards(before, after, options);
      expect(guard.verdict, JSON.stringify(options)).toBe('CHANGED');
      expect(guard.violation, JSON.stringify(options)).toBe(true);
    }
  });
});

// Spec inventory: `defaultGuardSpecs()` only shells out to `git rev-parse` and
// joins strings — nothing here is snapshotted, so the real git dir is read as
// a NAME only. This pins that the common-dir ledger (spec #5) is listed even
// while the file does not exist, which is the whole point of that spec.
describe('defaultGuardSpecs() — spec inventory', () => {
  it('lists <git common dir>/artibot/ledger.jsonl as a tree spec, whether or not the file exists', () => {
    const specs = defaultGuardSpecs();
    const ledgerSpecs = specs.filter((spec) => spec.path.endsWith(path.join('artibot', 'ledger.jsonl')));
    // Exactly one: the spec is pushed once; a second push anywhere would show
    // here. (This does NOT exercise the dedupe guard around that push — no
    // earlier spec can share the ledger path, so that branch is unreachable.)
    expect(ledgerSpecs).toHaveLength(1);
    expect(ledgerSpecs[0].mode).toBe('tree');
    // Under the common dir, not under a worktree's .artibot/runtime.
    expect(ledgerSpecs[0].path).not.toContain(path.join('.artibot', 'runtime'));
  });
});
