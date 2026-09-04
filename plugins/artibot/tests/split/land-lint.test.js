/**
 * `scripts/split/land.mjs` — the `lint` row (gotchas #25).
 *
 * WHY THE ROW EXISTS: measured 2026-09-04, a limb reported `land` 6/6 PASS
 * while eslint on the same diff had 3 errors and 2 warnings. CI runs
 * `eslint . --max-warnings=0`, so the batch was one landing from a red
 * pipeline and the checklist said nothing.
 *
 * These cases inject both runners, so they assert the ROW's decision table and
 * nothing else — no eslint process is started and no repository is read. The
 * end-to-end proof (real git repo, real eslint, one violation -> FAIL exit 1,
 * zero -> PASS exit 0) was run by hand on 2026-09-04 and is quoted in the
 * commit message; it is not automated here because it needs `node_modules`
 * inside the plugin root, which a clean CI checkout of `tests/` alone does not
 * guarantee.
 *
 * WHAT THESE CASES CANNOT SEE:
 *   - that eslint's own exit codes mean what we assume (0 clean, non-zero not);
 *   - that the diff names arrive `-z`-separated from a real git (the harness
 *     above covered that once, this file hard-codes the shape);
 *   - that the working tree eslint reads is the limb's tree — `lintCheck`'s
 *     header states that gap rather than closing it.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintCheck } from '../../scripts/split/land.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** git stub: NUL-separated names, the shape `--name-only -z` really emits. */
const diffOf = (...names) => () => ({ status: 0, stdout: names.map((n) => `${n}\0`).join(''), stderr: '' });
const okSpawn = () => ({ status: 0, stdout: '', stderr: '' });
const dirtySpawn = () => ({ status: 1, stdout: "  1:7  error  'x' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n", stderr: '' });

const run = (exec, spawn, pluginRoot = PLUGIN_ROOT) => lintCheck({
  cwd: '/repo', base: 'base', branch: 'worktree-split-rr-x', exec, spawn, pluginRoot,
});

describe('land — lint row', () => {
  it('passes with a SKIP detail when the limb changed no .js/.mjs', () => {
    const r = run(diffOf('docs/a.md', 'plugins/artibot/commands/split.md'), () => {
      throw new Error('eslint must not be spawned when there is nothing to lint');
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('SKIP');
  });

  it('passes when eslint exits 0', () => {
    const r = run(diffOf('plugins/artibot/lib/a.js', 'plugins/artibot/scripts/b.mjs'), okSpawn);
    expect(r).toMatchObject({ id: 'lint', ok: true });
    expect(r.detail).toContain('2파일');
  });

  it('fails when eslint exits non-zero, and quotes the tail of its output', () => {
    const r = run(diffOf('plugins/artibot/lib/a.js'), dirtySpawn);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('1 error');
  });

  it('is UNSUPPORTED — not PASS — when eslint is absent', () => {
    // The failure mode this guards: `check-unused-ratchet` once printed
    // "Baseline tightened 59 -> 0. PASS." when node_modules was missing,
    // destroying its own baseline while reporting success. Fail closed.
    const r = run(diffOf('plugins/artibot/lib/a.js'), okSpawn, '/nonexistent-plugin-root');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
  });

  it('is UNSUPPORTED when the diff itself fails, rather than reporting a clean lint', () => {
    const r = run(() => ({ status: 128, stdout: '', stderr: "fatal: bad revision 'base'\n" }), okSpawn);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
  });

  it('counts only files under plugins/artibot/ and says so for the rest', () => {
    // CI's lint script is plugin-scoped, so a file outside it is genuinely
    // unchecked by CI too. The row reports the gap instead of implying cover.
    let seen = null;
    const r = run(
      diffOf('plugins/artibot/lib/a.js', 'plugins/artibot-cowork/scripts/release.js', 'scripts/ci/x.mjs'),
      (_bin, args) => { seen = args; return { status: 0, stdout: '', stderr: '' }; },
    );
    expect(r.ok).toBe(true);
    expect(seen.filter((a) => a !== '--max-warnings=0' && a.endsWith('.js'))).toContain('lib/a.js');
    expect(r.detail).toContain('플러그인 밖 2건 미검사');
  });

  it('ignores non-JS extensions inside the plugin', () => {
    const r = run(diffOf('plugins/artibot/lib/a.json', 'plugins/artibot/README.md'), () => {
      throw new Error('eslint must not be spawned for json/md');
    });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('SKIP');
  });

  it('asks git for -z output (Korean paths + core.quotepath default)', () => {
    let argv = null;
    run((args) => { argv = args; return { status: 0, stdout: '', stderr: '' }; }, okSpawn);
    expect(argv).toContain('-z');
    expect(argv).toContain('--name-only');
  });
});
