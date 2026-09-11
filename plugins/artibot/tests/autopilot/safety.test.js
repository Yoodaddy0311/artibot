/**
 * Unit tests for lib/autopilot/safety.js
 * Covers classifyRisk, parseDuration, shouldPause.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRisk,
  DANGEROUS_PATTERNS,
  parseDuration,
  pauseReason,
  shouldPause,
} from '../../lib/autopilot/safety.js';
// 읽기 전용 — 두 곳이 쓴다. (1) 포크밤 드리프트 게이트가 L1 원본과 바이트를
// 대조한다. (2) 아래 ReDoS 정적 스캔이 L1·L2 규칙을 한 번에 훑는다. 이 파일은
// L1 소스를 편집하지 않는다.
import { BLOCKED_PATTERNS } from '../../lib/core/blocked-patterns.js';

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

  it.each([
    'rm -f file.txt',
    'rm -r dir',
    'rm -rv dir',
    'rm --recursive dir',
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

  // L1 은 normalizeCommand 가 따옴표를 벗겨서 잡는다. L2 는 앵커가 없어서 잡는다
  // — 경로는 다르지만 방향은 같다(차단 쪽). 인용문을 echo 하는 것 자체는
  // 무해하므로 이것은 의도된 과차단이고, 그래서 핀으로 고정한다.
  it('grades the fork bomb as danger even when it is quoted inside echo', () => {
    const r = classifyRisk(`echo '${CANONICAL}'`);
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
// ReDoS 정적 스캐너 — 선형성의 **정본 게이트**.
//
// 왜 벽시계가 아니라 소스인가: 시간 단언은 러너에 따라 흔들린다(Windows 에서
// `< 50` 이 50.54ms 로 떨어진 사례, 2026-09-11). 느슨하게 하면 게이트가 죽고
// 조이면 플레이크가 된다. 정규식 **소스의 모양**은 머신과 무관하므로 이쪽이
// 주 게이트이고, 아래 타이밍 블록은 smoke + 성장 비율로 내려간다.
//
// 무제한 런의 정의(이 스캐너가 RED 로 보는 것) — 세 조건을 모두 만족할 때:
//   1. 원자가 `.` 또는 부정 문자클래스 `[^…]` 이고,
//   2. 수량자의 상한이 **그 규칙에 허가된 창**을 넘고(기본 192, 예외 등록분만
//      512 — `WINDOW_CEILING_OVERRIDES`; `*` `+` `{n,}` = 무한, `{0,193}` = 193),
//   3. 그 원자가 공백 문자를 하나라도 매치할 수 있을 때.
//
// 3번은 브리프 원안에 없던 좁힘이다. 근거: 실측된 2차식 5건(dd·curl·wget·
// git push 규칙 3종)은 전부 "<단어> <한 줄 아무거나> <토큰>" 모양이었고, 가운데
// 런이 **공백을 넘어 여러 토큰을 가로지를 수 있어서** 단어가 나올 때마다 줄
// 끝까지 재스캔했다. 공백을 못 넘는 런은 토큰 하나 안에 갇힌다. 3번 없이
// 돌리면 git-branch-delete 의 토큰 본체 `[^\s;&|]*` 가 L1·L2 양쪽에서 6건씩
// RED 가 된다(2026-09-11 12:10 UTC 실측). 그 규칙은 120KB 적대 입력에서 선형인
// 것이 이미 측정돼 있으므로 12건 전부 오탐이다.
//
// ── 이 스캐너가 못 보는 것 (그린을 이 목록의 근거로 쓰지 말 것) ──
//  1. 긍정 문자클래스의 무제한 런. `[\w."` ]+` 는 공백을 포함하지만 스캔하지
//     않는다 — 뒤따르는 필수 토큰이 클래스에 안 들어가면 2차식이 아닐 수 있어
//     모양만으로 판정이 서지 않는다.
//  2. 축약 부정 클래스 `\S` `\W` `\D`. rm-rf-path 꼬리의 `\S+` 와 L1
//     'rm recursive+force' 의 `(?:\s+-\S+)*` 가 여기 해당한다.
//  3. 그룹에 붙은 수량자 = 중첩 수량자. `(?:\s+--?\w[\w-]*)*` 처럼 rm 규칙군의
//     **지수식** 위험이 이 모양인데 스캐너는 보지 않는다. 아래 `--opt` 프로브가
//     그 자리를 맡는다.
//  4. 공백을 못 넘는 무제한 런. 토큰 하나가 무한히 길면 O(토큰²) 은 여전히
//     가능하다. 실측된 사례는 없고, 생기면 아래 성장 비율이 잡아야 한다.
//  5. 전처리(guard-registry#normalizeCommand)와의 상호작용, 규칙 간 평가 순서,
//     classifyRisk 전체 경로의 합산 비용.
//  6. `[]]` 같은 JS 문자클래스 극단 문법(파싱 실패 시 fail-closed 로 보고한다).
//  7. **범위**. 이 스캔은 두 카탈로그(BLOCKED_PATTERNS · DANGEROUS_PATTERNS)만
//     훑는다. 리포의 다른 정규식은 들어오지 않는다 — 2026-09-11 12:2x UTC 실측
//     기준 `lib/security/human-gates.js:179,181` 에 `\bcurl\b[^\n]*` ·
//     `\bgit\s+push\b[^\n]*` 가 무앵커로 남아 있고(같은 2차식 모양), 같은 파일
//     :260,261 은 `^` 앵커라 해당하지 않는다. 그 파일은 이 작업의 소유 밖이다.
//  8. **등록된 예외 규칙의 정확한 창 값.** 기본 192 를 넘는 창은 등록해야만
//     통과하므로 **신규 규칙 구멍은 닫혔다**(2026-09-11 리더 판정 전에는 전역
//     상한 512 였고, 그때는 열려 있었다 — 아래 실측 참조). 남는 것은 *등록된*
//     2건뿐이다: rm 규칙이 512 안에서 어떤 값을 쓰든 여기는 그린이다. 그 정확
//     값은 tests/core/blocked-patterns.test.js 의 정확값 `toBe` 와 경계 쌍이
//     핀한다. 이 목록은 상한 허가일 뿐 폭의 정본이 아니다.
//     실측(B, 2026-09-11): 전역 상한 512 이던 판에서 L2 `wget-external` 을
//     `{0,192}` → `{0,512}` 로 넓혀 보니 **정적 스캔은 그린**이었고 경계 쌍
//     단언 하나만 RED 였다. 경계 쌍이 없는 신규 규칙이었다면 아무것도 못 잡았다.
// ───────────────────────────────────────────────────────────────────────────

/**
 * 기본 허용 최대 창. **192 를 넘는 창은 아래 OVERRIDES 에 등록해야 통과한다**
 * — 등록 안 된 규칙이 넓은 창을 쓰면 RED 다(신규 규칙 fail-closed).
 *
 * 왜 전역 상수가 아니라 기본값 + 허가 목록인가(2026-09-11 리더 판정): 전역
 * 상한을 512 로 올렸던 판이 fail-open 이었다. 실측 — 그 상태에서 L2
 * `wget-external` 을 `{0,192}` → `{0,512}` 로 넓혀 보니 **정적 스캔은 그린**
 * 이었고 경계 쌍 단언 하나만 RED 였다. 기존 규칙은 경계 쌍이 받쳐 줘서 막혔지만,
 * 경계 쌍 없이 새로 추가되는 규칙은 아무것도 잡지 못했다. 규율 §8 — 부정 목록은
 * 미래 항목에 fail-open 이고, 허용 목록은 아니다.
 */
const WINDOW_CEILING_DEFAULT = 192;

/**
 * 192 를 넘도록 **허가된** 규칙 목록. 키는 `<층>:<식별자>` 로, L1 은 label,
 * L2 는 id 를 쓴다(2026-09-11 현재 L2 예외 0건).
 *
 * 층 접두가 붙은 이유: 접두 없이 label 과 id 를 한 객체에 섞으면 **네임스페이스가
 * 겹친다.** 지금은 충돌이 없지만, 미래에 L2 id 가 L1 label 과 같은 문자열이 되면
 * 등록하지 않은 층에까지 조용히 예외가 적용된다 — 키 목록을 고정하는 핀 it 은
 * 새 키 추가는 잡아도 그 충돌은 감지하지 못한다. 접두가 그 경로를 아예 없앤다.
 *
 * 이것은 **폭 표가 아니라 상한 허가 목록**이다. 정확한 폭의 정본은 여전히
 * 경계 쌍·구조 단언이다 — L1 은 tests/core/blocked-patterns.test.js 의 정확값
 * `toBe`(rm 512 · pipe 192), L2 는 이 파일의 describe 'classifyRisk — the
 * dd/curl/wget window bound keeps ordinary commands matched'(192/193 쌍 6건).
 *
 * **두 값이 어긋나면 RED 가 맞다. 여기를 고쳐 맞추지 마라** — 게이트를
 * 통과시키려 게이트를 깎지 않는다(규율 §10). 폭이 정말 바뀌어야 하면 정본 쪽을
 * 먼저 옮기고 그 근거를 남긴 뒤 여기를 따라 올려라.
 *
 * rm 2건이 512 인 이유: rm 의 타깃은 PATH 이고 Windows MAX_PATH 는 260 이라
 * 192 창은 평범한 긴 경로를 아예 못 본다. 192 를 적용했더니
 * `rm --recursive <193자 이상>/x` 가 종전 L1 block → approve 로 뒤집혔고
 * (L2 에도 recursive-only 규칙이 없어 full-stack), 그건 사각이 아니라 커버리지
 * 회귀라 리더가 문서화 대신 창을 옮겼다. dd·pipe·git-push 는 옵션과 URL 을 재는
 * 다른 분포라 192 로 남는다 — dd 가 192 인 건 512 를 택할 이유가 없어서지
 * 512 가 금지라서가 아니다.
 */
const WINDOW_CEILING_OVERRIDES = Object.freeze({
  'L1:rm -rf with path': 512,
  'L1:rm -fr with path': 512,
});

/**
 * 규칙 하나에 적용할 상한을 고른다.
 * @param {'L1'|'L2'} layer 카탈로그 — L1 = blocked-patterns, L2 = safety
 * @param {string} key L1 은 label, L2 는 id
 * @returns {number}
 */
function ceilingFor(layer, key) {
  return WINDOW_CEILING_OVERRIDES[`${layer}:${key}`] ?? WINDOW_CEILING_DEFAULT;
}
/** 클래스가 공백을 매치할 수 있는지 보는 프로브 문자들. */
const SCAN_WHITESPACE = [' ', '\t', '\n', '\r', '\f', '\v'];

/**
 * 문자클래스 하나를 읽는다. JS 비-v 모드에서는 `[` 또는 `[^` 직후의 `]` 도
 * 클래스를 닫으므로 특례가 없다.
 * @param {string} source @param {number} start
 * @returns {{ end: number, negated: boolean } | null}
 */
function readCharClass(source, start) {
  let i = start + 1;
  const negated = source[i] === '^';
  if (negated) i += 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === ']') return { end: i + 1, negated };
    i += 1;
  }
  return null;
}

/**
 * 수량자 하나를 읽는다. 상한이 없으면 Infinity.
 * @param {string} source @param {number} i
 * @returns {{ end: number, max: number } | null}
 */
function readQuantifier(source, i) {
  const ch = source[i];
  if (ch === '*' || ch === '+') return { end: i + 1, max: Infinity };
  if (ch === '?') return { end: i + 1, max: 1 };
  if (ch !== '{') return null;
  const m = /^\{(\d+)(,(\d+)?)?\}/.exec(source.slice(i));
  if (!m) return null;
  const max = m[2] === undefined ? Number(m[1]) : (m[3] === undefined ? Infinity : Number(m[3]));
  return { end: i + m[0].length, max };
}

/**
 * 이 원자가 공백을 하나라도 매치할 수 있는가. `.` 은 어느 모드에서도 스페이스와
 * 탭을 매치하므로 항상 true. 파싱 불가면 fail-closed(true)로 보고한다.
 * @param {string|null} classSource `[^…]` 원문, `.` 이면 null
 * @param {string} flags
 * @returns {boolean}
 */
function canMatchWhitespace(classSource, flags) {
  if (classSource === null) return true;
  try {
    const probe = new RegExp(classSource, flags.includes('i') ? 'i' : '');
    return SCAN_WHITESPACE.some((c) => probe.test(c));
  } catch {
    return true;
  }
}

/**
 * 정규식 소스를 이스케이프 인식하며 걸어서 무제한 런을 보고한다.
 * @param {string} source @param {string} [flags]
 * @returns {{ index: number, snippet: string, kind: 'unbounded'|'wide-window' }[]}
 */
function findUnboundedRuns(source, flags = '', ceiling = WINDOW_CEILING_DEFAULT) {
  const found = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const atomStart = i;
    /** @type {{ classSource: string|null } | null} */
    let atom = null;
    if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      const cls = readCharClass(source, i);
      if (!cls) { i += 1; continue; }
      if (cls.negated) atom = { classSource: source.slice(atomStart, cls.end) };
      i = cls.end;
    } else if (ch === '(') {
      // 그룹 여는 괄호는 원자가 아니다. 수량자는 닫는 괄호에 붙는다.
      const open = /^\((?:\?:|\?=|\?!|\?<=|\?<!|\?<[A-Za-z_$][\w$]*>)?/.exec(source.slice(i));
      i += open[0].length;
      continue;
    } else if (ch === ')') {
      i += 1;
      const groupQuantifier = readQuantifier(source, i);
      // 그룹 수량자는 이번 스캔 범위 밖(못 보는 것 #3). 오파싱만 막고 넘어간다.
      if (groupQuantifier) {
        i = groupQuantifier.end;
        if (source[i] === '?') i += 1;
      }
      continue;
    } else if (ch === '.') {
      atom = { classSource: null };
      i += 1;
    } else {
      i += 1;
    }

    const q = readQuantifier(source, i);
    if (!q) continue;
    const quantifierEnd = q.end;
    i = q.end;
    if (source[i] === '?') i += 1; // lazy
    if (!atom) continue;
    if (q.max <= ceiling) continue;
    if (!canMatchWhitespace(atom.classSource, flags)) continue;
    found.push({
      index: atomStart,
      snippet: source.slice(atomStart, quantifierEnd),
      kind: q.max === Infinity ? 'unbounded' : 'wide-window',
    });
  }
  return found;
}

/**
 * 스캔 예외. **id 기준 정확히 1건**이고, 넓히려면 아래 두 it 을 모두 고쳐야 한다.
 *
 * sql-delete-no-where 의 `(?!.*\bWHERE\b)` 는 실측 선형이므로 규칙을 깎지 않고
 * 스캔이 비켜간다(검증 규율 §10: 게이트를 통과시키려 규칙을 깎지 않는다).
 * 실측 — node v24.15.0, 2026-09-11 12:10 UTC, 3회 중앙값, 단일 정규식 /
 * classifyRisk 전체 경로, 비매치 반복형(`'DELETE FROM t '`) 과 WHERE 꼬리
 * 적대형(같은 반복 + 끝에 ` WHERE x`):
 *          10,240B      20,480B      40,962B      122,880B
 *   반복형 0.01 / 0.07  0.02 / 0.12  0.06 / 0.26  0.12 / 0.68  ms
 *   꼬리형 0.01 / 0.08  0.02 / 0.12  0.04 / 0.26  0.12 / 0.70  ms
 * 입력 12배에 시간 12배 — 선형이다.
 *
 * "lookahead 안이면 전부 예외" 같은 일반 규칙은 채택하지 않았다. lookahead 도
 * 2차식일 수 있다. 예외는 이 id 하나이고, `.*` 가 lookahead 밖으로 나가면
 * 아래 it 이 RED 가 된다.
 */
const SCAN_ALLOWLIST = new Set(['sql-delete-no-where']);

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

  it('예외는 sql-delete-no-where 한 건뿐이다', () => {
    expect([...SCAN_ALLOWLIST]).toEqual(['sql-delete-no-where']);
  });

  it('sql-delete-no-where 의 유일한 무제한 런은 부정 lookahead 안에 있다', () => {
    const rule = DANGEROUS_PATTERNS.find((r) => r.id === 'sql-delete-no-where');
    const hits = findUnboundedRuns(rule.test.source, rule.test.flags);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBe('.*');
    // lookahead 밖으로 옮기면 이 단언이 RED 가 된다 — 예외가 넓어지지 않는다.
    expect(rule.test.source.slice(hits[0].index - 3, hits[0].index)).toBe('(?!');
  });
});

describe('ReDoS 정적 스캔 — 스캐너 자기검증', () => {
  // 게이트 자체가 거짓 그린이 되지 않게 스캐너를 스캐너로 검증한다.
  it.each([
    ['dot star', /a.*b/],
    ['dot plus with the s flag', /a.+b/s],
    ['negated-newline class star', /[^\n]*x/],
    ['negated-newline class plus', /[^\n]+x/],
    ['a window one past the default ceiling', /[^\n]{0,193}y/],
    ['a window at the rm exception width but unregistered', /[^\n]{0,512}y/],
    ['a window far wider than the ceiling', /[^\n]{0,1000}y/],
    ['an open-ended repeat', /[^\n]{3,}z/],
  ])('reports %s', (_name, re) => {
    expect(findUnboundedRuns(re.source, re.flags).length).toBeGreaterThan(0);
  });

  it.each([
    ['an escaped dot and star', /\.\*/],
    ['a dot and a star inside a class', /[.*]/],
    ['a window at exactly 192', /[^\n]{0,192}q/],
    ['a separator window at 192', /[^\n;&|]{0,192}q/],
    // 아래 셋은 "못 보는 것" 목록의 1·4번 그대로다. 통과가 안전을 뜻하지 않는다.
    ['a positive-class run (out of scope)', /[\w."` ]+/],
    ['an open repeat on a positive class (out of scope)', /[A-Za-z0-9]{16,}/],
    ['a token-confined run that cannot cross whitespace', /[^\s;&|]*/],
    ['a negated class that is alternated, not quantified', /(?:[^\S\n]|\\\r?\n)+x/],
  ])('does not report %s', (_name, re) => {
    expect(findUnboundedRuns(re.source, re.flags)).toEqual([]);
  });

  it('reports the exact span and kind, not just a boolean', () => {
    const hits = findUnboundedRuns(/\bdd\b[^\n]*\sof=/.source, 'i');
    // `\bdd\b` 는 소스에서 6자다(백슬래시 2개 포함).
    expect(hits).toEqual([{ index: 6, snippet: '[^\\n]*', kind: 'unbounded' }]);
  });

  it('reports a wide window as wide-window, not unbounded', () => {
    const hits = findUnboundedRuns(/\bdd\b[^\n]{0,193}\sof=/.source, 'i');
    expect(hits.map((h) => h.kind)).toEqual(['wide-window']);
  });

  // 상한 기본값이나 예외 목록이 조용히 움직이면 게이트의 의미가 통째로 바뀐다.
  it('pins the default ceiling at 192 and the boundary either side of it', () => {
    expect(WINDOW_CEILING_DEFAULT).toBe(192);
    expect(findUnboundedRuns(/[^\n]{0,192}q/.source)).toEqual([]);
    expect(findUnboundedRuns(/[^\n]{0,193}q/.source)).toHaveLength(1);
  });

  it('pins the override list to exactly the two L1 rm rules at 512', () => {
    expect(Object.keys(WINDOW_CEILING_OVERRIDES).sort()).toEqual([
      'L1:rm -fr with path',
      'L1:rm -rf with path',
    ]);
    expect(WINDOW_CEILING_OVERRIDES['L1:rm -rf with path']).toBe(512);
    expect(WINDOW_CEILING_OVERRIDES['L1:rm -fr with path']).toBe(512);
  });

  // 실행형 반증. 등록되지 않은 규칙은 192 를 넘는 순간 잡히고, 등록된 이름으로
  // 조회해야만 512 까지 통과한다 — 신규 규칙이 fail-closed 라는 주장의 증거다.
  it('reports a wide window on a rule that is not registered', () => {
    expect(findUnboundedRuns(/[^\n]{0,193}z/.source, '', ceilingFor('L1', 'not-registered'))).toHaveLength(1);
    expect(findUnboundedRuns(/[^\n]{0,512}z/.source, '', ceilingFor('L2', 'not-registered'))).toHaveLength(1);
  });

  it('lets a registered rule run to 512 but not past it', () => {
    const ceiling = ceilingFor('L1', 'rm -rf with path');
    expect(ceiling).toBe(512);
    expect(findUnboundedRuns(/[^\n]{0,512}z/.source, '', ceiling)).toEqual([]);
    expect(findUnboundedRuns(/[^\n]{0,513}z/.source, '', ceiling)).toHaveLength(1);
  });

  // 층 접두가 실제로 네임스페이스를 가르는지. 접두 없이 label 과 id 를 섞어
  // 두면 같은 문자열이 양쪽 층에 조용히 예외를 주는데, 핀 it 은 키 목록만
  // 고정하므로 그 충돌을 못 본다. 여기가 그 자리를 맡는다.
  it('keeps the L1 and L2 key namespaces apart', () => {
    // 같은 식별자라도 등록된 층에서만 512 가 나온다.
    expect(ceilingFor('L1', 'rm -rf with path')).toBe(512);
    expect(ceilingFor('L2', 'rm -rf with path')).toBe(WINDOW_CEILING_DEFAULT);
    // 등록 키는 전부 층 접두를 달고 있다.
    for (const key of Object.keys(WINDOW_CEILING_OVERRIDES)) {
      expect(key).toMatch(/^L[12]:/);
    }
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

/** 경계 쌍이 실제로 존재하는 규칙 id 집합. */
const BOUNDARY_PAIR_IDS = [
  ...FILLER_BOUNDARY_PAIRS.map((row) => row[2]),
  ...SPAN_BOUNDARY_PAIRS((n) => `${n}`, (n) => `${n}`).map((row) => row[2]),
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

  it('finds the six windowed rules it is supposed to find', () => {
    // 분모를 고정한다 — 위 단언이 "0 === 0" 으로 공허하게 그린이 되지 않도록.
    const windowed = DANGEROUS_PATTERNS.filter((r) => hasBoundedWindow(r.test.source));
    expect(windowed).toHaveLength(6);
    expect(BOUNDARY_PAIR_IDS).toHaveLength(6);
  });

  it('detects a bounded window and ignores shapes that are not one', () => {
    expect(hasBoundedWindow(/\bdd\b[^\n]{0,192}\sof=/.source)).toBe(true);
    expect(hasBoundedWindow(/\bgit\s+push\b[^\n;&|]{0,192}--force/.source)).toBe(true);
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
});
