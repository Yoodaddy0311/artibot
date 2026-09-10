/**
 * `scripts/split/land.mjs` — the `lint` row (gotchas #25, #G14).
 *
 * WHY THE ROW EXISTS: measured 2026-09-04, a limb reported `land` 6/6 PASS
 * while eslint on the same diff had 3 errors and 2 warnings. CI runs
 * `eslint . --max-warnings=0`, so the batch was one landing from a red
 * pipeline and the checklist said nothing.
 *
 * TWO LAYERS HERE, and the second exists because the first was not enough:
 *
 *   1. `land — lint row` injects both runners, so those cases assert the ROW's
 *      decision table and nothing else — no eslint process is started and no
 *      repository is read.
 *   2. `land — lint row (end-to-end)` builds a throwaway git repo in a temp dir
 *      and runs the REAL git and the REAL eslint against a REAL second
 *      checkout. Until 2026-09-10 this layer did not exist, and its absence is
 *      exactly what hid #G14: the row spawned eslint in the runner's own plugin
 *      root instead of the limb's worktree, so it linted the parent's bytes.
 *      A decision-table test cannot see that, because in it the cwd is a string
 *      nobody dereferences.
 *
 * THE TWO SYMPTOMS HAVE A CASE EACH, because one fixture cannot show both:
 *   (1) PASS leak — the limb only MODIFIES a file, so the parent's copy is
 *       lintable and clean and the wrong answer looks like a right one. Quiet,
 *       and the reason the row was trusted.
 *   (2) FAIL false positive — the limb ADDS a file, which does not resolve in
 *       the parent tree, so eslint exits 2 ("No files matching the pattern").
 *       Loud: reports/SPLIT/split-5f9fe3.md recorded 3/5 limbs hitting it.
 *   Adding a file makes (2) fire first and mask (1), which is why the leak case
 *   passes `churn: false`.
 *
 * WHAT THESE CASES STILL CANNOT SEE:
 *   - that CI's real `eslint.config.js` and this repo's rule set agree with the
 *     minimal config the e2e fixture writes (the fixture proves plumbing —
 *     which tree is read — not rule parity);
 *   - anything eslint is configured to ignore, or any file outside
 *     `plugins/artibot/` (CI's lint script is plugin-scoped too);
 *   - a real split worktree whose own `node_modules` junction is MISSING. The
 *     row turns eslint's exit code 2 into UNSUPPORTED rather than predicting
 *     that failure, so it is reported, never silently passed, but only the
 *     stubbed case covers it — the e2e configs need no packages.
 */

import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintCheck } from '../../scripts/split/land.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** A real directory, so the row's "does the worktree exist" guard is satisfied. */
const WT = path.resolve(PLUGIN_ROOT, '..', '..');
const BRANCH = 'worktree-split-rr-x';

/** git stub: NUL-separated names, the shape `--name-only -z` really emits. */
const diffOf = (...names) => () => ({ status: 0, stdout: names.map((n) => `${n}\0`).join(''), stderr: '' });
const okSpawn = () => ({ status: 0, stdout: '', stderr: '' });
const dirtySpawn = () => ({ status: 1, stdout: "  1:7  error  'x' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n", stderr: '' });

/**
 * The shape `rev-parse HEAD --abbrev-ref HEAD` really emits: sha, then name.
 * Built rather than written out because a 40-char hex literal trips the
 * repository's hardcoded-secret scanner.
 */
const HEAD_SHA = '5fec030ae904'.padEnd(40, '0');

/**
 * @param {Function} exec - stub for the `diff` call only; `rev-parse` is answered here
 * @param {Function} [spawn]
 * @param {string} [pluginRoot]
 * @param {{ head?: string, headSha?: string, headFail?: boolean,
 *           dirty?: string[], statusFail?: boolean,
 *           worktreePath?: string|undefined }} [opts]
 */
const run = (exec, spawn, pluginRoot = PLUGIN_ROOT, opts = {}) => lintCheck({
  cwd: '/repo',
  base: 'base',
  branch: BRANCH,
  worktreePath: 'worktreePath' in opts ? opts.worktreePath : WT,
  exec: (args, o) => {
    if (args[0] === 'rev-parse') {
      if (opts.headFail) return { status: 128, stdout: '', stderr: 'fatal: not a git repository\n' };
      return { status: 0, stdout: `${opts.headSha ?? HEAD_SHA}\n${opts.head ?? BRANCH}\n`, stderr: '' };
    }
    // A clean worktree by default, so every other case keeps its old meaning.
    if (args[0] === 'status') {
      if (opts.statusFail) return { status: 128, stdout: '', stderr: 'fatal: bad pathspec\n' };
      return { status: 0, stdout: (opts.dirty ?? []).map((e) => `${e}\0`).join(''), stderr: '' };
    }
    return exec(args, o);
  },
  spawn,
  pluginRoot,
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

  it('excludes deleted files from the diff (eslint errors on a path that is gone)', () => {
    // `git diff --name-only` lists deletions, and eslint given a path that no
    // longer exists in the limb tree exits 2 ("No files matching the pattern"),
    // which would read as a failure caused by a successful deletion.
    let argv = null;
    run((args) => { argv = args; return { status: 0, stdout: '', stderr: '' }; }, okSpawn);
    expect(argv).toContain('--diff-filter=d');
  });

  it('lints inside the limb worktree, not the checkout the runner was started from', () => {
    // #G14. eslint reads the WORKING TREE, so the cwd decides which bytes are
    // linted; the runner's own plugin root holds the parent's bytes.
    let cwd = null;
    const r = run(diffOf('plugins/artibot/lib/a.js'), (_bin, _args, o) => { cwd = o.cwd; return { status: 0, stdout: '', stderr: '' }; });
    expect(cwd).toBe(path.join(WT, 'plugins', 'artibot'));
    expect(r.detail).toContain(path.join(WT, 'plugins', 'artibot'));
  });

  it('is UNSUPPORTED when the plan entry carries no worktreePath', () => {
    // Falling back to the runner's root is precisely the #G14 defect, so a plan
    // that cannot say which tree to read fails closed instead.
    const r = run(diffOf('plugins/artibot/lib/a.js'), okSpawn, PLUGIN_ROOT, { worktreePath: undefined });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
    expect(r.detail).toContain('worktreePath');
  });

  it('still SKIPs when there is nothing to lint, even with no worktreePath', () => {
    // SKIP is decided before the worktree is validated, on purpose: with no
    // .js/.mjs in the diff, no working tree is read, so an unusable worktree
    // cannot make the answer wrong. Demanding one here would fail every
    // docs-only limb over a condition that cannot affect it.
    const r = run(diffOf('docs/a.md'), () => {
      throw new Error('eslint must not be spawned when there is nothing to lint');
    }, PLUGIN_ROOT, { worktreePath: '' });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('SKIP');
  });

  it('is UNSUPPORTED when the worktree directory does not exist', () => {
    const r = run(diffOf('plugins/artibot/lib/a.js'), okSpawn, PLUGIN_ROOT, { worktreePath: path.join(WT, 'no-such-worktree-G14') });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
  });

  it('is UNSUPPORTED when the worktree has some other branch checked out, and names the ref AND the sha', () => {
    // Both, because a detached worktree answers the ref name `HEAD`: without
    // the sha, two different wrong states print the same word and the table
    // cannot tell them apart.
    const r = run(diffOf('plugins/artibot/lib/a.js'), okSpawn, PLUGIN_ROOT, { head: 'master' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
    expect(r.detail).toContain('master');
    expect(r.detail).toContain(HEAD_SHA.slice(0, 12));
    expect(r.detail).not.toContain(HEAD_SHA); // shortened, not the full 40
  });

  it('is UNSUPPORTED when the worktree HEAD cannot be read at all', () => {
    const r = run(diffOf('plugins/artibot/lib/a.js'), okSpawn, PLUGIN_ROOT, { headFail: true });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
    expect(r.detail).toContain('조회 실패');
  });

  it('is UNSUPPORTED when a file in the lint set has uncommitted changes', () => {
    // The right branch is not the right bytes. eslint reads the working tree,
    // so a limb whose BRANCH carries a violation would pass whenever its
    // worktree happens to hold a fixed copy — grading bytes that will never
    // land. Refused rather than graded.
    const r = run(diffOf('plugins/artibot/lib/a.js', 'plugins/artibot/lib/b.js'), okSpawn, PLUGIN_ROOT, {
      dirty: [' M plugins/artibot/lib/a.js'],
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
    expect(r.detail).toContain('미커밋');
    expect(r.detail).toContain('lib/a.js');
    // With a denominator: one dirty file out of a two-file lint set reads
    // differently from a wholly dirty tree, and the two lead somewhere different.
    expect(r.detail).toContain('린트 대상 2건 중 1건');
  });

  it('asks git status only about the files it is going to lint', () => {
    // Scope matters: unrelated dirt in the worktree is not this row's business,
    // and widening it would block landings for reasons the row cannot justify.
    let argv = null;
    run(diffOf('plugins/artibot/lib/a.js', 'plugins/artibot/scripts/b.mjs'), okSpawn, PLUGIN_ROOT, {
      dirty: [],
    });
    const orig = lintCheck({
      cwd: '/repo',
      base: 'base',
      branch: BRANCH,
      worktreePath: WT,
      exec: (args) => {
        if (args[0] === 'status') { argv = args; return { status: 0, stdout: '', stderr: '' }; }
        if (args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD_SHA}\n${BRANCH}\n`, stderr: '' };
        return { status: 0, stdout: 'plugins/artibot/lib/a.js\0plugins/artibot/scripts/b.mjs\0', stderr: '' };
      },
      spawn: okSpawn,
      pluginRoot: PLUGIN_ROOT,
    });
    expect(orig.ok).toBe(true);
    expect(argv).toContain('--untracked-files=no');
    expect(argv).toContain('-z');
    // Repo-relative paths, because the pathspec is resolved from the worktree root.
    expect(argv).toContain('plugins/artibot/lib/a.js');
    expect(argv).toContain('plugins/artibot/scripts/b.mjs');
  });

  it('is UNSUPPORTED when git status itself fails', () => {
    const r = run(diffOf('plugins/artibot/lib/a.js'), okSpawn, PLUGIN_ROOT, { statusFail: true });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
    expect(r.detail).toContain('status 조회 실패');
  });

  it('gives each UNSUPPORTED reason its own wording, so the table alone identifies it', () => {
    // The row is usually read as one line in a markdown table. Two reasons that
    // open the same way send the reader to the wrong place: a stale plan entry
    // and a missing eslint install need opposite fixes.
    const js = 'plugins/artibot/lib/a.js';
    const details = {
      diffFailed: run(() => ({ status: 128, stdout: '', stderr: "fatal: bad revision 'base'\n" }), okSpawn).detail,
      noWorktreePath: run(diffOf(js), okSpawn, PLUGIN_ROOT, { worktreePath: undefined }).detail,
      worktreeGone: run(diffOf(js), okSpawn, PLUGIN_ROOT, { worktreePath: path.join(WT, 'no-such-worktree-G14') }).detail,
      headUnreadable: run(diffOf(js), okSpawn, PLUGIN_ROOT, { headFail: true }).detail,
      headMismatch: run(diffOf(js), okSpawn, PLUGIN_ROOT, { head: 'master' }).detail,
      statusFailed: run(diffOf(js), okSpawn, PLUGIN_ROOT, { statusFail: true }).detail,
      worktreeDirty: run(diffOf(js), okSpawn, PLUGIN_ROOT, { dirty: [' M plugins/artibot/lib/a.js'] }).detail,
      eslintAbsent: run(diffOf(js), okSpawn, '/nonexistent-plugin-root').detail,
      eslintUnrunnable: run(diffOf(js), () => ({ error: new Error('spawn EINVAL') })).detail,
      eslintConfigError: run(diffOf(js), () => ({ status: 2, stdout: '', stderr: "Cannot find package 'globals'\n" })).detail,
    };
    const marker = 'UNSUPPORTED — ';

    // Every one of them is UNSUPPORTED, and none is a pass.
    for (const [reason, detail] of Object.entries(details)) {
      expect(detail, reason).toContain(marker);
    }

    // Each carries the word that tells the reader which thing to go fix.
    expect(details.diffFailed).toContain('git diff');
    expect(details.noWorktreePath).toContain('plan limbs[]');
    expect(details.worktreeGone).toContain('디렉터리 없음');
    expect(details.headUnreadable).toContain('조회 실패');
    expect(details.headMismatch).toContain('불일치');
    expect(details.statusFailed).toContain('status 조회 실패');
    expect(details.worktreeDirty).toContain('미커밋');
    expect(details.eslintAbsent).toContain('eslint 없음');
    expect(details.eslintUnrunnable).toContain('실행 실패');
    expect(details.eslintConfigError).toContain('설정/입력 오류');

    // And no two of them open alike — the discriminator has to land early,
    // because the detail column is what gets truncated.
    const openings = Object.values(details).map((d) => d.split(marker)[1].slice(0, 12));
    expect(new Set(openings).size).toBe(openings.length);
  });

  it('is UNSUPPORTED — not a lint failure — when eslint exits 2 (config or input error)', () => {
    // Exit 2 is eslint's "configuration problem or internal error" (measured
    // 2026-09-10, eslint 10.2.1): a missing node_modules next to the worktree's
    // eslint.config.js lands here, and so does a path eslint cannot resolve.
    // Reporting it as a lint failure would blame the limb for a runner problem.
    const r = run(diffOf('plugins/artibot/lib/a.js'), () => ({ status: 2, stdout: '', stderr: 'Cannot find package \'globals\'\n' }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real git, real eslint, a real second checkout.
// ---------------------------------------------------------------------------

const ESLINT_BIN = path.join(PLUGIN_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const HAVE_ESLINT = fs.existsSync(ESLINT_BIN);
const E2E_BRANCH = 'worktree-split-e2e';
/** @type {string[]} */
const tmpDirs = [];
/**
 * Junctions into the REAL node_modules, each with the temp root that holds it.
 * Removed by link, never by recursion.
 * @type {{ link: string, tmp: string }[]}
 */
const junctions = [];

// `stdio: pipe` on all three: execFileSync inherits stderr by default, and git
// narrates every checkout plus a CRLF warning per file into the test output.
// A throw still carries the captured stderr on the error object.
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});

/**
 * Build a throwaway repo: a base commit, a limb branch, and a second checkout
 * with the limb branch on it. The primary checkout stays on the base branch —
 * that is the shape the runner sees (invoked from the parent on master).
 *
 * `churn` decides which #G14 symptom the fixture can express. With it on, the
 * limb also ADDS `lib/new.js` and DELETES `lib/gone.js` — paths that do not
 * resolve in the parent tree, which is symptom (2), the FAIL false positive.
 * With it OFF the limb only MODIFIES a file the parent also has, so every
 * linted path resolves in both trees: that is the only shape in which symptom
 * (1), the silent PASS, can be observed, because the parent's copy has to be
 * lintable and clean for the wrong answer to look like a right one.
 *
 * `junction` links the fixture's own `plugins/artibot/node_modules` at the real
 * one, so the fixture's parent can be handed in as `pluginRoot` — i.e. eslint
 * is found exactly where the pre-fix code found it, and only the tree being
 * read differs.
 *
 * @param {{ violation: boolean, churn?: boolean, junction?: boolean }} p
 * @returns {{ parent: string, worktree: string, parentPluginRoot: string }}
 */
function buildRepo({ violation, churn = true, junction = false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lgl-'));
  tmpDirs.push(tmp);
  const parent = path.join(tmp, 'r');
  const lib = path.join(parent, 'plugins', 'artibot', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  git(tmp, 'init', '-b', 'main', 'r');
  git(parent, 'config', 'user.email', 'e2e@example.invalid');
  git(parent, 'config', 'user.name', 'e2e');
  git(parent, 'config', 'commit.gpgsign', 'false');
  // No node_modules import: the row must not require one to load a config.
  fs.writeFileSync(path.join(parent, 'plugins', 'artibot', 'eslint.config.js'), "export default [{ rules: { 'no-unused-vars': 'error' } }];\n");
  fs.writeFileSync(path.join(lib, 'a.js'), 'export const y = 2;\n');
  fs.writeFileSync(path.join(lib, 'gone.js'), 'export const g = 1;\n');
  git(parent, 'add', '-A');
  git(parent, 'commit', '-m', 'base');

  git(parent, 'checkout', '-b', E2E_BRANCH);
  fs.writeFileSync(path.join(lib, 'a.js'), violation ? 'const x = 1;\nexport const y = 2;\n' : 'export const y = 3;\n');
  if (churn) {
    fs.writeFileSync(path.join(lib, 'new.js'), 'export const n = 1;\n');
    fs.rmSync(path.join(lib, 'gone.js'));
  }
  git(parent, 'add', '-A');
  git(parent, 'commit', '-m', 'limb');
  git(parent, 'checkout', 'main');

  const worktree = path.join(tmp, 'w');
  git(parent, 'worktree', 'add', worktree, E2E_BRANCH);

  // After every git command, so `add -A` never sees the link.
  const parentPluginRoot = path.join(parent, 'plugins', 'artibot');
  if (junction) {
    const link = path.join(parentPluginRoot, 'node_modules');
    fs.symlinkSync(path.join(PLUGIN_ROOT, 'node_modules'), link, 'junction');
    junctions.push({ link, tmp });
  }
  return { parent, worktree, parentPluginRoot };
}

afterAll(() => {
  // Junctions FIRST, by link. Measured on Node 24.15.0/Windows, `fs.rmSync`
  // recursive does not follow a junction and `fs.rmdirSync` removes the link
  // while the target survives — but the downside of being wrong here is the
  // real node_modules, so the link is severed before anything recurses, and a
  // failure to sever it skips the recursive delete rather than risking it.
  const stuck = new Set();
  for (const { link, tmp } of junctions) {
    try {
      // Windows: `symlinkSync(..., 'junction')` makes a real junction, removed
      // by rmdir. Elsewhere the type is ignored and it is an ordinary symlink,
      // where rmdir is ENOTDIR — CI is Linux, so without the retry every run
      // would leave its temp dirs behind.
      fs.rmdirSync(link);
    } catch {
      try {
        fs.unlinkSync(link);
      } catch {
        stuck.add(tmp);
      }
    }
  }
  for (const d of tmpDirs) {
    if (stuck.has(d)) continue;
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* a temp dir left behind is not a test failure */ }
  }
});

describe.skipIf(!HAVE_ESLINT)('land — lint row (end-to-end)', () => {
  it('catches a violation that exists only on the limb branch', () => {
    const { parent, worktree } = buildRepo({ violation: true });
    const r = lintCheck({ cwd: parent, base: 'main', branch: E2E_BRANCH, worktreePath: worktree });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no-unused-vars');
  }, 120000);

  it('passes a clean limb, including its new and deleted files', () => {
    // Positive control. `lib/new.js` does not exist in the parent checkout and
    // `lib/gone.js` no longer exists on the limb; either one used to turn a
    // clean limb into a FAIL row.
    const { parent, worktree } = buildRepo({ violation: false });
    const r = lintCheck({ cwd: parent, base: 'main', branch: E2E_BRANCH, worktreePath: worktree });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('0 errors 0 warnings');
  }, 120000);

  it('PASS leak (#G14 symptom 1): a limb-only violation whose parent copy is clean', () => {
    // The quieter of the two symptoms, and the one the brief's completion
    // criterion names. `churn: false` means the limb only MODIFIES `lib/a.js`,
    // so that path resolves in BOTH trees — eslint run against the parent
    // therefore succeeds and the row used to say PASS with nothing to hint at
    // the mistake. `junction: true` puts a real node_modules next to the
    // fixture's parent so it can serve as `pluginRoot`: the binary is then
    // found exactly where the pre-fix code found it and the ONLY difference
    // left is which working tree gets read.
    const { parent, worktree, parentPluginRoot } = buildRepo({ violation: true, churn: false, junction: true });

    // Witness for the counterfactual. Without this the leak is invisible: a
    // FAIL row proves nothing unless the wrong tree is shown to be clean.
    const parentCopy = spawnSync(process.execPath, [ESLINT_BIN, '--max-warnings=0', 'lib/a.js'], {
      cwd: parentPluginRoot, encoding: 'utf-8', windowsHide: true,
    });
    expect(parentCopy.status).toBe(0);

    // Same pluginRoot, limb worktree: the violation is seen.
    const limb = lintCheck({
      cwd: parent, base: 'main', branch: E2E_BRANCH, worktreePath: worktree, pluginRoot: parentPluginRoot,
    });
    expect(limb.ok).toBe(false);
    expect(limb.detail).toContain('no-unused-vars');

    // Same pluginRoot, parent tree: refused outright. The clean bytes the old
    // row would have graded are now unreachable, not merely unlikely.
    const wrongTree = lintCheck({
      cwd: parent, base: 'main', branch: E2E_BRANCH, worktreePath: parent, pluginRoot: parentPluginRoot,
    });
    expect(wrongTree.ok).toBe(false);
    expect(wrongTree.detail).toContain('UNSUPPORTED');
  }, 120000);

  it('refuses a worktree whose uncommitted copy hides the branch violation', () => {
    // The dirty-worktree hole, end to end: the BRANCH carries the violation,
    // the worktree holds a fixed copy that was never committed. eslint reads
    // the working tree, so it sees the fix and the row would report a clean
    // limb that is about to land a broken one.
    const { parent, worktree } = buildRepo({ violation: true, churn: false });
    const wtFile = path.join(worktree, 'plugins', 'artibot', 'lib', 'a.js');
    fs.writeFileSync(wtFile, 'export const y = 2;\n'); // the violation, undone but uncommitted

    // Control: the bytes on disk really are clean now, so a row that graded
    // them would say PASS.
    const onDisk = spawnSync(process.execPath, [ESLINT_BIN, '--max-warnings=0', 'lib/a.js'], {
      cwd: path.join(worktree, 'plugins', 'artibot'), encoding: 'utf-8', windowsHide: true,
    });
    expect(onDisk.status).toBe(0);

    const r = lintCheck({ cwd: parent, base: 'main', branch: E2E_BRANCH, worktreePath: worktree });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
    expect(r.detail).toContain('미커밋');
  }, 120000);

  it('is UNSUPPORTED when the given worktree has the base checked out', () => {
    // Pointing at the parent checkout is the #G14 configuration; the row now
    // refuses it instead of reporting on the wrong bytes.
    const { parent } = buildRepo({ violation: true });
    const r = lintCheck({ cwd: parent, base: 'main', branch: E2E_BRANCH, worktreePath: parent });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('UNSUPPORTED');
    expect(r.detail).toContain('main');
  }, 120000);
});
