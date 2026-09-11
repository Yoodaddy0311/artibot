/**
 * Firewall gate — the run ledger and the StateStore resolve to ONE location,
 * so N linked worktrees share one physical ledger (ADR-011, decision (a)).
 *
 * WHY THIS GATE EXISTS. Measured 2026-09-11 on this checkout: one main
 * checkout plus three `/split` worktrees held FOUR separate
 * `.artibot/runtime/ledger.jsonl` files. The design's "ONE physical ledger of
 * record" (ARTIBOT-5.0-DESIGN.md §3.6) was therefore already false whenever a
 * `/split` window existed, and the 2026-09-10 incident (five worktree ledgers,
 * ten versions missing from the merge) is what that divergence costs. ADR-011
 * answers it structurally rather than by a merge step: the ledger's location
 * is no longer its own rule, it is
 * `lib/project-state/store-location.js#resolveStoreLocation` — the SAME rule
 * the StateStore uses — so both answer "where does this project's history
 * live?" identically or neither does.
 *
 * That shared rule is the whole claim, and a shared import is easy to undo by
 * accident. This file is the gate that notices. It is fail-CLOSED by
 * construction: the suite is named in the branch's completion criteria, so a
 * deleted file is a missing gate (red), not a quiet pass.
 *
 * THE FOUR CASES (ADR-011 "게이트"), in the order they appear below:
 *   G1  Synthetic linked worktree. `writeEvent(mainRoot)` and
 *       `writeEvent(wtRoot)` return the SAME `result.path`, that path is
 *       `<main>/.git/artibot/ledger.jsonl`, `readLedgerCensus` reports the
 *       same `census.file.path` from both roots, and the file holds 2 events.
 *       Two roots, one file, counted from both sides.
 *   G2  A root with no `.git` at all. `result.path` is
 *       `<root>/.artibot/runtime/ledger.jsonl` — byte-identical to the
 *       pre-ADR-011 behaviour. This is a FALLBACK PIN, not a nicety: every
 *       tmpdir fixture in this repo lives on it, so a change that "fixed" the
 *       worktree case by moving the non-git case too would break them all and
 *       this case says so in one assertion instead of forty.
 *   G3  One REAL `createStateStore` commit made from the worktree root, with
 *       the real `resolveGitCommonDir` and the real writer wired as the
 *       `appendEvent` port. `/doctor` Check 8 (`checkLedgerStateParity`) is
 *       then run from BOTH roots and must report no `ledger-subset-violation`
 *       from either. This is the case that would have failed before ADR-011:
 *       the store wrote its journal under the shared common dir while the
 *       ledger went to the worktree's own tree, so from `mainRoot` the store
 *       had committed versions that no `state.updated` event paired with —
 *       which is exactly the lost-update signature Check 8 exists to raise.
 *   G4  A REAL `git worktree add`, re-checking G1 against the layout git
 *       actually writes rather than the one this file synthesizes.
 *
 * REAL STORE IS NEVER TOUCHED. Every root below is a fresh `mkdtempSync`
 * directory under the OS temp dir, and every `git` invocation passes an
 * explicit `cwd` inside it. This matters more than usual here: the post-ADR-011
 * path lives INSIDE `.git/`, which `git status` does not report, so a fixture
 * that leaked into `<repo>/.git/artibot/ledger.jsonl` would corrupt the real
 * ledger silently. Nothing below derives a project root from `process.cwd()`.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ────────────────────────────────────
 *   - CONCURRENCY BEYOND N=8. Co-location means one file takes every window's
 *     appends, so write frequency grows linearly with window count.
 *     `tests/firewall/ledger-append-survival.test.js` measures 3 and 8
 *     processes. N>8, a line near the 4 KB cap, and a network filesystem's
 *     `'a'`-flag atomicity are all UNMEASURED, here and there. Observed
 *     `/split` maximum is 12 windows.
 *   - LIVE HOOK PAYLOADS. Every case below calls the writer or the store
 *     directly. That a real hook passes the right `projectRoot` at all is
 *     G16's question (`tests/commands/doctor-checks-8-9.test.js`), and which
 *     `session_id`/`source`/`data` it passes is measured nowhere.
 *   - HOOK LATENCY. One more `statSync`/`readFileSync` pair now runs on the
 *     UserPromptSubmit path per ledger write. The cost is reported by
 *     `scripts/bench/hook-latency.mjs --n 20` with NO threshold (owner
 *     decision, 2026-09-11); that bench's own leak scan looks at
 *     `<repo>/.artibot/runtime/ledger.jsonl` and therefore cannot see the new
 *     location at all.
 *   - THE 128 KB TAIL. `scripts/hooks/subagent-handler.js` reads only the
 *     ledger's last 128 KB. A shared file fills that window faster than a
 *     per-worktree one, so a reader that used to see a session's whole history
 *     may now see a truncated slice. No case below reaches that size.
 *   - HISTORY OF A DELETED WORKTREE. The preservation claim is structural: the
 *     lines were never in the worktree, so removing it cannot take them. A
 *     test can only show "the file is still there afterwards", which is weaker
 *     than the claim and is not asserted as if it were.
 *   - PROJECTION NAME DRIFT. The projection stays per-tree; only the ledger
 *     and journal are shared. Whether two trees render compatible
 *     `state.yaml` names is W5-a's gate, not this one. G3 sidesteps it by
 *     passing `project` explicitly, which is a deliberate narrowing.
 *   - `spawns.ndjson` ASYMMETRY. `lib/learning/ledger/spawn-ledger.js` is NOT
 *     part of this change (owner decision (1): W5-b-6 moves it). Until then
 *     the ledger sums across every window while spawns stay per-tree, so
 *     `/doctor` Check 10 can report `route-bind-residue-mismatch` for a
 *     structural reason rather than a real one.
 *   - WHETHER THE INSTALLED COPY RUNS THIS CODE. Hooks execute from the
 *     installed plugin, not this working tree. Confirming the install carries
 *     the `store-location` import is a human grep, and no assertion here.
 *   - WHETHER A FIXTURE POLLUTED THE REAL `<repo>/.git/artibot/`. The isolation
 *     above is by construction, not by assertion — this suite cannot observe
 *     the real store without reaching for it, and reaching for it is the thing
 *     being avoided. Verified out of band by listing that directory before and
 *     after the run.
 *   - ONE-TIME MIGRATION CORRECTNESS. Folding the existing four files into one
 *     is the migration script's job, measured by its scratch dry run. Nothing
 *     here touches real data.
 *   - `/doctor` DOCUMENTATION WORDING. The Check 8 and Check 10 prose is
 *     pinned by `tests/commands/doctor-checks-8-9.test.js`, not here.
 *
 * @module tests/firewall/ledger-store-colocation
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEvent } from '../../lib/runtime/event-writer.js';
import { appendLedgerEvent, ledgerFilePath, readLedgerCensus } from '../../lib/runtime/ledger.js';
import { createStateStore, readJournal } from '../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { checkLedgerStateParity, CheckStatus } from '../../lib/project-state/doctor-checks.js';
import { graph, mission, MISSION_ID, T0, task } from '../project-state/helpers.js';

/** Roots this file created, removed after each case. */
const roots = [];

/**
 * A fresh temp root, realpath-ed so a Windows 8.3 short name cannot spell one
 * directory two ways. Registered for cleanup.
 * @param {string} tag - Suffix for the directory name.
 * @returns {string} Absolute root.
 */
function tmpRoot(tag) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `artibot-colocation-${tag}-`)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/**
 * Synthesize the on-disk layout git writes for a LINKED worktree: a `.git`
 * FILE at the worktree root pointing at `<main>/.git/worktrees/<name>`, and a
 * `commondir` file in that per-worktree directory holding a relative `../..`
 * back to `<main>/.git`.
 *
 * Cloned from `tests/project-state/git-common-dir.test.js#makeLinkedWorktree`
 * and `tests/runtime/event-writer.test.js#makeLinkedWorktree` on purpose: that
 * first suite owns the resolver's contract, and importing a private helper
 * across suites would couple files that test different modules.
 *
 * @param {object} params - Layout inputs.
 * @param {string} params.mainGitDir - Absolute `<main>/.git` (created here).
 * @param {string} params.worktreeRoot - Root the `.git` FILE is written into.
 * @param {string} [params.name='wt'] - Worktree name under `worktrees/`.
 * @returns {string} Absolute per-worktree git dir.
 */
function makeLinkedWorktree({ mainGitDir, worktreeRoot, name = 'wt' }) {
  const perWorktree = path.join(mainGitDir, 'worktrees', name);
  mkdirSync(perWorktree, { recursive: true });
  writeFileSync(path.join(perWorktree, 'commondir'), '../..\n');
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${perWorktree}\n`);
  return perWorktree;
}

/**
 * A main checkout and one linked worktree as SIBLING directories, so neither
 * root is a prefix of the other and a resolver that walked up the tree could
 * not pass by accident.
 *
 * @param {string} tag - Temp directory tag.
 * @returns {{mainRoot: string, wtRoot: string, mainGitDir: string, shared: string}}
 *   The two roots, the main `.git`, and the ledger file both must resolve to.
 */
function makePair(tag) {
  const base = tmpRoot(tag);
  const mainRoot = path.join(base, 'main');
  const wtRoot = path.join(base, 'wt');
  const mainGitDir = path.join(mainRoot, '.git');
  mkdirSync(mainGitDir, { recursive: true });
  makeLinkedWorktree({ mainGitDir, worktreeRoot: wtRoot });
  return {
    mainRoot, wtRoot, mainGitDir,
    shared: path.join(mainGitDir, 'artibot', 'ledger.jsonl'),
  };
}

/**
 * One allowlisted event payload. `tool.used` is the cheapest registered event
 * whose `data` contract this file can satisfy without a receipt schema.
 * @param {string} marker - Identifies which root wrote the line.
 * @returns {object} Writer input.
 */
function toolEvent(marker) {
  return {
    event: 'tool.used',
    session_id: 'sess-colocation-0001',
    source: 'hook',
    mission_id: MISSION_ID,
    data: { tool: 'Bash', ok: true, duration_ms: 1, marker },
  };
}

describe('G1 — a linked worktree and its main checkout write ONE ledger file', () => {
  it('returns the same result.path from both roots, under the git common dir', () => {
    const { mainRoot, wtRoot, shared } = makePair('g1');

    const fromMain = writeEvent(mainRoot, toolEvent('main'));
    const fromWorktree = writeEvent(wtRoot, toolEvent('worktree'));

    expect(fromMain.ok).toBe(true);
    expect(fromWorktree.ok).toBe(true);
    // The identity is the claim; the literal says WHICH location, so a change
    // that made both roots agree on the WRONG place still fails here.
    expect(fromWorktree.path).toBe(fromMain.path);
    expect(fromMain.path).toBe(shared);
    expect(existsSync(shared)).toBe(true);
    // Nothing landed in the worktree's own tree. Before ADR-011 this was the
    // file the worktree wrote, so it is the precise regression to watch.
    expect(existsSync(path.join(wtRoot, '.artibot', 'runtime', 'ledger.jsonl'))).toBe(false);
  });

  it('reports the same census.file.path and 2 events from either root', () => {
    const { mainRoot, wtRoot, shared } = makePair('g1-census');

    writeEvent(mainRoot, toolEvent('main'));
    writeEvent(wtRoot, toolEvent('worktree'));

    const fromMain = readLedgerCensus(mainRoot);
    const fromWorktree = readLedgerCensus(wtRoot);

    expect(fromWorktree.census.file.path).toBe(fromMain.census.file.path);
    expect(fromMain.census.file.path).toBe(shared);
    expect(fromMain.census.file.present).toBe(true);
    expect(fromMain.census.file.readable).toBe(true);

    // Two events, counted independently from each side, and the readers agree
    // on CONTENT as well as count: a reader that found two different files
    // with one line each would satisfy a length check alone.
    expect(fromMain.events).toHaveLength(2);
    expect(fromWorktree.events).toHaveLength(2);
    expect(fromWorktree.events.map((e) => e.data.marker)).toEqual(['main', 'worktree']);
    expect(fromMain.events.map((e) => e.data.marker)).toEqual(['main', 'worktree']);
    expect(fromMain.census.lines.nonblank).toBe(2);
    expect(fromMain.census.dropped_total.loss).toBe(0);
  });
});

describe('G2 — a root with no .git keeps the pre-ADR-011 path exactly', () => {
  it('falls back to <root>/.artibot/runtime/ledger.jsonl', () => {
    const root = tmpRoot('g2');
    // Self-check: the fallback only means anything if there is really no marker.
    expect(existsSync(path.join(root, '.git'))).toBe(false);
    expect(resolveGitCommonDir(root)).toBeNull();

    const res = writeEvent(root, toolEvent('non-git'));

    expect(res.ok).toBe(true);
    expect(res.path).toBe(path.join(root, '.artibot', 'runtime', 'ledger.jsonl'));
    expect(ledgerFilePath(root)).toBe(res.path);
    expect(readLedgerCensus(root).census.file.path).toBe(res.path);
    expect(readLedgerCensus(root).events).toHaveLength(1);
  });
});

describe('G3 — /doctor Check 8 sees no subset violation from either root', () => {
  const PROJECT = 'colocation-fixture';
  const SESSION_ID = 'sess-colocation-g3-0';

  /**
   * Build a store over `projectRoot` with the PRODUCTION ports: the real
   * `resolveGitCommonDir` and the real ledger writer. `appendEvent` appends
   * against the same root the store was opened on, which is how
   * `lib/runtime/middleware/tasks.js#openMissionStore` wires it.
   *
   * `project` is passed EXPLICITLY. Left to its default the store would use
   * `path.basename(projectRoot)`, which differs between `main` and `wt`, and
   * the two Check 8 calls below would then disagree about the project's name
   * and report a projection drift that is really a naming mismatch. Narrowing
   * the name away is deliberate: the name is W5-a's gate, the ledger location
   * is this one's.
   *
   * @param {string} projectRoot - Absolute root to open the store on.
   * @returns {object} The StateStore.
   */
  const openStore = (projectRoot) => createStateStore({
    projectRoot,
    sessionId: SESSION_ID,
    project: PROJECT,
    source: 'hook',
    now: () => new Date(T0),
    appendEvent: (envelope) => appendLedgerEvent(projectRoot, envelope),
    resolveGitCommonDir: () => resolveGitCommonDir(projectRoot),
  });

  /**
   * Collect exactly what `/doctor` Check 8 collects, resolved from `root`:
   * ledger events off disk, journal records off the store's own journal file,
   * and the projection as RAW TEXT so `compareProjection` re-renders and
   * compares byte for byte rather than falling to the structural comparison.
   *
   * @param {string} root - Root to resolve the inputs from.
   * @param {string} projection - The projection text written by the commit.
   * @returns {object} `{parity, journalPath, census, events, journal}`.
   */
  const inspect = (root, projection) => {
    const journalPath = openStore(root).paths.journal;
    const { events, census } = readLedgerCensus(root);
    const journal = readJournal(journalPath).records;
    const parity = checkLedgerStateParity({
      events, journal, projection, project: PROJECT, census,
    });
    return { parity, journalPath, census, events, journal };
  };

  it('commits from the worktree into the shared journal and the shared ledger', () => {
    const { mainRoot, wtRoot, shared, mainGitDir } = makePair('g3-wiring');
    const store = openStore(wtRoot);

    // Self-check BEFORE the commit: the store rule put the journal under the
    // main checkout's common dir, not under the worktree. Without this the
    // parity assertions could be passing on two stores that merely happen to
    // be empty in the same way.
    expect(store.location.source).toBe('git-common-dir');
    expect(store.paths.journal).toBe(path.join(mainGitDir, 'artibot', 'project-state.jsonl'));
    expect(openStore(mainRoot).paths.journal).toBe(store.paths.journal);
    // The projection is the one thing that stays per-tree.
    expect(store.paths.projection).toBe(path.join(wtRoot, '.artibot', 'state.yaml'));

    const res = store.updateMission(MISSION_ID, () => mission(), {
      graph: graph([task('t1')]), reason: 'g3-colocation',
    });
    expect(res.ok).toBe(true);

    expect(existsSync(shared)).toBe(true);
    expect(ledgerFilePath(mainRoot)).toBe(shared);
    expect(readLedgerCensus(mainRoot).census.file.path)
      .toBe(readLedgerCensus(wtRoot).census.file.path);
  });

  it('finds no ledger-subset violation from the worktree root', () => {
    const { wtRoot } = makePair('g3-wt');
    const store = openStore(wtRoot);
    store.updateMission(MISSION_ID, () => mission(), {
      graph: graph([task('t1')]), reason: 'g3-colocation',
    });
    const projection = readFileSync(store.paths.projection, 'utf8');

    const { parity, journal, events } = inspect(wtRoot, projection);

    // Measured, not defaulted: all three inputs present, so the verdict is a
    // comparison rather than an absence.
    expect(Array.isArray(events)).toBe(true);
    expect(Array.isArray(journal)).toBe(true);
    expect(parity.findings.map((f) => f.code)).not.toContain('parity-inputs-absent');
    expect(parity.status).not.toBe(CheckStatus.UNMEASURED);

    expect(parity.findings.map((f) => f.code)).not.toContain('ledger-subset-violation');
    expect(parity.findings).toEqual([]);
    expect(parity.status).toBe(CheckStatus.PASS);
  });

  it('finds no ledger-subset violation from the MAIN root either', () => {
    // THE case ADR-011 exists for. The commit happened in the worktree; this
    // reads the ledger from the main checkout. Before the change, the main
    // root's ledger was a different (here, absent) file, so the journal's
    // committed `state_version` had no paired `state.updated` event and
    // `compareLedgerVersions` raised `ledger-subset-violation` — a FAIL.
    const { mainRoot, wtRoot } = makePair('g3-main');
    const store = openStore(wtRoot);
    store.updateMission(MISSION_ID, () => mission(), {
      graph: graph([task('t1')]), reason: 'g3-colocation',
    });
    // The projection is read from the root that WROTE it, and the same text is
    // handed to both calls. It is per-tree by design, so reading it from
    // `mainRoot` would make this case `unmeasured` on a missing input and stop
    // measuring the ledger at all.
    const projection = readFileSync(store.paths.projection, 'utf8');
    expect(projection).toContain(PROJECT);

    const { parity, events, journal } = inspect(mainRoot, projection);

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.event === 'state.updated')).toBe(true);
    expect(journal.length).toBeGreaterThan(0);
    expect(parity.findings.map((f) => f.code)).not.toContain('parity-inputs-absent');
    expect(parity.findings.map((f) => f.code)).not.toContain('ledger-subset-violation');
    expect(parity.findings).toEqual([]);
    expect(parity.status).toBe(CheckStatus.PASS);
  });

  it('reaches the same verdict from both roots, on the same census', () => {
    const { mainRoot, wtRoot, shared } = makePair('g3-both');
    const store = openStore(wtRoot);
    store.updateMission(MISSION_ID, () => mission(), {
      graph: graph([task('t1')]), reason: 'g3-colocation',
    });
    const projection = readFileSync(store.paths.projection, 'utf8');

    const fromWorktree = inspect(wtRoot, projection);
    const fromMain = inspect(mainRoot, projection);

    expect(fromMain.parity.status).toBe(fromWorktree.parity.status);
    expect(fromMain.parity.findings).toEqual(fromWorktree.parity.findings);
    expect(fromMain.census.file.path).toBe(shared);
    expect(fromMain.census.file.path).toBe(fromWorktree.census.file.path);
    expect(fromMain.parity.census.status).toBe(CheckStatus.PASS);
    expect(fromMain.journalPath).toBe(fromWorktree.journalPath);
    expect(fromMain.events).toEqual(fromWorktree.events);
  });
});

/**
 * Whether a `git` binary is on PATH. G4 is the only case that needs one.
 *
 * NOTE ON SKIPPING. `doctor-checks-8-9.test.js`'s G16 does not guard this way:
 * it calls `git init` in `beforeAll` and a missing binary fails the suite. The
 * choice here is to SKIP instead, because an absent `git` is an environment
 * fact rather than a regression in this change — but the cost is real and is
 * stated rather than hidden: when G4 skips, the synthetic layout in G1 is the
 * ONLY evidence that the worktree case works, and a divergence between git's
 * real on-disk shape and this file's synthesis would go unseen.
 * @type {boolean}
 */
let GIT_AVAILABLE = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  GIT_AVAILABLE = false;
}

describe.skipIf(!GIT_AVAILABLE)('G4 — the same holds for a real `git worktree add`', () => {
  // An INDEPENDENT throwaway repository under the OS temp dir, the G16 pattern:
  // `git worktree add` mutates the repository it runs in, so every call below
  // passes an explicit cwd inside `tmp` and none may touch the Artibot checkout.
  const run = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  /**
   * Normalise a path by the repository's own rule
   * (`lib/git/project-root.js#sameDir`): realpath first, then case-fold on
   * win32 only. git writes its own spelling of the main `.git` into the
   * worktree's pointer file, and on Windows that can differ in case from the
   * spelling this test holds. This is NORMALISATION, not tolerance — the
   * negative control below compares directories that differ by more than case.
   * @param {string} p - Path to normalise.
   * @returns {string} Comparable spelling.
   */
  const norm = (p) => {
    let out;
    try {
      out = realpathSync.native(p);
    } catch {
      out = p;
    }
    return process.platform === 'win32' ? out.toLowerCase() : out;
  };

  let tmp = null;
  let mainRoot = null;
  let wtRoot = null;

  beforeAll(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-colocation-g4-')));
    mainRoot = path.join(tmp, 'main');
    wtRoot = path.join(tmp, 'wt');
    mkdirSync(mainRoot, { recursive: true });
    run(['init', '-q'], mainRoot);
    run(['-c', 'user.email=g4@test.invalid', '-c', 'user.name=g4',
      'commit', '-q', '--allow-empty', '-m', 'root'], mainRoot);
    run(['worktree', 'add', '-q', '-b', 'colocation-g4-wt', wtRoot], mainRoot);
  });

  afterAll(() => {
    if (tmp === null) return;
    try {
      run(['worktree', 'remove', '--force', wtRoot], mainRoot);
    } catch {
      // Best effort — the recursive remove below is the cleanup that matters.
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('built a real LINKED worktree — its `.git` is a file, not a directory', () => {
    // Self-check. Without it every assertion after this could be passing
    // against two ordinary repositories and would say nothing about worktrees.
    expect(statSync(path.join(mainRoot, '.git')).isDirectory()).toBe(true);
    expect(statSync(path.join(wtRoot, '.git')).isFile()).toBe(true);
  });

  it('resolves both roots to the main checkout\'s common dir', () => {
    expect(norm(resolveGitCommonDir(wtRoot))).toBe(norm(path.join(mainRoot, '.git')));
    expect(norm(resolveGitCommonDir(wtRoot))).toBe(norm(resolveGitCommonDir(mainRoot)));
    // Negative control: the per-worktree git dir is NOT the common dir, and the
    // two differ by more than the normalisation above can absorb.
    expect(norm(resolveGitCommonDir(wtRoot)))
      .not.toBe(norm(path.join(mainRoot, '.git', 'worktrees', 'colocation-g4-wt')));
  });

  it('writes both roots\' events into one real file under <main>/.git/artibot', () => {
    const fromMain = writeEvent(mainRoot, toolEvent('g4-main'));
    const fromWorktree = writeEvent(wtRoot, toolEvent('g4-worktree'));

    expect(fromMain.ok).toBe(true);
    expect(fromWorktree.ok).toBe(true);
    expect(norm(fromWorktree.path)).toBe(norm(fromMain.path));
    expect(norm(fromMain.path)).toBe(norm(path.join(mainRoot, '.git', 'artibot', 'ledger.jsonl')));
    expect(existsSync(fromMain.path)).toBe(true);
    expect(existsSync(path.join(wtRoot, '.artibot', 'runtime', 'ledger.jsonl'))).toBe(false);

    // `readLedgerCensus` returns `{events, census}`; the census field is nested
    // one level in, so both sides are read through the same spelling here.
    const readFromMain = readLedgerCensus(mainRoot);
    const readFromWorktree = readLedgerCensus(wtRoot);
    expect(norm(readFromWorktree.census.file.path)).toBe(norm(readFromMain.census.file.path));
    expect(readFromMain.events.map((e) => e.data.marker)).toEqual(['g4-main', 'g4-worktree']);
    expect(readFromWorktree.events.map((e) => e.data.marker)).toEqual(['g4-main', 'g4-worktree']);
    expect(readFromMain.census.dropped_total.loss).toBe(0);
  });
});
