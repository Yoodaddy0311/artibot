import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  blocked, cleanup, git, makeDir, makeRepo, runReviewStop,
} from './_gate-state-harness.js';

/**
 * O2 — the review gate's loop-guard memory (`last-review-gate-sha.txt`) belongs
 * to ONE working tree and outlives a plugin update.
 *
 * WHAT THE FILE IS FOR. `stop-review-gate.js` blocks a Stop that has review
 * issues, and remembers the `repo|HEAD|changed files` fingerprint it blocked on,
 * so the same persistent issue does not block every later Stop of the same
 * state (`stop_hook_active` only covers the immediate retry). It is a per-TREE
 * fact: the fingerprint names one repository root.
 *
 * THE DEFECT, MEASURED BEFORE THE FIX. The memory was ONE file in the versioned
 * plugin directory, shared by every project. Project A's block, then project
 * B's block, then A's next Stop over the SAME state: B had overwritten the
 * slot, so A blocked again — the loop the guard exists to stop, now reintroduced
 * by working in two projects (or two `/split` worktrees) at once. And a plugin
 * update started every tree over.
 *
 * The fingerprint embeds the repository root, so a foreign value never SUPPRESSES
 * a block; the defect is over-blocking, not under-blocking. That is why the
 * CONTROL below matters: it shows the suppression path itself is alive, so the
 * cases that expect silence are not silent because the gate cannot run.
 *
 * WHAT THESE CANNOT SEE: which persisted issue classes real sessions hit (the
 * fixture's issue is a `console.log` plus a missing test), and the gate's
 * `node --check`/pattern scans beyond that one file.
 */

/** @type {string[]} */
const created = [];
afterEach(() => cleanup(created));

let counter = 0;
const sid = (label) => `rev-${label}-${process.pid}-${Date.now()}-${(counter += 1)}`;

/** A repo whose last commit adds a file the review gate flags. */
const flaggedRepo = (label) => makeRepo(created, label, { dirty: false, extraCommit: true });

describe('O2 — stop-review-gate keeps its loop-guard memory per working tree', () => {
  it('CONTROL: the first Stop over a flagged state blocks, an identical second Stop does not', () => {
    const plugin = makeDir(created, 'plugin');
    const repo = flaggedRepo('ctl');

    const first = runReviewStop(repo, plugin, sid('ctl'));
    const second = runReviewStop(repo, plugin, sid('ctl'));

    expect(blocked(first.stdout), `first. stdout=${first.stdout} stderr=${first.stderr}`).toBe(true);
    expect(first.stdout).toContain('Review gate found');
    expect(blocked(second.stdout), `second. stdout=${second.stdout} stderr=${second.stderr}`).toBe(false);
  }, 120_000);

  it('judges the project the payload names, not the directory the process happens to run in', () => {
    const plugin = makeDir(created, 'plugin');
    const repo = flaggedRepo('pcwd');
    const elsewhere = makeDir(created, 'elsewhere');

    // The sibling Stop gate (dev-verify-gate) roots on the payload `cwd`; the two
    // gates answer the same Stop and must be talking about the same repository.
    const run = runReviewStop(repo, plugin, sid('pcwd'), { processCwd: elsewhere });

    expect(blocked(run.stdout), `stdout=${run.stdout} stderr=${run.stderr}`).toBe(true);
    expect(run.stdout).toContain('Review gate found');
  }, 120_000);

  it('leaves no gate state behind when there is nothing to remember', () => {
    const plugin = makeDir(created, 'plugin');
    // One commit and a clean tree: no changed files, so the gate approves before
    // it has any fingerprint to keep.
    const repo = makeRepo(created, 'clean', { dirty: false });

    // `expectChanges: false` — this case EXPECTS "no changes to review".
    const run = runReviewStop(repo, plugin, sid('clean'), { expectChanges: false });

    expect(run.status, `stderr=${run.stderr}`).toBe(0);
    expect(blocked(run.stdout)).toBe(false);
    expect(existsSync(path.join(repo, '.git', 'artibot', 'gates')), 'gates/ under the store').toBe(false);
    expect(existsSync(path.join(plugin, 'runtime')), 'runtime/ under the plugin root').toBe(false);
  }, 120_000);

  it('project B blocking in between does not make project A block again over the same state', () => {
    const plugin = makeDir(created, 'plugin');
    const projectA = flaggedRepo('a');
    const projectB = flaggedRepo('b');

    const a1 = runReviewStop(projectA, plugin, sid('a'));
    const b1 = runReviewStop(projectB, plugin, sid('b'));
    const a2 = runReviewStop(projectA, plugin, sid('a'));

    expect(blocked(a1.stdout), `A1. stdout=${a1.stdout} stderr=${a1.stderr}`).toBe(true);
    expect(blocked(b1.stdout), `B1 is a different tree and blocks on its own. stdout=${b1.stdout}`).toBe(true);
    expect(blocked(a2.stdout), `A2. stdout=${a2.stdout} stderr=${a2.stderr}`).toBe(false);
  }, 180_000);

  it('the memory survives a plugin update (each plugin version is its own directory)', () => {
    const pluginV1 = makeDir(created, 'plugin-v1');
    const pluginV2 = makeDir(created, 'plugin-v2');
    const repo = flaggedRepo('upd');

    const before = runReviewStop(repo, pluginV1, sid('upd'));
    const after = runReviewStop(repo, pluginV2, sid('upd'));

    expect(blocked(before.stdout), `before. stdout=${before.stdout} stderr=${before.stderr}`).toBe(true);
    expect(blocked(after.stdout), `after. stdout=${after.stdout} stderr=${after.stderr}`).toBe(false);
  }, 120_000);

  it('two worktrees of one repository each remember their own block', () => {
    const plugin = makeDir(created, 'plugin');
    const main = flaggedRepo('main');
    const wt = path.join(makeDir(created, 'wt-parent'), 'wt');
    git(['worktree', 'add', '-q', wt, '-b', `gate-it-rev-${process.pid}-${Date.now()}`], main);

    // Both trees sit at the same commit, so both have the same issue — and both
    // share one git common directory, the store's F3 location. A memory keyed
    // by repository (not by tree) would let each worktree's block evict the
    // other's, and the third Stop below would block again.
    const m1 = runReviewStop(main, plugin, sid('m'));
    const w1 = runReviewStop(wt, plugin, sid('w'));
    const m2 = runReviewStop(main, plugin, sid('m'));
    const w2 = runReviewStop(wt, plugin, sid('w'));

    expect(blocked(m1.stdout), `m1. stdout=${m1.stdout} stderr=${m1.stderr}`).toBe(true);
    expect(blocked(w1.stdout), `w1. stdout=${w1.stdout} stderr=${w1.stderr}`).toBe(true);
    expect(blocked(m2.stdout), `m2. stdout=${m2.stdout} stderr=${m2.stderr}`).toBe(false);
    expect(blocked(w2.stdout), `w2. stdout=${w2.stdout} stderr=${w2.stderr}`).toBe(false);
  }, 240_000);

  it('a real new edit after a block still blocks again (the mtime half of the guard is intact)', () => {
    const plugin = makeDir(created, 'plugin');
    const repo = flaggedRepo('edit');
    const session = sid('e');

    expect(blocked(runReviewStop(repo, plugin, session).stdout)).toBe(true);

    // Same fingerprint — the changed-file list comes from the COMMITS
    // (`HEAD~1..HEAD`), which a working-tree edit does not alter — but a flagged
    // file is newer than the remembered block. The guard must not call that
    // "already seen". The mtime is set explicitly (+5 s) so the case measures the
    // guard, not this filesystem's timestamp resolution.
    const widget = path.join(repo, 'plugins', 'artibot', 'lib', 'widget.js');
    const later = new Date(Date.now() + 5_000);
    writeFileSync(widget, `${readFileSync(widget, 'utf-8')}// edited again\n`);
    utimesSync(widget, later, later);
    const again = runReviewStop(repo, plugin, session);

    expect(blocked(again.stdout), `stdout=${again.stdout} stderr=${again.stderr}`).toBe(true);
  }, 120_000);
});
