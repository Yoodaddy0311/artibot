/**
 * Gate scan anchoring — enumeration must not grow when the working tree does.
 *
 * ── The defect class ────────────────────────────────────────────────────────
 * `isProjectPluginDir` is a *name* rule (`artibot` | `artibot-*` | `_shared`),
 * and `listPluginRoots` used to hand every matching name straight to
 * `statSync`. So "is this a plugin root" was answered by what the filesystem
 * happened to be showing, and anything wearing the right name was believed.
 *
 * Two failure modes follow, and they need different guards:
 *
 *   1. A nested repo copy is *adopted*. Measured 2026-08-26: seven directories
 *      under `plugins/artibot/runtime/autopilot/worktrees/` while `git worktree
 *      list` reported only the main tree — orphaned trees no command was
 *      tracking. One placed directly under `plugins/`, or a junction pointing
 *      at one, matches the name rule and contributes a second copy of every
 *      skill and doc. The git anchor is what excludes it.
 *   2. A dangling link *crashes* the enumerator. `readdirSync` lists it and
 *      `statSync` throws ENOENT, so an unguarded scan does not fail the gate —
 *      it takes the gate down, which is a different and worse outcome.
 *
 * On (2), be precise about what the working tree does and does not demonstrate.
 * `plugins/artibot/UsersHeechangLee…escratchpad/jx` is a real dangling link
 * here — it points inside its own parent at a target that does not exist — but
 * it is NOT an instance of this function's crash path: it is named `jx`, which
 * the name rule rejects, and it sits inside `plugins/artibot/` rather than
 * beside it, so `listPluginRoots` never enumerates it at all. It is evidence
 * that links of this kind occur in this tree, nothing more. The crash path is
 * reproduced below with a planted link that does match the name rule.
 *
 * Both artifacts are invisible to git — the REPO ROOT `.gitignore` (not
 * `plugins/artibot/.gitignore`, which carries no such rule) ignores them at
 * `:59 *AppDataLocalTemp*` and `runtime/autopilot/`. That is what makes
 * `git ls-files` the anchor separating "on disk" from "part of this project".
 *
 * ── Why this file runs no gate ──────────────────────────────────────────────
 * It imports enumeration functions and nothing else. Running the gates instead
 * is what turned the zip-drift test into 158 process spawns, and `npm run ci`
 * includes vitest, so a test that shells out to a gate can re-enter itself.
 * Fixtures inject `trackedNames` rather than running `git init`, which keeps
 * the spawn count at zero for every case except the one marked otherwise.
 *
 * ── What this gate does NOT see ─────────────────────────────────────────────
 *   - Indirect contamination routed through `node_modules/` or `coverage/`:
 *     both are skipped by the scanners before enumeration reaches them, so a
 *     copy planted inside either is outside what these assertions describe.
 *   - Tools outside the gates entirely — the editor's file indexer, a `tsc`
 *     `include` glob, `eslint .`. They walk the same tree with their own
 *     enumeration and their own ignore lists. `eslint.config.js:36-46`
 *     deliberately ignores only `.ap-boot.mjs` and `coverage/`, so it still
 *     descends into `runtime/`; anchoring the CI scanners does not move that.
 *   - Whether a *tracked* root's contents are correct. This asserts which roots
 *     get scanned, not what the scan then finds.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _resetTrackedNameCache,
  isProjectPluginDir,
  listPluginRoots,
} from '../../scripts/ci/ci-utils.js';
import {
  assertEntityFloors,
  countByRoot,
  listAllSkillFiles,
  listEntityRoots,
} from '../../scripts/ci/skill-scan-roots.js';

const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;

/** The three roots a fixture declares as genuinely tracked. */
const TRACKED = new Set(['artibot', 'artibot-cowork', '_shared']);

/**
 * Build a throwaway `plugins/` tree with the same shape as the real one.
 *
 * Counts are deliberately tiny — this fixture proves *which roots* are
 * enumerated, and a floor assertion against it would only be re-measuring the
 * fixture. Real floors stay in `MIN_ENTITY_COUNTS`.
 *
 * @returns {{tmp: string, plugins: string}}
 */
function makePluginsTree() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gate-anchor-'));
  const plugins = path.join(tmp, 'plugins');
  for (const root of ['artibot', 'artibot-cowork']) {
    for (const skill of ['alpha', 'beta']) {
      mkdirSync(path.join(plugins, root, 'skills', skill), { recursive: true });
      writeFileSync(
        path.join(plugins, root, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\n---\n`,
      );
    }
    mkdirSync(path.join(plugins, root, 'commands'), { recursive: true });
    writeFileSync(path.join(plugins, root, 'commands', 'cmd.md'), '# cmd\n');
    mkdirSync(path.join(plugins, root, 'agents'), { recursive: true });
    writeFileSync(path.join(plugins, root, 'agents', 'agent.md'), '---\nname: agent\n---\n');
  }
  mkdirSync(path.join(plugins, '_shared'), { recursive: true });
  writeFileSync(path.join(plugins, '_shared', 'NOTE.md'), '# shared\n');

  process.env.CLAUDE_PLUGIN_ROOT = path.join(plugins, 'artibot');
  _resetTrackedNameCache();
  return { tmp, plugins };
}

/**
 * Plant a full nested repo copy — the shape a worktree leaves behind.
 *
 * @param {string} plugins - Fixture plugins directory.
 * @param {string} name - Directory name to create under it.
 * @returns {void}
 */
function plantNestedCopy(plugins, name) {
  const copy = path.join(plugins, name, 'skills', 'stowaway');
  mkdirSync(copy, { recursive: true });
  writeFileSync(path.join(copy, 'SKILL.md'), '---\nname: stowaway\n---\n');
  mkdirSync(path.join(plugins, name, 'commands'), { recursive: true });
  writeFileSync(path.join(plugins, name, 'commands', 'stowaway.md'), '# stowaway\n');
}

/**
 * Plant a link named like a plugin root, then optionally break it.
 *
 * `symlinkSync(..., 'junction')` is what makes this runnable unprivileged on
 * Windows: a plain symlink there needs elevation (measured 2026-08-26: EPERM),
 * and skipping the case on the one OS where the artifact was found would leave
 * the hole untested exactly where it opened. On POSIX the type argument is
 * ignored and an ordinary symlink results.
 *
 * @param {string} plugins - Fixture plugins directory.
 * @param {string} name - Link name under it.
 * @param {string} target - Directory the link points at.
 * @param {{dangling?: boolean}} [opts] - Remove the target after linking.
 * @returns {void}
 */
function plantLink(plugins, name, target, opts = {}) {
  symlinkSync(target, path.join(plugins, name), 'junction');
  if (opts.dangling) rmSync(target, { recursive: true, force: true });
}

/** Enumeration snapshot, reduced to basenames so paths stay comparable. */
function snapshot() {
  return {
    roots: listPluginRoots({ trackedNames: TRACKED }).map((p) => path.basename(p)),
    skillRoots: listEntityRoots('skills', { trackedNames: TRACKED }).map((r) => r.name),
    commandRoots: listEntityRoots('commands', { trackedNames: TRACKED }).map((r) => r.name),
    agentRoots: listEntityRoots('agents', { trackedNames: TRACKED }).map((r) => r.name),
    skillKeys: listAllSkillFiles({ trackedNames: TRACKED }).map((s) => s.key),
  };
}

describe('gate scan anchoring', () => {
  /** @type {string[]} */
  const created = [];

  afterEach(() => {
    if (ORIGINAL_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
    _resetTrackedNameCache();
    while (created.length) rmSync(created.pop(), { recursive: true, force: true });
  });

  /** Make a fixture and register it for teardown. */
  function fixture() {
    const made = makePluginsTree();
    created.push(made.tmp);
    return made;
  }

  it('names a nested copy the way the predicate would accept it', () => {
    // If this ever stops holding, the two tests below are testing nothing:
    // they would be planting a directory the name rule rejects anyway.
    expect(isProjectPluginDir('artibot-stowaway')).toBe(true);
    expect(isProjectPluginDir('artibot-ghost')).toBe(true);
  });

  it('does not adopt an untracked nested repo copy as a plugin root', () => {
    const { plugins } = fixture();
    const before = snapshot();
    expect(before.roots).toEqual(['_shared', 'artibot', 'artibot-cowork']);

    plantNestedCopy(plugins, 'artibot-stowaway');

    expect(snapshot()).toEqual(before);
  });

  it('does not adopt a link that merely wears a plugin-root name', () => {
    const { tmp, plugins } = fixture();
    const before = snapshot();

    const target = path.join(tmp, 'elsewhere');
    mkdirSync(path.join(target, 'skills', 'stowaway'), { recursive: true });
    writeFileSync(path.join(target, 'skills', 'stowaway', 'SKILL.md'), '---\nname: x\n---\n');
    plantLink(plugins, 'artibot-ghost', target);

    expect(snapshot()).toEqual(before);
  });

  it('drops a dangling link instead of throwing ENOENT out of the gate', () => {
    const { tmp, plugins } = fixture();
    const before = snapshot();

    const target = path.join(tmp, 'doomed');
    mkdirSync(target, { recursive: true });
    plantLink(plugins, 'artibot-ghost', target, { dangling: true });

    // The distinction that matters: a gate that fails reports a finding, a gate
    // that throws reports nothing at all and looks like an infrastructure blip.
    expect(() => listPluginRoots({ trackedNames: TRACKED })).not.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('keeps a dangling link out even when its name IS tracked', () => {
    // Defence in depth: the git anchor and the stat guard close different
    // holes, and a test that only planted untracked links would pass with the
    // guard deleted.
    const { tmp, plugins } = fixture();
    const target = path.join(tmp, 'doomed-cowork');
    mkdirSync(target, { recursive: true });
    rmSync(path.join(plugins, 'artibot-cowork'), { recursive: true, force: true });
    plantLink(plugins, 'artibot-cowork', target, { dangling: true });

    const roots = listPluginRoots({ trackedNames: TRACKED }).map((p) => path.basename(p));
    expect(roots).toEqual(['_shared', 'artibot']);
  });

  it('lets the floors still fail when a real root goes missing', () => {
    // The anchor removes roots from the enumeration, so it could in principle
    // hide a genuine regression. It does not: a missing root is still a floor
    // failure, which is the loud outcome.
    const { plugins } = fixture();
    rmSync(path.join(plugins, 'artibot-cowork'), { recursive: true, force: true });

    const counts = countByRoot(
      listAllSkillFiles({ trackedNames: TRACKED }).map((s) => ({ rootName: s.rootName })),
    );
    const failures = assertEntityFloors('skills', counts);
    expect(failures.join('\n')).toMatch(/artibot-cowork/);
  });

  it('resolves the real repo roots through git, with no override', () => {
    // The only case that spawns a process (one `git ls-files`), and the only
    // one that proves the default resolver works — every assertion above runs
    // against an injected set and would pass even if git resolution were dead.
    _resetTrackedNameCache();
    const roots = listPluginRoots().map((p) => path.basename(p));
    expect(roots).toEqual(['_shared', 'artibot', 'artibot-cowork']);
  });
});
