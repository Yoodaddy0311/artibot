/**
 * scripts/migrate-command-toolsets.js#migrateCommandToolsets — the write outcome.
 *
 * `scripts/utils/index.js#atomicWriteSync` stopped throwing in the 2026-11-21 review (M4)
 * and answers false instead. The migration ignored the answer: a command file whose write
 * never landed was still tallied as `insert`/`create` in the report and the process exited 0
 * (review follow-up, "atomicWriteSync return value ignored" x4). These cases pin that a false
 * answer is a `failed` row and a `failed=` total, and that the result says `ok: false`.
 *
 * HOW A FAILURE IS PRODUCED: `node:fs#renameSync` is wrapped so a rename onto the one path in
 * `failing.renameTo` throws a non-transient `EIO` (no retry budget spent) — the technique of
 * tests/core/atomic-write-honest-result.test.js. Reads are real.
 *
 * WHAT THIS DOES NOT SEE: the CLI's `process.exit(ok ? 0 : 1)` line itself (main() reads the
 * real commands/, so it is not run here), and the real commands/ and toolsets.json (every
 * case uses a mkdtemp copy-free fixture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const { migrateCommandToolsets } = await import('../../scripts/migrate-command-toolsets.js');

const WITH_FM = '---\ndescription: has frontmatter\n---\n\n# Body\n';
const NO_FM = '# No frontmatter\n';

let dir;
let commandsDir;
let toolsetsPath;
let log;
let logSpy;
let warnSpy;
let errSpy;

/** Write `<commandsDir>/<slug>.md` and return its path. */
function addCommand(slug, text) {
  const file = path.join(commandsDir, `${slug}.md`);
  writeFileSync(file, text);
  return file;
}

function run(extra = {}) {
  return migrateCommandToolsets({ commandsDir, toolsetsPath, ...extra });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-migrate-toolsets-'));
  commandsDir = dir;
  toolsetsPath = path.join(dir, 'toolsets.json');
  writeFileSync(toolsetsPath, JSON.stringify({ toolsets: { core: { commands: ['alpha', 'beta'] } } }));
  log = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { log.push(a.join(' ')); });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  failing.renameTo = null;
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrateCommandToolsets', () => {
  it('inserts toolset: and reports insert when the write lands', () => {
    const file = addCommand('alpha', WITH_FM);

    const result = run();

    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ insert: 1, failed: 0 });
    expect(readFileSync(file, 'utf8')).toContain('toolset: core\n---');
    expect(log.join('\n')).toContain('| alpha | core | insert |');
  });

  it('reports an insert whose write did not land as failed, with ok false and the file untouched', () => {
    const file = addCommand('alpha', WITH_FM);
    failing.renameTo = file;

    const result = run();

    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({ insert: 0, failed: 1 });
    expect(result.rows).toEqual([{ command: 'alpha', toolset: 'core', action: 'failed' }]);
    expect(readFileSync(file, 'utf8')).toBe(WITH_FM);
    const report = log.join('\n');
    expect(report).toContain('| alpha | core | failed |');
    expect(report).toMatch(/Totals: insert=0, .*failed=1/);
  });

  it('reports a create whose write did not land as failed, and still migrates the next file', () => {
    const stuck = addCommand('alpha', NO_FM);
    const ok = addCommand('beta', NO_FM);
    failing.renameTo = stuck;

    const result = run();

    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({ create: 1, failed: 1 });
    expect(readFileSync(stuck, 'utf8')).toBe(NO_FM);
    expect(readFileSync(ok, 'utf8')).toMatch(/^---\ntoolset: core\n---\n/);
  });

  it('counts a skip as success and writes nothing for a file that already has toolset:', () => {
    const text = '---\ntoolset: core\n---\n# Body\n';
    const file = addCommand('alpha', text);
    failing.renameTo = file;

    const result = run();

    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ skip: 1, failed: 0 });
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('counts a would-be insert and writes nothing on a dry run', () => {
    const file = addCommand('alpha', WITH_FM);

    const result = run({ dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ insert: 1, failed: 0 });
    expect(readFileSync(file, 'utf8')).toBe(WITH_FM);
  });
});
