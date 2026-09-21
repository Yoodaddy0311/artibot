/**
 * Firewall — untracked `.artibot/missions/` vs. the repo's clean-tree gates.
 *
 * 무엇을 재는가: 미추적 `.artibot/missions/` 가 실제 git 리포에 있을 때
 *   1) autopilot preflight 의 `gitClean` 이 warn 인가 fail 인가 (실측),
 *   2) split 의 줄기 착지 검사 6행이 missions 유무에 영향을 받는가 (실측),
 *   3) `land.mjs` 의 lint 행이 status 를 부를 때 미추적을 제외하는가 (실호출).
 * 대조군 없이 A 하나만 재면 아무것도 증명하지 못하므로, 같은 경로를 커밋한
 * 경우(B1)와 무시 규칙을 넣은 경우(B2)를 양성 대조로 함께 잰다.
 *
 * 이 게이트가 못 보는 것 (rules §9 — 적어두지 않으면 게이트 자체가 착시가 된다):
 *   - preflight 밖의 다른 clean-tree 소비처. 이 파일은 preflight·limb-landing·
 *     land.mjs 세 곳만 잰다. 훅(stop-recap, git-autopilot-save/close),
 *     `scripts/update-git.js#stashIfDirty`(`--include-untracked` 로 stash 한다),
 *     `lib/autopilot/worktree-manager.js#describeWorktreeHead`,
 *     `scripts/split/watch.mjs`, `lib/handoff/*`, `scripts/update-marketplace.js`,
 *     `scripts/cron/auto-commit-runner.js` 는 여기서 재지 않는다 — 미확인.
 *   - 특히 `plugins/artibot-cowork/scripts/release.js#validateGitState`. 소스 대조로는
 *     porcelain 둘째 열이 공백이 아닌 줄을 전부 unstaged 로 보아 exit 1 을 낸다 —
 *     미추적 missions 를 실제로 **막는** 것으로 보이는 유일한 소비처인데, 이 파일은
 *     그것을 실행하지 않는다(2026-09-21 기준 실행 재현 미확인).
 *   - 라이브 `.artibot/missions/` 의 실제 크기·중첩·파일 수. 픽스처는 파일 1~2개다.
 *     픽스처 크기가 현실과 다르면 성능·대량 경로에 대해서는 아무 말도 하지 않는다.
 *   - 정책 자체(missions 를 추적할 것인가 무시할 것인가). 이 파일은 현 상태를
 *     기록만 하며, warn 이 옳은 설계인지 판단하지 않는다.
 *   - `runPreflight` 전체 배터리. `lockFree`·`repoConcurrency` 는 실제 lock 스토어를
 *     읽고 `diskSpace` 는 실제 볼륨을 읽으므로 hermetic 하지 않다 → 여기서는
 *     `runIndividualCheck` 만 쓴다. 따라서 "gitClean 때문에 ok=false 가 되지
 *     않는다" 는 소스 대조(fail 분기 부재)로만 뒷받침되고 배터리 실행으로는 미확인.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIndividualCheck } from '../../lib/autopilot/preflight.js';
import { checkLimbLanding } from '../../lib/git/limb-landing-check.js';
import { lintCheck } from '../../scripts/split/land.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAND_SRC = path.resolve(HERE, '../../scripts/split/land.mjs');

// A worktree-isolated shell can export GIT_DIR / GIT_WORK_TREE; either would
// point every temp-repo command back at the real repository. `tests/git/
// limb-landing-check.test.js` does NOT scrub these (measured 2026-09-21) — it
// relies on them being unset. This file does not rely on that.
const GIT_ENV = { ...process.env };
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GIT_INDEX_FILE;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

/** Raw (untrimmed) porcelain — the thing every consumer actually parses. */
function porcelain(cwd) {
  return git(['status', '--porcelain'], cwd);
}

function initRepo(prefix, repoRootGitignore) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(['init', '-q', '-b', 'main', '.'], dir);
  git(['config', 'user.email', 'test@example.invalid'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  // The real root ignore file, byte for byte: measuring under a different rule
  // set would measure a repository that does not exist.
  fsSync.copyFileSync(repoRootGitignore, path.join(dir, '.gitignore'));
  fsSync.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(['add', '.gitignore', 'seed.txt'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function writeMission(repo, id) {
  const dir = path.join(repo, '.artibot', 'missions', id);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, 'intent.md'), `# ${id}\n\nprobe fixture\n`);
  return path.posix.join('.artibot', 'missions', id, 'intent.md');
}

let repoRootGitignore = '';
let repoA = '';
let repoC = '';
/** Every temp repo made here, removed in afterAll. */
const madeRepos = [];

/** A fresh repo per case — no test depends on another's leftover state. */
function freshRepo(prefix) {
  const dir = initRepo(prefix, repoRootGitignore);
  madeRepos.push(dir);
  return dir;
}

beforeAll(() => {
  const top = git(['rev-parse', '--show-toplevel'], HERE).trim();
  repoRootGitignore = path.join(top, '.gitignore');
  // Fail loudly rather than silently measuring an empty rule set.
  expect(fsSync.existsSync(repoRootGitignore)).toBe(true);

  repoA = freshRepo('artibot-missions-preflight-');
  repoC = freshRepo('artibot-missions-landing-');
});

afterAll(() => {
  for (const d of madeRepos) {
    if (d) fsSync.rmSync(d, { recursive: true, force: true });
  }
});

describe('missions vs. autopilot preflight gitClean', () => {
  it('A — untracked missions make the tree dirty and gitClean warns (not fail)', () => {
    writeMission(repoA, 'm-0001');
    const caseAPorcelain = porcelain(repoA);

    // Recorded verbatim in the limb report. Git collapses a wholly-untracked
    // directory to one entry, so the exact spelling is asserted loosely on the
    // path but strictly on "not empty" and "one entry".
    expect(caseAPorcelain.trim()).not.toBe('');
    const entries = caseAPorcelain.trim().split('\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].startsWith('??')).toBe(true);
    expect(entries[0]).toContain('.artibot');

    const r = runIndividualCheck('gitClean', { cwd: repoA });
    expect(r.name).toBe('gitClean');
    expect(r.status).toBe('warn');
    expect(r.status).not.toBe('fail');
    expect(r.detail).toMatch(/dirty path\(s\)/);
  });

  it('A3 — with a tracked sibling under .artibot (the real repo shape) the entry is the missions dir', () => {
    // Case A's `?? .artibot/` spelling is a fixture artifact: there the whole
    // directory is untracked. The real repository tracks other files under it,
    // so git cannot collapse that far. Same verdict, different spelling.
    const repo = freshRepo('artibot-missions-a3-');
    fsSync.mkdirSync(path.join(repo, '.artibot'), { recursive: true });
    fsSync.writeFileSync(path.join(repo, '.artibot', 'project.md'), '# project\n');
    git(['add', '.artibot/project.md'], repo);
    git(['commit', '-q', '-m', 'chore: track project.md'], repo);

    writeMission(repo, 'm-0001');
    expect(porcelain(repo)).toBe('?? .artibot/missions/\n');
    expect(runIndividualCheck('gitClean', { cwd: repo }).status).toBe('warn');
  });

  it('A2 — a git failure also degrades to warn, never fail', () => {
    const r = runIndividualCheck('gitClean', { cwd: repoA }, {
      gitRunner: () => { throw new Error('git unavailable in probe'); },
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('git unavailable in probe');
  });

  it('B1 — positive control: committing the same path makes gitClean pass', () => {
    const repo = freshRepo('artibot-missions-b1-');
    writeMission(repo, 'm-0001');
    expect(porcelain(repo).trim()).not.toBe('');

    git(['add', '.artibot'], repo);
    git(['commit', '-q', '-m', 'chore: track mission m-0001'], repo);

    expect(porcelain(repo).trim()).toBe('');
    expect(runIndividualCheck('gitClean', { cwd: repo }).status).toBe('pass');
  });

  it('B2 — positive control: an ignore rule makes an untracked mission pass', () => {
    const repo = freshRepo('artibot-missions-b2-');
    fsSync.appendFileSync(path.join(repo, '.gitignore'), '\n.artibot/missions/\n');
    git(['add', '.gitignore'], repo);
    git(['commit', '-q', '-m', 'chore: ignore missions'], repo);
    expect(porcelain(repo).trim()).toBe('');

    writeMission(repo, 'm-0002');
    expect(porcelain(repo).trim()).toBe('');
    expect(runIndividualCheck('gitClean', { cwd: repo }).status).toBe('pass');
  });
});

describe('missions vs. split limb landing checks', () => {
  it('C — the six landing rows are identical with and without untracked missions', () => {
    git(['checkout', '-q', '-b', 'limb-probe', 'main'], repoC);
    const srcDir = path.join(repoC, 'src');
    fsSync.mkdirSync(srcDir, { recursive: true });
    fsSync.writeFileSync(path.join(srcDir, 'x.js'), 'export const x = 1;\n');
    git(['add', 'src/x.js'], repoC);
    git(['commit', '-q', '-m', 'feat: x', '-m', 'Split-Limb: done'], repoC);

    const args = {
      cwd: repoC,
      limb: 'probe',
      branch: 'limb-probe',
      base: 'main',
      allowlist: ['src/**'],
    };

    expect(porcelain(repoC).trim()).toBe('');
    const before = checkLimbLanding(args);
    // Without these two, FAIL === FAIL would satisfy the deep-equal below. Not
    // pinned to 'PASS': an old git without merge-tree answers UNSUPPORTED.
    expect(before.status).not.toBe('FAIL');
    expect(before.checks.find((c) => c.id === 'trailer')?.ok).toBe(true);

    writeMission(repoC, 'm-0001');
    const dirtyNow = porcelain(repoC);
    // Proves the second run really did have missions on disk — without this the
    // deep-equal below could pass because nothing changed at all.
    expect(dirtyNow.trim()).not.toBe('');
    expect(dirtyNow).toContain('.artibot');

    const after = checkLimbLanding(args);

    expect(after.status).toBe(before.status);
    expect(after.checks).toEqual(before.checks);
    expect(after.changedFiles).toEqual(before.changedFiles);
    expect(before.changedFiles).toEqual(['src/x.js']);
    // No row is a working-tree row: every id below is diff/rev-list derived.
    expect(before.checks.map((c) => c.id)).toEqual([
      'trailer', 'ownership', 'binary', 'citations', 'merge-dry-run', 'behind-base',
    ]);
  });
});

describe('land.mjs lint row ignores untracked files', () => {
  it('D — the real lintCheck status call carries --untracked-files=no', () => {
    const calls = [];
    const stubExec = (a) => {
      calls.push(a);
      const joined = a.join(' ');
      if (joined.startsWith('diff --name-only')) {
        return { status: 0, stdout: 'plugins/artibot/lib/z.js\0', stderr: '' };
      }
      if (joined.startsWith('rev-parse')) {
        return { status: 0, stdout: `${'a'.repeat(40)}\nlimb-probe\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const r = lintCheck({
      cwd: repoC,
      base: 'main',
      branch: 'limb-probe',
      worktreePath: repoC,
      exec: stubExec,
      spawn: () => { throw new Error('eslint must not spawn in this probe'); },
      // A plugin root with no node_modules stops the row before eslint runs.
      pluginRoot: path.join(repoC, 'no-such-plugin-root'),
    });

    expect(r.id).toBe('lint');
    const statusCalls = calls.filter((a) => a[0] === 'status');
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]).toContain('--untracked-files=no');
  });

  it('D2 — source pin: every status argv in land.mjs excludes untracked files', () => {
    const src = fsSync.readFileSync(LAND_SRC, 'utf-8');
    const found = statusArgvLiterals(src);
    // Not vacuous: a rename that removes the call must turn this red, not green.
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.filter((m) => !m.includes('--untracked-files=no'))).toEqual([]);
  });

  it('D3 — scanner self-verification: the pin is red on a stripped source', () => {
    const fake = "const d = exec([ 'status', '--porcelain', '-z', '--', f ], { cwd });";
    const found = statusArgvLiterals(fake);
    expect(found).toHaveLength(1);
    expect(found.filter((m) => !m.includes('--untracked-files=no'))).toHaveLength(1);
  });
});

/**
 * Every `['status', ...]` argv array literal in a source string.
 * @param {string} source
 * @returns {string[]}
 */
function statusArgvLiterals(source) {
  return source.match(/\[\s*'status'[^\]]*\]/g) || [];
}
