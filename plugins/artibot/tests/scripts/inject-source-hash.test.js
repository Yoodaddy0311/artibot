/**
 * scripts/inject-source-hash.js#injectSourceHashes — the write outcome.
 *
 * `scripts/utils/index.js#atomicWriteSync` stopped throwing in the 2026-11-21 review (M4)
 * and answers false instead. This script ignored the answer, so a SKILL.md whose rewrite
 * never landed was still counted in the `update` row and missing from `error` (review
 * follow-up, "atomicWriteSync return value ignored" x4). These cases pin that a false
 * answer is an `error` row naming the skill, and never an `update`.
 *
 * HOW A FAILURE IS PRODUCED: `node:fs#renameSync` is wrapped so a rename onto the one path
 * in `failing.renameTo` throws a non-transient `EIO` (no retry budget spent) — the
 * technique of tests/core/atomic-write-honest-result.test.js. The read side
 * (`node:fs/promises`) is real, so the skill is read and hashed for real.
 *
 * EXIT CODE (owner decision 2026-11-22, same rule as migrate-command-toolsets): `main` answers
 * 1 when at least one SKILL.md was not written; a read error alone stays 0, the script's
 * long-standing convention. No CI, release or npm script runs this file (repo-wide grep,
 * 2026-11-22), so the 1 breaks no pipeline.
 *
 * WHAT THIS DOES NOT SEE: the one line that hands `main`'s answer to `process.exitCode`
 * (the CLI reads the real skills/, so it is not run here), a real Windows sharing violation
 * (an EPERM that clears inside the retry budget is a success), and the real skills/ (every
 * case uses a mkdtemp skills dir).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failing = vi.hoisted(() => ({ renameTo: null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const renameSync = (from, to) => {
    if (failing.renameTo !== null && String(to) === failing.renameTo) {
      throw Object.assign(new Error(`EIO: injected rename failure -> ${to}`), { code: 'EIO' });
    }
    return actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

const { injectSourceHashes, main } = await import('../../scripts/inject-source-hash.js');

const BODY = '---\nname: demo\ndescription: demo skill\n---\n\n# Demo\n\nBody text.\n';

let dir;
let out;
let outSpy;
let errSpy;

/** Create `<dir>/<name>/SKILL.md` with a stale (absent) source_hash. */
function addSkill(name) {
  mkdirSync(path.join(dir, name));
  const file = path.join(dir, name, 'SKILL.md');
  writeFileSync(file, BODY);
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-inject-hash-'));
  out = [];
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  failing.renameTo = null;
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('injectSourceHashes', () => {
  it('writes source_hash and counts an update when the write lands', async () => {
    const file = addSkill('ok-skill');

    const results = await injectSourceHashes({ skillsDir: dir });

    expect(results).toMatchObject({ update: 1, skip: 0, error: 0 });
    expect(readFileSync(file, 'utf8')).toMatch(/^source_hash: [0-9a-f]+$/m);
  });

  it('counts a skill whose rewrite did not land as an error naming it, never as an update', async () => {
    const file = addSkill('stuck-skill');
    failing.renameTo = file;

    const results = await injectSourceHashes({ skillsDir: dir });

    expect(results).toMatchObject({ update: 0, skip: 0, error: 1 });
    expect(results.errors).toHaveLength(1);
    expect(results.errors[0]).toMatch(/^stuck-skill: .*not written/);
    expect(readFileSync(file, 'utf8')).toBe(BODY);
    const report = out.join('');
    expect(report).toContain('| update | 0 |');
    expect(report).toContain('| error  | 1 |');
    expect(report).toContain('- stuck-skill: ');
  });

  it('keeps counting the other skills after one write fails', async () => {
    const stuck = addSkill('a-stuck');
    const ok = addSkill('b-ok');
    failing.renameTo = stuck;

    const results = await injectSourceHashes({ skillsDir: dir });

    expect(results).toMatchObject({ update: 1, error: 1 });
    expect(readFileSync(ok, 'utf8')).toMatch(/^source_hash: /m);
  });

  it('counts a would-be update and writes nothing on a dry run', async () => {
    const file = addSkill('dry-skill');

    const results = await injectSourceHashes({ skillsDir: dir, dryRun: true });

    expect(results).toMatchObject({ update: 1, error: 0 });
    expect(readFileSync(file, 'utf8')).toBe(BODY);
  });

  it('skips a skill whose hash is already current', async () => {
    const file = addSkill('fresh-skill');
    await injectSourceHashes({ skillsDir: dir });
    const written = readFileSync(file, 'utf8');

    const results = await injectSourceHashes({ skillsDir: dir });

    expect(results).toMatchObject({ update: 0, skip: 1, error: 0 });
    expect(readFileSync(file, 'utf8')).toBe(written);
  });
});

describe('main — CLI exit code', () => {
  /** A skill directory with no SKILL.md: the read fails (ENOENT) and lands in the error row. */
  function addUnreadableSkill(name) {
    mkdirSync(path.join(dir, name));
  }

  it('answers 1 when a SKILL.md was not written', async () => {
    failing.renameTo = addSkill('stuck-skill');

    expect(await main({ argv: [], skillsDir: dir })).toBe(1);
  });

  it('answers 1 when a write failure sits next to a read error', async () => {
    addUnreadableSkill('a-no-file');
    failing.renameTo = addSkill('b-stuck');

    expect(await main({ argv: [], skillsDir: dir })).toBe(1);
  });

  it('answers 0 when the only error is a read error (long-standing convention)', async () => {
    addUnreadableSkill('no-file');
    addSkill('ok-skill');

    const code = await main({ argv: [], skillsDir: dir });

    expect(code).toBe(0);
    expect(out.join('')).toContain('| error  | 1 |');
  });

  it('answers 0 on a clean run', async () => {
    addSkill('ok-skill');

    expect(await main({ argv: [], skillsDir: dir })).toBe(0);
  });

  it('answers 0 on a dry run, which writes nothing and so cannot fail a write', async () => {
    failing.renameTo = addSkill('dry-skill');

    expect(await main({ argv: ['--dry-run'], skillsDir: dir })).toBe(0);
    expect(readFileSync(failing.renameTo, 'utf8')).toBe(BODY);
  });
});
