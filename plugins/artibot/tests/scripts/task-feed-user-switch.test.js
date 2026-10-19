/**
 * SH-11 pre-flip item 5 — WHERE the canary key lives.
 *
 * `split.missionBinding.enabled` was read from ONE place, `<pluginRoot>/
 * artibot.config.json` (`task-feed.mjs#readShippedConfigSync`). In production
 * the plugin root is a version-scoped cache directory and the installers copy
 * the shipped `artibot.config.json` over it (and over the marketplace copy and
 * `~/.claude/artibot/artibot.config.json`) on every install, so a value an owner
 * turned ON in the installed copy was put back to the shipped `false` by the
 * next `/update` — quietly: nothing failed, runs just stopped being bound. The
 * same reason `model-routing.json` does not live in that config
 * (`lib/core/model-overrides.js`).
 *
 * The durable place is a separate user file at the ROOT of the artibot state
 * directory (`resolveArtibotDir()`, `~/.claude/artibot`):
 * `split-mission-binding.json` = `{ "enabled": true | false }`. The installers
 * copy three root files by name and mirror five subdirectories; they name
 * neither this file nor a glob over the root. Precedence, fail-closed:
 *
 *   a well-formed file decides (true ON, false OFF — a local kill switch that
 *   outlives a release that ships ON); an ABSENT file leaves the shipped value in
 *   charge; a file that is THERE but cannot be read as `{ enabled: boolean }`
 *   reads OFF, whatever the shipped value says (an intent we cannot read must not
 *   leave a behaviour change on).
 *
 * An INJECTED `config` is the whole answer and the file is not consulted — the
 * test seam keeps meaning what it says, and `null` stays "no config = off". The
 * one production injector, `dispatch.mjs`, applies the file to the config it
 * loads (`applyUserBindingSwitch`; measured in dispatch-user-switch.test.js), so
 * the four readers of the key cannot disagree.
 *
 * WHAT THIS CANNOT SEE (rules section 9): a real `/update`. That the file
 * survives one is read from `install.sh` / `install.ps1` (root files copied by
 * name, subdirectories mirrored — no root glob) and from `model-routing.json`,
 * which sits in the same directory and outlived the 2026-10-13 install on the
 * machine this was written on; no installer was run here. Nor does it see a
 * host that sets `CLAUDE_PLUGIN_ROOT` somewhere unexpected, or the census
 * (`scripts/ledger/v51-census.mjs`) printing the SHIPPED value of the key rather
 * than the effective one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveArtibotDir } from '../../lib/core/config.js';
import { readRunJson, writeRunJson } from '../../lib/git/split-run-file.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { readLaneStates, setLaneState } from '../../scripts/split/lane-state.mjs';
import {
  applyUserBindingSwitch, feedLimb, missionBindingEnabled, readUserBindingSwitch, USER_BINDING_SWITCH_FILE, userBindingSwitchPath,
} from '../../scripts/split/task-feed.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SID = 'abcd1234-ef56-7890-1234-567890abcdef';
const MISSION = 'M-20261019-Sabcd1234';
const RUN = 'split-t';
const T1 = () => new Date('2026-10-19T05:00:00.000Z');
const ON = { split: { missionBinding: { enabled: true } } };
const OFF = { split: { missionBinding: { enabled: false } } };

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

let stateDir;
let pluginRoot;
beforeEach(() => {
  stateDir = tmp('artibot-user-switch-state-');
  pluginRoot = tmp('artibot-user-switch-plugin-');
  vi.stubEnv('CLAUDE_PLUGIN_ROOT', pluginRoot);
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
/** What the installer put at the plugin root. `null` = no file. */
const writeShipped = (cfg) => { if (cfg !== null) fs.writeFileSync(path.join(pluginRoot, 'artibot.config.json'), asText(cfg)); };
const writeSwitch = (text) => fs.writeFileSync(path.join(stateDir, USER_BINDING_SWITCH_FILE), asText(text));
const eff = (extra = {}) => missionBindingEnabled({ switchDir: stateDir, ...extra });

describe('readUserBindingSwitch — absent, set, or unusable', () => {
  it('no file, and no directory either, is `absent`', () => {
    expect(readUserBindingSwitch({ dir: stateDir })).toEqual({ status: 'absent' });
    expect(readUserBindingSwitch({ dir: path.join(stateDir, 'never-created') })).toEqual({ status: 'absent' });
  });

  it('a well-formed file is `set`, carrying the literal value', () => {
    writeSwitch({ enabled: true });
    expect(readUserBindingSwitch({ dir: stateDir })).toEqual({ status: 'set', enabled: true });
    writeSwitch({ enabled: false });
    expect(readUserBindingSwitch({ dir: stateDir })).toEqual({ status: 'set', enabled: false });
  });

  it('tolerates what a person editing it by hand leaves: a BOM, CRLF, indentation and a note key', () => {
    writeSwitch('﻿{\r\n  "enabled": true,\r\n  "note": "local wave 5"\r\n}\r\n');
    expect(readUserBindingSwitch({ dir: stateDir })).toEqual({ status: 'set', enabled: true });
  });

  it.each([
    ['malformed JSON', '{ nope'],
    ['an empty file', ''],
    ['an array', '[true]'],
    ['null', 'null'],
    ['a bare string', '"true"'],
    ['enabled as the string "true"', '{"enabled":"true"}'],
    ['enabled as 1', '{"enabled":1}'],
    ['enabled as null', '{"enabled":null}'],
    ['no enabled key', '{}'],
  ])('%s is `unusable`, with a reason', (_label, text) => {
    writeSwitch(text);
    const got = readUserBindingSwitch({ dir: stateDir });
    expect(got.status).toBe('unusable');
    expect(typeof got.reason).toBe('string');
    expect(got.reason).not.toBe('');
  });

  it('a directory sitting where the file should be is `unusable`, not absent and not a crash', () => {
    fs.mkdirSync(path.join(stateDir, USER_BINDING_SWITCH_FILE));
    expect(readUserBindingSwitch({ dir: stateDir }).status).toBe('unusable');
  });

  it('the default location is the artibot state directory ROOT — the directory the model-routing overrides use, not the plugin root', () => {
    expect(userBindingSwitchPath()).toBe(path.resolve(resolveArtibotDir(), USER_BINDING_SWITCH_FILE));
    expect(path.dirname(userBindingSwitchPath())).toBe(path.resolve(resolveArtibotDir()));
    expect(path.relative(PLUGIN_ROOT, userBindingSwitchPath()).startsWith('..')).toBe(true);
    expect(path.basename(userBindingSwitchPath())).not.toBe('artibot.config.json'); // the one name the installers overwrite there
  });

  it('neither installer names the file (so an install cannot copy over or prune it), and both still copy the shipped config by name', () => {
    for (const installer of ['install.sh', 'install.ps1']) {
      const text = fs.readFileSync(path.join(PLUGIN_ROOT, installer), 'utf-8');
      expect(text, installer).not.toContain('split-mission-binding');
      expect(text, installer).toContain('artibot.config.json');
    }
  });

  // The premise the file's location rests on, pinned as TEXT (the repo never runs the installer: a real install
  // overwrites ~/.claude). A mirror prunes whatever its destination holds that the source lacks, so if any
  // destination were the state dir ROOT, a root-level user file would go. None is: each is a named subdirectory.
  it('no directory mirror in either installer has the state dir root as its destination — only named subdirectories are replaced or pruned', () => {
    const sh = fs.readFileSync(path.join(PLUGIN_ROOT, 'install.sh'), 'utf-8');
    const shDestinations = [...sh.matchAll(/^\s*(?:atomic_replace_dir|safe_copy_dir)\s+"[^"]*"\s+("[^"]*")/gm)].map((m) => m[1]);
    expect(shDestinations.length, 'the scan must see the real mirrors (at least the five under ARTIBOT_DIR)').toBeGreaterThanOrEqual(5);
    for (const dst of shDestinations.filter((d) => /ARTIBOT_DIR|mkt_root|v_root/.test(d))) expect(dst).toMatch(/^"\$\{(?:ARTIBOT_DIR|mkt_root|v_root)\}\/\S+"$/);

    const ps = fs.readFileSync(path.join(PLUGIN_ROOT, 'install.ps1'), 'utf-8');
    // `Copy-Tree` appends the leaf of the source to the root it is given, and the two cache mirrors join root + leaf.
    expect(ps).toMatch(/function Copy-Tree \{[\s\S]*?\$target = Join-Path \$DstDir \(Split-Path -Leaf \$SrcDir\)/);
    const mirrors = [...ps.matchAll(/Copy-DirClean -SrcDir \S+ -DstDir (\([^)]*\))/g)].map((m) => m[1]);
    expect(mirrors.length).toBeGreaterThanOrEqual(3);
    for (const dst of mirrors) expect(dst).toMatch(/^\(Join-Path \$(?:mktRoot|vRoot) \$dir\)$/);
  });
});

describe('applyUserBindingSwitch — the effective config, on a copy', () => {
  it('an ABSENT file returns the very object it was given (null included)', () => {
    const cfg = structuredClone(OFF);
    expect(applyUserBindingSwitch(cfg, { dir: stateDir })).toBe(cfg);
    expect(applyUserBindingSwitch(null, { dir: stateDir })).toBeNull();
  });

  it('a file saying true turns the key ON in a COPY: the input, and what it shares, is untouched', () => {
    const cfg = { agents: { x: 1 }, split: { dispatch: { budget: 3 }, missionBinding: { enabled: false, comment: 'c' } } };
    const before = structuredClone(cfg);
    writeSwitch({ enabled: true });
    const got = applyUserBindingSwitch(cfg, { dir: stateDir });
    expect(got).not.toBe(cfg);
    expect(got.split.missionBinding).toEqual({ enabled: true, comment: 'c' });
    expect(got.split.dispatch).toEqual({ budget: 3 });
    expect(got.agents).toBe(cfg.agents);
    expect(cfg).toEqual(before);
  });

  it('a file saying false turns a shipped-ON key OFF; an unusable file does too', () => {
    writeSwitch({ enabled: false });
    expect(applyUserBindingSwitch(structuredClone(ON), { dir: stateDir }).split.missionBinding.enabled).toBe(false);
    writeSwitch('{ nope');
    expect(applyUserBindingSwitch(structuredClone(ON), { dir: stateDir }).split.missionBinding.enabled).toBe(false);
  });

  it('builds the path when the config has none, and also over a missing config (null)', () => {
    writeSwitch({ enabled: true });
    expect(applyUserBindingSwitch({}, { dir: stateDir })).toEqual(ON);
    expect(applyUserBindingSwitch({ split: { dispatch: {} } }, { dir: stateDir })).toEqual({ split: { dispatch: {}, missionBinding: { enabled: true } } });
    expect(applyUserBindingSwitch(null, { dir: stateDir })).toEqual(ON);
  });
});

describe('missionBindingEnabled — the user file outranks the shipped copy that /update rewrites', () => {
  it('shipped OFF, file true: ON (the case that used to be reverted)', () => {
    writeShipped(OFF);
    writeSwitch({ enabled: true });
    expect(eff()).toBe(true);
  });

  it('SURVIVES AN UPDATE: the installer rewrites the plugin-root config, the answer does not move', () => {
    writeShipped(OFF);
    writeSwitch({ enabled: true });
    expect(eff()).toBe(true);
    writeShipped({ ...OFF, version: '9.9.9', comment: 'the next release\'s shipped copy' }); // what an install puts there
    expect(eff()).toBe(true);
  });

  it('CONTRAST — the old way of turning it on, editing the plugin-root copy, IS undone by that same rewrite', () => {
    writeShipped(ON);
    expect(eff()).toBe(true);
    writeShipped(OFF); // the update
    expect(eff()).toBe(false);
  });

  it('file false beats a shipped true: a local kill switch survives a release that ships the key ON', () => {
    writeShipped(ON);
    writeSwitch({ enabled: false });
    expect(eff()).toBe(false);
  });

  it('an unusable file reads OFF even when the shipped value is ON (fail-closed)', () => {
    writeShipped(ON);
    for (const text of ['{ nope', '{"enabled":"true"}', '[]', '{}']) {
      writeSwitch(text);
      expect(eff(), text).toBe(false);
    }
  });

  it('no file at all: the shipped value decides, exactly as before — a literal true is on, everything else (unreadable included) is off', () => {
    writeShipped(ON);
    expect(eff()).toBe(true);
    writeShipped(OFF);
    expect(eff()).toBe(false);
    writeShipped({ split: {} });
    expect(eff()).toBe(false);
    writeShipped('{ this is not json');
    expect(eff()).toBe(false);
    fs.rmSync(path.join(pluginRoot, 'artibot.config.json'), { force: true });
    expect(eff()).toBe(false);
  });

  it('the file is the owner\'s own decision, so an unreadable SHIPPED config does not veto it', () => {
    writeSwitch({ enabled: true });
    writeShipped('{ this is not json');
    expect(eff()).toBe(true);
    fs.rmSync(path.join(pluginRoot, 'artibot.config.json'), { force: true });
    expect(eff()).toBe(true);
  });

  it('an INJECTED config is the whole answer: the file is not consulted, and null stays "no config = off"', () => {
    writeSwitch({ enabled: true });
    expect(eff({ config: OFF })).toBe(false);
    expect(eff({ config: null })).toBe(false);
    expect(eff({ config: { split: { missionBinding: { enabled: 'true' } } } })).toBe(false);
    writeSwitch({ enabled: false });
    expect(eff({ config: ON })).toBe(true);
  });
});

/* ══════════ the readers the switch reaches: lane-state (write + --list) and the feeder's bind ══════════ */

const splitDir = (parent) => path.join(parent, '.artibot', 'split');

/** A bound run beside a real store; the plugin root says OFF, as shipped. */
function boundWorld() {
  const parent = tmp('artibot-user-switch-run-');
  fs.mkdirSync(splitDir(parent), { recursive: true });
  const record = { mission_id: MISSION, run_id: RUN, generation: 1, bound_at: '2026-10-19T04:00:00.000Z', bound_by_session: SID };
  fs.writeFileSync(path.join(splitDir(parent), 'plan.json'), JSON.stringify({ runId: RUN, limbs: [{ limb: 'auth', affectedPaths: ['lib/auth/**'] }], missionBinding: record }));
  writeRunJson(parent, { runId: RUN, windowReuse: { auth: 'w-a @ /p' } });
  const store = createStateStore({ projectRoot: parent, sessionId: SID, renderProjectionFile: false, appendEvent: () => ({ ok: true }) });
  expect(store.updateMission(MISSION, () => ({ status: 'executing', intent: { path: 'i.md', revision: 1 }, plan: { path: 'p.md', revision: 1 } }), { reason: 'test.seed' }).ok).toBe(true);
  writeShipped(OFF);
  return { parent, store, opts: { cwd: parent, sessionId: SID, openStore: () => store, switchDir: stateDir, now: T1 } };
}

describe('the readers of the key see the file', () => {
  it('lane-state writes a bound run through its mission when the file says true, although the shipped config says false', () => {
    const { parent, store, opts } = boundWorld();
    writeSwitch({ enabled: true });
    const r = setLaneState({ limb: 'auth', state: 'active' }, opts);
    expect(r).toMatchObject({ source: 'store', missionId: MISSION, state: 'active' });
    expect(store.getTaskGraph(MISSION).tasks[0].ops.state).toBe('active');
    expect(readRunJson(parent).lanes.auth.projected_from).toBe('store');
  });

  it('CONTROL — without the file the same call is the legacy write and says disabled', () => {
    const { parent, store, opts } = boundWorld();
    const r = setLaneState({ limb: 'auth', state: 'active' }, opts);
    expect(r.binding).toEqual({ status: 'disabled' });
    expect(readRunJson(parent).lanes.auth.projected_from).toBe('run.json');
    expect(store.getTaskGraph(MISSION).tasks).toEqual([]);
  });

  it('lane-state --list reads the node when the file says true', () => {
    const { opts } = boundWorld();
    writeSwitch({ enabled: true });
    setLaneState({ limb: 'auth', state: 'review' }, opts);
    const { rows, binding } = readLaneStates(opts);
    expect(binding).toMatchObject({ status: 'bound', mission_id: MISSION });
    expect(rows.find((x) => x.limb === 'auth')).toMatchObject({ state: 'review', source: 'store' });
  });

  it('the feeder binds an unbound run on the first dispatch only when the file says true', () => {
    const parent = tmp('artibot-user-switch-bind-');
    fs.mkdirSync(splitDir(parent), { recursive: true });
    const plan = { runId: RUN, limbs: [{ limb: 'auth', affectedPaths: ['lib/auth/**'] }] };
    fs.writeFileSync(path.join(splitDir(parent), 'plan.json'), JSON.stringify(plan));
    writeRunJson(parent, { runId: RUN });
    writeShipped(OFF);
    const store = createStateStore({ projectRoot: parent, sessionId: SID, renderProjectionFile: false, appendEvent: () => ({ ok: true }) });
    expect(store.updateMission(MISSION, () => ({ status: 'executing', intent: { path: 'i.md', revision: 1 }, plan: { path: 'p.md', revision: 1 } }), { reason: 'test.seed' }).ok).toBe(true);
    const feed = () => feedLimb({ parentRoot: parent, plan, limb: 'auth', sessionId: SID, bind: true }, { openStore: () => store, now: T1, switchDir: stateDir });

    expect(feed()).toMatchObject({ fed: true, claim: 'claimed' }); // no file: the shipped OFF binds nothing
    expect(JSON.parse(fs.readFileSync(path.join(splitDir(parent), 'plan.json'), 'utf-8')).missionBinding).toBeUndefined();

    writeSwitch({ enabled: true });
    expect(feed()).toMatchObject({ fed: true, claim: 'bound:node', binding: { status: 'created' } });
    expect(JSON.parse(fs.readFileSync(path.join(splitDir(parent), 'plan.json'), 'utf-8')).missionBinding.mission_id).toBe(MISSION);
  });
});
