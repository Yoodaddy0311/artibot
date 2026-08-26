/**
 * skill-scan-roots — the options pass-through, and the no-arg path it must not
 * have disturbed.
 *
 * `listEntityRoots` and `listAllSkillFiles` gained an `options` parameter in
 * 4cdd3278 for one reason: `ci-utils.js#listPluginRoots` anchors root
 * enumeration to `git ls-files`, and a fixture that cannot run `git init`
 * needs to hand it a stand-in set. That parameter is only useful if it
 * actually reaches `listPluginRoots` — and a forwarding argument is precisely
 * the kind of thing that can be dropped without any test noticing, because
 * every existing caller passes nothing and would go on passing.
 *
 * So the two halves are asserted separately:
 *   (a) no-arg calls still resolve the real roots through git, and
 *   (b) an injected set changes the result in the one way that is only
 *       possible if it travelled the whole way down.
 *
 * (b) uses a throwaway tree rather than the repo. Outside a work tree the git
 * anchor yields nothing to filter on, so the bare name rule admits an artifact
 * root — which makes the injected set the *only* thing that can exclude it,
 * and therefore makes its exclusion proof of delivery.
 *
 * What this file does NOT cover: the gates themselves (they are never run
 * here — see `tests/firewall/gate-scan-anchoring.test.js` for why), the
 * contents of a root once enumerated, and `assertEntityFloors`' own logic
 * beyond the one call used as a denominator check.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _resetTrackedNameCache } from '../../scripts/ci/ci-utils.js';
import {
  assertEntityFloors,
  countByRoot,
  listAllSkillFiles,
  listEntityRoots,
  PRIMARY_ROOT,
  qualify,
} from '../../scripts/ci/skill-scan-roots.js';

const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;

/** Roots a fixture declares tracked. Deliberately omits the artifact root. */
const TRACKED = new Set(['artibot', 'artibot-cowork']);

/** Skills planted per real root, so counts are predictable without pinning inventory. */
const FIXTURE_SKILLS = ['alpha', 'beta'];

/**
 * Build a throwaway plugins tree containing two genuine roots plus one
 * artifact root that only the name rule would accept.
 *
 * @returns {{tmp: string, plugins: string}}
 */
function makeTree() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'skill-scan-roots-'));
  const plugins = path.join(tmp, 'plugins');
  const write = (root, skill) => {
    mkdirSync(path.join(plugins, root, 'skills', skill), { recursive: true });
    writeFileSync(
      path.join(plugins, root, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\n---\n`,
    );
  };
  for (const root of ['artibot', 'artibot-cowork']) {
    for (const skill of FIXTURE_SKILLS) write(root, skill);
    mkdirSync(path.join(plugins, root, 'commands'), { recursive: true });
    writeFileSync(path.join(plugins, root, 'commands', 'cmd.md'), '# cmd\n');
  }
  // The stowaway: an untracked nested copy wearing an `artibot-` name.
  write('artibot-stowaway', 'stowaway');
  mkdirSync(path.join(plugins, 'artibot-stowaway', 'commands'), { recursive: true });
  writeFileSync(path.join(plugins, 'artibot-stowaway', 'commands', 'cmd.md'), '# cmd\n');

  process.env.CLAUDE_PLUGIN_ROOT = path.join(plugins, 'artibot');
  _resetTrackedNameCache();
  return { tmp, plugins };
}

describe('skill-scan-roots', () => {
  /** @type {string[]} */
  const created = [];

  afterEach(() => {
    if (ORIGINAL_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
    _resetTrackedNameCache();
    while (created.length) rmSync(created.pop(), { recursive: true, force: true });
  });

  function fixture() {
    const made = makeTree();
    created.push(made.tmp);
    return made;
  }

  // ── (a) the no-arg path still behaves as it did ───────────────────────────
  describe('no-arg calls resolve the real repo roots', () => {
    it('enumerates both entity roots for every kind', () => {
      for (const kind of ['skills', 'commands', 'agents']) {
        const names = listEntityRoots(kind).map((r) => r.name);
        expect(names, `kind=${kind}`).toEqual(['artibot', 'artibot-cowork']);
      }
    });

    it('meets the declared floors, so the roots were really read', () => {
      // Without this the test above passes on two empty directories.
      const counts = countByRoot(listAllSkillFiles());
      expect(assertEntityFloors('skills', counts)).toEqual([]);
      expect(counts.artibot).toBeGreaterThan(0);
      expect(counts['artibot-cowork']).toBeGreaterThan(0);
    });

    it('treats an omitted options argument the same as an explicit undefined', () => {
      expect(listEntityRoots('skills', undefined).map((r) => r.name))
        .toEqual(listEntityRoots('skills').map((r) => r.name));
      expect(listAllSkillFiles(undefined).map((s) => s.key))
        .toEqual(listAllSkillFiles().map((s) => s.key));
    });

    it('qualifies non-primary roots and leaves the primary bare', () => {
      const keys = listAllSkillFiles().map((s) => s.key);
      expect(keys.some((k) => k.startsWith('artibot-cowork/'))).toBe(true);
      expect(keys.some((k) => k.startsWith(`${PRIMARY_ROOT}/`))).toBe(false);
      expect(qualify('artibot-cowork', 'daily')).toBe('artibot-cowork/daily');
    });
  });

  // ── (b) the injected set reaches listPluginRoots ───────────────────────────
  describe('options travel down to listPluginRoots', () => {
    it('admits the artifact root when nothing is injected', () => {
      // The control. Outside a work tree the name rule stands alone, so the
      // stowaway is enumerated — which is what makes its later absence mean
      // something rather than being true of an empty fixture.
      const { plugins } = fixture();
      expect(plugins).toContain('skill-scan-roots-');
      expect(listEntityRoots('skills').map((r) => r.name))
        .toEqual(['artibot', 'artibot-cowork', 'artibot-stowaway']);
    });

    it('excludes the artifact root from listEntityRoots when injected', () => {
      fixture();
      for (const kind of ['skills', 'commands']) {
        const names = listEntityRoots(kind, { trackedNames: TRACKED }).map((r) => r.name);
        expect(names, `kind=${kind}`).toEqual(['artibot', 'artibot-cowork']);
      }
    });

    it('excludes the artifact root from listAllSkillFiles when injected', () => {
      fixture();
      const bare = listAllSkillFiles().map((s) => s.key);
      const injected = listAllSkillFiles({ trackedNames: TRACKED }).map((s) => s.key);

      expect(bare).toContain('artibot-stowaway/stowaway');
      expect(injected).not.toContain('artibot-stowaway/stowaway');
      expect(injected).toEqual(['alpha', 'artibot-cowork/alpha', 'artibot-cowork/beta', 'beta']);
    });

    it('carries the injected set through the countByRoot → floors path', () => {
      // The shape a gate actually uses: enumerate, tally, assert floors. An
      // un-forwarded option would leave `artibot-stowaway` in the tally and
      // trip the "no entry in MIN_ENTITY_COUNTS" branch.
      fixture();
      const counts = countByRoot(listAllSkillFiles({ trackedNames: TRACKED }));
      expect(Object.keys(counts).sort()).toEqual(['artibot', 'artibot-cowork']);
      expect(assertEntityFloors('skills', countByRoot(listAllSkillFiles())).join('\n'))
        .toMatch(/artibot-stowaway/);
    });
  });
});
