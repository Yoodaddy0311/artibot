/**
 * `scripts/split/dispatch.mjs` x the Task Graph feeder — the wiring only.
 *
 * `tests/scripts/split-tools.test.js` owns dispatch's rendering, lane state and
 * fork point; `tests/scripts/task-feed.test.js` owns what the feeder does to a
 * real store. This file measures the ONE property that belongs to neither:
 * that the feeder is record-only at the dispatch seam — the exit code, the
 * existing output keys and every file dispatch writes are the same whether the
 * feed succeeds, skips, or throws.
 *
 * Kept separate from `split-tools.test.js` because that file is already 900
 * lines, and the stem rule gives `dispatch*` its own coverage file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dispatch from '../../scripts/split/dispatch.mjs';

/** Exactly the ten keys `--json` printed before the feeder existed. */
const PRE_FEED_KEYS = ['briefPath', 'copied', 'dryRun', 'forkPoint', 'laneState', 'limb', 'pointer', 'promptPath', 'siblings', 'to'];

let parent;

/** A parent root with plan.json and one limb brief — the minimum dispatch needs. */
function seedParent(limb = 'auth') {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-dispatch-feed-'));
  const splitDir = path.join(parent, '.artibot', 'split');
  const worktreePath = path.join(parent, '.claude', 'worktrees', `split-demo-${limb}`);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(path.join(splitDir, limb), { recursive: true });
  fs.writeFileSync(path.join(splitDir, limb, 'brief.md'), `# ${limb}\n\n## 소유 파일 allowlist\n- src/${limb}\n\n## 완료 기준\n- tests\n`);
  fs.writeFileSync(path.join(splitDir, 'plan.json'), JSON.stringify({
    runId: 'split-abc123',
    parentRoot: parent,
    repoShort: 'demo',
    base: 'deadbeef',
    parentSession: 'demo-a1',
    limbs: [{ limb, worktreePath, branch: `worktree-split-demo-${limb}`, affectedPaths: [`src/${limb}`] }],
  }, null, 2));
  return { parent, worktreePath };
}

/** Collect stdout/stderr the way `main` writes them. */
const collect = () => {
  const out = []; const err = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, stdout: () => out.join(''), stderr: () => err.join('') };
};

beforeEach(() => { seedParent(); });
afterEach(() => { fs.rmSync(parent, { recursive: true, force: true }); });

describe('dispatch.mjs — the feeder is wired and record-only', () => {
  it('passes the parent root, the parsed plan and the limb, and returns the result verbatim', async () => {
    /** @type {any} */ let seen = null;
    const feed = { fed: true, skipped: null, missionId: 'M-20260921-Sabcd1234', taskId: 'auth', added: ['auth'], refreshed: [], claim: 'claimed' };
    const r = await dispatch.runDispatch(dispatch.parseArgs(['auth']), {
      cwd: parent, config: null, feedLimb: (a) => { seen = a; return feed; },
    });
    expect(seen.parentRoot).toBe(parent);
    expect(seen.limb).toBe('auth');
    expect(seen.dryRun).toBe(false);
    expect(seen.plan.limbs[0].affectedPaths).toEqual(['src/auth']);
    expect(r.taskFeed).toEqual(feed);
  });

  it('--dry-run reaches the feeder with dryRun true — the feeder is what refuses to write', async () => {
    /** @type {any} */ let seen = null;
    await dispatch.runDispatch(dispatch.parseArgs(['auth', '--dry-run']), {
      cwd: parent, config: null, feedLimb: (a) => { seen = a; return { fed: false, skipped: 'dry-run' }; },
    });
    expect(seen.dryRun).toBe(true);
  });

  it('a skipped feed leaves every other key and the written files exactly as they were', async () => {
    const opts = { cwd: parent, config: null };
    const fedRoot = parent;
    const fed = await dispatch.runDispatch(dispatch.parseArgs(['auth']), { ...opts, feedLimb: () => ({ fed: true, claim: 'claimed' }) });
    const promptFedBytes = fs.statSync(fed.promptPath).size;

    fs.rmSync(fedRoot, { recursive: true, force: true });
    seedParent();
    const skippedRun = await dispatch.runDispatch(dispatch.parseArgs(['auth']), { ...opts, cwd: parent, feedLimb: () => ({ fed: false, skipped: 'no-mission' }) });

    // Everything naming the tmp root is blanked — the two runs use different
    // `mkdtemp` directories, and the property under test is the SHAPE.
    const norm = (o) => ({
      ...o, taskFeed: null, pointer: '', promptPath: '', briefPath: '', prompt: '', siblings: [],
      forkPoint: { ...o.forkPoint, reason: typeof o.forkPoint.reason === 'string' ? 'reason' : o.forkPoint.reason },
    });
    expect(norm(skippedRun)).toEqual(norm(fed));
    // Byte length, not bytes: the prompt embeds the tmp root and its derived
    // project slug, which differ per `mkdtemp`. The roots are the same length,
    // so a rendering that dropped or added anything would move this number.
    expect(fs.statSync(skippedRun.promptPath).size).toBe(promptFedBytes);
    expect(skippedRun.laneState.state).toBe('active');
  });

  it('the feeder runs AFTER the lane write, so a feed that throws cannot lose run.json', async () => {
    // Defensive: `feedLimb` is documented as never throwing, and this is the
    // assertion that the dispatch seam does not depend on that promise being
    // kept. A throw surfaces as exit 1 — but only after every file is written.
    const runPath = path.join(parent, '.artibot', 'split', 'run.json');
    const c = collect();
    const code = await dispatch.main(['auth', '--json'], {
      cwd: parent, config: null, ...c.io, feedLimb: () => { throw new Error('feeder blew up'); },
    });
    expect(code).toBe(1);
    expect(JSON.parse(c.stdout()).error).toMatch(/feeder blew up/);
    expect(JSON.parse(fs.readFileSync(runPath, 'utf-8')).lanes.auth.state).toBe('active');
  });

  it('--json adds taskFeed and removes nothing', async () => {
    const c = collect();
    expect(await dispatch.main(['auth', '--json'], {
      cwd: parent, config: null, ...c.io, feedLimb: () => ({ fed: false, skipped: 'no-session-id' }),
    })).toBe(0);
    const parsed = JSON.parse(c.stdout());
    expect(Object.keys(parsed).sort()).toEqual([...PRE_FEED_KEYS, 'taskFeed'].sort());
    for (const key of PRE_FEED_KEYS) expect(Object.hasOwn(parsed, key)).toBe(true);
    expect(parsed.taskFeed).toEqual({ fed: false, skipped: 'no-session-id' });
  });

  it('the real feeder is the default port — dispatch works with no seam and still exits 0', async () => {
    const c = collect();
    // No `feedLimb` injected: the production `task-feed.mjs` runs against a tmp
    // parent with no mission row. Which skip reason it gives depends on whether
    // the host session id leaks into `process.env` (measured 2026-09-21), so
    // only the record-only contract is pinned, not the reason.
    expect(await dispatch.main(['auth', '--json'], { cwd: parent, config: null, ...c.io })).toBe(0);
    const parsed = JSON.parse(c.stdout());
    expect(parsed.taskFeed.fed).toBe(false);
    expect(typeof parsed.taskFeed.skipped).toBe('string');
    expect(parsed.laneState.state).toBe('active');
  });
});
