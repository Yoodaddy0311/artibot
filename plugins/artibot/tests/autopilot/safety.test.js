/**
 * Unit tests for lib/autopilot/safety.js
 * Covers classifyRisk, parseDuration, shouldPause.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetExceeded,
  classifyRisk,
  DANGEROUS_PATTERNS,
  parseDuration,
  pauseReason,
  shouldPause,
} from '../../lib/autopilot/safety.js';
// 읽기 전용 — 두 곳이 쓴다. (1) 포크밤 드리프트 게이트가 L1 원본과 바이트를
// 대조한다. (2) 아래 ReDoS 정적 스캔이 **세 카탈로그**(L1 · L2 · HG)를 한 번에
// 훑는다 — 2026-09-14 에 HUMAN_GATE_MATRIX 가 세 번째로 들어왔다(스캐너 헤더
// "못 보는 것" 7번 = tests/helpers/regex-scan.js 참조). 이 파일은 L1 소스를
// 편집하지 않는다.
import { BLOCKED_PATTERNS } from '../../lib/core/blocked-patterns.js';
// 읽기 전용 — 정적 스캔의 **세 번째 카탈로그**(2026-09-14 추가). 같은
// PreToolUse 경로(probe 'command', tools Bash)를 타면서 두 카탈로그 밖이라
// 종전 스캔이 못 보던 자리다. 이 파일은 human-gates.js 를 편집하지 않는다.
import { HUMAN_GATE_MATRIX } from '../../lib/security/human-gates.js';
// 정적 스캐너의 유일한 구현(2026-09-14 추출). 종전에는 이 파일과
// tests/firewall/human-gate-matrix-selfcheck.test.js 섹션 G 가 같은 HG 29패턴을
// 서로 다른 규칙으로 두 번 훑었고 HG-11 예외도 두 곳에 있었다.
import {
  ceilingFor,
  findUnboundedRuns,
  HG_SCAN_ALLOWLIST,
} from '../helpers/regex-scan.js';

describe('classifyRisk', () => {
  it('flags git push --force as danger', () => {
    const r = classifyRisk('git push --force origin main');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-force-push');
  });

  it('flags SQL DROP TABLE as danger', () => {
    const r = classifyRisk({ command: 'DROP TABLE users;' });
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-drop-table');
  });

  it('returns safe for benign ls command', () => {
    const r = classifyRisk('ls -la /tmp');
    expect(r.level).toBe('safe');
  });

  it('flags curl http external as caution', () => {
    const r = classifyRisk('curl https://api.example.com/data');
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('curl-external');
  });

  it('flags rm -rf with broad glob as danger', () => {
    const r = classifyRisk('rm -rf *');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-broad');
  });
});

describe('classifyRisk — L1 parity for discard-class git commands', () => {
  it.each([
    ['git checkout .', 'git-checkout-discard'],
    ['git checkout -- .', 'git-checkout-discard'],
    ['git checkout . && npm test', 'git-checkout-discard'],
    ['git restore .', 'git-restore-discard'],
    ['git restore -- .', 'git-restore-discard'],
    ['git stash drop', 'git-stash-drop'],
    ['git stash drop stash@{0}', 'git-stash-drop'],
    ['git stash clear', 'git-stash-drop'],
  ])('grades %s as danger via %s', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });

  it.each([
    'git checkout main',
    'git checkout -b feat/x',
    'git checkout ./src/file.js',
    'git restore --staged file.js',
    'git restore src/file.js',
    'git stash list',
    'git stash pop',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

describe('classifyRisk — scoped recursive delete is caution', () => {
  it.each([
    'rm -rf ./build',
    'rm -rf build',
    'rm -fr dist',
    'rm -rf node_modules/.cache',
    'rm -rfv dist',
    'rm -r -f dist',
    'rm -f -r dist',
    'rm --recursive --force dist',
    'rm -rf -- build',
  ])('grades %s as caution via rm-rf-path', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('rm-rf-path');
  });

  // `rm -r dir` · `rm -rv dir` · `rm --recursive dir` USED TO SIT IN THIS LIST.
  // They moved to the rm-recursive-path describe below on 2026-09-14 — the new
  // rule is what made them caution, so leaving them pinned safe here would have
  // been pinning the blind spot. They are the only three rows this catalogue
  // addition flips (measured: the 17-command probe in the report, and the
  // targeted suites tests/hooks/{bash-risk-guard,pre-bash,permission-auto-approve}
  // carry no force-less recursive rm pin at all).
  it.each([
    'rm -f file.txt',
    'rm --force file.txt',
    'rm -f /',
    'rm /tmp/file.txt',
    'ls -la /tmp',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  it.each([
    ['rm -rf /', 'rm-rf-root'],
    ['rm -rf ~/x', 'rm-rf-root'],
    ['rm -rf $HOME/x', 'rm-rf-root'],
    ['rm -fr /', 'rm-rf-root'],
    ['rm -r /', 'rm-rf-root'],
    ['rm -rfv /', 'rm-rf-root'],
    ['rm -r -f /', 'rm-rf-root'],
    ['rm -f -r /', 'rm-rf-root'],
    ['rm --recursive --force /', 'rm-rf-root'],
    ['rm -rf -- /', 'rm-rf-root'],
    ['rm -rv /', 'rm-rf-root'],
    ['rm -rfv ~/x', 'rm-rf-root'],
    ['rm -r -f $HOME', 'rm-rf-root'],
    ['rm -rf *', 'rm-rf-broad'],
    ['rm -fr *', 'rm-rf-broad'],
    ['rm -rfv *', 'rm-rf-broad'],
    ['rm -r -f *', 'rm-rf-broad'],
    ['rm --recursive --force *', 'rm-rf-broad'],
  ])('keeps %s at danger via %s (root/glob rules win over rm-rf-path)', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// rm-rf-root — 타깃 터미네이터(2026-09-14, guard-l2-followups ①).
//
// 종전 루트 분기는 `\/(?:\s|$|\*|\w)` 였다. `/` 뒤에 공백·입력끝·`*`·단어문자가
// 와야만 매치하므로 셸이 토큰을 끝내는 **다른 모든 방법**이 사각이었다. 실측
// 2026-09-14(node v24.15.0, 규칙 단독 + classifyRisk + L1 executeChain 3열):
// 타깃 34형 중 23형이 L2 safe 였고, 래퍼 10형 중 9형이 safe 였다.
//
// 이 사각이 비싼 이유는 **언급이 아니라 실행형**이라는 데 있다. `sh -c "…"`,
// `eval "…"`, 백틱, `(…)`, `{ …; }` 는 전부 실행되는 형태인데 danger 가 아니었다.
// heredoc 만 danger 였고 그것도 우연이다 — 줄바꿈이 옛 터미네이터 집합에 있었다.
// L1 은 34형 + 10래퍼 전부 block 이었으므로 이것은 **L2 단독 결함**이고
// PreToolUse 차단에는 영향이 0 이었다. 그래도 방향 규칙(L1 block ⇒ L2 ≥ caution)
// 위반이 32건이었다.
//
// 이 describe 가 증명하지 않는 것: L1 쪽 판정은 여기서 재지 않는다. 세 열
// 재현표는 PARITY(tests/core/guard-registry-safe-override-scope.test.js)가
// 행 단위로 핀하고, 이 파일은 L2 판정만 책임진다.
describe('classifyRisk — rm-rf-root reads every shell token terminator', () => {
  // 종전 miss 16형 + 종전 hit 형을 한 표로 둔다. 분모가 보여야 "16형을 고쳤다"가
  // 검증 가능한 문장이 된다.
  it.each([
    // 루트 분기 — 인용부호·괄호·분리자·리다이렉트
    'rm -rf /"',
    "rm -rf /'",
    'rm -rf /)',
    'rm -rf /;',
    'rm -rf /&',
    'rm -rf /|',
    'rm -rf />x',
    // 루트 분기 — 두 번째 `/` 와 `.`. `rm -rf //` 와 `rm -rf /.` 는 루트를 지운다.
    'rm -rf //',
    'rm -rf /.',
    'rm -rf /..',
    // `--` 구분자 뒤에서도 같다.
    'rm -rf -- /"',
    // `~` 분기 — 같은 모양의 같은 구멍
    'rm -rf ~"',
    'rm -rf ~)',
    'rm -rf ~;',
    'rm -rf ~&',
    'rm -rf ~|',
    // `$HOME` 분기
    'rm -rf $HOME"',
    'rm -rf $HOME;',
    'rm -rf $HOME&',
    'rm -rf $HOME)',
    'rm -rf $HOME|',
  ])('grades %s as danger via rm-rf-root', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // 래퍼 9형. heredoc 은 종전에도 danger 라 위 'still grades a heredoc body'
  // it 이 이미 갖고 있다 — 여기 다시 넣지 않는다.
  it.each([
    ['pipe to sh', 'echo "rm -rf /" | sh'],
    ['command substitution', 'echo "$(rm -rf /)"'],
    ['sh -c double-quoted', 'sh -c "rm -rf /"'],
    ['sh -c single-quoted', "sh -c 'rm -rf /'"],
    ['bash -c with $HOME', 'bash -c "rm -rf $HOME"'],
    ['subshell', '(rm -rf /)'],
    ['brace group', '{ rm -rf /; }'],
    ['eval', 'eval "rm -rf /"'],
    ['backticks', '`rm -rf /`'],
  ])('grades the %s wrapper as danger via rm-rf-root', (_name, command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // 따옴표 감싼 타깃. 종전에는 rm-rf-path 로 흘러 **caution 으로 강등**됐다 —
  // L1 은 정규화로 따옴표를 지우고 block 하는데 L2 만 "범위가 정해진 경로"로
  // 읽었다. 타깃 앞 `["']?` 가 그 한 자리를 메운다.
  it.each([
    'rm -rf "/"',
    "rm -rf '/'",
    'rm -rf "$HOME"',
  ])('grades the quoted target %s as danger via rm-rf-root', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // 수용된 과대 판정. 큰따옴표 안의 `~` 는 확장되지 않으므로 이것은 문자 그대로의
  // `./~` 디렉터리를 지운다 — 즉 홈이 아니다. 방향이 차단 쪽이라 받되 **조용히
  // 두지 않는다.** 실사용 발생률은 미측정(트랜스크립트 조사 안 함).
  it('accepts the quoted-tilde over-match knowingly', () => {
    const r = classifyRisk('rm -rf "~"');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // 2026-09-14 에 "범위 밖(오너 결정)"으로 남겼던 `${HOME}`·`~user` 두 형은
  // 2026-09-21(guard-l2-residual)에 닫혔다. 아래 두 describe 가 그 자리다.
  // 여기에는 **닫혔다는 사실만** 핀한다 — 형별 분모는 아래에서 센다.
  it('no longer misses the two shapes the 2026-09-14 comment listed', () => {
    expect(classifyRisk('rm -rf ${HOME}').level).toBe('danger');
    expect(classifyRisk('rm -rf ~user').level).toBe('danger');
  });

  // 음성 16형. 이 편집은 **터미네이터를 넓히는** 변경이라 원리적으로 과대 판정
  // 위험이 있다 — 그 위험을 재는 자리가 여기다. 실측 2026-09-14: 신규 매치 0.
  it.each([
    'rm -rf ./build',
    'rm -rf build',
    'rm -fr dist',
    'rm -rf node_modules/.cache',
    'rm -rfv dist',
    'rm -r -f dist',
    'rm --recursive --force dist',
    'rm -rf -- build',
    'rm -f file.txt',
    'rm --force file.txt',
    'rm -f /',
    'rm /tmp/file.txt',
    'ls -la /tmp',
    'rm -r ./build',
    'rm -rf *',
    // 따옴표 분기가 아무 토큰이나 받지 않는지. `["']?` 뒤에도 타깃은
    // `/`·`~`·`$HOME` 이어야 한다.
    'rm -rf "build"',
  ])('leaves %s off rm-rf-root', (command) => {
    expect(classifyRisk(command).matchedId).not.toBe('rm-rf-root');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// rm-rf-root — `${HOME}` 중괄호 형과 `~name` 사용자 홈(2026-09-21,
// guard-l2-residual). 2026-09-14 주석이 "범위 밖(오너 결정)"으로 남긴 딱 그 두
// 형이다. 리더가 2026-09-21 에 재개했다.
//
// 착수 전 실측(2026-09-21, node v24.15.0, classifyRisk + executeChain 2열):
//   ${HOME} 5형(맨몸·끝 슬래시·하위경로·큰따옴표·force 없는 재귀)
//     L1 block(force 있을 때) / L2 **caution**. 평문 `$HOME` 은 danger 이므로
//     같은 타깃을 가리키는 두 표기가 **등급이 갈렸다** — 방향 규칙 위반은
//     아니지만 과소 판정이다.
//   ~name 3형 + `~+`·`~-`·`~1`
//     L2 **safe**. force 가 붙으면 L1 은 `rm recursive+force (any target)` 로
//     block 하므로 **L1 block / L2 safe = 방향 규칙 위반**이고,
//     force 없는 재귀형(`rm -r ~user`·`rm --recursive ~user`)은 L1 도 approve —
//     **full-stack 사각**이다. 이 둘이 이 줄기의 본체다.
//
// 수리는 규칙을 **추가하지 않았다**. `~name` 은 홈 디렉터리이고 `${HOME}` 은
// `$HOME` 과 같은 값이므로 둘 다 rm-rf-root 의 소관이다. 타깃 분기 두 개만
// 넓혔고 규칙 수(27)와 정적 스캐너 분모(95)는 무접촉이다.
//
// 수용된 과대 판정: 이름이 틸드로 시작하는 **문자 그대로의 상대 경로**
// (`rm -rf ~backup` — 그런 사용자가 없으면 셸이 확장하지 않고 리터럴로 둔다)도
// danger 가 된다. 방향은 차단 쪽이고, 2026-09-14 가 받은 따옴표-틸드 과대 판정과
// 같은 종류다. 실사용 발생률은 **미측정**(트랜스크립트 조사 없음).
describe('classifyRisk — rm-rf-root grades ${HOME} like $HOME', () => {
  it.each([
    'rm -rf ${HOME}',
    'rm -rf ${HOME}/',
    'rm -rf ${HOME}/x',
    'rm -rf "${HOME}"',
    "rm -rf '${HOME}'",
    'rm -rf ${HOME};',
    'rm -rf ${HOME}&',
    'rm -rf ${HOME}|',
    'rm -rf ${HOME})',
    'rm -rf ${HOME}"',
    'rm -rf -- ${HOME}',
    'rm -rfv ${HOME}',
    'rm -r -f ${HOME}',
    'rm --recursive --force ${HOME}',
    // force 없는 재귀형. 평문 `$HOME` 쪽과 같이 rm-rf-root 는 force 를
    // 요구하지 않는다.
    'rm -r ${HOME}',
    'rm --recursive ${HOME}',
    'bash -c "rm -rf ${HOME}"',
  ])('grades %s as danger via rm-rf-root', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // 음성 대조 — **다른 변수**가 사고로 danger 가 되지 않는지. 평문 분기가
  // `$HOMEDIR` 를 거부하는 것과 정확히 같은 이유로, 중괄호 분기도 `HOME` 다음에
  // 곧바로 `}` 를 요구한다.
  it.each([
    'rm -rf ${HOMEDIR}',
    'rm -rf ${HOME_DIR}',
    'rm -rf ${HOMEPAGE}/x',
    'rm -rf ${HOMEBREW_PREFIX}',
    'rm -rf ${PROJECT_HOME}',
    // `}` 뒤에 단어문자가 붙으면 그것은 홈의 **형제**다(`/home/user` + `x`),
    // 홈이 아니다. 평문 쪽 `$HOMEDIR` 와 같은 판단.
    'rm -rf ${HOME}x',
    'rm -rf ${HOME}_old',
  ])('leaves %s off rm-rf-root', (command) => {
    expect(classifyRisk(command).matchedId).not.toBe('rm-rf-root');
  });

  // 치환·기본값 연산자 형. **danger 가 아니라 caution 으로 남긴다** — 이것은
  // 결정이지 누락이 아니다.
  //   이유 1(일관성): 평문 분기도 `rm -rf $HOME:-/tmp` 를 danger 로 보지 않는다.
  //     터미네이터 집합에 `:` 가 없기 때문이고, 중괄호 분기는 리더 조건 ③ 대로
  //     **같은 터미네이터 규칙**을 쓴다.
  //   이유 2(비용): `${HOME:-/tmp}` 를 잡으려면 `${…}` 본문 문법으로 들어가야
  //     하는데, 그러면 `${HOMEBREW_PREFIX:-/usr}` 같은 이웃을 가르는 일을 새
  //     수량자로 해야 한다. 얻는 것보다 과대 판정 위험이 크다.
  //   남는 것: 이 3형은 실제로 홈을 지우는데 L2 는 caution 이다. 과소 판정이
  //     맞고, L1 은 force 가 있으면 block 하므로 full-stack 사각은 아니다.
  //     **완전한 사각은 force 없는 형**(`rm -r ${HOME:-/tmp}`)이고 그것도
  //     rm-recursive-path 가 caution 으로 받는다. 미측정: 실사용 발생률.
  it.each([
    'rm -rf ${HOME:-/tmp}',
    'rm -rf ${HOME:?}',
    'rm -rf ${HOME-x}',
  ])('leaves the substitution form %s at caution, not danger', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).not.toBe('rm-rf-root');
  });
});

describe('classifyRisk — rm-rf-root grades ~name (another user home)', () => {
  it.each([
    'rm -rf ~user',
    'rm -rf ~user/',
    'rm -rf ~user/x',
    'rm -rf ~alice',
    'rm -rf ~bob/data',
    'rm -rf ~user-name',
    'rm -rf ~user.name',
    'rm -rf ~user_name',
    'rm -rf ~user;',
    'rm -rf ~user&',
    'rm -rf ~user|',
    'rm -rf ~user)',
    'rm -rf ~user"',
    'rm -rf -- ~user',
    'rm -rfv ~user',
    'rm -r -f ~user',
  ])('grades %s as danger via rm-rf-root', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // 이 줄기의 본체 — force 플래그가 없는 재귀 삭제. 착수 전 L1 approve +
  // L2 safe 로 **full-stack** 이었다(실측 2026-09-21, executeChain 2열).
  it.each([
    'rm -r ~user',
    'rm --recursive ~user',
    'rm -R ~user',
  ])('closes the full-stack miss %s at L2', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // 수용된 과대 판정. 그런 사용자가 없으면 셸은 `~backup` 을 확장하지 않고
  // 리터럴 상대 경로로 둔다 — 즉 홈이 아니다. 방향이 차단 쪽이라 받되 **조용히
  // 두지 않는다.** 2026-09-14 의 따옴표-틸드 항목과 같은 종류다.
  it('accepts the literal tilde-path over-match knowingly', () => {
    expect(classifyRisk('rm -rf ~backup').matchedId).toBe('rm-rf-root');
    expect(classifyRisk('rm -rf "~user"').matchedId).toBe('rm-rf-root');
  });

  // 음성 대조 — 틸드로 시작하지 않는 타깃은 그대로다.
  it.each([
    'rm -rf ./build',
    'rm -rf build',
    'rm -rf node_modules/.cache',
    'rm -rf "build"',
    'rm -f file.txt',
    // 틸드 **뒤가 이름이 아닌** 형. `~.foo` 는 유효한 사용자 이름이 아니라
    // 셸도 확장하지 않는다.
    'rm -rf ~.foo',
    'rm -rf ~$USER',
  ])('leaves %s off rm-rf-root', (command) => {
    expect(classifyRisk(command).matchedId).not.toBe('rm-rf-root');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 차집합 — rm-rf-root 가 **받지 않는** 틸드·$HOME 선두 타깃 (2026-09-22,
// guard-rm-flag-redos).
//
// 두 경로 규칙(rm-rf-path·rm-recursive-path)은 `(?![-/~*]|\$HOME\b)` 로 틸드와
// $HOME 선두를 통째로 "rm-rf-root 의 일"이라며 제외했는데, rm-rf-root 는 그
// **일부만** 받았다. 그 차집합은 어느 층에도 닿지 않았다 — 실측 2026-09-22
// (node v24.15.0, classifyRisk + BLOCKED_PATTERNS 2열):
//   rm -rf ~user* · ~* · ~$USER · ~.foo · ~+1 · ~-1   L1 block   / L2 safe
//   rm -rf $HOME* · $HOME.bak · $HOME-old             L1 block   / L2 safe
//   rm -r  ~$USER · rm -r $HOME*                      L1 approve / L2 safe  <- full-stack
// 전부 홈의 **형제나 글롭**이지 홈 자체가 아니므로 정직한 등급은 danger 가
// 아니라 caution 이고, 제외를 `(?![-/*])` 로 줄이면 두 경로 규칙이 그대로 받는다.
// 기존 danger 는 움직일 수 없다 — classifyRisk 는 첫 danger 에서 반환하고 두
// 경로 규칙은 caution 이라, 이 편집은 safe 를 올릴 수만 있다.
describe('classifyRisk — tilde/$HOME targets rm-rf-root does not claim are caution', () => {
  it.each([
    ['rm -rf ~user*', 'rm-rf-path'],
    ['rm -rf ~*', 'rm-rf-path'],
    ['rm -rf ~$USER', 'rm-rf-path'],
    ['rm -rf ~.foo', 'rm-rf-path'],
    ['rm -rf ~+1', 'rm-rf-path'],
    ['rm -rf ~-1', 'rm-rf-path'],
    ['rm -rf $HOME*', 'rm-rf-path'],
    ['rm -rf $HOME.bak', 'rm-rf-path'],
    ['rm -rf $HOME-old', 'rm-rf-path'],
    ['rm -rf ${HOME:-/tmp}', 'rm-rf-path'],
    // force 없는 재귀형 — 착수 전 **어느 층도 보지 않던** 자리.
    ['rm -r ~$USER', 'rm-recursive-path'],
    ['rm -r $HOME*', 'rm-recursive-path'],
  ])('grades %s caution via %s', (command, id) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe(id);
  });

  // `~+` = $PWD, `~-` = $OLDPWD, `~1` = 디렉터리 스택. 홈이 아니라 **현재
  // (또는 스택에 쌓인) 디렉터리**이고, 이 카탈로그는 같은 부류인 `.`·`./`·
  // `$PWD` 를 언제나 caution 으로 매겨 왔다. 28e37002 이 이 셋을 잠깐 danger 로
  // 올린 것은 `\w` 선두 이름 클래스의 **부작용**이었다. 그 커밋 기준으로는
  // 의도된 danger→caution 하향이고, 줄기 이전 기준선(b7924207)으로는 safe→
  // caution 상승이다. safe 로 돌아가는 형은 하나도 없다.
  it.each([
    'rm -rf ~+',
    'rm -rf ~-',
    'rm -rf ~1',
    'rm -r ~+',
    'rm --recursive ~1',
  ])('aligns the dirstack form %s with . and $PWD at caution', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(['rm-rf-path', 'rm-recursive-path']).toContain(r.matchedId);
  });

  // 의도된 과소 판정 — 숫자 선두 사용자 이름. 이름 클래스를 `[A-Za-z_]` 선두로
  // 둔 것은 dirstack 형(`~1`)을 빼내기 위해서이고, 그 대가로 `~1abc` 라는
  // **실제로 존재할 수 있는** 사용자 홈이 danger 가 아니라 caution 이 된다.
  // 실사용 빈도는 **미측정**. 조용히 두지 않으려고 여기 핀한다.
  it('under-grades a digit-leading user name deliberately', () => {
    const r = classifyRisk('rm -rf ~1abc');
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('rm-rf-path');
  });

  // 음성 대조 — 편집이 danger 쪽을 건드리지 않았는지. 이 다섯이 움직이면
  // 위 행들은 아무것도 증명하지 못한다.
  it.each([
    ['rm -rf /', 'rm-rf-root'],
    ['rm -rf ~', 'rm-rf-root'],
    ['rm -rf ~/x', 'rm-rf-root'],
    ['rm -rf ~user', 'rm-rf-root'],
    ['rm -rf ${HOME}', 'rm-rf-root'],
  ])('keeps %s at danger via %s', (command, id) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(id);
  });

  // 오탐 대조군 — 홈이 **아닌** 변수, 평범한 상대 경로.
  it('does not turn $HOMEDIR or ./build into something new', () => {
    expect(classifyRisk('rm -rf $HOMEDIR').matchedId).toBe('rm-rf-path');
    expect(classifyRisk('rm -rf ./build').matchedId).toBe('rm-rf-path');
    expect(classifyRisk('rm -rf ${HOMEDIR}').matchedId).toBe('rm-rf-path');
  });

  // 두 경로 규칙은 **같은 편집**을 받는다. rm-rf-path 에서 force lookahead 만
  // 지우면 rm-recursive-path 와 바이트 동일해야 한다 — 한쪽만 고치면 여기서
  // 먼저 깨진다.
  it('keeps the two path rules byte-identical apart from the force lookahead', () => {
    const byId = (id) => DANGEROUS_PATTERNS.find((r) => r.id === id);
    const forceLookahead = '(?=(?:\\s+--?\\w[\\w-]*)*\\s+(?:--force|-[a-eg-z]*f[a-z]*)(?![\\w-]))';
    expect(byId('rm-rf-path').test.source).toContain(forceLookahead);
    expect(byId('rm-rf-path').test.source.replace(forceLookahead, ''))
      .toBe(byId('rm-recursive-path').test.source);
  });
});

// 언급 대조 — 두 신규 형 모두. 터미네이터·이름 클래스를 넓히는 편집은 원리적으로
// 과대 판정 위험이 있고, 그 위험이 가장 비싸게 드러나는 곳이 "삭제를 말하는 글"이다.
// 실측 2026-09-21: 신규 거짓 양성 0.
describe('classifyRisk — the two new shapes stay safe in mention form', () => {
  it.each([
    'echo "rm -rf ${HOME}"',
    'echo "rm -rf ~user"',
    '# rm -rf ${HOME}',
    '# rm -rf ~user',
    'echo rm -rf ${HOME}',
    'echo rm -rf ~user',
    "grep -n 'rm -rf ~user' notes.txt",
    'git commit -m "document rm -rf ${HOME}"',
  ])('leaves the mention %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// rm-recursive-path — force 플래그 없는 재귀 삭제(리더 추가 목표 A, 2026-09-14).
//
// 왜 생겼나(실측 2026-09-14, node v24.15.0, executeChain + classifyRisk 17형):
// force 없는 재귀 삭제는 **full-stack 사각**이었다.
//   rm -r ./build                 L1 approve / L2 safe
//   rm -R x                       L1 approve / L2 safe
//   rm -r dir · rm -rv dir        L1 approve / L2 safe
//   rm --recursive dir            L1 approve / L2 safe
//   rm --recursive <513자>/x      L1 approve / L2 safe   <- 창(512) 밖
//   rm --recursive a/b/c          L1 block   / L2 safe   <- L1 단독, 방향 규칙 위반
// L1 은 `rm -rf with path`(-\w*r\w*f 결합 토큰) 와 `rm recursive+force
// (any target)` 둘 다 force 를 요구하고, `--recursive` 롱폼만 창 안의 `/` 와
// 함께일 때 잡는다. L2 는 rm-rf-root 가 `/`·`~`·$HOME 타깃을, rm-rf-path 가
// force 를 요구했다. 이 규칙이 그 교집합을 메운다.
//
// 이 describe 가 증명하지 않는 것: L1 쪽 폭(512)은 여기서 재지 않는다 —
// tests/core/blocked-patterns.test.js 의 'DOCUMENTED BLIND SPOT' 과 경계 쌍이
// 그 정본이고, 이 파일은 L2 판정만 책임진다.
describe('classifyRisk — force-less recursive delete is caution', () => {
  it.each([
    'rm -r ./build',
    'rm --recursive a/b/c',
    'rm -R x',
    'rm -r dir',
    'rm -rv dir',
    'rm --recursive dir',
    'rm -r -- dir',
  ])('grades %s as caution via rm-recursive-path', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('rm-recursive-path');
  });

  // 창 밖 경로. L1 은 여기서 approve 이므로(창 512) 이 행이 그린이라는 것이
  // full-stack 사각이 닫혔다는 유일한 증거다. 513 은 L1 창의 첫 바깥 값이다.
  it('grades a recursive delete with a path past the L1 512-char window as caution', () => {
    const r = classifyRisk(`rm --recursive ${'a'.repeat(513)}/x`);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('rm-recursive-path');
  });

  // 순서 의존 핀. force 가 있으면 rm-rf-path 가 먼저 잡아야 한다 — 새 규칙을
  // 배열 앞으로 옮기면 여기가 먼저 깨진다(caution 은 첫 히트가 이긴다).
  it.each([
    ['rm -rf ./build', 'rm-rf-path'],
    ['rm -r -f dist', 'rm-rf-path'],
    ['rm --recursive --force out', 'rm-rf-path'],
  ])('leaves %s on rm-rf-path, not the new rule', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe(matchedId);
  });

  // 음성 대조. 재귀 플래그가 없으면 발화하지 않는다.
  it.each([
    'rm x',
    'rm -f x',
    'rm -i x',
    'rm -- x',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  // 루트·글로브 타깃은 위 두 규칙이 danger 로 먼저 가져간다 — 새 규칙이
  // 그것을 caution 으로 강등시키지 않는지 본다.
  it.each([
    ['rm -rf /', 'rm-rf-root'],
    ['rm -r /', 'rm-rf-root'],
    ['rm -r ~/x', 'rm-rf-root'],
    ['rm -r $HOME/x', 'rm-rf-root'],
    ['rm -r *', 'rm-rf-broad'],
  ])('keeps %s at danger via %s', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });

  // 창 게이트와의 관계: 이 규칙은 창을 갖지 않으므로 경계 쌍 집합에 들어가면
  // 안 된다. 아래 'windowed rule ids === boundary pair ids' 가 집합 동일성을
  // 보지만, 그 단언은 규칙이 창을 **얻었을 때**만 움직인다. 여기서 직접 못
  // 박아 둔다 — 누가 이 규칙에 `[^\n]{0,N}` 을 끼워 넣으면 양쪽이 함께 RED 다.
  it('carries no window, so it is out of the boundary-pair set', () => {
    const rule = DANGEROUS_PATTERNS.find((r) => r.id === 'rm-recursive-path');
    expect(rule).toBeDefined();
    expect(rule.level).toBe('caution');
    expect(hasBoundedWindow(rule.test.source)).toBe(false);
  });

  // 배열 순서 자체를 핀한다. 위 'leaves … on rm-rf-path' 와 중복이 아니다 —
  // 저쪽은 판정을, 여기는 원인을 고정한다.
  it('sits after rm-rf-path in the catalogue', () => {
    const ids = DANGEROUS_PATTERNS.map((r) => r.id);
    expect(ids.indexOf('rm-recursive-path')).toBeGreaterThan(ids.indexOf('rm-rf-path'));
  });
});

describe('classifyRisk — force push: lease is caution, blind force stays danger', () => {
  // 오너 결정 2026-09-11 ①. L1(blocked-patterns.js `git push --force` 규칙) 은
  // --force-with-lease / --force-if-includes 를 패턴 안 부정 예측으로 면제한다
  // (2026-09-11 까지는 safeOverrides 목록이었다). L2 가 같은 명령을 danger 로
  // 부르면 두 층이 정반대를 말한다 → L2 는 caution 으로 내린다.
  it.each([
    'git push --force origin main',
    'git push origin main --force',
    'git push --force',
    'git push --force-with-lease origin main --force',
    // A blind --force anywhere outranks a lease flag, whatever the order.
    'git push --force-with-lease --force',
    // The separator stop must not cut a force flag that sits BEFORE the
    // separator — that one really is the push's own flag.
    'git push origin main --force && echo done',
  ])('grades %s as danger via git-force-push', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-force-push');
  });

  it.each([
    'git push -f origin main',
    'git push origin main -f',
    // -f is blind even when a lease flag follows it.
    'git push -f --force-with-lease',
    // A separator ends the -f token just as whitespace does. The old tail
    // demanded whitespace or end-of-string, so a real blind force push that
    // was merely followed by another command went ungraded.
    'git push origin main -f; echo done',
    'git push origin main -f && echo done',
    'git push -f|cat',
  ])('grades %s as danger via git-force-push-short', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-force-push-short');
  });

  it.each([
    'git push --force-with-lease origin main',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main',
    'git push --force-if-includes origin main',
    'git push --force-with-lease --force-if-includes origin main',
  ])('grades %s as caution via git-force-push-lease', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('git-force-push-lease');
  });

  it.each([
    'git push origin main',
    'git push --tags',
    'git pull --force',
    // The option run stops at a shell separator, so a force flag belonging to a
    // LATER command on the same line is not the push's flag. Without that stop
    // all three of these were graded danger via git-force-push-short — the `-f`
    // of the second command was absorbed into the push's run.
    'git push origin main && rm -f x',
    'git push origin main; ls -f',
    'git push origin main | grep -f pattern file',
    // -f must be a whole token: a longer short-flag bundle or a hyphenated
    // continuation is a different flag, not a blind force.
    'git push -fu origin main',
    'git push -f-x origin',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

/** 백슬래시. 리터럴로 쓰면 이스케이프 단계에서 사고가 난다. */
const BACKSLASH = String.fromCharCode(92);

/**
 * 콜론. 포크밤 리터럴을 이 파일 안에서만 조립하기 위한 분절자 —
 * tests/core/blocked-patterns.test.js 의 관례와 같다. 완성된 포크밤 문자열을
 * Bash 명령줄에 넣으면 L1 PreToolUse 가 차단한다(인용해도 마찬가지).
 */
const COLON = String.fromCharCode(58);

describe('classifyRisk — git branch delete is case-sensitive on -D', () => {
  // 오너 결정 2026-09-11 ④. /i 플래그 때문에 안전한 `git branch -d` 가
  // danger 로 등록됐다. -D(강제)만 danger, -d/--delete 는 safe.
  it.each([
    'git branch -D topic',
    'git branch -D feat/x',
    'git branch -q -D topic',
    'git branch -Dv topic',
    'git branch --delete --force topic',
    'git branch --force --delete topic',
    'git branch -fd topic',
    'git branch -df topic',
    'git branch -f -d topic',
    // 인수 뒤에 붙은 플래그도 git 은 그대로 받는다 — 옵션 런이 대시 없는
    // 인수를 건너뛰지 못하면 이 네 형태가 전부 샌다(검수 2026-09-11 실측).
    'git branch -d topic -f',
    'git branch --delete topic --force',
    'git branch -f topic -d',
    'git branch topic -D',
    // 명령어 `git` 만 대소문자 무시 — 셸은 GIT 을 그대로 실행한다.
    'Git branch -D x',
    'GIT branch -D x',
    // 백슬래시 줄 연속은 한 명령이다 — 런이 끊기면 안 된다. 백슬래시는
    // String.fromCharCode(92) 로 조립해 리터럴 이스케이프 사고를 피한다.
    `git branch -d topic ${BACKSLASH}\n -f`,
    `git branch ${BACKSLASH}\n -D topic`,
    `git branch${BACKSLASH}\n -d topic -f`,
    `git branch -d topic ${BACKSLASH}\r\n -f`,
  ])('grades %j as danger via git-branch-delete', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-branch-delete');
  });

  it.each([
    'git branch -d topic',
    'git branch -d feat/x',
    'git branch --delete topic',
    'git branch -q -d topic',
    'git branch',
    'git branch -a',
    'git branch -r',
    'git branch -vv',
    'git branch --list',
    'git branch -m old new',
    'git branch --sort=-committerdate',
    // 셸 구분자에서 옵션 런이 끝난다 — 뒤 명령의 -f 를 빌려오면 안 된다.
    'git branch -d topic && echo -f',
    'git branch -d topic | grep -f',
    'git branch -d topic; rm -f x',
    // 줄바꿈도 런을 끝낸다. 이 경계가 없으면 안전한 2줄 스크립트가
    // 뒷줄의 -f 때문에 danger 가 된다(검수 정규식 실측 오탐 2건).
    // 둘째 줄은 그 자체로 safe 한 명령이어야 이 경계만 검증한다.
    'git branch -d old\nnpm run build -- --force',
    'git branch -d topic\necho -f done',
    // -f 는 있지만 삭제 플래그가 없다.
    'git branch -m Dev -f',
    'git branch -v -f',
    'git branch --format=%(refname) -f',
    // git 이 대문자 서브커맨드를 거부한다 — 실행되지 않는 형태는 잡지 않는다.
    'git BRANCH -D x',
    // 줄 연속 뒤라도 셸 구분자는 여전히 런을 끝낸다.
    `git branch -d topic ${BACKSLASH}\n && ls -f`,
    `git branch -d topic ${BACKSLASH}\n | grep -f`,
  ])('leaves %j safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  // 검수 정규식이 실제로 낸 오탐 그대로. 둘째 줄은 rm-rf-path 로 caution 이
  // 되므로 level 로는 못 잡는다 — 어느 규칙이 잡았는지를 봐야 한다.
  // 브랜치 삭제 규칙이 다음 줄의 -rf 를 강제 플래그로 빌려오면 안 된다.
  it.each([
    'git branch -d old\nrm -rf build',
    'git branch -d topic\ngit push -f origin main',
  ])('does not let git-branch-delete claim %j across a newline', (command) => {
    expect(classifyRisk(command).matchedId).not.toBe('git-branch-delete');
  });
});

describe('classifyRisk — TRUNCATE needs SQL statement shape', () => {
  // 오너 결정 2026-09-11 ②. /\bTRUNCATE\b/i 는 단어가 스치기만 해도 발화해
  // `grep -n -i "truncate\|force-with-lease" file` 을 차단했다(2026-09-11 실측).
  it.each([
    'TRUNCATE users;',
    'TRUNCATE TABLE users',
    'truncate table users;',
    'TRUNCATE ONLY users CASCADE',
    'psql -c "TRUNCATE users RESTART IDENTITY"',
    'TRUNCATE DATABASE foo',
    'TRUNCATE TABLE public.users RESTART IDENTITY CASCADE',
    'TRUNCATE users, orders;',
    'TRUNCATE users RESTRICT;',
  ])('grades %s as danger via sql-truncate', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-truncate');
  });

  it.each([
    'grep -n -i "truncate\\|force" file.js',
    'grep -n -B2 -A3 "force-with-lease\\|TRUNCATE\\|dd if" some.test.js',
    'git log --grep=truncate',
    'echo truncate',
    'node -e "fs.truncateSync(p)"',
    'truncate -s 0 file.log',
    'git commit -m "truncate long branch names"',
    'rg --files-with-matches TRUNCATE lib/',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

describe('classifyRisk — dd writing to a raw device is danger', () => {
  // 오너 결정 2026-09-11 ③. L1(blocked-patterns.js:54 `dd\s+if=`) 은 차단하는데
  // L2 는 safe 였다 — "L1 block ⇒ L2 >= caution" 방향 규칙 위반.
  it.each([
    'dd if=/dev/zero of=/dev/sda',
    'dd if=/dev/zero of=/dev/sdb bs=1M',
    'sudo dd if=disk.img of=/dev/disk2 bs=4m',
    'dd of=/dev/sda if=/dev/zero',
  ])('grades %s as danger via dd-device-write', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('dd-device-write');
  });

  it.each([
    'dd if=a.img of=b.img',
    'echo dd',
    'node scripts/dd-report.js',
    'ls /dev/sda',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

describe('classifyRisk — fork bomb', () => {
  // 4형은 tests/core/blocked-patterns.test.js 의 L1 포크밤 describe 와 같은
  // 문자열이다. L2 는 normalizeCommand 를 거치지 않고 원문을 그대로 보지만,
  // 규칙에 앵커가 없어 같은 4형을 모두 잡는다.
  const CANONICAL = `${COLON}(){ ${COLON}|${COLON}& };${COLON}`;
  const SPACED = `${COLON} () { ${COLON} | ${COLON} & } ; ${COLON}`;
  const TIGHT = `${COLON}(){${COLON}|${COLON}&};${COLON}`;
  // 괄호 없는 형태. 셸이 실행하지는 못하지만 종전 L1 규칙이 유일하게 잡던
  // 형태라 괄호를 선택 그룹으로 두어 그대로 유지한다.
  const LEGACY = `${COLON}{ ${COLON}|${COLON}& };${COLON}`;

  it.each([
    ['canonical', CANONICAL],
    ['spaced', SPACED],
    ['no inner spaces', TIGHT],
    ['legacy paren-less shape', LEGACY],
  ])('grades the %s shape as danger via fork-bomb', (_name, command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    // 이 단언이 순서 의존까지 막는다 — 다른 규칙이 먼저 걸리면 id 가 달라진다.
    expect(r.matchedId).toBe('fork-bomb');
  });

  // 2026-09-14 계약 반전(guard-command-position). 종전에는 이 입력이 danger 였고
  // "의도된 과차단"이라는 주석과 함께 핀돼 있었다. **echo 인용은 실행이 아니다** —
  // 세그먼트 전처리(lib/core/command-segments.js#blankPrinterSegments)가 프린터
  // 세그먼트를 통째로 비우므로 순수 언급은 더 이상 발화하지 않는다. 이 오탐은
  // 관념적인 것이 아니었다: 가드 소스를 다루는 정찰·검수 창에서 2026-09-11 하루에
  // 6회 실차단됐다(브리프 §배경 실사례).
  //
  // 강등이 아니라 **정확해진 것**임을 아래 세 it 이 증명한다 — 파이프·치환·세그먼트
  // 분리가 붙는 순간 전부 danger 로 돌아온다. 이 네 it 은 한 묶음이다. 위만 남기고
  // 아래를 지우면 fail-open 이 된다.
  it('leaves the fork bomb safe when it is only quoted inside echo', () => {
    const r = classifyRisk(`echo '${CANONICAL}'`);
    expect(r.level).toBe('safe');
    expect(r.matchedId).toBeUndefined();
  });

  it.each([
    ['piped into a shell (condition ii)', (c) => `echo '${c}' | sh`],
    ['inside a command substitution (condition iii)', (c) => `echo "$(${c})"`],
    ['in a second segment after a printer (segment split)', (c) => `echo 'safe' ; ${c}`],
    ['redirected out of the printer (condition iv)', (c) => `echo '${c}' > /tmp/f`],
  ])('still grades the fork bomb danger when it is %s', (_name, build) => {
    const r = classifyRisk(build(CANONICAL));
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('fork-bomb');
  });

  // 허용목록 밖 프린터는 면제되지 않는다(fail-closed 의 실행형 반증).
  it('still grades the fork bomb danger through a printer outside the allowlist', () => {
    const r = classifyRisk(`logger '${CANONICAL}'`);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('fork-bomb');
  });

  // 경계. `:` 는 셸 no-op 이라 정상 스크립트에 흔하다. L1 음성 5건과 동일.
  it.each([
    `echo hi; ${COLON}`,
    `function f() { ${COLON}; }`,
    `while ${COLON}; do sleep 1; done`,
    'build: ; @echo hi',
    `${COLON}() { echo hi; }`,
  ])('leaves %j safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  // 드리프트 게이트. 이 규칙의 값은 L1 과 같은 판정을 한다는 것뿐이므로
  // 바이트가 갈라지는 순간 가치가 사라진다.
  it('keeps the pattern byte-identical to the L1 fork bomb rule', () => {
    const l2 = DANGEROUS_PATTERNS.find((r) => r.id === 'fork-bomb');
    const l1 = BLOCKED_PATTERNS.find((p) => p.label === 'fork bomb');
    expect(l2).toBeDefined();
    expect(l1).toBeDefined();
    expect(l2.test.source).toBe(l1.pattern.source);
    expect(l2.test.flags).toBe(l1.pattern.flags);
  });

  // 120KB 는 종료와 판정만 본다 — 벽시계는 40KB 단언이 맡는다. 2차식이
  // 돌아오면 여기는 느려질 뿐 실패하지 않으므로 이것을 성능 근거로 쓰지 말 것.
  it.each([
    ['space', `${COLON}${' '.repeat(120_000)}x`],
    ['newline', `${COLON}${'\n'.repeat(120_000)}x`],
  ])('returns safe on a 120KB %s run after a single colon', (_name, input) => {
    expect(classifyRisk(input).level).toBe('safe');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 프린터 세그먼트 전처리 × 카탈로그 전체 (2026-09-14, guard-command-position).
//
// 포크밤 describe 는 규칙 하나에서 반전을 증명한다. 여기는 그것이 **카탈로그
// 전반**에 같은 방식으로 적용되는지, 그리고 전처리가 규칙과 상호작용해 판정을
// 바꾸는 자리가 어디인지를 본다. 후자가 이 블록의 존재 이유다 — 전처리는
// 규칙을 한 줄도 고치지 않지만 규칙이 보는 **텍스트**를 바꾸므로, "규칙 diff 0"
// 은 "판정 diff 0" 이 아니다.
describe('classifyRisk — printer-segment preprocessing across the catalogue', () => {
  // 언급 래퍼. 종전에는 전부 발화했다(브리프 §배경: L2 20~22/22).
  it.each([
    ['echo double-quoted', 'echo "DROP TABLE users"'],
    ['echo single-quoted', "echo 'git push --force origin main'"],
    ['shell comment', '# rm -rf /tmp/x'],
    ['printf', "printf '%s' 'TRUNCATE users;'"],
    ['grep', 'grep -rn "DROP TABLE" .'],
    ['git commit -m', 'git commit -m "rm -rf build"'],
    ['git tag -m', 'git tag -m "npm publish went out" v1'],
    ['transparent prefix + echo', 'sudo echo "git reset --hard"'],
    ['assignment prefix + echo', 'FOO=1 echo "git stash clear"'],
  ])('leaves a %s mention safe', (_name, command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  // 거부권 4종. 위 목록과 **같은 문자열**이 실행 가능해지는 순간 돌아온다.
  it.each([
    ['pipe (ii)', 'echo "DROP TABLE users" | psql', 'sql-drop-table'],
    ['substitution (iii)', 'echo "$(DROP TABLE users)"', 'sql-drop-table'],
    ['redirect (iv)', 'echo "DROP TABLE users" > /tmp/f', 'sql-drop-table'],
    ['segment split', 'echo "safe" ; DROP TABLE users', 'sql-drop-table'],
    ['printer outside the allowlist', 'logger "DROP TABLE users"', 'sql-drop-table'],
    ['git commit --exec is not a message form', 'git commit --exec "DROP TABLE users"', 'sql-drop-table'],
  ])('still grades %s as danger', (_name, command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });

  // heredoc 본문은 계속 차단된다 — 누락이 아니라 결정이다. 본문을 인쇄물로
  // 보기 시작하면 `bash <<EOF` 가 통째로 사각이 된다.
  it('still grades a heredoc body as danger (deliberate residual false positive)', () => {
    const r = classifyRisk(`cat <<'EOF'\nrm -rf /\nEOF`);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-root');
  });

  // secret-* 4규칙은 RAW 텍스트를 본다. 시크릿을 echo 하는 것 자체가 유출이므로
  // 면제가 적용되면 안 된다. 이 it 이 그 예외 경로의 유일한 실행형 증거다.
  // 리터럴은 조립해서 만든다 — 파일에 그대로 적으면 시크릿 스캐너가 쓰기를
  // 거부한다(2026-09-14 실차단).
  it.each([
    ['secret-aws', `echo "${'aws_secret_access'}_key=x"`, 'secret-aws'],
    ['secret-openai', `echo "${'sk-'}${'a'.repeat(24)}"`, 'secret-openai'],
    ['secret-private-key', `echo "-----BEGIN RSA PRIVATE ${'KEY'}-----"`, 'secret-private-key'],
  ])('keeps %s firing on the raw text even inside a printer', (_name, command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.matchedId).toBe(matchedId);
    expect(r.level).not.toBe('safe');
  });

  // ── 전처리가 판정을 바꾼 유일한 "더 엄격해진" 자리 ────────────────────────
  // 규칙 소스는 그대로인데 판정이 safe -> danger 로 움직인다. 방향이 차단
  // 쪽이라 받아들이지만, **조용히 두지 않는다**.
  // 원인: sql-delete-no-where 의 꼬리 `(?!.*\bWHERE\b)` 는 줄 끝까지가 아니라
  // 입력 끝까지(`s` 플래그) 훑었다. `DELETE FROM t; echo "WHERE"` 에서 종전에는
  // 그 `WHERE` 가 lookahead 를 막아 safe 였다 — 즉 **인쇄되는 단어 하나로 SQL
  // 규칙을 무력화할 수 있었다.** 전처리가 인쇄 세그먼트를 비우면서 그 우회가
  // 닫혔다.
  //
  // **2026-09-14 후속(guard-l2-followups ②)**: 이제 규칙 자체도 `[^;]{0,192}`
  // 라 `;` 를 못 넘는다. 즉 이 우회는 두 번 닫혀 있고, 이 it 은 더 이상 전처리
  // 단독의 증거가 아니다. 전처리와 무관한 규칙 단독 증거는 아래 describe 의
  // 'closes the printed-WHERE bypass in the rule source alone' 이 맡는다.
  it('closes the "print the word WHERE to defuse the rule" bypass', () => {
    const r = classifyRisk('DELETE FROM t; echo "WHERE"');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-delete-no-where');
  });

  // 음성 대조 — 진짜 WHERE 절은 인쇄물이 아니므로 전처리가 손대지 않는다.
  //
  // **2026-09-14 반전**(guard-l2-followups ②). 이 it 은 종전에 선재 오탐을
  // "그대로 두었다"고 핀했다 — 그 줄기가 정규식을 0건 편집했기 때문이다. 이제
  // 규칙 몸통에서 공백을 뺐으므로 오탐이 사라졌고, 핀도 뒤집는다. 원인은
  // 그때 적어 둔 그대로였다: 몸통 문자클래스가 공백을 포함해 `t WHERE id` 까지
  // 삼킨 뒤 `=` 에서 멈추면 lookahead 가 성립해 버렸다.
  it('no longer fires on a single-line WHERE clause', () => {
    const r = classifyRisk('DELETE FROM t WHERE id=1');
    expect(r.level).toBe('safe');
    expect(r.matchedId).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// sql-delete-no-where — 몸통 클래스 + 창 있는 lookahead(2026-09-14, ②).
//
// 두 자리를 고쳤다. (1) 몸통 `[\w."` ]+` 에서 공백 제거 — 단일행 WHERE 8형이
// 전부 오탐이었다(실측 8/8). (2) lookahead `(?!.*\bWHERE\b)` → `(?![^;]{0,192}…)`
// 이고 `s` 플래그 삭제. `[^;]` 는 문장 경계를 못 넘으므로 **뒷 문장의 WHERE 로
// 앞 문장을 무력화하는 우회**가 닫힌다.
//
// 포기하는 것: 테이블명 뒤 193자 이후의 WHERE 는 보이지 않아 danger 로 판정한다
// (fail-closed). 그 폭의 정본은 아래 경계 쌍 하나뿐이다.
describe('classifyRisk — sql-delete-no-where reads the WHERE that belongs to it', () => {
  it.each([
    'DELETE FROM t WHERE id=1',
    "DELETE FROM t WHERE name = 'x'",
    'DELETE FROM t WHERE id IN (1,2)',
    'DELETE FROM t WHERE active',
    'DELETE FROM a USING b WHERE a.id=b.id',
    'DELETE FROM t WHERE',
    'psql -c "DELETE FROM t WHERE id=1"',
    `DELETE FROM t WHERE ${'x'.repeat(200)}`,
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  // 진성 9형. 오탐 수리가 진양성을 깎지 않았다는 것이 이 목록의 전부다.
  it.each([
    'DELETE FROM t;',
    'DELETE FROM t',
    'DELETE FROM "t"',
    '`DELETE FROM t`;',
    'DELETE FROM db.t',
    'DELETE FROM t RETURNING *',
    'DELETE FROM t ORDER BY id LIMIT 1',
    'DELETE FROM t\n',
    'psql -c "DELETE FROM t"',
  ])('keeps %s at danger', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-delete-no-where');
  });

  // 줄바꿈 WHERE. `[^;]` 는 줄바꿈을 넘으므로 `s` 플래그를 지워도 계속 safe 다
  // — `s` 는 `.` 에만 의미가 있었고 새 식에는 `.` 이 없다.
  it.each([
    'DELETE FROM t\nWHERE id=1',
    'DELETE FROM t\n  WHERE id=1',
  ])('leaves the multi-line form %j safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  // `;` 경계. 뒷 문장의 WHERE 는 앞 문장과 무관하다.
  it('does not let a later statement WHERE defuse this one', () => {
    const r = classifyRisk('DELETE FROM t; SELECT 1 WHERE x');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-delete-no-where');
  });

  // 위 'closes the "print the word WHERE to defuse the rule" bypass' 는 전체
  // 경로(전처리 포함)를 재고, 이 it 은 **규칙 소스 단독**을 잰다. 두 개가 다른
  // 것을 증명한다 — 종전에는 그 우회가 전처리에만 의존해 닫혀 있었고, 전처리를
  // 끄면 되살아났다. 이제 규칙 혼자로도 닫힌다.
  it('closes the printed-WHERE bypass in the rule source alone, with no preprocessing', () => {
    const rule = DANGEROUS_PATTERNS.find((r) => r.id === 'sql-delete-no-where');
    expect(rule.test.test('DELETE FROM t; echo "WHERE"')).toBe(true);
    // 같은 식이 진짜 WHERE 절은 여전히 비껴간다 — 위 true 가 "무조건 매치"가
    // 아니라는 분모.
    expect(rule.test.test('DELETE FROM t WHERE id=1')).toBe(false);
  });

  // 포기 범위를 실행형으로 못 박는다. 193 은 창(192)의 첫 바깥 값이고, 그
  // 바깥에서는 WHERE 가 있어도 danger 다 — fail-closed 이지 사각이 아니다.
  it('grades a WHERE past the 192-character window as danger (fail-closed)', () => {
    // 테이블명과 WHERE 사이가 정확히 193자 — 창의 첫 바깥 값.
    const past = `DELETE FROM t ${'x'.repeat(191)} WHERE y`;
    const r = classifyRisk(past);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-delete-no-where');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ReDoS 정적 스캔 — 선형성의 **정본 게이트**.
//
// 스캐너 구현과 그 교리(무제한 런의 정의 3조건 · 창 상한 허가 목록 · **못 보는 것**
// 8국)은 2026-09-14 부터 `tests/helpers/regex-scan.js` 에 있다. 거기가 정본이고
// 이 파일은 그것을 **세 카탈로그에 적용**하는 자리다. 호출 파일은 둘이다 —
// 이 파일(L1 · L2 · HG 카탈로그 스캔)와
// `tests/firewall/human-gate-matrix-selfcheck.test.js` 섹션 G(HG 구조 핀).
// 스캐너 자체의 자기검증은 `tests/helpers/regex-scan.test.js` 로 같이 옮겼다.
//
// 아래 `SCAN_ALLOWLIST` 만 이 파일에 남는다 — L2 카탈로그 전용 정책이고
// DANGEROUS_PATTERNS 를 소유한 것이 이 파일이기 때문이다. HG 예외는 두 파일이
// 함께 쓰므로 헬퍼의 `HG_SCAN_ALLOWLIST` 가 유일한 등록처다.
// ────────────────────────────────────────────────────────────────────────────

/**
 * 스캔 예외. **2026-09-14 부로 공집합이다.**
 *
 * 종전 유일 항목은 `sql-delete-no-where` 였고 근거는 "`(?!.*\bWHERE\b)` 는 실측
 * 선형"이었다. **그 근거는 틀렸다.** 그 측정은 비매치 반복형(`'DELETE FROM t '`)
 * 으로 했는데 그 입력은 **첫 시도에서 매치가 끝나** 백트래킹을 한 번도 밟지
 * 않는다. 매 시도 위치에서 실패하는 입력으로 다시 재면 2차식이 나온다 —
 * 실측(node v24.15.0, 2026-09-14, 3회 중앙값, 규칙 단독,
 * `fill('DELETE FROM t=1 WHERE x ', n)`):
 *            20,480B   40,962B   122,880B   raw t122880/t20480
 *   옛 규칙    6.10      26.00     257.00     42x  <- 2차식
 *   현 규칙    0.38       0.74       3.09     5.6x
 * 절대값은 실행마다 크게 흔들리지만(옛 규칙 122,880B 가 5회에서 132~257ms)
 * 모양은 안 흔들린다 — 옛 비율 16~60x, 현 비율 3~9x.
 * 두 측정 모두 참이었고 **일반화가 거짓**이었다. 교훈은 규율 §9 그대로다:
 * 픽스처가 현실과 다르면 그 그린은 아무것도 증명하지 않는다.
 *
 * 지금 규칙은 `[^;]{0,192}` 로 창이 있어 스캐너 기본 상한(192) 안이고, `.` 이
 * 없어 무제한 런 자체가 0 이다. 예외가 필요 없으므로 목록을 비웠다 — 규칙을
 * 깎아 게이트를 통과시킨 것이 아니라 게이트를 만족하도록 **규칙을 고쳤다**
 * (규율 §10). 아래 두 it 이 "예외 0건"과 "그 규칙 스캔 0 hit"을 각각 붙든다.
 */
const SCAN_ALLOWLIST = new Set();

describe('ReDoS 정적 스캔 — 규칙 소스에 무제한 런이 없다', () => {
  it.each(BLOCKED_PATTERNS.map((p, idx) => [`L1[${idx}] ${p.label}`, p.pattern, p.label]))(
    '%s', (_name, pattern, key) => {
      const hits = findUnboundedRuns(pattern.source, pattern.flags, ceilingFor('L1', key));
      expect(hits.map((h) => h.snippet)).toEqual([]);
    },
  );

  it.each(
    DANGEROUS_PATTERNS
      .filter((r) => !SCAN_ALLOWLIST.has(r.id))
      .map((r) => [`L2 ${r.id}`, r.test, r.id]),
  )('%s', (_name, pattern, key) => {
    const hits = findUnboundedRuns(pattern.source, pattern.flags, ceilingFor('L2', key));
    expect(hits.map((h) => h.snippet)).toEqual([]);
  });

  // 세 카탈로그를 합친 분모. 위 세 it.each 가 "몇 개를 훑었는지"는 러너 출력에
  // 안 보이므로, 카탈로그가 줄어들어도 전부 그린이다. 여기가 그 자리를 맡는다.
  //
  // 2026-09-14: 이 줄기 브리프는 분모를 39 + 26 + 29 = 94 로 적었으나 실측은
  // **39 + 27 + 29 = 95** 다(L2 는 27개 — 헬퍼 추출 전후 hit 집합을 덤프해
  // 대조하면서 드러났다). 문서의 수치가 아니라 이 it 이 정본이다.
  it('scans 95 patterns across the three catalogues (39 + 27 + 29)', () => {
    expect(BLOCKED_PATTERNS).toHaveLength(39);
    expect(DANGEROUS_PATTERNS).toHaveLength(27);
    const hg = HUMAN_GATE_MATRIX.reduce((n, row) => n + row.patterns.length, 0);
    expect(hg).toBe(29);
    expect(BLOCKED_PATTERNS.length + DANGEROUS_PATTERNS.length + hg).toBe(95);
  });

  it('L2 예외는 0건이다', () => {
    expect([...SCAN_ALLOWLIST]).toEqual([]);
    // 위 L2 it.each 의 분모가 카탈로그 전체인지. 예외가 하나라도 생기면
    // 여기가 먼저 RED 다 — 조용히 규칙 하나가 스캔 밖으로 나가지 않는다.
    expect(DANGEROUS_PATTERNS.filter((r) => !SCAN_ALLOWLIST.has(r.id)))
      .toHaveLength(DANGEROUS_PATTERNS.length);
  });

  it('sql-delete-no-where 는 무제한 런이 0 이라 예외가 필요 없다', () => {
    const rule = DANGEROUS_PATTERNS.find((r) => r.id === 'sql-delete-no-where');
    expect(findUnboundedRuns(rule.test.source, rule.test.flags)).toEqual([]);
    // 근거를 모양으로 못 박는다. `.` 이 없고(그래서 `s` 플래그도 없다) 창이
    // 기본 상한 안이다. `{0,192}` 를 넓히거나 `.*` 로 되돌리면 위 L2 it.each 가
    // RED 가 되고, 예외를 다시 추가하려면 바로 위 '예외는 0건' it 도 함께
    // 고쳐야 한다 — 두 군데를 고치게 만드는 것이 이 쌍의 목적이다.
    expect(rule.test.source).toContain('[^;]{0,192}');
    expect(rule.test.source).not.toContain('.*');
    expect(rule.test.flags).not.toContain('s');
  });

  // ── 세 번째 카탈로그 (2026-09-14) ─────────────────────────────────────────
  // 왜 늘렸나: HG 표는 같은 PreToolUse 경로를 탄다(probe 'command', tools Bash)
  // 면서 두 정규식 카탈로그 밖이라 W7 정적 스캔이 구조적으로 못 봤다. 그 사각의
  // 비용은 가정이 아니라 실측이었다 — 바운드 전 HG-07 은 단일 정규식으로
  // 40,962B 187.7ms / 122,880B 1,658.6ms(curl), 90.2 / 1,085.4ms(git push)였다
  // (3회 중앙값, node v24.15.0, 2026-09-14 01:3x KST, 다른 세션 부하 있음).
  // 5초 훅 예산 안이지만 2차식 곡선이고, 스캐너가 못 보는 한 다음 규칙도 같은
  // 모양으로 들어온다. 이제 본다.
  it.each(
    HUMAN_GATE_MATRIX.flatMap((row) => row.patterns.map((pattern, i) => [
      `HG ${row.id}[${i}]`, pattern, `${row.id}[${i}]`,
    ])),
  )('%s', (_name, pattern, key) => {
    if (HG_SCAN_ALLOWLIST.has(key)) return;
    const hits = findUnboundedRuns(pattern.source, pattern.flags, ceilingFor('HG', key));
    expect(hits.map((h) => h.snippet)).toEqual([]);
  });

  // 분모 고정. 위 it.each 가 "0개를 훑고 통과"하는 공허한 그린이 되지 않도록.
  // 숫자가 움직이면 HG 표가 바뀐 것이므로 읽고 나서 고치는 게 맞다.
  it('scans all 29 human-gate patterns across 13 rows', () => {
    expect(HUMAN_GATE_MATRIX).toHaveLength(13);
    const total = HUMAN_GATE_MATRIX.reduce((n, row) => n + row.patterns.length, 0);
    expect(total).toBe(29);
    // HG-10 은 patterns 가 비어 있다(패턴화 불가 선언). 그 행이 있어도
    // flatMap 이 무너지지 않는다는 것을 여기서 함께 본다.
    expect(HUMAN_GATE_MATRIX.filter((row) => row.patterns.length === 0).map((r) => r.id))
      .toEqual(['HG-10']);
  });

  it('예외는 `^` 앵커를 가진 HG-11 두 건뿐이다', () => {
    expect([...HG_SCAN_ALLOWLIST].sort()).toEqual(['HG-11[0]', 'HG-11[1]']);
  });

  // 예외의 근거를 실행형으로 붙든다. 면제 사유는 "앵커가 있다" 이므로, 앵커가
  // 사라지면(누가 `^` 를 떼거나 `m` 플래그를 붙이면) 면제가 성립하지 않는다.
  it.each([...HG_SCAN_ALLOWLIST])('%s 는 `^` 로 시작하고 m 플래그가 없다', (key) => {
    const [, id, idx] = /^(HG-\d+)\[(\d+)\]$/.exec(key);
    const pattern = HUMAN_GATE_MATRIX.find((row) => row.id === id).patterns[Number(idx)];
    expect(pattern.source.startsWith('^')).toBe(true);
    expect(pattern.flags).not.toContain('m');
    // 면제가 사소하지 않다는 반증 — 앵커를 빼면 스캐너가 실제로 잡는다.
    expect(findUnboundedRuns(pattern.source.slice(1), pattern.flags).length).toBeGreaterThan(0);
  });
});

/**
 * 반복 단위로 정확히 bytes 길이의 근접-비매치 payload 를 만든다.
 * @param {string} unit @param {number} bytes @returns {string}
 */
function fill(unit, bytes) {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/**
 * fn 을 runs 회 돌려 경과 시간의 중앙값(ms)을 돌려준다. 단발 벽시계는 GC 와
 * 스케줄러에 흔들린다 — 중앙값이 그 흔들림을 뺀다.
 * @param {() => void} fn @param {number} runs @returns {number}
 */
function medianMs(fn, runs) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(runs / 2)];
}

/**
 * 성장 게이트의 바닥값(ms). 분자·분모에 같은 값을 더한다 — 선형이고 빠른
 * 규칙(포크밤 공백 런은 20,480B 에서 0.26ms)에서는 고정 오버헤드와 스케줄러
 * 잡음이 측정값을 지배해 생 비율이 무의미하게 튄다.
 */
const RATIO_FLOOR_MS = 4;

/**
 * 6배 구간의 성장 비율. **인접한 2배 구간(40,962/20,480 · 122,880/40,962)은
 * 쓰지 않는다 — 분해능이 없다.**
 *
 * 실측 근거(2026-09-11 21:2x KST, 바운드 후 코드, 7규칙 × 10회):
 *   잡음 범위  40,962/20,480  1.08 ~ 3.39   <- 임계 후보 3.0 과 겹친다
 *   잡음 범위  122,880/40,962 2.19 ~ 3.85   <- 임계 후보 4.5 와 여유 17%뿐
 *   잡음 상한  122,880/20,480 <= 8.44
 *   2차식 신호 122,880/20,480 34 ~ 41       <- 바운드 전, 기대값 6² = 36
 * 6배 구간만이 잡음(<= 8.44)과 신호(34~41)를 가른다. 임계 18 은 그 사이
 * 기하 중앙 근처로, 잡음 상한의 2.1배이고 신호 하한의 0.53배다.
 *
 * 바닥값은 2차식 신호를 지우지 않는다: 수리 전 포크밤은 40KB 1,255ms /
 * 120KB 17,199ms 였고, 바닥값 4ms 를 넣어도 13.7 로 남는다.
 *
 * **못 보는 것 — 임계에 걸치는 2차식(2026-09-14 실측).** 위 문장은 절대값이
 * 큰 2차식에 대해서만 참이다. t(20,480) 이 바닥값과 같은 자릿수면 4ms 가
 * 분모를 지배해 비율이 주저앉는다. 실사례는 옛 sql-delete-no-where 다. 규칙을
 * 옛 소스로 되돌려 전체 경로를 재면(`fill('DELETE FROM t=1 WHERE x ', n)`,
 * 3회 중앙값, node v24.15.0, Windows, 같은 하네스 4회 반복):
 *   growth  18.80 / 17.70 / 22.57 / 12.44   <- 4회 중 2회만 임계 18 초과
 *   raw t122880/t20480  30.5 / 35.7 / 43.2 / 16.6x  <- 전부 2차식
 * 즉 **이 게이트는 진짜 2차식을 절반만 잡았다.** 판정이 러너 잡음에 뒤집힌다.
 * (현행 식은 같은 4회에서 1.38 / 1.71 / 1.92 / 2.17 로 여유가 한 자릿수다.)
 *
 * 바닥값을 내리지 않는다: 포크밤 공백 런처럼 진짜 선형이고 빠른 규칙에서 생
 * 비율이 무의미하게 튀는 것을 막는 값이고 그 근거는 실측이다. 대신 결론을
 * 적어 둔다 — **성장 게이트는 정적 스캔의 보조이지 대체가 아니다.** 주 게이트는
 * 위 ReDoS 정적 스캔이고, 이 사건의 실제 경로는 그 스캔이 옛 식의 `.*` 를
 * 잡았을 것을 `SCAN_ALLOWLIST` 예외가 비켜 가게 한 것이었다. 예외를 적을 때는
 * 그 예외가 어느 게이트를 끄는지까지 적어야 한다.
 * @param {number} numerator @param {number} denominator @returns {number}
 */
function growth(numerator, denominator) {
  return (numerator + RATIO_FLOOR_MS) / (denominator + RATIO_FLOOR_MS);
}

describe('classifyRisk — option-run scanning is linear', () => {
  /** @param {string} command @returns {number} elapsed ms */
  function timeClassify(command) {
    const started = performance.now();
    classifyRisk(command);
    return performance.now() - started;
  }

  // The rm rules scan an option run before the target. If a run of long
  // options can be split more than one way, a non-matching tail costs 2^n.
  // bash-risk-guard.js runs inside a 5s PreToolUse hook, so a blow-up here
  // silently deletes the L2 verdict instead of failing loudly.
  it('stays linear on long option runs', () => {
    // 26 first: it is the largest size the exponential form still finishes
    // fast enough to report a failure rather than hang the suite.
    expect(timeClassify(`rm ${'--opt '.repeat(26)}x`)).toBeLessThan(200);
    expect(timeClassify(`rm ${'--opt '.repeat(40)}x`)).toBeLessThan(200);
    expect(timeClassify(`rm ${'--opt '.repeat(2000)}/`)).toBeLessThan(200);
  });

  // Same hazard for the 2026-09-11 rules: sql-truncate scans an identifier
  // list and git-branch-delete scans an option run, both on near-miss input
  // where a backtracking form would keep retrying.
  it('stays linear on near-miss TRUNCATE and git branch payloads', () => {
    expect(timeClassify(`TRUNCATE ${'a'.repeat(5000)}`)).toBeLessThan(200);
    expect(timeClassify(`TRUNCATE ${'a,'.repeat(2000)}b`)).toBeLessThan(200);
    expect(timeClassify(`TRUNCATE TABLE ${'x'.repeat(5000)}`)).toBeLessThan(200);
    expect(timeClassify(`git branch ${'--opt '.repeat(2000)}x`)).toBeLessThan(200);
    expect(timeClassify(`git branch ${'-abc '.repeat(2000)}x`)).toBeLessThan(200);
    // 옵션 런이 대시 없는 인수까지 받게 된 뒤의 적대 입력(40KB).
    expect(timeClassify(`git branch ${'a '.repeat(20000)}x`)).toBeLessThan(200);
    expect(timeClassify(`git branch -d x ${'a '.repeat(20000)}y`)).toBeLessThan(200);
    // 줄 연속 분기를 더한 뒤의 적대 입력. 백슬래시는 [^\S\n] 와 배타적이라
    // 구분자 두 갈래가 겹치지 않는다 — 겹치면 여기서 터진다.
    expect(timeClassify(`git branch ${`${BACKSLASH}\n`.repeat(20000)}x`)).toBeLessThan(200);
    expect(timeClassify(`git branch -d x ${`${BACKSLASH}\n `.repeat(20000)}y`)).toBeLessThan(200);
    expect(timeClassify(`dd ${'if=a '.repeat(2000)}x`)).toBeLessThan(200);
  });

  // `fill` 은 아래 성장-비율 describe 와 공유하므로 모듈 스코프에 있다.

  // dd-device-write / curl-external / wget-external and the three git-push
  // rules all read "<word> <anything on this line> <token>". With an unbounded
  // `[^\n]*` in the middle, every occurrence of the word rescans the rest of the
  // line, so a line made only of the word is quadratic. Measured at 40,962B
  // before the window bound (node v24.15.0, 2026-09-11 06:36 and 06:45 UTC):
  // dd 852.1 / 863.7 / 759.9 ms (122,880B 6,306.1 ms) and `git push`
  // 600.3 / 630.3 / 645.8 ms (122,880B 5,236.0 ms). The window bound in
  // safety.js is what makes these linear; if someone widens one back to `*`
  // this test is the alarm.
  // 포크밤 규칙의 구분자는 전부 `\s*` 다. 콜론이 촘촘한 입력만 쓰면 긴 공백 런을
  // 만들지 못해 머리 쪽 모호 구간을 건드리지 못하고 **2차식 위에서도 그린**이 된다
  // (L1 실측: 수리 전 40KB 공백 1,255ms). 그래서 아래 8건 중 뒤쪽 다섯이 본체다.
  // L1 은 단일 정규식을 쟀고 여기는 classifyRisk 전체 경로라 수치가 다르다.
  it.each([
    ['40KB colon run', COLON.repeat(40_000)],
    ['40KB colon-paren run', `${COLON} () `.repeat(8_000)],
    ['40KB colon-brace run', `${COLON}(){ ${COLON}|${COLON}& `.repeat(4_000)],
    ['40KB space run after a single colon', `${COLON}${' '.repeat(40_000)}x`],
    ['40KB newline run after a single colon', `${COLON}${'\n'.repeat(40_000)}x`],
    ['40KB space run after colon-brace-colon', `${COLON}{${COLON}${' '.repeat(40_000)}x`],
    ['40KB space run after an almost-complete fork bomb', `${COLON}{${COLON}|${COLON}&};${' '.repeat(40_000)}x`],
    ['40KB mixed space/newline run after a single colon', `${COLON}${' \n'.repeat(20_000)}x`],
  ])('does not blow up on a %s', (_name, input) => {
    expect(timeClassify(input)).toBeLessThan(200);
  });

  it('stays linear on near-miss dd, curl, wget and git push payloads', () => {
    for (const unit of ['dd ', 'curl ', 'wget ', 'git push ']) {
      const payload = fill(unit, 40_962);
      expect(payload).toHaveLength(40_962);
      expect(timeClassify(payload)).toBeLessThan(200);
    }
  });
});

/**
 * 크기에 따라 스케일되는 근접-비매치 payload. 이름은 어느 규칙군을 겨냥하는지다.
 * @type {[string, (n: number) => string][]}
 */
const SCALED_PAYLOADS = [
  ['dd', (n) => fill('dd ', n)],
  ['curl', (n) => fill('curl ', n)],
  ['wget', (n) => fill('wget ', n)],
  ['git push', (n) => fill('git push ', n)],
  // 포크밤 규칙의 구분자는 전부 `\s*` 다. 콜론이 촘촘한 입력은 긴 공백 런을
  // 만들지 못해 2차식 위에서도 그린이 된다 — 그래서 공백 런을 쓴다.
  ['fork-bomb space run', (n) => `${COLON}${' '.repeat(n - 2)}x`],
  // rm 규칙군의 위험은 지수식(그룹 수량자)이라 정적 스캐너가 못 본다(#3).
  ['rm option run', (n) => `rm ${fill('--opt ', n - 4)}x`],
  // 2026-09-14 ① — 넓어진 터미네이터 클래스를 겨눈다. 루트 분기가 터미네이터를
  // 통째로 잃었고 `~`/`$HOME` 은 분리자 7종을 얻었으므로, 그 문자들이 촘촘한
  // 입력에서 새 백트래킹이 생기지 않는지 본다.
  //
  // **이 두 형이 약한 신호라는 것을 적어 둔다**: 둘 다 첫 위치에서 매치하므로
  // rm-rf-root 는 즉시 반환한다. 그러면 재는 것은 그 앞 규칙 25개 + 전처리이지
  // 새 클래스의 백트래킹이 아니다. 새 클래스 자체의 선형성은 규칙 단독 실측이
  // 근거다(122,880B 0.01ms, 위 safety.js 주석). 여기는 "전체 경로가 이 입력에서
  // 터지지 않는다"만 증명한다 — 게이트 옆에 게이트가 못 보는 것을 적는다.
  ['quote-root fill', (n) => fill('rm -rf /" ', n)],
  ['tilde-paren fill', (n) => fill('rm -rf ~) ', n)],
  // 2026-09-21 (guard-l2-residual) — 이 편집이 **더한 수량자는 하나뿐**이다:
  // 틸드 분기의 이름 런 `\w[\w.-]*`. 중괄호 분기(`\$\{HOME\}`)는 전부 리터럴이라
  // 수량자를 더하지 않는다.
  //
  // 위 두 행과 달리 이 행들은 **긴 단일 런**이다. 촘촘한 반복 입력은 첫 위치에서
  // 곧장 매치하거나 곧장 실패해 런 안의 백트래킹을 전혀 건드리지 못한다 —
  // 2026-09-14 주석이 quote-root/tilde-paren 에 대해 스스로 적어 둔 약점이고,
  // 같은 약점을 반복하지 않으려고 형을 바꿨다.
  //   tilde-name run   `rm -rf ~` + 'a'×(n-9) + '*'
  //     이름 런이 입력 전체를 삼킨 뒤 터미네이터가 `*` 에서 실패한다. `*` 는
  //     이름 클래스에도 터미네이터 클래스에도 없으므로 **되돌릴 때마다 다시
  //     실패**한다 — 이 수량자에서 최악에 가장 가까운 형이다.
  //   tilde-dot run    같은 형, 채움 문자가 `.`
  //     `.` 은 이름 클래스 안이지만 **첫 문자로는 못 오는**(선두는 `\w`) 문자라
  //     선두 원자와 꼬리 수량자의 경계를 따로 건드린다.
  //   brace-home near-miss  `rm -rf ${HOMEDIR} ` 반복
  //     중괄호 분기가 `HOME` 까지 맞고 `}` 에서 틀어지는 형. 수량자는 없지만
  //     교대(alternation)가 매 시작 위치에서 두 갈래를 시도하는 비용을 잰다.
  ['tilde-name run', (n) => `rm -rf ~${'a'.repeat(n - 9)}*`],
  ['tilde-dot run', (n) => `rm -rf ~a${'.'.repeat(n - 10)}*`],
  ['brace-home near-miss', (n) => fill('rm -rf ${HOMEDIR} ', n)],
  // 2026-09-22 (guard-rm-flag-redos) — **플래그 런**. 위 행들이 전부 타깃 쪽
  // 수량자를 겨냥하는 동안 플래그 토큰은 한 번도 스윕되지 않았고, 그 자리가
  // 2차식이었다. 왜 종전 행들이 못 봤는지는 regex-scan.js 헤더 1-b 에 있다:
  // `'rm -rf '` 류 촘촘한 반복은 첫 위치에서 판정이 끝나 플래그 런 안으로
  // 들어가지 않는다. 그래서 **quantifier 마다 긴 단일 런**이 필요하다.
  //   `rm -` + 'r'×(n-5) + `_`  — 재귀 lookahead `-[a-z]*[r][a-z]*` 의 두 런이
  //     같은 문자로 채워져 n 갈래로 쪼개진다. 꼬리 `_` 는 `(?![\w-])` 를 깨서
  //     **모든 갈래가 실패**하게 만든다 — 이 수량자의 최악형이다.
  //   `rm -r -` + 'f'×(n-8) + `_`  — force lookahead 전용. **그냥 'f' 로 채우면
  //     안 된다**: 재귀 lookahead 가 먼저 평가돼 곧장 실패하므로 force 토큰은
  //     한 번도 안 읽힌다(실측 2026-09-22: 'f'×n 단일 런은 수리 전에도
  //     40,962B 0.8ms — 아무것도 증명하지 못하는 그린이다). 앞에 `-r` 을 둬
  //     재귀 쪽을 **통과시켜야** force 런에 도달한다.
  // 수리 전 실측(node v24.15.0, classifyRisk 전체, 1회): 'r' 런 1,949.8ms
  // (20,480B) · 7,726.3ms (40,962B) — 위 `< 200ms` smoke 단언이 RED 다. force
  // 런 452.0ms · 1,758.2ms, 역시 RED. 수리 후 각각 1.03ms · 0.85ms.
  ['rm flag run (r)', (n) => `rm -${'r'.repeat(n - 5)}_`],
  ['rm force run (reachable)', (n) => `rm -r -${'f'.repeat(n - 8)}_`],
  // 양성 대조군 — 실패형만 재면 "안 걸려서 빨랐다"와 구별되지 않는다. 런이
  // 유효한 플래그 토큰으로 끝나고 타깃이 뒤에 오면 규칙이 실제로 매치한다.
  ['rm flag run (matching)', (n) => `rm -${'r'.repeat(n - 8)}f /x`],
  // 2026-09-14 ② — sql-delete-no-where 는 종전에 SCAN_ALLOWLIST 에 있어 정적
  // 스캔 밖이었고 여기에도 payload 가 없었다. 즉 **3층 중 어느 층도 이 규칙을
  // 보지 않았다.** 그 상태에서 옛 식은 2차식이었다. 이제 (i) 스캔 대상이고
  // 이 행이 (ii)(iii) 을 맡는다.
  //
  // 형 선정: `t=1 WHERE x` 반복은 **매 시도 위치에서 실패**한다. 옛 식의 선형
  // 주장을 만든 `'DELETE FROM t '` 반복은 첫 시도에 매치해 끝나므로 이 자리에
  // 쓰면 2차식 위에서도 그린이다 — 픽스처가 결론을 바꾼 실제 사례다(위
  // SCAN_ALLOWLIST JSDoc 의 수치표).
  //
  // **이 행이 못 하는 것**: 옛 식으로 되돌려도 이 행이 RED 가 된다는 보장이
  // 없다. 실측 4회 성장 18.80 / 17.70 / 22.57 / 12.44 — 임계 18 을 넘은 것이
  // 4회 중 2회다(raw 비율은 4회 모두 16~43x 로 2차식). 되돌림을 확실히 잡는
  // 것은 위 ReDoS 정적 스캔이고(`.*` = 무제한 런 = 즉시 RED, 예외 0건),
  // 이 행은 그 보조다. `growth` JSDoc 의 "못 보는 것" 절 참조.
  ['sql delete near-miss', (n) => fill('DELETE FROM t=1 WHERE x ', n)],

  // ── 전처리 경로 (2026-09-14, guard-command-position) ─────────────────────
  // 위 6형은 **규칙**을 겨눈다. 아래 9형은 `blankPrinterSegments` 의 토크나이저를
  // 겨눈다 — 규칙이 선형이어도 전처리가 2차식이면 전체 경로가 2차식이다.
  // 설계 프로브의 c 열 수치는 세그먼트마다 문자열을 재조립해 O(n²)였고 그래서
  // **무효다**(브리프 §미확인). 아래가 구현 실측이고 이것이 정본이다.
  //
  // 형태 선정 근거 — 토크나이저가 상태를 바꾸는 자리 전부:
  //   분리자 런(`;` `|` `&&`) · 세그먼트가 수만 개로 쪼개지는 형(echo x; 반복)
  //   · 한 세그먼트가 입력 전체인 형(따옴표 스팬·주석·공백 런)
  //   · 닫히지 않는 상태(불균형 따옴표·`$(` 런).
  // 마지막 둘이 본체다: 열린 상태를 만날 때마다 끝까지 다시 읽는 구현이면
  // 거기서 터진다.
  //
  // 실측 — classifyRisk 전체 경로(전처리 포함), 3회 중앙값, node v24.15.0,
  // Windows 11, 2026-09-14 09:2x KST. 122,880B 는 **단언하지 않는다**(규약);
  // 규칙 주석에 수치를 병기하라는 요구가 이 표다.
  //            20,480B  40,962B  122,880B   growth(6배 구간, 임계 18)
  //   echo-semicolon  5.7    4.8     7.1      1.14
  //   semicolon       0.7    0.6     2.1      1.30
  //   pipe            0.7    0.4     1.7      1.22
  //   and-and         0.9    1.0     2.8      1.38
  //   quoted span     0.8    1.1     3.4      1.53
  //   subst-open      0.7    0.5     0.9      1.03
  //   unbalanced "    0.6    1.3     3.6      1.65
  //   comment         0.5    1.0     2.1      1.37
  //   space           0.9    1.3     4.4      1.73
  // 전부 선형(최대 1.73 대 임계 18, 잡음 상한 8.44 아래)이고 40,962B 최대
  // 4.8ms 로 200ms smoke 대비 40배 여유다. **창·분리자 클래스·전처리 단계를
  // 바꾸면 이 표를 다시 재라** — 안 재면 표가 조용히 썩고 그 다음 착시의
  // 근거가 된다.
  ['echo-semicolon run', (n) => fill('echo x; ', n)],
  ['semicolon run', (n) => ';'.repeat(n)],
  ['pipe run', (n) => '|'.repeat(n)],
  ['and-and run', (n) => fill('&& ', n)],
  ['quoted span', (n) => `echo "${'a'.repeat(n - 7)}"`],
  ['subst-open run', (n) => fill('$(', n)],
  ['unbalanced quote', (n) => `echo "${'a'.repeat(n - 6)}`],
  ['comment run', (n) => `# ${'x'.repeat(n - 2)}`],
  ['space run', (n) => `${' '.repeat(n - 1)}x`],
];

describe('classifyRisk — 크기를 키워도 성장 비율이 선형 범위 안이다', () => {
  // 3층 중 (ii)(iii). (i) 은 위 정적 스캔이고 그쪽이 정본이다.
  //
  // 왜 단일 벽시계를 버렸나: `< 50` 단언이 Windows 러너에서 50.54ms 로 떨어진
  // 사례가 있다(2026-09-11). 임계를 올리면 2차식을 놓치고, 그대로 두면
  // 플레이크다. 그래서 절대값은 넉넉한 smoke(`< 200`, 40,962B 에서만)로 두고,
  // 판정은 **크기 간 성장 비율**에 맡긴다 — 비율은 머신 속도에 거의 불변이다.
  //
  // 임계는 **한 구간뿐**이다: t(122,880) < 18 × t(20,480), 6배 구간.
  // 인접한 2배 구간 두 개(40,962/20,480 · 122,880/40,962)를 쓰던 초안은
  // 분해능이 없어 버렸다 — `growth` 의 JSDoc 에 잡음·신호 실측치가 있다.
  // 요지: 2배 구간의 잡음이 각각 3.39 / 3.85 까지 올라가 임계 후보 3.0 / 4.5
  // 와 겹치거나 붙는다. 6배 구간은 잡음 상한 8.44 와 2차식 신호 34~41 사이가
  // 비어 있어 18 을 그 사이에 놓을 수 있다. 같은 형식을 L1 쪽 테스트도 쓴다
  // (형식만 통일 — 헬퍼는 이 파일 안에 자급형으로 둔다).
  //
  // 122,880B 는 절대값을 단언하지 않는다. 규칙 주석의 3회 측정값이 그 자리를
  // 맡는다(2026-09-11 dd 5회 중 1회 56.2ms). 창·분리자 클래스·전처리 단계를
  // 바꿀 때마다 120KB 를 재측정할 것.
  //
  // 못 보는 것: 이 블록은 **크기에 따라 스케일되는** 입력만 본다. 고정 크기
  // 지수형 프로브(`--opt` ×26/40)는 위 describe 의 smoke 단언이 맡는다.
  it.each(SCALED_PAYLOADS)(
    '%s: t(122,880) < 18 × t(20,480)',
    (_name, build) => {
      const t20480 = medianMs(() => classifyRisk(build(20_480)), 3);
      const t40962 = medianMs(() => classifyRisk(build(40_962)), 3);
      // 회귀 시 120KB 측정으로 넘어가기 전에 여기서 빨리 실패시킨다.
      expect(t40962).toBeLessThan(200);
      const t122880 = medianMs(() => classifyRisk(build(122_880)), 3);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    },
    30_000,
  );

  it('builds each payload at the byte size it claims', () => {
    for (const [, build] of SCALED_PAYLOADS) {
      expect(build(20_480)).toHaveLength(20_480);
      expect(build(40_962)).toHaveLength(40_962);
      expect(build(122_880)).toHaveLength(122_880);
    }
  });

  // 2026-09-21 — 신규 수량자(`\w[\w.-]*`) 전용 단일-런 스윕.
  // 10K → 20K → 40K → 120K 를 **구조로** 단언한다: 반환하고, 판정이 예고한
  // 값이다. 벽시계는 재지 않는다 — 위 성장 비율 행이 그 일을 맡고, 120KB 절대값
  // 단언은 이 파일의 규약상 금지다(플레이크).
  //
  // **이 it 이 증명하지 않는 것**: "빠르다"를 증명하지 않는다. 2차식이어도
  // 충분히 기다리면 반환하므로 이 단언만으로는 그린이 될 수 있다. 2차식을 잡는
  // 것은 SCALED_PAYLOADS 의 성장 비율(임계 18)과 정적 스캔이고, 이 it 은
  // **종료와 판정 안정성**만 맡는다. 게이트 옆에 게이트가 못 보는 것을 적는다.
  it.each([
    // 2026-09-22 기대값 safe → caution. **게이트 완화가 아니다**: 이 두 형이
    // 재는 것은 rm-rf-root 이름 런의 백트래킹이고, 그 규칙은 여전히 끝까지
    // 실패한다(`*` 는 터미네이터 집합 밖). 바뀐 것은 그 뒤에 rm-rf-path 가
    // 틸드 선두 타깃을 더 이상 넘기지 않아 caution 으로 받는다는 것뿐이다.
    ['tilde-name run', (/** @type {number} */ n) => `rm -rf ~${'a'.repeat(n - 9)}*`, 'caution'],
    ['tilde-dot run', (/** @type {number} */ n) => `rm -rf ~a${'.'.repeat(n - 10)}*`, 'caution'],
    // 같은 런이 **끝에서 끝나면** 매치한다(터미네이터 = 입력 끝). 실패형만
    // 재면 "안 걸려서 빨랐다"와 구별이 안 되므로 양성 대조군을 같이 둔다.
    ['tilde-name run (matching)', (/** @type {number} */ n) => `rm -rf ~${'a'.repeat(n - 8)}`, 'danger'],
    ['brace-home near-miss', (/** @type {number} */ n) => fill('rm -rf ${HOMEDIR} ', n), 'caution'],
    // 2026-09-22 플래그 런. 실패형 둘 + 양성 대조군 하나.
    ['rm flag run (r)', (/** @type {number} */ n) => `rm -${'r'.repeat(n - 5)}_`, 'safe'],
    ['rm force run (reachable)', (/** @type {number} */ n) => `rm -r -${'f'.repeat(n - 8)}_`, 'safe'],
    ['rm flag run (matching)', (/** @type {number} */ n) => `rm -${'r'.repeat(n - 8)}f /x`, 'danger'],
  ])('terminates on a %s at 10K/20K/40K/120K', (_name, build, level) => {
    for (const size of [10_240, 20_480, 40_962, 122_880]) {
      const payload = build(size);
      expect(payload).toHaveLength(size);
      expect(classifyRisk(payload).level).toBe(level);
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 언어 보존 차분 검증 — 옛 플래그 조각을 **동결 참조**로 둔다 (2026-09-22,
// guard-rm-flag-redos).
//
// 2026-09-22 의 토큰 교체는 성능만 고치고 **받아들이는 문자열 집합은 한 글자도
// 움직이지 않아야** 한다. 코퍼스 전후표(1,967 문자열, level+matchedId 완전 동일)
// 는 그것을 코퍼스 안에서만 말한다 — 코퍼스에 없는 플래그 표기는 아무것도
// 증명하지 못한다. 그래서 코퍼스에 기대지 않는 **전수 열거**를 여기 둔다.
//
// 왜 동결 사본인가: 옛 조각을 살아 있는 소스에서 읽어 오면 두 쪽이 같이 바뀌어
// 대조가 사라진다. 아래 OLD_* 는 의도적으로 손으로 박은 2026-09-21 이전 값이고,
// **수리해서는 안 되는 문자열**이다.
//
// 이 게이트가 못 보는 것: 길이 5 까지의 토큰만 본다. 그보다 긴 토큰에서 갈리는
// 차이는 여기서 안 잡힌다 — 다만 두 식 모두 그 길이에서 이미 구조가 반복이라
// 새 분기가 생길 자리가 없다. 그리고 이것은 **언어**만 본다. 성능은 위 성장
// 비율 게이트가, 판정 등급은 코퍼스 핀이 맡는다.
const FROZEN_OLD_FLAG_PAIRS = /** @type {[string, RegExp, RegExp][]} */ ([
  ['rm-rf-root',
    /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+["']?(?:\/|~(?:[A-Za-z_][\w.-]*)?(?:\s|$|\/|[;&|()<>"'`])|\$(?:HOME|\{HOME\})(?:\s|$|\/|[;&|()<>"'`]))/i,
    DANGEROUS_PATTERNS.find((r) => r.id === 'rm-rf-root').test],
  ['rm-rf-broad',
    /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+\*/i,
    DANGEROUS_PATTERNS.find((r) => r.id === 'rm-rf-broad').test],
  ['rm-rf-path',
    /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?=(?:\s+--?\w[\w-]*)*\s+(?:--force|-[a-z]*[f][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?![-/*])\S+/i,
    DANGEROUS_PATTERNS.find((r) => r.id === 'rm-rf-path').test],
  ['rm-recursive-path',
    /\brm\b(?=(?:\s+--?\w[\w-]*)*\s+(?:--recursive|-[a-z]*[r][a-z]*)(?![\w-]))(?:\s+--?\w[\w-]*)*(?:\s+--)?\s+(?![-/*])\S+/i,
    DANGEROUS_PATTERNS.find((r) => r.id === 'rm-recursive-path').test],
  ['L1 rm recursive+force (any target)',
    /\brm\b(?=(?:\s+-\S+)*\s+(?:-[a-z]*r[a-z]*|--recursive)\b)(?=(?:\s+-\S+)*\s+(?:-[a-z]*f[a-z]*|--force)\b)(?:\s+-\S+)*\s+(?!-)\S+/i,
    BLOCKED_PATTERNS.find((p) => p.label === 'rm recursive+force (any target)').pattern],
  ['L1 rm -rf with path',
    /rm\s+(-\w*r\w*f|--recursive)[^\n]{0,512}\//i,
    BLOCKED_PATTERNS.find((p) => p.label === 'rm -rf with path').pattern],
  ['L1 rm -fr with path',
    /rm\s+-\w*f\w*r[^\n]{0,512}\//i,
    BLOCKED_PATTERNS.find((p) => p.label === 'rm -fr with path').pattern],
  ['L1 rm with wildcard',
    /rm\s+-\w*[rf]\w*\s+\*/i,
    BLOCKED_PATTERNS.find((p) => p.label === 'rm with wildcard').pattern],
]);

/** 플래그 토큰 알파벳. 대문자 R/F 가 핵심이다 — `/i` 에서 클래스가 접히므로
 * `[a-qs-z]` 는 `R` 도 뺀다. 필수 `r` 이 여전히 `R` 을 받는다는 것을 이 알파벳이
 * 증명한다. 숫자·`_`·`-` 는 `\w` 와 `[a-z]` 의 경계, 그리고 `(?![\w-])` 꼬리를
 * 건드린다.
 * @type {readonly string[]} */
const FLAG_ALPHABET = Object.freeze(['r', 'f', 'x', 'R', 'F', '9', '_', '-']);

/** @type {readonly ((t: string) => string)[]} */
const FLAG_TEMPLATES = Object.freeze([
  (t) => `rm -${t}`,
  (t) => `rm -${t} /`,
  (t) => `rm -${t} ./build`,
  (t) => `rm -${t} *`,
  (t) => `rm -${t} ~user`,
  (t) => `rm -${t} -q x/y`,
  (t) => `rm -q -${t} /tmp/x`,
  (t) => `rm -${t} a/b`,
]);

describe('flag lookahead — 토큰 교체가 언어를 바꾸지 않는다', () => {
  /** @type {string[]} */
  const tokens = [''];
  let frontier = [''];
  for (let len = 1; len <= 5; len++) {
    const next = frontier.flatMap((t) => FLAG_ALPHABET.map((c) => t + c));
    tokens.push(...next);
    frontier = next;
  }

  it('enumerates 37,449 flag tokens (0..5 over 8 characters)', () => {
    expect(tokens).toHaveLength(37_449);
  });

  it.each(FROZEN_OLD_FLAG_PAIRS)(
    '%s: frozen old fragment and current rule agree on every token',
    (_name, oldRe, currentRe) => {
      /** @type {string[]} */
      const mismatches = [];
      for (const token of tokens) {
        for (const build of FLAG_TEMPLATES) {
          const s = build(token);
          if (oldRe.test(s) !== currentRe.test(s)) mismatches.push(s);
        }
      }
      expect(mismatches).toEqual([]);
    },
    30_000,
  );

  // 양성 대조군 — 위 단언이 "둘 다 아무것도 안 맞아서" 통과하는 것이 아님을
  // 보인다. 이 행들이 false 로 뒤집히면 위 0-불일치는 아무 의미가 없다.
  it('keeps the uppercase forms matching under /i', () => {
    const byLabel = (l) => BLOCKED_PATTERNS.find((p) => p.label === l).pattern;
    const byId = (i) => DANGEROUS_PATTERNS.find((r) => r.id === i).test;
    expect(byId('rm-rf-root').test('rm -RF /')).toBe(true);
    expect(byId('rm-rf-root').test('rm -Rf /')).toBe(true);
    expect(byId('rm-rf-root').test('rm -rF /')).toBe(true);
    expect(byId('rm-recursive-path').test('rm -R ./x')).toBe(true);
    expect(byLabel('rm -rf with path').test('rm -RF /')).toBe(true);
    expect(byLabel('rm -fr with path').test('rm -FR /x')).toBe(true);
    expect(byLabel('rm with wildcard').test('rm -R *')).toBe(true);
    expect(byLabel('rm recursive+force (any target)').test('rm -RF x')).toBe(true);
  });

  // 동결 사본이 진짜로 옛 모양인지. 이 단언이 없으면 누군가 OLD_* 를 새 값으로
  // "고쳐" 위 차분을 자기 자신과의 비교로 만들어 버릴 수 있다.
  it('keeps the frozen references on the OLD shape', () => {
    for (const [, oldRe, currentRe] of FROZEN_OLD_FLAG_PAIRS) {
      expect(oldRe.source).not.toBe(currentRe.source);
      expect(oldRe.source).toMatch(/\[a-z\]\*\[?[rf]\]?\[a-z\]\*|\\w\*[rf]\\w\*|\\w\*\[rf\]\\w\*/);
    }
  });
});

/**
 * 경계 쌍 테이블 — 토큰 앞에 `\s` 를 스스로 갖는 규칙들(filler 형).
 * @type {[string, (f: string) => string, string, string][]}
 */
const FILLER_BOUNDARY_PAIRS = [
  ['dd', (f) => `dd${f} of=/dev/sda`, 'dd-device-write', 'danger'],
  ['curl', (f) => `curl${f} https://e.example/a`, 'curl-external', 'caution'],
  ['wget', (f) => `wget${f} https://e.example/a`, 'wget-external', 'caution'],
];

/**
 * 경계 쌍 테이블 — git push 3종. `span`/`filler` 클로저를 받아 조립한다.
 * @param {(n: number) => string} span @param {(n: number) => string} filler
 * @returns {[string, (n: number) => string, string, string][]}
 */
const SPAN_BOUNDARY_PAIRS = (span, filler) => [
  ['blind force', (n) => `git push${span(n)}--force origin main`, 'git-force-push', 'danger'],
  ['leased force', (n) => `git push${span(n)}--force-with-lease origin main`, 'git-force-push-lease', 'caution'],
  ['short force', (n) => `git push${filler(n)} -f`, 'git-force-push-short', 'danger'],
];

/**
 * 경계 쌍 테이블 — 창이 **부정 lookahead 안**에 있어 판정이 뒤집힌 규칙
 * (2026-09-14, sql-delete-no-where). 위 두 표는 "창 안이면 매치"지만 여기는
 * 창 안에서 WHERE 를 **찾으면 매치하지 않는다.** 그래서 192 = safe,
 * 193 = danger 로 방향이 반대다.
 *
 * 별도 표로 둔 이유: 같은 it.each 에 섞으면 단언 방향을 행마다 분기해야 하고,
 * 그러면 방향을 잘못 적은 행이 조용히 통과한다. 표를 나눠 단언을 고정한다.
 * @type {[string, (gap: string) => string, string, string][]}
 */
const LOOKAHEAD_BOUNDARY_PAIRS = [
  ['sql-delete-no-where', (gap) => `DELETE FROM t${gap}WHERE y`, 'sql-delete-no-where', 'danger'],
];

/** 경계 쌍이 실제로 존재하는 규칙 id 집합. */
const BOUNDARY_PAIR_IDS = [
  ...FILLER_BOUNDARY_PAIRS.map((row) => row[2]),
  ...SPAN_BOUNDARY_PAIRS((n) => `${n}`, (n) => `${n}`).map((row) => row[2]),
  ...LOOKAHEAD_BOUNDARY_PAIRS.map((row) => row[2]),
];

/**
 * `source` 에 바운드된 부정 클래스 창 `[^…]{n,m}` 이 있는가.
 * @param {string} source @returns {boolean}
 */
function hasBoundedWindow(source) {
  return /\[\^(?:\\.|[^\]\\])*\]\{\d+,\d+\}/.test(source);
}

describe('ReDoS 창 게이트 — 창을 가진 L2 규칙은 전부 경계 쌍을 갖는다', () => {
  // 세 장치가 **한 게이트**이고 역할이 겹치지 않는다:
  //   정적 스캔  = 상한 허가 (192 초과는 등록된 규칙만)
  //   경계 쌍    = 정확 폭   (192 매치 / 193 miss)
  //   이 단언    = 누락 0    (창을 가졌는데 경계 쌍이 없는 규칙이 없다)
  //
  // 왜 필요한가: 창 확대는 **순수 superset 변경**이라 기존 양성·음성 테스트로는
  // 원리적으로 안 잡힌다(짧은 명령은 폭과 무관하게 계속 매치한다). 창밖 miss
  // 단언만이 잡는데, 신규 규칙이 창만 달고 경계 쌍 없이 들어오면 그 단언 자체가
  // 없다. 그러면 스캐너는 등록 없이는 192 까지만 허용하므로 192 짜리 신규 규칙은
  // 통과하고, 그 규칙의 폭을 핀하는 것은 리포에 하나도 없게 된다.
  //
  // **폭 숫자를 여기서 복제하지 않는다** — 집합의 동일성만 본다. 정확 폭의 정본은
  // 경계 쌍 하나뿐이고, 여기를 고쳐 그린을 만들면 게이트를 깎는 것이다(규율 §10).
  // 짝이 되는 L1 단언은 A 소유의 tests/core/blocked-patterns.test.js 에 있다
  // (2026-09-11 기준 A 가 넣는 중 — 이 파일은 L2 만 책임진다).
  it('windowed rule ids === boundary pair ids', () => {
    const windowed = DANGEROUS_PATTERNS
      .filter((r) => hasBoundedWindow(r.test.source))
      .map((r) => r.id)
      .sort();
    expect(windowed).toEqual([...BOUNDARY_PAIR_IDS].sort());
  });

  it('finds the seven windowed rules it is supposed to find', () => {
    // 분모를 고정한다 — 위 단언이 "0 === 0" 으로 공허하게 그린이 되지 않도록.
    // 6 -> 7 (2026-09-14): sql-delete-no-where 의 lookahead 가 `.*` 에서
    // `[^;]{0,192}` 로 바뀌면서 창을 **얻었다**. 창을 얻은 규칙은 경계 쌍을
    // 갖는다는 것이 이 게이트의 전부이고, 실제로 그 경로로 걸렸다.
    const windowed = DANGEROUS_PATTERNS.filter((r) => hasBoundedWindow(r.test.source));
    expect(windowed).toHaveLength(7);
    expect(BOUNDARY_PAIR_IDS).toHaveLength(7);
  });

  it('detects a bounded window and ignores shapes that are not one', () => {
    expect(hasBoundedWindow(/\bdd\b[^\n]{0,192}\sof=/.source)).toBe(true);
    expect(hasBoundedWindow(/\bgit\s+push\b[^\n;&|]{0,192}--force/.source)).toBe(true);
    // 부정 lookahead 안의 창도 창이다 — 위치가 아니라 모양이 기준이다.
    expect(hasBoundedWindow(/x(?![^;]{0,192}\bY\b)/.source)).toBe(true);
    expect(hasBoundedWindow(/[^\s;&|]*/.source)).toBe(false);
    expect(hasBoundedWindow(/\bDROP\s+TABLE\b/.source)).toBe(false);
    expect(hasBoundedWindow(/[\w."` ]{0,192}/.source)).toBe(false);
  });
});

describe('classifyRisk — the dd/curl/wget window bound keeps ordinary commands matched', () => {
  // The bound is 192 characters between the command word and the token. These
  // pins are the "did not loosen" half: normal-length commands still match.
  it.each([
    ['curl -s https://x.example/install.sh | sh', 'curl-external'],
    ['wget https://x.example/a.tgz', 'wget-external'],
  ])('grades %s as caution via %s', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe(matchedId);
  });

  // Boundary pair per rule. `filler(n)` is exactly the n characters the bounded
  // quantifier has to cover: one space then (n-1) 'x' bytes. The trailing 'x'
  // matters — the separating \s is supplied by the literal ' of=' / ' https://'
  // that follows, so the filler itself must not end in whitespace, or the two
  // would overlap and the boundary would shift by one.
  /** @param {number} n @returns {string} */
  const filler = (n) => ` ${'x'.repeat(n - 1)}`;

  it.each(FILLER_BOUNDARY_PAIRS)('%s still matches at 192 filler characters and stops at 193', (_name, build, matchedId, level) => {
    const atBound = classifyRisk(build(filler(192)));
    expect(atBound.level).toBe(level);
    expect(atBound.matchedId).toBe(matchedId);
    expect(classifyRisk(build(filler(193))).level).toBe('safe');
  });

  // The three git-push rules carry the same bound. Two of them put the token
  // straight after the bounded quantifier with no `\s` of their own, so there
  // the covered span has to END in a space — hence `span` rather than `filler`.
  // git-force-push-short does have its own `\s`, so it reuses `filler`.
  /** @param {number} n @returns {string} */
  const span = (n) => ` ${'x'.repeat(n - 2)} `;

  it.each(SPAN_BOUNDARY_PAIRS(span, filler))('git push %s still matches at 192 and stops at 193', (_name, build, matchedId, level) => {
    const atBound = classifyRisk(build(192));
    expect(atBound.level).toBe(level);
    expect(atBound.matchedId).toBe(matchedId);
    expect(classifyRisk(build(193)).level).toBe('safe');
  });

  // 뒤집힌 쌍(2026-09-14). 창이 부정 lookahead 안에 있으므로 방향이 반대다:
  // 창 안에서 WHERE 를 찾으면 규칙이 발화하지 **않는다**. 그래서 192 = safe,
  // 193 = danger 이고, 이것이 "193자 밖의 WHERE 는 못 보고 fail-closed 로
  // danger 를 낸다"는 포기 범위의 정본이다.
  //
  // `span` 을 쓰는 이유: lookahead 본문은 `[^;]{0,192}` 뒤에 바로 `\bWHERE\b`
  // 라 자기 `\s` 가 없다. 창이 테이블명과 WHERE 사이 **전부**를 덮어야 하므로
  // 간격이 공백으로 끝나야 한다 — filler(끝이 'x')를 쓰면 경계가 한 칸 밀린다.
  it.each(LOOKAHEAD_BOUNDARY_PAIRS)('%s stays safe at a 192-character gap and flips to danger at 193', (_name, build, matchedId, level) => {
    expect(classifyRisk(build(span(192))).level).toBe('safe');
    const past = classifyRisk(build(span(193)));
    expect(past.level).toBe(level);
    expect(past.matchedId).toBe(matchedId);
  });
});

describe('parseDuration', () => {
  it('parses 4h as 4 hours in ms', () => {
    expect(parseDuration('4h')).toBe(4 * 3_600_000);
  });

  it('parses 30m as 30 minutes in ms', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
  });

  it('parses 2h as 2 hours in ms', () => {
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
  });

  it('returns null for unparseable input', () => {
    expect(parseDuration('hello')).toBeNull();
  });
});

describe('shouldPause', () => {
  it('triggers when buildFailures >= 3', () => {
    const state = { counters: { buildFailures: 3, testFailures: 0 } };
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('build-failures-threshold');
  });

  it('does not trigger at buildFailures 2', () => {
    const state = { counters: { buildFailures: 2, testFailures: 0 } };
    expect(shouldPause(state)).toBe(false);
  });

  it('triggers when testFailures >= 5', () => {
    const state = { counters: { buildFailures: 0, testFailures: 5 } };
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('test-failures-threshold');
  });

  it('does not trigger at testFailures 4', () => {
    const state = { counters: { buildFailures: 0, testFailures: 4 } };
    expect(shouldPause(state)).toBe(false);
  });

  // F03 — the budget is documented in tokens; before this branch existed the
  // limit was compared against USD spend and never fired.
  const budgetState = (tokens, options) => ({
    counters: { buildFailures: 0, testFailures: 0 },
    options,
    usage: { totals: { tokensIn: tokens, tokensOut: 0, costUsd: 0 }, phases: {} },
  });

  it('triggers when the token budget is exhausted', () => {
    const state = budgetState(2_100_000, { budgetTokens: 2_000_000 });
    expect(budgetExceeded(state)).toBe(true);
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('budget-exceeded');
  });

  it('treats exactly 100% as exhausted', () => {
    const state = budgetState(2_000_000, { budgetTokens: 2_000_000 });
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('budget-exceeded');
  });

  it('does not trigger below the token limit', () => {
    const state = budgetState(1_999_999, { budgetTokens: 2_000_000 });
    expect(shouldPause(state)).toBe(false);
    expect(pauseReason(state)).toBeNull();
  });

  it('reads a legacy options.budget as tokens', () => {
    const state = budgetState(2_100_000, { budget: 2_000_000 });
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('budget-exceeded');
  });

  it('triggers on an exhausted USD budget independently of tokens', () => {
    const state = {
      counters: { buildFailures: 0, testFailures: 0 },
      options: { budgetTokens: 2_000_000, budgetUsd: 60 },
      usage: { totals: { tokensIn: 10, tokensOut: 0, costUsd: 61 }, phases: {} },
    };
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('budget-exceeded');
  });

  it('never pauses when usage was never measured', () => {
    const state = { counters: { buildFailures: 0, testFailures: 0 }, options: { budgetTokens: 2_000_000 } };
    expect(budgetExceeded(state)).toBe(false);
    expect(shouldPause(state)).toBe(false);
    expect(pauseReason(state)).toBeNull();
  });

  it('never pauses when no budget is configured', () => {
    const state = budgetState(9_999_999, {});
    expect(shouldPause(state)).toBe(false);
  });

  it('keeps the higher-priority reasons ahead of the budget branch', () => {
    const state = budgetState(2_100_000, { budgetTokens: 2_000_000 });
    state.counters.buildFailures = 3;
    expect(pauseReason(state)).toBe('build-failures-threshold');
  });

  it('ranks the budget branch ahead of a recorded danger error', () => {
    const state = budgetState(2_100_000, { budgetTokens: 2_000_000 });
    state.errors = [{ severity: 'danger', kind: 'rm-rf' }];
    expect(pauseReason(state)).toBe('budget-exceeded');
  });
});
