/**
 * Firewall gate — the SPAWN ledger resolves to the same location as the run
 * ledger, so N linked worktrees share one physical `spawns.ndjson`
 * (ADR-011 decision (a), extended to `lib/learning/ledger/spawn-ledger.js` by
 * W5-b-6).
 *
 * WHY THIS GATE EXISTS. ADR-011 moved the run ledger and the StateStore
 * journal onto one rule (`lib/project-state/store-location.js#resolveStoreLocation`)
 * and `tests/firewall/ledger-store-colocation.test.js` is the gate that keeps
 * them there. The spawn ledger was deliberately left OUT of that change (owner
 * decision (1)), and its own header said so: until W5-b-6 the run ledger summed
 * across every `/split` window while spawn records stayed per-tree. That
 * asymmetry is exactly the divergence ADR-011 exists to prevent, one file later
 * — `/doctor` Check 10 could report `route-bind-residue-mismatch` because the
 * two ledgers were counted from different directories, not because a bind was
 * actually lost. W5-b-6 closes it, and a shared rule is easy to undo by
 * accident, so this file is the gate that notices.
 *
 * It is fail-CLOSED by construction: the suite is named in the branch's
 * completion criteria, so a deleted file is a missing gate (red), not a quiet
 * pass.
 *
 * THE GATES, in the order they appear below:
 *   G1  Synthetic linked worktree. `appendSpawn(mainRoot, …)` and
 *       `appendSpawn(wtRoot, …)` return the SAME `result.path`, that path is
 *       `<main>/.git/artibot/spawns.ndjson`, `readSpawns` reports both records
 *       from BOTH roots, and neither root grew a private copy. Two roots, one
 *       file, counted from both sides.
 *   G2  A root with no `.git` at all falls back to
 *       `<root>/.artibot/runtime/spawns.ndjson`. This is a FALLBACK PIN: every
 *       tmpdir fixture in this repo lives on it, so a change that "fixed" the
 *       worktree case by moving the non-git case too would break them all, and
 *       this case says so in one assertion instead of forty. Note the literal
 *       is `runtime`, NOT the pre-W5-b-6 `.artibot/ledger/` — the fallback
 *       directory moved with the rule, and that move is asserted, not tolerated.
 *   G3  THE "ONE RULE" EVIDENCE. For a git directory, a synthetic linked
 *       worktree, and a non-git root alike, `spawnLedgerPath` and
 *       `ledgerFilePath` name files in the SAME directory. This is the claim
 *       the whole change makes, and it is the one an accidental revert breaks
 *       first: a copy of the two-branch logic would keep G1 and G2 green while
 *       drifting apart from the run ledger.
 *   G4  A REAL `git worktree add`, re-checking G1 against the layout git
 *       actually writes rather than the one this file synthesizes.
 *   G5  CONCURRENT APPEND, 8 processes x 20 records = 160, on BOTH store
 *       locations — the shape `tests/firewall/ledger-append-survival.test.js`
 *       measures for the run ledger, now that this file takes the same
 *       contention. Spawn records carry NO dedupe key, so survival is judged by
 *       160 distinct `agentId` markers rather than by the reader's census.
 *
 * REAL STORE IS NEVER TOUCHED. Every root below is a fresh `mkdtempSync`
 * directory under the OS temp dir. This matters more than usual here: the
 * post-ADR-011 path lives INSIDE `.git/`, which `git status` does not report, so
 * a fixture that leaked into the real `.git/artibot/spawns.ndjson` would corrupt
 * the live spawn ledger silently and leave no porcelain trace. Nothing below
 * derives a project root from `process.cwd()`.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ────────────────────────────────────
 *   - CONCURRENCY BEYOND N=8. G5's widest case is 8 processes. The observed
 *     `/split` maximum is 12 windows and nothing bounds it at 12, so 8 to 12 is
 *     UNMEASURED. 160/160 at 8 is not a proof about 12.
 *   - LIVE HOOK PAYLOADS. Every case below calls `appendSpawn` DIRECTLY. That a
 *     real SubagentStart/SubagentStop hook passes the right `projectRoot` is
 *     `tests/hooks/subagent-spawn-ledger.test.js`'s question, and which
 *     `sessionId`/`agentType`/routing columns it passes is measured nowhere
 *     here.
 *   - WHETHER A FIXTURE POLLUTED THE REAL STORE. The isolation above is by
 *     construction, not by assertion — this suite cannot observe the real
 *     `.git/artibot/` without reaching for it, and reaching for it is the thing
 *     being avoided. Worse than the run-ledger case: a tmp-root leak would also
 *     be invisible to `git status`, because temp directories are outside the
 *     repository entirely.
 *   - THE 128 KB TAIL. `scripts/hooks/subagent-handler.js` reads only the RUN
 *     ledger's last 128 KB. `readSpawns` reads the whole spawn file, so the tail
 *     window is irrelevant to every assertion here and nothing below reaches
 *     that size anyway.
 *   - ONE-TIME MIGRATION CORRECTNESS. Folding pre-W5-b-6
 *     `<root>/.artibot/ledger/spawns.ndjson` files into the shared location is
 *     the migration's job, measured by its own dry run. Nothing here touches
 *     real data, and no case below asserts that old records were carried over.
 *   - WHETHER THE INSTALLED COPY RUNS THIS CODE. Hooks execute from the
 *     installed plugin, not this working tree, so a green run here says nothing
 *     about where a live spawn record lands today. That is a human grep of the
 *     install, and no assertion here.
 *
 * @module tests/firewall/spawn-ledger-colocation
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appendSpawn, readSpawns, spawnLedgerPath } from '../../lib/learning/ledger/spawn-ledger.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MODULE = pathToFileURL(
  path.join(HERE, '..', '..', 'lib', 'learning', 'ledger', 'spawn-ledger.js'),
).href;

/** Records each child appends in G5 — the run ledger's survival depth. */
const LINES_PER_PROCESS = 20;

/** Processes G5 contends with — the run ledger's widest measured shape. */
const PROCESSES = 8;

/**
 * Where G5 makes its children resolve to. `spawnLedgerPath` answers differently
 * with and without a `.git` marker and BOTH answers take concurrent appends in
 * production, so each is contended for separately.
 * @type {ReadonlyArray<'fallback'|'git-common-dir'>}
 */
const STORES = ['fallback', 'git-common-dir'];

/** Roots this file created outside G4/G5, removed after each case. */
const roots = [];

/**
 * A fresh temp root, realpath-ed so a Windows 8.3 short name cannot spell one
 * directory two ways. Registered for cleanup.
 * @param {string} tag - Suffix for the directory name.
 * @returns {string} Absolute root.
 */
function tmpRoot(tag) {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `artibot-spawn-coloc-${tag}-`)));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/**
 * Normalise a path by the repository's own rule
 * (`lib/git/project-root.js#sameDir`): realpath first, then case-fold on win32
 * only. git writes its own spelling of the main `.git` into a worktree's
 * pointer file, and on Windows that can differ in case from the spelling this
 * test holds. This is NORMALISATION, not tolerance — the negative controls
 * below compare directories that differ by more than case.
 * @param {string} p - Path to normalise.
 * @returns {string} Comparable spelling.
 */
function norm(p) {
  let out;
  try {
    out = realpathSync.native(p);
  } catch {
    out = p;
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/**
 * Synthesize the on-disk layout git writes for a LINKED worktree: a `.git`
 * FILE at the worktree root pointing at `<main>/.git/worktrees/<name>`, and a
 * `commondir` file in that per-worktree directory holding a relative `../..`
 * back to `<main>/.git`.
 *
 * Cloned from `tests/firewall/ledger-store-colocation.test.js#makeLinkedWorktree`
 * on purpose: `tests/project-state/git-common-dir.test.js` owns the resolver's
 * contract, and importing a private helper across suites would couple files
 * that test different modules.
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
 *   The two roots, the main `.git`, and the spawn file both must resolve to.
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
    shared: path.join(mainGitDir, 'artibot', 'spawns.ndjson'),
  };
}

/**
 * One spawn record. `start` is the only event that `summarizeSpawns` counts, so
 * it is the shape a reader actually acts on.
 * @param {string} marker - Identifies which root or child wrote the line.
 * @returns {object} Writer input.
 */
function spawnRecord(marker) {
  return {
    event: 'start',
    sessionId: 'sess-spawn-coloc-0001',
    agentId: marker,
    agentName: marker,
    agentType: 'tdd-guide',
    requestedModel: 'opus',
    canonicalModel: 'opus',
  };
}

describe('G1 — two roots of one repository append to ONE spawn file', () => {
  it('returns the same path from both roots and reads both records from either', () => {
    const { mainRoot, wtRoot, shared } = makePair('g1');

    const fromMain = appendSpawn(mainRoot, spawnRecord('g1-main'));
    const fromWorktree = appendSpawn(wtRoot, spawnRecord('g1-worktree'));

    expect(fromMain.ok).toBe(true);
    expect(fromWorktree.ok).toBe(true);
    expect(fromWorktree.path).toBe(fromMain.path);
    expect(fromMain.path).toBe(shared);
    expect(existsSync(shared)).toBe(true);

    // Counted from BOTH sides: one file is only interesting if each root can
    // see the other's line, which is the property `/doctor` Check 10 needs.
    expect(readSpawns(mainRoot).map((r) => r.agentId)).toEqual(['g1-main', 'g1-worktree']);
    expect(readSpawns(wtRoot).map((r) => r.agentId)).toEqual(['g1-main', 'g1-worktree']);

    // Negative control: no root grew a private copy, at either of the two
    // spellings a divergent writer could pick. `.artibot/ledger` is named
    // explicitly because it is where the PRE-W5-b-6 code wrote.
    expect(existsSync(path.join(wtRoot, '.artibot', 'ledger'))).toBe(false);
    expect(existsSync(path.join(wtRoot, '.artibot', 'runtime'))).toBe(false);
    expect(existsSync(path.join(mainRoot, '.artibot', 'ledger'))).toBe(false);
  });
});

describe('G2 — a root with no `.git` keeps the fallback location', () => {
  it('resolves to `<root>/.artibot/runtime/spawns.ndjson` and writes there', () => {
    const root = tmpRoot('g2');
    const expected = path.join(root, '.artibot', 'runtime', 'spawns.ndjson');

    // The literal is the assertion. Every tmpdir fixture in this repo depends
    // on this branch staying exactly where it is.
    expect(spawnLedgerPath(root)).toBe(expected);
    expect(resolveGitCommonDir(root)).toBeNull();

    const res = appendSpawn(root, spawnRecord('g2-fallback'));
    expect(res.ok).toBe(true);
    expect(res.path).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(readSpawns(root).map((r) => r.agentId)).toEqual(['g2-fallback']);
  });
});

describe('G3 — one rule, not two copies of one rule', () => {
  it('puts the spawn ledger in the run ledger\'s directory for all three root shapes', () => {
    // (a) An ordinary checkout: a bare `.git` DIRECTORY is all the resolver needs.
    const gitRoot = tmpRoot('g3-git');
    mkdirSync(path.join(gitRoot, '.git'), { recursive: true });

    // (b) A synthetic LINKED worktree, where the two-branch rule has to follow
    //     a pointer file rather than stat a directory.
    const { mainRoot, wtRoot } = makePair('g3-wt');

    // (c) No `.git` anywhere — the fallback branch.
    const plainRoot = tmpRoot('g3-plain');

    for (const root of [gitRoot, mainRoot, wtRoot, plainRoot]) {
      expect(path.dirname(spawnLedgerPath(root))).toBe(path.dirname(ledgerFilePath(root)));
      // Same directory, DIFFERENT file: co-location is not collision.
      expect(path.basename(spawnLedgerPath(root))).toBe('spawns.ndjson');
      expect(spawnLedgerPath(root)).not.toBe(ledgerFilePath(root));
    }

    // Negative control: the shared rule is not vacuous — the two branches do
    // resolve to genuinely different directories, so "they always agree" is a
    // statement about the rule and not about a constant.
    expect(path.dirname(spawnLedgerPath(gitRoot)))
      .not.toBe(path.dirname(spawnLedgerPath(plainRoot)));
  });
});

/**
 * Whether a usable `git` is on PATH. G4 and G5's git-dir case do not need it,
 * but G4 cannot synthesize the layout it exists to check.
 * @type {boolean}
 */
let GIT_AVAILABLE = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  GIT_AVAILABLE = false;
}

describe.skipIf(!GIT_AVAILABLE)('G4 — the same holds for a real `git worktree add`', () => {
  // An INDEPENDENT throwaway repository under the OS temp dir: `git worktree
  // add` mutates the repository it runs in, so every call below passes an
  // explicit cwd inside `tmp` and none may touch the Artibot checkout.
  const run = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  let tmp = null;
  let mainRoot = null;
  let wtRoot = null;

  beforeAll(() => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-spawn-coloc-g4-')));
    mainRoot = path.join(tmp, 'main');
    wtRoot = path.join(tmp, 'wt');
    mkdirSync(mainRoot, { recursive: true });
    run(['init', '-q'], mainRoot);
    run(['-c', 'user.email=g4@test.invalid', '-c', 'user.name=g4',
      'commit', '-q', '--allow-empty', '-m', 'root'], mainRoot);
    run(['worktree', 'add', '-q', '-b', 'spawn-coloc-g4-wt', wtRoot], mainRoot);
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

  it('writes both roots\' spawn records into one real file under <main>/.git/artibot', () => {
    const fromMain = appendSpawn(mainRoot, spawnRecord('g4-main'));
    const fromWorktree = appendSpawn(wtRoot, spawnRecord('g4-worktree'));

    expect(fromMain.ok).toBe(true);
    expect(fromWorktree.ok).toBe(true);
    expect(norm(fromWorktree.path)).toBe(norm(fromMain.path));
    expect(norm(fromMain.path))
      .toBe(norm(path.join(mainRoot, '.git', 'artibot', 'spawns.ndjson')));
    expect(existsSync(fromMain.path)).toBe(true);
    expect(existsSync(path.join(wtRoot, '.artibot', 'runtime', 'spawns.ndjson'))).toBe(false);
    expect(existsSync(path.join(wtRoot, '.artibot', 'ledger', 'spawns.ndjson'))).toBe(false);

    expect(readSpawns(mainRoot).map((r) => r.agentId)).toEqual(['g4-main', 'g4-worktree']);
    expect(readSpawns(wtRoot).map((r) => r.agentId)).toEqual(['g4-main', 'g4-worktree']);
  });
});

/**
 * The child program. Appends `LINES_PER_PROCESS` records as fast as it can, so
 * the eight copies overlap rather than politely taking turns. Each record's
 * `agentId` is a distinct `p<i>:<j>` marker, which is how survival is judged:
 * spawn records carry no dedupe key, so 160 DISTINCT markers is the only way to
 * tell "nothing was lost" from "a line was written twice".
 *
 * The argv is destructured rather than read through `process.argv[1]`, because
 * `tests/ci/direct-run-guard.test.js`'s scanner has fired on that string inside
 * a probe source before (#64).
 * @type {string}
 */
const CHILD_SOURCE = `
import { appendSpawn } from ${JSON.stringify(SPAWN_MODULE)};

const [, , root, label] = process.argv;
let written = 0;
for (let i = 0; i < ${LINES_PER_PROCESS}; i += 1) {
  const res = appendSpawn(root, {
    event: 'start',
    sessionId: 'sess-spawn-survival',
    agentId: label + ':' + i,
    agentName: label,
    agentType: 'tdd-guide',
    requestedModel: 'opus',
    canonicalModel: 'opus',
  });
  if (res.ok) written += 1;
}
process.stdout.write(String(written));
`;

/**
 * Run one child to completion.
 * @param {string} script - Absolute path to the child program.
 * @param {string} root - Project root the child resolves on its own.
 * @param {string} label - Child identity, embedded in every record it writes.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} Outcome.
 */
function runChild(script, root, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, root, label], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('G5 — concurrent spawn append across real processes', () => {
  for (const store of STORES) {
    const expected = PROCESSES * LINES_PER_PROCESS;

    it(`keeps ${expected} of ${expected} records written by ${PROCESSES} processes `
      + `into the ${store} location`, async () => {
      const root = tmpRoot(`g5-${store}`);
      if (store === 'git-common-dir') {
        // A bare `.git` DIRECTORY is all `resolveGitCommonDir` needs, and it is
        // what every non-worktree checkout has. The children are never told the
        // resolved path — each one resolves `root` on its own, so this also
        // measures that 8 independent processes agree on one file.
        mkdirSync(path.join(root, '.git'), { recursive: true });
      }
      // Self-check: the case is measuring the location it claims to. Without it
      // a resolver change could quietly move both rows onto one path and the
      // titles would lie.
      const target = spawnLedgerPath(root);
      expect(target).toBe(store === 'git-common-dir'
        ? path.join(root, '.git', 'artibot', 'spawns.ndjson')
        : path.join(root, '.artibot', 'runtime', 'spawns.ndjson'));

      const script = path.join(root, 'spawn-append-child.mjs');
      writeFileSync(script, CHILD_SOURCE, 'utf-8');

      const results = await Promise.all(
        Array.from({ length: PROCESSES }, (unused, i) => runChild(script, root, `p${i}`)),
      );
      for (const r of results) {
        expect(r.stderr).toBe('');
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(String(LINES_PER_PROCESS));
      }

      // (1) Nothing was lost, and nothing was torn: every surviving line is
      //     still parseable on its own. `readSpawns` SKIPS corrupt lines
      //     silently, so the raw count is checked first — otherwise a torn line
      //     would look like a missing one and the two failures would be
      //     indistinguishable.
      const raw = readFileSync(target, 'utf-8').split('\n').filter((l) => l.length > 0);
      expect(raw).toHaveLength(expected);

      const records = readSpawns(root);
      expect(records).toHaveLength(expected);

      // (2) 160 DISTINCT markers. Spawn records have no dedupe key, so this is
      //     what stands in for one: a duplicated line and a lost line both
      //     shrink this set, and step (1) already separated the two cases.
      const ids = new Set(records.map((r) => r.agentId));
      expect(ids.size).toBe(expected);

      // (3) Each process contributed a complete, gapless 0..19 run — a stronger
      //     statement than "160 of something", since 160 distinct markers could
      //     in principle come from an uneven split.
      const byChild = new Map();
      for (const rec of records) {
        const [label, seq] = String(rec.agentId).split(':');
        if (!byChild.has(label)) byChild.set(label, []);
        byChild.get(label).push(Number(seq));
      }
      expect(byChild.size).toBe(PROCESSES);
      for (const seqs of byChild.values()) {
        expect([...seqs].sort((a, b) => a - b))
          .toEqual(Array.from({ length: LINES_PER_PROCESS }, (unused, i) => i));
      }
    });
  }
});
