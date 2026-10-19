/**
 * `scripts/split/dispatch.mjs` x the user-level SH-11 switch — the wiring.
 *
 * `dispatch` is the ONE production caller that injects a `config` into the key
 * readers (it loads it once with `loadConfig()` and hands the same object to the
 * lane write and the feeder, so the three cannot disagree). An injected config is
 * the whole answer for `missionBindingEnabled`, so unless dispatch lays the user
 * switch file over the config it loads, a switch the owner turned ON in
 * `~/.claude/artibot/split-mission-binding.json` would be honoured by every CLI
 * that reads the key itself (`lane-state`, the lease sync) and ignored by the one
 * command that WRITES the binding — no run would ever be bound. This file
 * measures that wiring (`task-feed-user-switch.test.js` owns the file's own
 * semantics).
 *
 * Every test here writes the REAL default location of the switch file, so the
 * suite refuses to run unless the artibot state directory is a tmp dir (the
 * plugin's vitest setup redirects it; the repo-root config does not).
 *
 * WHAT THIS CANNOT SEE (rules section 9): a live host — the one end-to-end test
 * below is the done-condition's shape (dispatch binds, a lane write goes to the
 * node, `--list` reads the node) against a tmp store, not a live bound run; none
 * exists yet. And a real `/update` between the steps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetConfig, resolveArtibotDir } from '../../lib/core/config.js';
import { readRunJson } from '../../lib/git/split-run-file.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { readMissionBindingEnabled } from '../../lib/topology/split-state-sources.js';
import * as dispatch from '../../scripts/split/dispatch.mjs';
import { readLaneStates, setLaneState } from '../../scripts/split/lane-state.mjs';
import { USER_BINDING_SWITCH_FILE, userBindingSwitchPath } from '../../scripts/split/task-feed.mjs';

const SID = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20261019-Sabcd1234';
const ON = { split: { missionBinding: { enabled: true } } };
const OFF = { split: { missionBinding: { enabled: false } } };

const made = [];
let parent;
let pluginRoot;

/** A parent root with plan.json and one limb brief — the minimum dispatch needs (see dispatch-task-feed.test.js). */
function seedParent(limb = 'auth') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-dispatch-switch-'));
  made.push(dir);
  const splitDir = path.join(dir, '.artibot', 'split');
  const worktreePath = path.join(dir, '.claude', 'worktrees', `split-demo-${limb}`);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(path.join(splitDir, limb), { recursive: true });
  fs.writeFileSync(path.join(splitDir, limb, 'brief.md'), `# ${limb}\n\n## 소유 파일 allowlist\n- src/${limb}\n\n## 완료 기준\n- tests\n`);
  fs.writeFileSync(path.join(splitDir, 'plan.json'), JSON.stringify({
    runId: 'split-abc123',
    parentRoot: dir,
    repoShort: 'demo',
    base: 'deadbeef',
    parentSession: 'demo-a1',
    limbs: [{ limb, worktreePath, branch: `worktree-split-demo-${limb}`, affectedPaths: [`src/${limb}`] }],
  }, null, 2));
  return dir;
}

/** What the installer put at the plugin root, reached through CLAUDE_PLUGIN_ROOT (the variable loadConfig() honours). */
function shipConfig(cfg) {
  fs.writeFileSync(path.join(pluginRoot, 'artibot.config.json'), JSON.stringify(cfg));
  resetConfig();
}

const writeSwitch = (value) => fs.writeFileSync(userBindingSwitchPath(), typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(() => {
  const state = path.resolve(resolveArtibotDir()).toLowerCase();
  if (!state.startsWith(path.resolve(os.tmpdir()).toLowerCase())) {
    throw new Error(`refusing to run: the artibot state dir (${state}) is not a tmp dir, so the switch file this suite writes would land in a real home`);
  }
  fs.mkdirSync(path.dirname(userBindingSwitchPath()), { recursive: true });
  fs.rmSync(userBindingSwitchPath(), { force: true });
  pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-dispatch-switch-plugin-'));
  made.push(pluginRoot);
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot);
  resetConfig();
  parent = seedParent();
});
afterEach(() => {
  fs.rmSync(userBindingSwitchPath(), { force: true });
  vi.unstubAllEnvs();
  resetConfig();
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

/** Run dispatch with NO injected config (so it loads the shipped one) and a feeder stub that records what it was handed. */
async function dispatchSeen(extra = {}) {
  /** @type {{ args: any, ports: any }|null} */ let seen = null;
  await dispatch.runDispatch(dispatch.parseArgs(['auth']), {
    cwd: parent,
    feedLimb: (args, ports) => { seen = { args, ports }; return { fed: false, skipped: 'stub' }; },
    ...extra,
  });
  return seen;
}

describe('dispatch.mjs derives `bind` and the forwarded config from the key WITH the user switch laid over it', () => {
  it('file true over a shipped false: the feeder is asked to bind, and the config it is handed says ON', async () => {
    shipConfig(OFF);
    writeSwitch({ enabled: true });
    const seen = await dispatchSeen();
    expect(seen.args.bind).toBe(true);
    expect(readMissionBindingEnabled(seen.ports.config)).toBe(true);
  });

  it('CONTROL — no file: the shipped false binds nothing, and the forwarded config is the loaded one', async () => {
    shipConfig(OFF);
    const seen = await dispatchSeen();
    expect(seen.args.bind).toBe(false);
    expect(readMissionBindingEnabled(seen.ports.config)).toBe(false);
  });

  it('file false over a shipped true: a local kill switch — nothing is bound', async () => {
    shipConfig(ON);
    writeSwitch({ enabled: false });
    const seen = await dispatchSeen();
    expect(seen.args.bind).toBe(false);
    expect(readMissionBindingEnabled(seen.ports.config)).toBe(false);
  });

  it('an unusable file reads OFF over a shipped true', async () => {
    shipConfig(ON);
    writeSwitch('{ nope');
    const seen = await dispatchSeen();
    expect(seen.args.bind).toBe(false);
    expect(readMissionBindingEnabled(seen.ports.config)).toBe(false);
  });

  it('an INJECTED config is not touched by the file: tests and tools that pass one keep meaning what they say', async () => {
    writeSwitch({ enabled: true });
    expect((await dispatchSeen({ config: OFF })).args.bind).toBe(false);
    expect((await dispatchSeen({ config: null })).args.bind).toBe(false);
    writeSwitch({ enabled: false });
    expect((await dispatchSeen({ config: ON })).args.bind).toBe(true);
  });

  it('the file survives what /update does to the plugin root: the shipped config is rewritten, the dispatch still binds', async () => {
    shipConfig(OFF);
    writeSwitch({ enabled: true });
    expect((await dispatchSeen()).args.bind).toBe(true);
    shipConfig({ ...OFF, version: '9.9.9' }); // the next release's copy
    expect((await dispatchSeen()).args.bind).toBe(true);
  });
});

describe('the done-condition\'s shape, against a tmp store: dispatch binds, a lane write goes to the node, --list reads the node', () => {
  it('first dispatch binds the run; lane-state review and done are store commits; --list answers from the node while run.json is rolled back', async () => {
    shipConfig(OFF); // as shipped: the only thing turning it ON is the user file
    writeSwitch({ enabled: true });
    const store = createStateStore({ projectRoot: parent, sessionId: SID, renderProjectionFile: false, appendEvent: () => ({ ok: true }) });
    expect(store.updateMission(MISSION, () => ({ status: 'executing', intent: { path: 'i.md', revision: 1 }, plan: { path: 'p.md', revision: 1 } }), { reason: 'test.seed' }).ok).toBe(true);
    const seams = { cwd: parent, sessionId: SID, openStore: () => store };

    // 1. dispatch: the lane is written (legacy — no record exists yet), then the feed binds.
    const first = await dispatch.runDispatch(dispatch.parseArgs(['auth']), seams);
    expect(first.taskFeed).toMatchObject({ fed: true, claim: 'bound:node', binding: { status: 'created', mission_id: MISSION } });
    const plan = JSON.parse(fs.readFileSync(path.join(parent, '.artibot', 'split', 'plan.json'), 'utf-8'));
    expect(plan.missionBinding).toMatchObject({ mission_id: MISSION, run_id: 'split-abc123', generation: 1 });

    // 2. lane-state review: the CLI reads the same key (no config injected) and writes the node.
    const review = setLaneState({ limb: 'auth', state: 'review' }, { ...seams, now: () => new Date('2026-10-19T06:00:00.000Z') });
    expect(review).toMatchObject({ source: 'store', missionId: MISSION, previous: 'active', state: 'review' });
    const afterReview = readRunJson(parent);

    // 3. lane-state done.
    const done = setLaneState({ limb: 'auth', state: 'done' }, { ...seams, now: () => new Date('2026-10-19T07:00:00.000Z') });
    expect(done).toMatchObject({ source: 'store', previous: 'review', state: 'done' });
    expect(store.getTaskGraph(MISSION).tasks.find((t) => t.id === 'auth')).toMatchObject({ status: 'done', ops: { state: 'done' } });

    // 4. --list is the node: roll run.json back to the earlier projection and the table still says done.
    fs.writeFileSync(path.join(parent, '.artibot', 'split', 'run.json'), JSON.stringify(afterReview));
    expect(readRunJson(parent).lanes.auth.state).toBe('review');
    const listed = readLaneStates(seams);
    expect(listed.binding).toMatchObject({ status: 'bound', mission_id: MISSION });
    expect(listed.rows.find((r) => r.limb === 'auth')).toMatchObject({ state: 'done', source: 'store' });
  });

  it('CONTROL — the same steps with no file bind nothing and leave every lane on run.json', async () => {
    shipConfig(OFF);
    const store = createStateStore({ projectRoot: parent, sessionId: SID, renderProjectionFile: false, appendEvent: () => ({ ok: true }) });
    expect(store.updateMission(MISSION, () => ({ status: 'executing', intent: { path: 'i.md', revision: 1 }, plan: { path: 'p.md', revision: 1 } }), { reason: 'test.seed' }).ok).toBe(true);
    const seams = { cwd: parent, sessionId: SID, openStore: () => store };
    const first = await dispatch.runDispatch(dispatch.parseArgs(['auth']), seams);
    expect(first.taskFeed).toMatchObject({ fed: true, claim: 'claimed' });
    expect(JSON.parse(fs.readFileSync(path.join(parent, '.artibot', 'split', 'plan.json'), 'utf-8')).missionBinding).toBeUndefined();
    const review = setLaneState({ limb: 'auth', state: 'review' }, seams);
    expect(review.source).toBeUndefined();
    expect(readRunJson(parent).lanes.auth.projected_from).toBe('run.json');
    expect(readLaneStates(seams).binding).toBeNull();
  });
});

describe('the suite\'s own guard', () => {
  it('writes only to the default location of the switch file, which is the (tmp) artibot state dir root', () => {
    expect(path.dirname(userBindingSwitchPath())).toBe(path.resolve(resolveArtibotDir()));
    expect(path.basename(userBindingSwitchPath())).toBe(USER_BINDING_SWITCH_FILE);
  });
});
