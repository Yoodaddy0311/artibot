/**
 * source_hash freshness gate — shrink-only ratchet over every primary-root SKILL.md.
 *
 * `source_hash` in SKILL.md frontmatter is the 8-char body hash computed by
 * `lib/core/skill-hash.js#computeHash`. Its only reader is the advisory
 * `scripts/phase1-audit.js` (`verifyHash`), which never fails a build — the
 * session-start hash cache (`lib/core/skill-hash-cache.js`) hashes the body
 * itself and does not read the stored value — so a body edit that forgot the
 * hash went unnoticed. This gate closes that.
 *
 * ── Ratchet, not a full pin ─────────────────────────────────────────────────
 * 107 of 114 primary-root SKILL.md files were stale at 2026-09-28T06:24Z:
 * cf556052 (SH-09 B-2, 2026-09-23) added one or two body lines to 108 SKILL.md
 * files without refreshing their hashes (self-evaluation was refreshed first).
 * All were refreshed in bulk (skill-hash-refresh), so {@link FROZEN_STALE} is empty.
 * The gate is RED in both directions:
 *   1. a SKILL.md outside the set is stale  → new staleness, refresh its hash;
 *   2. a SKILL.md inside the set now matches → remove it from the set;
 *   3. a set entry no longer exists on disk → remove it from the set.
 * (2) and (3) keep the set from rotting: it can only shrink, and a bulk refresh
 * leaves it as `[]` (plus the dated history above, as skill-hash-refresh did).
 * A NEW SKILL.md must carry a matching `source_hash` too (a missing one counts
 * as stale). Compute it with `computeHash(extractSkillBody(text))` and edit
 * that one line; `scripts/inject-source-hash.js` rewrites every file as LF.
 *
 * ── Denominator ─────────────────────────────────────────────────────────────
 * Fail-closed at {@link MIN_PRIMARY_SKILLS} = 114, the measured count, not the
 * round `MIN_ENTITY_COUNTS.artibot.skills` floor (100) in
 * `scripts/ci/skill-scan-roots.js`. That floor catches "the scanner found
 * nothing"; here up to 14 silently unscanned files would coast under it, and
 * each one is a file whose hash nobody checked. Deleting a skill therefore
 * needs a deliberate edit of this constant.
 *
 * ── What this gate cannot see ───────────────────────────────────────────────
 * - Frontmatter-only edits: the hash covers the body only (`extractSkillBody`).
 * - Line-ending changes and trailing-whitespace-only edits: `computeHash`
 *   normalizes CRLF and applies `trimEnd()` before hashing.
 * - Further body edits to a file already in FROZEN_STALE: it was stale and
 *   stays stale, so the ratchet reports nothing new.
 * - Files other than SKILL.md (e.g. `references/*.md`): they carry no hash.
 *   cf556052 also edited 25 such reference files.
 * - artibot-cowork: its SKILL.md files carry no `source_hash` (46 of 46 null,
 *   2026-09-28T06:09Z), so they are outside the denominator. That count is an
 *   observation and is not pinned here; a cowork file that *does* declare a
 *   hash must match it (asserted below).
 *
 * @module tests/skills/source-hash-fresh
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeHash, verifyHash } from '../../lib/core/skill-hash.js';
import { listAllSkillFiles, PRIMARY_ROOT } from '../../scripts/ci/skill-scan-roots.js';

/** Measured primary-root SKILL.md count (2026-09-28T06:24Z). */
const MIN_PRIMARY_SKILLS = 114;

/** Primary-root SKILL.md paths whose `source_hash` is known stale. Shrink only. */
const FROZEN_STALE = Object.freeze([]);

/**
 * Hash-check each SKILL.md.
 *
 * @param {Array<{rel: string, file: string}>} entries - `rel` is the path
 *   relative to the plugin root (`skills/<name>/SKILL.md`).
 * @returns {Promise<Array<{rel: string, current: string, stored: string|null, match: boolean}>>}
 */
async function scanHashes(entries) {
  const out = [];
  for (const { rel, file } of entries) {
    out.push({ rel, ...(await verifyHash(file)) });
  }
  return out;
}

/**
 * Compare scan results against the frozen stale set. Pure.
 *
 * @param {Array<{rel: string, match: boolean}>} results - From {@link scanHashes}.
 * @param {readonly string[]} frozen - Known-stale relative paths.
 * @returns {{newStale: string[], healed: string[], vanished: string[]}}
 */
function evaluateRatchet(results, frozen) {
  const frozenSet = new Set(frozen);
  const seen = new Set(results.map((r) => r.rel));
  return {
    newStale: results.filter((r) => !r.match && !frozenSet.has(r.rel)).map((r) => r.rel),
    healed: results.filter((r) => r.match && frozenSet.has(r.rel)).map((r) => r.rel),
    vanished: frozen.filter((rel) => !seen.has(rel)),
  };
}

const CLEAN = Object.freeze({ newStale: [], healed: [], vanished: [] });

function toEntries(files) {
  return files.map((f) => ({ rel: `skills/${f.name}/SKILL.md`, file: f.file }));
}

describe('source-hash-fresh — ratchet self-check (fixtures)', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Write `skills/<name>/SKILL.md` with the given stored hash (or the true one). */
  function writeSkill(name, body, storedHash) {
    const skillDir = path.join(dir, 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    const hash = storedHash ?? computeHash(body);
    const file = path.join(skillDir, 'SKILL.md');
    writeFileSync(file, `---\r\nname: ${name}\r\nsource_hash: ${hash}\r\n---\r\n${body}`);
    return { name, file };
  }

  it('is RED when a skill outside the frozen set carries a stale hash', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'src-hash-fresh-'));
    const files = [
      writeSkill('fresh', '# Fresh\r\nbody\r\n'),
      writeSkill('drifted', '# Drifted\r\nbody\r\n', '00000000'),
    ];
    const verdict = evaluateRatchet(await scanHashes(toEntries(files)), []);
    expect(verdict.newStale).toEqual(['skills/drifted/SKILL.md']);
  });

  it('is RED when a frozen entry now matches (the set must shrink)', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'src-hash-fresh-'));
    const files = [writeSkill('refreshed', '# Refreshed\r\nbody\r\n')];
    const verdict = evaluateRatchet(await scanHashes(toEntries(files)), ['skills/refreshed/SKILL.md']);
    expect(verdict.healed).toEqual(['skills/refreshed/SKILL.md']);
    expect(verdict.newStale).toEqual([]);
  });

  it('is RED when a frozen entry no longer exists on disk', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'src-hash-fresh-'));
    const files = [writeSkill('kept', '# Kept\r\nbody\r\n')];
    const verdict = evaluateRatchet(await scanHashes(toEntries(files)), ['skills/gone/SKILL.md']);
    expect(verdict.vanished).toEqual(['skills/gone/SKILL.md']);
  });

  it('is clean when stale files are exactly the frozen ones', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'src-hash-fresh-'));
    const files = [
      writeSkill('fresh', '# Fresh\r\nbody\r\n'),
      writeSkill('known', '# Known\r\nbody\r\n', '00000000'),
    ];
    const verdict = evaluateRatchet(await scanHashes(toEntries(files)), ['skills/known/SKILL.md']);
    expect(verdict).toEqual(CLEAN);
  });
});

describe('source-hash-fresh — live tree', () => {
  const all = listAllSkillFiles();
  const primary = all.filter((f) => f.rootName === PRIMARY_ROOT);

  it(`scans at least ${MIN_PRIMARY_SKILLS} primary-root SKILL.md files (fail-closed denominator)`, () => {
    expect(primary.length).toBeGreaterThanOrEqual(MIN_PRIMARY_SKILLS);
  });

  it('frozen set has no duplicates and stays sorted', () => {
    expect(new Set(FROZEN_STALE).size).toBe(FROZEN_STALE.length);
    expect([...FROZEN_STALE].sort()).toEqual([...FROZEN_STALE]);
  });

  it('has no stale source_hash outside the frozen set, and no frozen entry that healed or vanished', async () => {
    const results = await scanHashes(toEntries(primary));
    expect(results.length).toBe(primary.length);
    expect(evaluateRatchet(results, FROZEN_STALE)).toEqual(CLEAN);
  });

  it('every non-primary SKILL.md that declares a source_hash matches it', async () => {
    const others = all.filter((f) => f.rootName !== PRIMARY_ROOT);
    const results = await scanHashes(others.map((f) => ({ rel: f.key, file: f.file })));
    const declaredButStale = results.filter((r) => r.stored !== null && !r.match).map((r) => r.rel);
    expect(declaredButStale).toEqual([]);
  });
});
