/**
 * Auto-invoke guard — the model must stay able to start what the plugin tells
 * it to start.
 *
 * `CLAUDE.md` "Auto-invoke Principle": users do not type slash commands; the
 * model starts the command or skill itself through the host's Skill tool. The
 * frontmatter key `disable-model-invocation: true` (dmi) refuses exactly that
 * call — host 2.1.291 answers it with "cannot be used with Skill tool due to
 * disable-model-invocation" (string read from the host binary, 2026-11-07). A
 * dmi on the wrong file therefore switches auto-invoke off for that name and
 * nothing errors anywhere. Owner decision 2026-11-07 (relayed by the leader):
 * no new dmi; the principle is held by this gate instead.
 *
 *  1. Every name in `AUTO_INVOKE_NAMES` has at least one surface
 *     (`commands/<n>.md` or `skills/<n>/SKILL.md`) without dmi — unless it is in
 *     `AUTO_INVOKE_SURFACELESS`, which then must have no surface at all.
 *  2. Every dmi surface under `commands/` and `skills/` is in `DMI_EXCEPTIONS`
 *     (a ratchet: a new dmi is a decision with a written reason, not a drift).
 *  3. Every exception is still dmi and carries a reason (no dead exceptions).
 *  4. The scanner goes red on synthetic frontmatter (rules §10: a gate that
 *     cannot fail proves nothing).
 *  5. The `CLAUDE.md` prose list is name-for-name `AUTO_INVOKE_PROSE_NAMES`.
 *
 * WHAT THIS GATE CANNOT SEE (stated beside it so it is not read as more):
 *  - Which file the host picks when a command and a skill share a name and only
 *    one is dmi (`daily` today: the command is not, the skill is). Check 1 passes
 *    `daily` on the command alone; whether the Skill tool resolves
 *    `artibot:daily` to the command is UNVERIFIED.
 *  - How the host coerces a value other than the literal `true`. The scanner
 *    reads every value but `false` as dmi — the direction that fails closed here.
 *  - Whether the model WANTS to call a name. That is description quality, the
 *    description linter's job; this gate only proves the call is not refused.
 *  - `plugins/artibot-cowork` (its own `skills/daily/SKILL.md` is dmi) and
 *    commands nested below `commands/`: neither is scanned.
 *
 * @module tests/firewall/auto-invoke-dmi-guard
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTO_INVOKE_NAMES,
  AUTO_INVOKE_PROSE_NAMES,
  AUTO_INVOKE_SURFACELESS,
  DMI_EXCEPTIONS,
} from '../../lib/cognitive/auto-invoke.js';
import { AUTO_ACTIVATE_ALLOWLIST } from '../../lib/cognitive/auto-activate.js';
import { HINT_SLASH_MAP } from '../../lib/observability/decision-events.js';
import { frontmatter, stripComment } from './frontmatter-tools.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read a plugin file with CRLF folded to LF (a Windows checkout is CRLF, CI is LF). */
function read(rel) {
  return readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');
}

const DMI_KEY = /^disable-model-invocation:[ \t]*(.*)$/m;

/**
 * dmi state of one file: `true` / `false`, or `null` when there is no
 * frontmatter (the caller fails on it). Only the frontmatter block counts —
 * `skills/persona-distill/SKILL.md` carries the key inside a body template.
 * @param {string} text
 * @returns {boolean | null}
 */
function readDmi(text) {
  const block = frontmatter(text);
  if (block === null) return null;
  const m = block.match(DMI_KEY);
  return m !== null && stripComment(m[1]) !== 'false';
}

/** The surfaces a name has on disk, as plugin-relative paths. */
function surfacesOf(name) {
  return [`commands/${name}.md`, `skills/${name}/SKILL.md`]
    .filter((rel) => existsSync(path.join(PLUGIN_ROOT, rel)));
}

/** True when at least one of the given file texts is free of dmi. */
function modelCallable(texts) {
  return texts.some((text) => readDmi(text) === false);
}

/** Every top-level command and every skill, as plugin-relative paths. */
function listSurfaces() {
  const commands = readdirSync(path.join(PLUGIN_ROOT, 'commands'), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => `commands/${d.name}`);
  const skills = readdirSync(path.join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(PLUGIN_ROOT, 'skills', d.name, 'SKILL.md')))
    .map((d) => `skills/${d.name}/SKILL.md`);
  return [...commands, ...skills];
}

/** dmi surfaces with no entry in the given exception map. */
function unlisted(dmiSurfaces, exceptions) {
  return dmiSurfaces.filter((rel) => !Object.hasOwn(exceptions, rel));
}

describe('auto-invoke set — one constant, three sources', () => {
  it('is exactly the union of the allowlist, the hint targets and the prose names', () => {
    const sources = [...AUTO_ACTIVATE_ALLOWLIST, ...Object.values(HINT_SLASH_MAP), ...AUTO_INVOKE_PROSE_NAMES];
    expect([...AUTO_INVOKE_NAMES].sort()).toEqual([...new Set(sources)].sort());
    expect(new Set(AUTO_INVOKE_NAMES).size).toBe(AUTO_INVOKE_NAMES.length);
    expect(Object.isFrozen(AUTO_INVOKE_NAMES)).toBe(true);
    expect(Object.isFrozen(AUTO_INVOKE_PROSE_NAMES)).toBe(true);
    expect(Object.isFrozen(AUTO_INVOKE_SURFACELESS)).toBe(true);
    expect(Object.isFrozen(DMI_EXCEPTIONS)).toBe(true);
  });

  it('CLAUDE.md lists the prose names and points at the constant', () => {
    const md = read('CLAUDE.md');
    const line = md.split('\n').find((l) => l.startsWith('Never tell the user to type slash-commands.'));
    expect(line, 'Auto-invoke Principle line missing — this gate fails closed').toBeDefined();
    const listed = (line.match(/Applies to (.*?) — all commands/)?.[1] ?? '').match(/`\/[a-z-]+`/g) ?? [];
    expect(listed.map((s) => s.slice(2, -1))).toEqual([...AUTO_INVOKE_PROSE_NAMES]);
    expect(md).toContain('lib/cognitive/auto-invoke.js#AUTO_INVOKE_NAMES');
  });
});

describe('auto-invoke set — every name keeps a surface the model may call', () => {
  const callable = AUTO_INVOKE_NAMES.filter((n) => !Object.hasOwn(AUTO_INVOKE_SURFACELESS, n));

  it.each(callable)('%s has at least one surface without disable-model-invocation', (name) => {
    const surfaces = surfacesOf(name);
    expect(surfaces.length, `${name}: no commands/${name}.md and no skills/${name}/SKILL.md`).toBeGreaterThan(0);
    for (const rel of surfaces) expect(readDmi(read(rel)), `${rel}: no frontmatter`).not.toBeNull();
    expect(modelCallable(surfaces.map(read)), `${name}: every surface is dmi (${surfaces.join(', ')})`).toBe(true);
  });

  it('a surfaceless name is in the set, has a reason and really has no surface', () => {
    for (const [name, reason] of Object.entries(AUTO_INVOKE_SURFACELESS)) {
      expect(AUTO_INVOKE_NAMES).toContain(name);
      expect(typeof reason === 'string' && reason.length >= 20, `${name}: reason`).toBe(true);
      expect(surfacesOf(name), `${name} grew a surface — drop it from AUTO_INVOKE_SURFACELESS`).toEqual([]);
    }
  });
});

describe('dmi ratchet — no new disable-model-invocation without a written reason', () => {
  const surfaces = listSurfaces();
  const dmiSurfaces = surfaces.filter((rel) => readDmi(read(rel)) === true);

  it('scanned a real tree (denominator, not an empty pass)', () => {
    expect(surfaces.length).toBeGreaterThan(100);
    expect(dmiSurfaces.length).toBeGreaterThan(0);
  });

  it('every dmi surface is a listed exception', () => {
    expect(unlisted(dmiSurfaces, DMI_EXCEPTIONS)).toEqual([]);
  });

  it('every exception is still dmi and says why', () => {
    for (const [rel, reason] of Object.entries(DMI_EXCEPTIONS)) {
      expect(existsSync(path.join(PLUGIN_ROOT, rel)), `${rel}: gone — drop the exception`).toBe(true);
      expect(readDmi(read(rel)), `${rel}: no longer dmi — drop the exception`).toBe(true);
      expect(typeof reason === 'string' && reason.length >= 20, `${rel}: reason`).toBe(true);
    }
  });
});

describe('scanner self-check — synthetic frontmatter', () => {
  it.each([
    ['literal true', '---\nname: x\ndisable-model-invocation: true\n---\nbody', true],
    ['quoted, commented', '---\ndisable-model-invocation: "true"  # why\n---\n', true],
    ['non-literal value fails closed', '---\ndisable-model-invocation: yes\n---\n', true],
    ['explicit false', '---\ndisable-model-invocation: false\n---\n', false],
    ['key absent', '---\nname: x\n---\n', false],
    ['key only in the body', '---\nname: x\n---\ndisable-model-invocation: true\n', false],
    ['no frontmatter', 'disable-model-invocation: true\n', null],
  ])('%s', (_label, text, expected) => {
    expect(readDmi(text)).toBe(expected);
  });

  it('a name whose every surface is dmi is not callable; one clean surface is enough', () => {
    const dmi = '---\ndisable-model-invocation: true\n---\n';
    const clean = '---\nname: x\n---\n';
    expect(modelCallable([dmi, dmi])).toBe(false);
    expect(modelCallable([])).toBe(false);
    expect(modelCallable([dmi, clean])).toBe(true);
  });

  it('an unlisted dmi surface is reported', () => {
    expect(unlisted(['commands/new.md', 'commands/old.md'], { 'commands/old.md': 'reason' })).toEqual(['commands/new.md']);
  });
});
