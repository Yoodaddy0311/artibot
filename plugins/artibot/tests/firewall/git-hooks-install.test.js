/**
 * 검사 목적 2가지.
 *   1. `pre-push` 배치 계약 — 복사본이 **올바른 .git/hooks 에** byte-단위로 들어가고,
 *      `core.hooksPath` 가 설정돼 있으면 설치를 거부한다.
 *   2. landing-flow 게이트 동작 — master 직푸시를 막고 ci/** 를 거친 SHA 는 통과시킨다.
 *
 * 이 스위트는 실제 임시 git 리포를 만들어서 설치기를 돌리고 **훅을 실행한다**.
 * 정적 스캔이 아니다. (게이트가 못 보는 것은 각 describe 헤더에 따로 적었다.)
 *
 * ── 회귀 가드 (실제로 났던 버그) ──────────────────────────────────────────────
 * `git rev-parse --git-path hooks` 는 **git 을 호출한 cwd 기준 상대경로**를 준다.
 * 이걸 `--show-toplevel` 기준으로 resolve 하면 리포 밖으로 걸어나가서, 개발 중
 * 실측으로 조상 디렉터리의 `.git/hooks/` 에 훅을 설치했다. 아래
 * "설치 경로가 그 리포 안이다" 테스트가 그 재발을 잡는다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *   - **개발자가 설치기를 실제로 돌렸는지는 알 수 없다.** `.git/` 은 커밋되지 않으므로
 *     CI 도, 이 테스트도, 남의 클론의 설치 상태를 볼 수 없다. 설치 여부의 유일한
 *     확인 수단은 각자 `npm run hooks:install -- --check` 다.
 *   - **훅이 실행하는 `scripts/ci/validate-*.js` 는 여전히 워크트리 공급이다.**
 *     복사 설치는 "훅 자체가 공격자 통제" 와 "게이트 자기무력화" 를 닫을 뿐,
 *     적대적 브랜치를 체크아웃한 채 push 하는 것을 안전하게 만들지 않는다.
 *   - push 시 훅이 실제로 차단하는지는 여기서 재현하지 않는다(원격·의존성 필요).
 *   - **이 스위트는 커밋된 훅이 아니라 워킹트리의 훅을 읽는다** (`beforeEach` 의
 *     `cpSync(HOOKS_SRC/pre-push, …)`). 그래서 다른 주체가 그 파일을 편집하는 중이면
 *     결과는 **그 시점의 편집본**을 반영한다 — 내 변경과 무관한 red 가 나올 수 있다.
 *     실제 사고(2026-08-15 18:48): 뮤테이션 테스트로 `protected_refs=''` 를 잠깐
 *     넣어둔 사이 다른 에이전트 2명이 각각 20건 실패를 관측했고, 훅이 복원된 뒤로는
 *     재현되지 않아 "1/8 플레이크" 로 몇 시간 미귀속 상태였다. 그 서명은
 *     **stdout 빈 문자열 + stderr `node_modules missing`** 인데, 이는 landing-flow
 *     게이트가 아예 발동하지 않았다는 뜻이라 **정상 훅에서는 나올 수 없다**
 *     (정상이면 stdout 에 `landing-flow  FAIL` 이 있고 `node_modules missing` 은 없다).
 *     그 조합을 보면 플레이크를 의심하지 말고 `git hash-object
 *     plugins/artibot/scripts/git-hooks/pre-push` 를 HEAD 판본과 대조하라.
 *     교훈: 훅 뮤테이션은 공유 워킹트리가 아니라 **사본/워크트리**에서 하라.
 *
 * @module tests/firewall/git-hooks-install
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { announceBashSkip, probeSh } from '../../scripts/utils/bash-compat.js';

/**
 * Which `sh` runs the hook — and whether one exists at all.
 *
 * This suite spawns a POSIX shell, so it inherits the launcher-dependence that
 * bash-compat.js exists to document. Measured 2026-08-15 on Windows: from Git
 * Bash `sh` is on PATH, from PowerShell it is not (PATH there carries Git\cmd,
 * which holds git.exe but no shell). Before this probe was wired in, the
 * resulting ENOENT was folded into "the hook exited 1 and printed nothing" and
 * reported as **23 failures of the landing-flow gate** — a false red aimed at
 * the one gate that keeps unreviewed commits off master. The next person to see
 * it would have "fixed" a hook that was never broken.
 *
 * On POSIX (= CI, all nine workflows are ubuntu-latest) plain `sh` always
 * probes ok, so nothing here can skip in CI. That is pinned, not assumed:
 * tests/scripts/bash-compat.test.js asserts `probeSh().ok` on every non-Windows
 * platform, so a probe regression turns CI red instead of silently deleting the
 * 23 gate tests below.
 */
const SH = probeSh();
if (!SH.ok) announceBashSkip('git-hooks-install: pre-push execution', SH.reason);

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');
const HOOKS_SRC = join(PLUGIN_ROOT, 'scripts', 'git-hooks');

/** @type {string} */
let repo;
/** 임시 리포 안의 설치기 경로 */
let installer;

/**
 * 설치기를 돌리고 결과를 돌려준다. throw 하지 않는다 — exit code 를 단언하기 위해.
 * @param {string[]} args
 */
function runInstaller(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [installer, ...args], {
      cwd: join(repo, 'plugins', 'artibot'),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 임시 리포에 커밋 하나를 만들고 그 full SHA 를 돌려준다. */
function commit(message) {
  git(['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

/** pre-push stdin 한 줄. git 이 주는 형식 그대로. */
const ZERO = '0'.repeat(40);
/**
 * @param {string} remoteRef 밀어넣는 원격 ref (`refs/heads/master` 등)
 * @param {string} sha 로컬 SHA
 */
function pushLine(remoteRef, sha) {
  return `${remoteRef} ${sha} ${remoteRef} ${ZERO}\n`;
}

/**
 * 설치된 훅을 git 이 부르는 방식 그대로 실행한다: cwd = 리포 루트,
 * argv = `<remote name> <remote url>`, stdin = push 될 ref 목록.
 *
 * URL 은 반드시 GitHub 이 아닌 호스트여야 한다. `gh` 는 알려진 GitHub 호스트를
 * 가리키는 remote 가 없으면 **네트워크를 타기 전에** 로컬에서 즉시 실패하므로,
 * 이 스위트는 gh 설치 여부와 무관하게 항상 "판정 불가(=2)" 경로로 들어간다.
 * 그래서 오프라인 폴백(ci/** ref 대조)이 결정론적으로 테스트된다.
 *
 * @param {string} stdin
 * @param {Record<string, string>} [env]
 */
function runHook(stdin, env = {}) {
  const args = [join('.git', 'hooks', 'pre-push'), 'origin', 'https://example.invalid/x.git'];
  try {
    const stdout = execFileSync(SH.sh ?? 'sh', args, {
      cwd: repo,
      input: stdin,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '', all: stdout };
  } catch (error) {
    // A shell that never started has no exit status. Folding that into
    // `status ?? 1` manufactures "the hook exited 1 with empty output", which
    // every assertion below then fails against for a reason that has nothing to
    // do with the hook. Fail loudly and name the cause instead — the skipIf
    // above should already have prevented this, so reaching here means the
    // probe and the spawn disagree, which is worth a stack trace.
    if (typeof error.status !== 'number' && error.code) {
      throw new Error(
        `could not execute the hook via '${SH.sh ?? 'sh'}' (${error.code}). `
        + `probeSh(): ${SH.ok ? 'ok' : SH.reason}. `
        + 'Run this suite from Git Bash, or install Git for Windows so a POSIX sh is discoverable.',
        { cause: error },
      );
    }
    const stdout = error.stdout?.toString() ?? '';
    const stderr = error.stderr?.toString() ?? '';
    return { code: error.status ?? 1, stdout, stderr, all: stdout + stderr };
  }
}

/**
 * 훅이 landing-flow 게이트를 **통과해서** 뒤쪽 10종 게이트 구간까지 갔다는 증거.
 *
 * 임시 리포에는 node_modules 가 없으므로 훅은 거기서 fail-closed 로 멈춘다.
 * 이 문자열이 보이면 landing-flow 가 막지 않았다는 뜻이고, 안 보이면 그 전에
 * 끊긴 것이다. 통과/차단을 exit code 로는 구분할 수 없어서(둘 다 1) 이 마커를
 * 쓴다. 덤으로 npx eslint 까지 가지 않으므로 이 스위트는 네트워크를 타지 않는다.
 */
const REACHED_CONTENT_GATES = 'node_modules missing';

/**
 * The contexts master's branch protection requires, as the hook must see them.
 *
 * A third copy of this list would be a third thing to drift, so nothing here
 * asserts these strings against the hook directly — `workflow-branch-lockstep`
 * owns that comparison. These are only fixture material for the stub `gh`.
 */
const REQUIRED = [
  'Validate (Node 22)',
  'Validate (Node 24)',
  'Validate artibot plugin.json structure',
  'Validate artibot-cowork plugin.json structure',
];

/** One check-run line in the exact shape the hook's `gh api --jq` emits. */
const ghLine = (name, conclusion = 'success', status = 'completed') =>
  `${status}\t${conclusion}\t${name}`;

/**
 * Writes a stub `gh` and returns an env that puts it ahead of the real one.
 *
 * Path 1 cannot otherwise be tested: it needs a network, an authenticated gh,
 * and a commit that actually exists on the remote with the check runs the case
 * calls for. A stub answers deterministically instead, so these tests do not
 * change colour with the account, the network, or the day's CI state.
 *
 * `FAKE_GH_OUT` is printed verbatim on stdout; `FAKE_GH_FAIL` is printed on
 * stderr with exit 1, which is how the hook sees a gh error.
 *
 * @param {Record<string, string>} extra
 */
function withFakeGh(extra = {}) {
  const dir = join(repo, '.fakebin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      'if [ -n "${FAKE_GH_FAIL:-}" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi',
      'printf \'%s\' "${FAKE_GH_OUT:-}"',
      'exit 0',
      '',
    ].join('\n'),
  );
  try {
    chmodSync(join(dir, 'gh'), 0o755);
  } catch {
    // Windows filesystems ignore the exec bit; MSYS sh runs the file anyway.
  }
  // path.delimiter, not ':' — a bash-style ':' join would split the drive
  // letter off every Windows PATH entry and the stub would never be found.
  return { PATH: dir + delimiter + process.env.PATH, ...extra };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'artibot-hooks-'));
  const dest = join(repo, 'plugins', 'artibot', 'scripts', 'git-hooks');
  mkdirSync(dest, { recursive: true });
  cpSync(join(HOOKS_SRC, 'pre-push'), join(dest, 'pre-push'));
  cpSync(join(HOOKS_SRC, 'install.js'), join(dest, 'install.js'));
  installer = join(dest, 'install.js');
  git(['init', '-q', '.']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('git hooks 설치기', () => {
  it('훅을 .git/hooks 에 byte-단위로 동일하게 설치한다', () => {
    const result = runInstaller();
    expect(result.code, result.stderr).toBe(0);

    const installed = join(repo, '.git', 'hooks', 'pre-push');
    expect(existsSync(installed)).toBe(true);
    // byte-단위 동일성은 훅의 drift 자기검사(raw hash 비교)가 성립하기 위한 전제다.
    // 여기서 개행이 바뀌면 설치 직후부터 모든 push 가 drift FAIL 로 막힌다.
    expect(readFileSync(installed)).toEqual(
      readFileSync(join(repo, 'plugins', 'artibot', 'scripts', 'git-hooks', 'pre-push')),
    );
  });

  it('설치 경로가 그 리포 안이다 (조상 리포로 새지 않는다)', () => {
    // 회귀 가드: --git-path 를 toplevel 기준으로 resolve 하던 버그가 조상 디렉터리의
    // .git/hooks 에 설치했다. 설치 경로는 반드시 이 임시 리포 하위여야 한다.
    runInstaller();
    const installed = resolve(repo, '.git', 'hooks', 'pre-push');
    expect(existsSync(installed)).toBe(true);

    const rel = relative(repo, installed);
    expect(rel.startsWith('..')).toBe(false);
  });

  it('core.hooksPath 가 설정돼 있으면 설치를 거부한다', () => {
    // hooksPath 는 .git/hooks 를 덮으므로, 이때 설치하면 "설치된 것처럼 보이지만
    // 절대 실행되지 않는" 복사본이 남는다. 그건 훅이 없는 것보다 나쁘다.
    git(['config', 'core.hooksPath', 'plugins/artibot/scripts/git-hooks']);
    const result = runInstaller();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('core.hooksPath');
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  it('--check 는 미설치를 stale 로 보고하고 exit 1 이다', () => {
    const result = runInstaller(['--check']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('STALE');
    // --check 는 아무것도 쓰지 않는다.
    expect(existsSync(join(repo, '.git', 'hooks', 'pre-push'))).toBe(false);
  });

  it('--check 는 설치 후 exit 0 이다', () => {
    runInstaller();
    const result = runInstaller(['--check']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('up to date');
  });

  it('--check 는 소스가 바뀌면 stale 을 잡는다 (drift 감지)', () => {
    runInstaller();
    const source = join(repo, 'plugins', 'artibot', 'scripts', 'git-hooks', 'pre-push');
    writeFileSync(source, `${readFileSync(source, 'utf-8')}\n# changed\n`);

    const result = runInstaller(['--check']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('differs from source');
  });

  it('남의 pre-push 훅을 파괴하지 않고 백업한다', () => {
    const target = join(repo, '.git', 'hooks', 'pre-push');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\necho someone-elses-hook\n');

    const result = runInstaller();
    expect(result.code).toBe(0);
    expect(readFileSync(`${target}.backup`, 'utf-8')).toContain('someone-elses-hook');
    expect(readFileSync(target, 'utf-8')).toContain('Artibot pre-push gate.');
  });
});

/**
 * landing-flow 게이트 — master 직푸시 차단.
 *
 * 정적 grep 이 아니라 **실제 훅을 실행한다**. 임시 리포를 만들고 git 이 주는 것과
 * 같은 stdin/argv 를 먹인 뒤 stdout/stderr 를 단언한다.
 *
 * ── 이 테스트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *   - **온라인 경로(`gh api ... /check-runs`)는 여기서 실행되지 않는다.** remote 가
 *     GitHub 이 아니라 gh 가 즉시 실패하고, 훅은 오프라인 폴백으로 내려간다.
 *     그게 의도다 — 테스트가 네트워크·gh 인증 상태에 따라 green/red 가 갈리면
 *     게이트가 아니라 flake 다. 온라인 경로의 판정(422 = 원격에 커밋 없음,
 *     그 외 오류 = 판정 불가)은 실측으로만 확인했다: 2026-08-15, 실제 리포에서
 *     green SHA 는 "all 6 check runs on the server are green" 으로 통과,
 *     존재하지 않는 SHA 는 422 로 차단.
 *   - **CI 색상은 오프라인 폴백이 검증하지 않는다.** 폴백이 증명하는 건 "그 SHA 가
 *     ci/** 브랜치에 올라갔다" 까지고 "그 검사가 초록이었다" 가 아니다. 훅이 그때
 *     stderr 로 NOTE 를 내는지를 아래에서 단언하는 이유다.
 *   - **다른 클론에는 훅 자체가 없다.** `.git/` 은 커밋되지 않으므로 이 테스트도 CI 도
 *     남의 클론 설치 상태를 볼 수 없다. `git push --no-verify` 도 그냥 건너뛴다.
 *     이 게이트는 실수를 줄이지, 브랜치 보호를 대체하지 않는다. 우회를 불가능하게
 *     만드는 건 원격의 enforce_admins 뿐이다.
 *   - **원격이 실제로 보호하는 브랜치 목록은 원격 상태다.** 훅의 protected_refs 는
 *     그 수동 사본이라, GitHub 에서 새 브랜치를 보호해도 여기선 아무 일도 안 난다.
 */
describe.skipIf(!SH.ok)('pre-push landing-flow 게이트', () => {
  beforeEach(() => {
    runInstaller();
  });

  it('master 직푸시를 막고, 이유·올바른 플로우·우회법을 한 화면에 낸다', () => {
    const sha = commit('direct');
    const result = runHook(pushLine('refs/heads/master', sha));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('landing-flow  FAIL');
    expect(result.stderr).toContain('BLOCKED by the landing-flow gate');

    // 왜 막혔는지 + 올바른 플로우 + escape hatch 가 전부 같은 출력에 있어야 한다.
    // 셋 중 하나라도 빠지면 막힌 사람이 다음에 뭘 할지 알 수 없다.
    expect(result.all).toContain('required status checks are expected');
    expect(result.all).toContain('git switch -c ci/short-topic');
    expect(result.all).toContain('git merge --ff-only ci/short-topic');
    expect(result.all).toContain('ARTIBOT_ALLOW_DIRECT_PUSH=1 git push origin master');
    expect(result.all).toContain('Landing changes on master');

    // 단락(short-circuit) 증거. 플로우가 틀렸으면 11-15s 짜리 내용 게이트를 도는 건
    // 무의미하다 -- 틀린 건 트리가 아니라 경로다.
    expect(result.all).not.toContain(REACHED_CONTENT_GATES);
  });

  it('main 도 같은 게이트를 받는다', () => {
    const sha = commit('direct-main');
    const result = runHook(pushLine('refs/heads/main', sha));
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('ci/** 를 거친 SHA 는 통과시킨다', () => {
    const sha = commit('landed');
    git(['update-ref', 'refs/remotes/origin/ci/topic', sha]);

    const result = runHook(pushLine('refs/heads/master', sha));
    expect(result.stdout).toContain('landing-flow  ok');
    expect(result.stdout).toContain('refs/remotes/origin/ci/topic');
    // 실제로 통과했는지는 뒤 구간에 도달했는지로만 증명된다.
    expect(result.all).toContain(REACHED_CONTENT_GATES);
  });

  it('오프라인 폴백으로 통과시킬 때 CI 색상 미검증을 stderr 로 알린다', () => {
    // 이 NOTE 가 이 게이트의 유일한 fail-open 을 말한다. 지우면 게이트가 실제보다
    // 강해 보이고, 그 착시가 게이트 자체보다 위험하다.
    const sha = commit('landed');
    git(['update-ref', 'refs/remotes/origin/ci/topic', sha]);

    const result = runHook(pushLine('refs/heads/master', sha));
    expect(result.stderr).toContain('Accepted on local evidence alone');
    expect(result.stderr).toContain('NOT verified');
  });

  it('ci/** ref 가 있어도 SHA 가 다르면 막는다', () => {
    // NEGATIVE CONTROL: 위 테스트가 "ci ref 가 존재하기만 하면 통과" 를 보고
    // green 이 된 것이 아님을 확인한다. 대조가 없으면 그 테스트는 공허하다.
    const older = commit('older');
    commit('newer');
    git(['update-ref', 'refs/remotes/origin/ci/topic', older]);

    const result = runHook(pushLine('refs/heads/master', git(['rev-parse', 'HEAD']).trim()));
    expect(result.stdout).toContain('landing-flow  FAIL');
    expect(result.all).not.toContain(REACHED_CONTENT_GATES);
  });

  it('ci/** tip 의 조상은 통과시키지 않는다 (동일성이지 조상관계가 아니다)', () => {
    // push 는 브랜치 tip 에 대해서만 워크플로를 돌린다. tip 의 조상 커밋에는
    // check run 이 아예 붙지 않으므로, 조상을 통과시키면 검사 안 된 SHA 가 master
    // 로 간다. 조상관계로 느슨하게 판정하고 싶은 유혹이 있어서 못박아 둔다.
    const parent = commit('parent');
    const tip = commit('tip');
    git(['update-ref', 'refs/remotes/origin/ci/topic', tip]);

    const result = runHook(pushLine('refs/heads/master', parent));
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('중첩된 ci 세그먼트는 ci/** 로 인정하지 않는다', () => {
    // refs/remotes/*/ci/* 의 `*` 는 `/` 를 넘지 않는다(실측 2026-08-15). 그래서
    // refs/remotes/origin/feature/ci/x 는 매치되지 않는다. 이 glob 의미가 바뀌면
    // 아무 브랜치나 이름에 ci 를 끼워 넣어 게이트를 통과할 수 있다.
    const sha = commit('nested');
    git(['update-ref', 'refs/remotes/origin/feature/ci/sneaky', sha]);

    const result = runHook(pushLine('refs/heads/master', sha));
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('보호 대상이 아닌 ref 에는 게이트가 관여하지 않는다', () => {
    // 플로우 1단계인 `git push -u origin ci/topic` 자체가 막히면 안 된다.
    const sha = commit('side');
    const result = runHook(pushLine('refs/heads/ci/topic', sha));
    expect(result.all).not.toContain('landing-flow');
    expect(result.all).toContain(REACHED_CONTENT_GATES);
  });

  it('ARTIBOT_ALLOW_DIRECT_PUSH=1 은 이 게이트만 끄고 그 사실을 알린다', () => {
    const sha = commit('deliberate');
    const result = runHook(pushLine('refs/heads/master', sha), { ARTIBOT_ALLOW_DIRECT_PUSH: '1' });

    expect(result.stdout).toContain('landing-flow  SKIP');
    // 환경변수는 `--no-verify` 와 달리 한 명령에 갇히지 않는다. rc 나 CI job env 에
    // 눌러앉으면 이후 모든 push 가 조용히 ungated 가 되므로 매번 시끄러워야 한다.
    expect(result.stderr).toContain('set in your environment');
    // "이 게이트만" 이 핵심이다. 나머지 10종은 그대로 돌아야 한다.
    expect(result.all).toContain(REACHED_CONTENT_GATES);
  });

  it('ARTIBOT_SKIP_PREPUSH=1 은 landing-flow 를 포함해 전부 끈다', () => {
    const sha = commit('skip-all');
    const result = runHook(pushLine('refs/heads/master', sha), { ARTIBOT_SKIP_PREPUSH: '1' });
    expect(result.code).toBe(0);
    expect(result.all).not.toContain('landing-flow');
  });

  it('삭제 전용 push 는 게이트 이전에 끝난다', () => {
    // 플로우 마지막 단계가 `git push origin --delete ci/topic` 이다. 삭제에는
    // 검사할 트리가 없고, 여기서 막히면 플로우가 자기 꼬리를 문다.
    commit('del');
    const result = runHook(`(delete) ${ZERO} refs/heads/ci/topic ${'1'.repeat(40)}\n`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('deletion-only push');
  });

  it('한 push 에 여러 ref 가 실려도 보호 대상만 골라 검사한다', () => {
    const sha = commit('multi');
    const result = runHook(pushLine('refs/heads/ci/topic', sha) + pushLine('refs/heads/master', sha));
    expect(result.stdout).toContain('landing-flow  FAIL');
    expect(result.stderr).toContain('refs/heads/master');
  });
});

/**
 * landing-flow 경로 1 — 서버 check run 판정.
 *
 * 실제 `gh` 대신 PATH 앞에 스텁을 꽂아 결정론적으로 돌린다. 네트워크·계정·그날의
 * CI 상태에 따라 green/red 가 갈리면 게이트가 아니라 flake 이기 때문이다.
 *
 * ── 이 스위트가 못 보는 것 (rules §9) ────────────────────────────────────────
 *   - **진짜 `gh api` 의 응답 형태는 검증하지 않는다.** 스텁은 훅의 jq 가 낸다고
 *     가정한 TSV 를 그대로 뱉을 뿐이다. GitHub 이 필드 이름을 바꾸면 이 스위트는
 *     전부 green 인 채로 훅만 깨진다. 실제 응답 형태는 실측으로만 확인했다:
 *     2026-08-15 12:53 KST, `5c2f656a` 는 필수 4종 포함 6런 전부 green 으로 통과,
 *     `146dde99` 는 비필수 1런만 green 이라 차단.
 *   - **필수 컨텍스트 목록이 원격과 맞는지는 여기서 안 본다.** 그 대조는
 *     workflow-branch-lockstep.test.js 가 훅의 미러를 파싱해서 한다.
 *   - 훅의 `required_contexts` 가 비었을 때의 fail-closed 분기는 훅을 편집해야
 *     재현되므로 미검증이다(코드로만 확인).
 */
describe.skipIf(!SH.ok)('pre-push landing-flow — 경로 1 (서버 check run)', () => {
  beforeEach(() => {
    runInstaller();
  });

  it('필수 컨텍스트가 0개면 비필수 run 이 green 이어도 차단한다', () => {
    // 회귀 가드 — 실제로 났던 결함. 이전 판정은 run 을 **개수로만** 셌다:
    // total=1 / running=0 / bad=0 이면 통과였다. 그래서 master 커밋 146dde99 가
    // 비필수 "Run self-control task" 하나만 green 인 채로 게이트를 통과했다.
    // 막으려던 바로 그 착지다. 개수는 이 질문에 답할 수 없고 이름만 답한다.
    const sha = commit('non-required-only');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({ FAKE_GH_OUT: ghLine('Run self-control task') }),
    );

    expect(result.stdout).toContain('landing-flow  FAIL');
    expect(result.all).toContain('0 of 4 required contexts');
    for (const ctx of REQUIRED) expect(result.all).toContain(ctx);
    expect(result.all).not.toContain(REACHED_CONTENT_GATES);
  });

  it('필수 4종이 전부 green 이면 통과한다', () => {
    const sha = commit('all-green');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({ FAKE_GH_OUT: REQUIRED.map((c) => ghLine(c)).join('\n') }),
    );

    expect(result.stdout).toContain('landing-flow  ok');
    expect(result.stdout).toContain('all 4 required contexts green');
    expect(result.all).toContain(REACHED_CONTENT_GATES);
  });

  it('필수 4종 중 하나라도 빠지면 차단하고 빠진 이름을 낸다', () => {
    const sha = commit('one-missing');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({ FAKE_GH_OUT: REQUIRED.slice(0, 3).map((c) => ghLine(c)).join('\n') }),
    );

    expect(result.all).toContain('3 of 4 required contexts');
    expect(result.all).toContain(REQUIRED[3]);
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('이름은 정확 일치여야 한다 (부분 일치로 필수를 만족시킬 수 없다)', () => {
    // NEGATIVE CONTROL: `grep -Fxq` 를 부분일치로 느슨하게 바꾸면 아무 이름에
    // 필수 컨텍스트를 접두사로 붙여 게이트를 통과시킬 수 있다.
    const sha = commit('prefix-attack');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({
        FAKE_GH_OUT: REQUIRED.map((c) => ghLine(`${c} (not really)`)).join('\n'),
      }),
    );

    expect(result.all).toContain('0 of 4 required contexts');
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('필수 4종이 green 이어도 다른 run 이 red 면 차단한다 (전건 green 엄격성 유지)', () => {
    const sha = commit('extra-red');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({
        FAKE_GH_OUT: [...REQUIRED.map((c) => ghLine(c)), ghLine('Lint', 'failure')].join('\n'),
      }),
    );

    expect(result.all).toContain('1 of 5 check runs did not succeed');
    expect(result.all).toContain('Lint: failure');
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('아직 끝나지 않은 run 이 있으면 차단한다', () => {
    const sha = commit('still-running');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({
        FAKE_GH_OUT: [
          ...REQUIRED.slice(0, 3).map((c) => ghLine(c)),
          ghLine(REQUIRED[3], null, 'in_progress'),
        ].join('\n'),
      }),
    );

    expect(result.all).toContain('have not finished');
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('skipped 와 neutral 은 green 으로 친다', () => {
    // GitHub 이 통과로 취급하므로 여기서도 통과여야 한다. 실패로 세면 정당하게
    // 건너뛴 job 하나에 착지가 막힌다.
    const sha = commit('skipped-ok');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({
        FAKE_GH_OUT: [
          ghLine(REQUIRED[0], 'skipped'),
          ghLine(REQUIRED[1], 'neutral'),
          ghLine(REQUIRED[2]),
          ghLine(REQUIRED[3]),
        ].join('\n'),
      }),
    );

    expect(result.stdout).toContain('landing-flow  ok');
    expect(result.all).toContain(REACHED_CONTENT_GATES);
  });

  it('check run 이 하나도 없으면 차단한다', () => {
    const sha = commit('no-runs');
    const result = runHook(pushLine('refs/heads/master', sha), withFakeGh({ FAKE_GH_OUT: '' }));

    expect(result.all).toContain('no check run has attached to it');
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('gh 422 는 판정이다 — 원격에 커밋이 없으면 차단', () => {
    const sha = commit('not-on-remote');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({ FAKE_GH_FAIL: 'gh: No commit found for SHA: x (HTTP 422)' }),
    );

    expect(result.all).toContain('the remote does not have this commit');
    expect(result.stdout).toContain('landing-flow  FAIL');
  });

  it('그 외 gh 오류는 판정 불가라서 경로 2 로 내려간다', () => {
    // 판정 불가를 통과로 접으면 오프라인에서 게이트가 통째로 무력해지고,
    // 차단으로 접으면 정당한 착지가 네트워크 사정으로 막힌다. 둘 다 아니다.
    const sha = commit('gh-offline');
    git(['update-ref', 'refs/remotes/origin/ci/topic', sha]);
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({ FAKE_GH_FAIL: 'error connecting to api.github.com' }),
    );

    expect(result.stdout).toContain('landing-flow  ok');
    expect(result.stderr).toContain('NOT verified');
    expect(result.all).toContain(REACHED_CONTENT_GATES);
  });

  it('차단 안내문이 실제 술어를 그대로 말한다 (필수 4종 이름 포함)', () => {
    // 안내문과 코드가 어긋나면, 시킨 대로 했는데도 계속 막히는 사람이 생긴다.
    // 훅은 이 목록을 required_contexts 에서 렌더링하므로 세 번째 사본이 아니다.
    const sha = commit('guidance');
    const result = runHook(
      pushLine('refs/heads/master', sha),
      withFakeGh({ FAKE_GH_OUT: ghLine('Run self-control task') }),
    );

    expect(result.all).toContain('matched by name');
    for (const ctx of REQUIRED) expect(result.all).toContain(ctx);
    expect(result.all).toContain('ARTIBOT_ALLOW_DIRECT_PUSH=1 git push origin master');
  });
});

/**
 * 이 스위트의 fail-open 방지선.
 *
 * 위 두 describe 는 sh 가 없으면 통째로 사라진다. 그런데 **사라진 것과 통과한 것은
 * 요약 출력에서 구분되지 않는다** — 스킵을 도입하면 그 자체가 새로운 착시가 된다.
 * POSIX(= CI, 워크플로 9개가 전부 ubuntu-latest)에는 sh 가 반드시 있으므로, 거기서
 * 스킵이 일어났다면 환경 탓이 아니라 프로브가 깨진 것이다. 그때 조용히 23건을
 * 잃는 대신 여기서 RED 가 된다. Windows 만 면제인 이유는 그쪽 판정이 "어느 셸이
 * 띄웠는가" 에 정당하게 의존하기 때문이다(Git Bash → ok, PowerShell → 파생 탐색).
 */
describe.skipIf(process.platform === 'win32')('sh 프로브 (CI 스킵 방지선)', () => {
  it('POSIX 에서는 ok 여서 landing-flow 게이트 23건이 스킵되지 않는다', () => {
    expect(SH.ok, `probeSh failed on POSIX: ${SH.reason}`).toBe(true);
  });
});

describe('pre-push 훅 소스 계약', () => {
  const hook = readFileSync(join(HOOKS_SRC, 'pre-push'), 'utf-8');

  it('drift 자기검사를 포함한다', () => {
    // 이게 없으면 복사 설치는 stale gate 를 조용히 실행하고, 적대적 브랜치가
    // 훅을 바꿔도 아무 신호가 없다.
    expect(hook).toContain('git hash-object --no-filters');
    expect(hook).toContain('installed hook differs from the source file in the work tree');
  });

  it('work tree 를 가리키는 core.hooksPath 를 권하지 않는다', () => {
    // 과거 안내문이 이 설정을 권장했고, 그것이 신뢰경계 결함의 원인이었다.
    //
    // 음성 단언만으로는 약하다: 이 정규식은 백틱 없는 주석 한 형태만 잡는데, 훅 헤더는
    // 같은 명령을 **금지문 안에서 백틱을 달고** 인용하고 있어서 정규식을 넓히면 그
    // 금지문 자체가 걸려 오탐이 된다. "권장"과 "금지"를 정규식으로 가르는 건 취약하다.
    // 그래서 금지문이 실제로 존재한다는 **양성 단언**을 함께 건다. 이쪽은 오탐이 없고,
    // 누가 헤더를 다시 권장문으로 되돌리면 이 단언이 RED 가 된다.
    expect(hook).not.toMatch(/^#\s+git config core\.hooksPath/m);
    expect(hook).toContain('Do NOT use');
    expect(hook).toContain('core.hooksPath');
  });

  it('전제조건 실패는 전부 exit 1 이다 (fail-closed)', () => {
    for (const marker of [
      'not inside a git work tree',
      'node not on PATH',
      'node_modules missing',
    ]) {
      expect(hook).toContain(marker);
    }
  });

  it('landing-flow 게이트 옆에 "못 보는 것" 이 적혀 있다', () => {
    // rules §9: 게이트를 만들면 그 게이트가 못 보는 것을 게이트 옆에 적어라.
    // 안 적으면 게이트 자체가 다음 착시의 근거가 된다. 특히 이 게이트에는 진짜
    // fail-open 이 하나 있다(gh 판정 불가 시 CI 색상 미검증 통과). 그 문구를
    // 지우면서 게이트만 남기는 편집을 막는다.
    expect(hook).toContain('WHAT THIS GATE CANNOT SEE');
    expect(hook).toContain('FAIL-OPEN');
    expect(hook).toContain('enforce_admins');
  });

  it('gh 실패를 통과로 바꾸지 않는다 (판정 불가 != 초록)', () => {
    // 온라인 경로가 대답하지 못했을 때 통과시키는 유일한 근거는 로컬 ci/** ref
    // 대조다. gh 오류를 곧장 pass 로 접는 편집이 들어오면 게이트가 오프라인에서
    // 통째로 무력해진다.
    expect(hook).toContain('No commit found for SHA');
    expect(hook).toContain('sha_on_pushed_ci_branch');
  });
});
