/**
 * The `--force-with-lease` exemption must not travel outside the rules it was
 * written for.
 *
 * `SAFE_OVERRIDES` was introduced so a genuinely safe force push
 * (`git push --force-with-lease`) is not blocked alongside `git push --force`.
 * It was applied inside the loop over EVERY blocked pattern and tested against
 * the whole command string, so appending that token to any command at all
 * skipped the entire denylist. Measured 2026-08-30 against the real hook:
 * `rm -rf /` blocked, `rm -rf / --force-with-lease` allowed. The flag means
 * nothing to `rm`, so it costs an attacker nothing to add.
 *
 * The exemption moved off the global list onto the two `git push` rules
 * (`lib/core/blocked-patterns.js`); category scoping was not enough either — the
 * flag is equally meaningless to `git reset --hard`. Since 2026-09-11 those two
 * rules exempt via a negative lookahead, so `safeOverrides` has no consumers.
 *
 * SCOPE: this file pins the exemption's reach only. The denylist remains a
 * denylist — semantically equivalent commands (`rm -rf ~`, `find / -delete`)
 * still pass, and nothing here should be read as covering that.
 *
 * ---------------------------------------------------------------------------
 * L1/L2 PARITY MATRIX (second describe block, below)
 *
 * Two independent layers judge the same command string and they do not agree:
 *
 *   L1 = lib/core/blocked-patterns.js#BLOCKED_PATTERNS, reached through
 *        guard-registry#executeChain. Outcome is 'block' or not-'block'.
 *   L2 = lib/autopilot/safety.js#classifyRisk. Outcome is
 *        { level: 'safe'|'caution'|'danger', matchedId }.
 *
 * PARITY_MATRIX pins one row per command so a disagreement can only change
 * when someone edits this table on purpose. Each row carries a `status`:
 *
 *   'agreed'         — both layers point the same way AND that is the target
 *                      value. Direction rule: L1 'block' implies L2 is at
 *                      least 'caution'; L1 'pass' implies L2 is 'safe'.
 *   'owner-decision' — the row pins the CURRENT value for regression
 *                      detection only. Reaching parity would require either a
 *                      loosening (unblocking, or lowering a level) or a
 *                      tightening that has no evidence behind it yet, so the
 *                      owner decides. `note` states which.
 *
 * The sibling changes those target values waited on have all landed (L1's
 * pathless recursive-delete rule; L2's git-checkout-discard /
 * git-restore-discard / git-stash-drop / rm-rf-path), so no row is RED by
 * design any more. A red row now means a real disagreement.
 *
 * 2026-09-14 (guard-command-position) added a THIRD input to both layers:
 * lib/core/command-segments.js#blankPrinterSegments blanks printer segments
 * before either layer reads the text. It edits no rule regex. Twelve rows were
 * added for it — four veto conditions, four mention wrappers, the two
 * rm-recursive-path rows, and two residual divergences. Read the
 * `echo "git checkout . is dangerous"` row first; it is the one that moved.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  executeChain,
  registerBuiltinGuards,
  resetGuards,
} from '../../lib/core/guard-registry.js';
import { classifyRisk } from '../../lib/autopilot/safety.js';

beforeEach(() => {
  resetGuards();
  registerBuiltinGuards();
});

/**
 * @param {string} command
 * @returns {{ decision: string, reason?: string }}
 */
function judge(command) {
  return executeChain(
    'pre',
    'Bash',
    { tool_name: 'Bash', tool_input: { command } },
    { cwd: '/tmp' },
  );
}

describe('dangerous-command — exemption scope', () => {
  it('blocks the commands the denylist names', () => {
    // Baseline. If these ever stop blocking, the cases below prove nothing.
    expect(judge('rm -rf /').decision).toBe('block');
    expect(judge('git reset --hard').decision).toBe('block');
    expect(judge('git push --force origin main').decision).toBe('block');
  });

  it('does not let a git flag exempt a filesystem command', () => {
    const r = judge('rm -rf / --force-with-lease');
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('rm -rf with path');
  });

  it('does not let the exemption travel to other git rules', () => {
    // Same category, but the flag is meaningless here — a category-wide
    // exemption would have let this through.
    expect(judge('git reset --hard --force-with-lease').decision).toBe('block');
    expect(judge('git clean -fd --force-if-includes').decision).toBe('block');
  });

  it('still allows the safe force push the exemption exists for', () => {
    // Over-correction guard: the point was never to block these.
    expect(judge('git push --force-with-lease origin main').decision).not.toBe('block');
    expect(judge('git push --force-if-includes origin main').decision).not.toBe('block');
  });
});

/**
 * @typedef {Object} ParityRow
 * @property {string} command - Exact string handed to both layers
 * @property {'block'|'pass'} l1 - Target guard-registry decision
 * @property {'safe'|'caution'|'danger'} l2 - Target classifyRisk level
 * @property {string|null} l2Id - Target classifyRisk matchedId, null when safe
 * @property {'agreed'|'owner-decision'} status - See header block
 * @property {string} note - Why this row reads the way it does
 */

/**
 * Baseline for the current L1 values was measured by the lead on
 * 2026-09-11 00:08 KST. Target values assume the two sibling changes named in
 * the file header have landed.
 * @type {ReadonlyArray<ParityRow>}
 */
const PARITY_MATRIX = Object.freeze([
  {
    command: 'rm -rf /',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '루트 삭제 — 두 층 모두 최고 등급. 이 행이 깨지면 나머지 행은 아무것도 증명하지 못한다.',
  },
  {
    command: 'rm -rf ./build',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'agreed',
    note: 'L1 은 경로에 슬래시가 있어 원래 차단. L2 는 rm-rf-path 착지 전까지 safe (RED 예상).',
  },
  {
    command: 'rm -rf build',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'agreed',
    note: '슬래시 없는 재귀 삭제. L1·L2 양쪽 규칙 착지 전까지 pass/safe (RED 예상).',
  },
  {
    command: 'rm -rf node_modules/.cache',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'agreed',
    note: '상대경로 경계 — L1 은 슬래시 규칙으로 원래 차단하며, 그 차단은 의도된 값이다.',
  },
  {
    command: 'git checkout .',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-checkout-discard',
    status: 'agreed',
    note: '작업 트리 전체 폐기. L2 규칙 착지 전까지 safe (RED 예상).',
  },
  {
    command: 'git restore .',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-restore-discard',
    status: 'agreed',
    note: 'checkout . 과 동형. L2 규칙 착지 전까지 safe (RED 예상).',
  },
  {
    command: 'git checkout -- .',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-checkout-discard',
    status: 'agreed',
    note: '`--` 구분자형 — git 공식 문서가 권하는 표기이고 파괴력은 위 행과 같다. 2026-09-11 15:5x KST 실측에서 L1 approve / L2 danger 였다: L1 규칙이 `\\.\\s*$` 앵커라 점 뒤에 무엇이든 오면 놓쳤다. L2 와 같은 `(?:--\\s+)?\\.(?=\\s|$)` 모양으로 바꿔 닫는다.',
  },
  {
    command: 'git restore -- .',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-restore-discard',
    status: 'agreed',
    note: 'checkout 형과 동형. 두 규칙은 같은 모양이어야 하며, 한쪽만 고치면 이 행이 먼저 깨진다(2026-09-11 15:5x KST 실측 L1 approve / L2 danger).',
  },
  {
    command: 'git checkout . && echo hi',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-checkout-discard',
    status: 'agreed',
    note: '셸 체이닝 — `&&` 로 명령을 이어붙이면 앵커가 닿지 않아 L1 을 통째로 통과했다(2026-09-11 15:5x KST 실측). 맨 줄바꿈과 달리 `&&` 는 같은 입력 안의 두 명령이고 앞 명령이 파괴적이므로 두 층 모두 잡아야 한다.',
  },
  {
    command: 'echo "git checkout . is dangerous"',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '오탐 ① **해소**(2026-09-14, guard-command-position). 종전 값은 L1 block / L2 danger 였고 owner-decision 으로 "현재 값을 핀할 뿐 목표가 아니다"라고 적혀 있었다. 명령을 언급만 하는 것은 실행이 아니다 — 이제 두 층 모두 통과한다. 수리는 규칙이 아니라 **전처리**다: `lib/core/command-segments.js#blankPrinterSegments` 가 프린터 세그먼트(echo·printf·grep·주석·`git commit -m` …)를 같은 길이로 비운 뒤 두 층이 그 텍스트를 본다. 규칙 정규식은 L1·L2 통틀어 **0건 수정**이다. 브리프가 비교한 3안 중 명령 시작 앵커와 따옴표 구간 제거는 각각 적대 67형에서 실행형 양성을 18건씩 잃어 기각됐다. 면제는 허용목록 안에서만 일어나고 파이프·치환·리다이렉트가 각각 거부권을 가지므로 fail-closed 다 — 그 네 경로의 양성 대조가 바로 아래 행들이다. L1 을 느슨하게 해서 맞춘 것이 아니라는 증거도 그 행들이다.',
  },
  {
    command: 'git stash drop',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-stash-drop',
    status: 'agreed',
    note: '스택 공유 — 되돌릴 수 없다. L2 규칙 착지 전까지 safe (RED 예상).',
  },
  {
    command: 'git push --force origin main',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-force-push',
    status: 'agreed',
    note: '무검사 강제 푸시 — 두 층 모두 이미 최고 등급.',
  },
  {
    command: 'git push --force-with-lease origin main',
    l1: 'pass',
    l2: 'caution',
    l2Id: 'git-force-push-lease',
    status: 'owner-decision',
    note: '오너 결정 2026-09-11 확정: L2 danger → caution. L1 정본은 lease 허용(blocked-patterns.js `git push --force` 규칙의 부정 예측 `(?!-with-lease|-if-includes)` — 2026-09-11 까지는 safeOverrides 목록이었다). 여전히 agreed 가 아니다 — 헤더 방향 규칙상 L1 pass 는 L2 safe 를 요구하는데, lease 도 원격 히스토리를 다시 쓰므로 safe 로 내리지 않는다. 이 행은 그 잔여 불일치를 핀한다.',
  },
  {
    command: 'git push -f --force-with-lease origin main',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-force-push-short',
    status: 'agreed',
    note: '무검사 `-f` 와 lease 플래그를 함께 실은 형태. lease 는 `-f` 가 하는 일을 되돌리지 못한다 — git 은 뒤에 오는 강제 지정을 그대로 쓴다. 2026-09-11 15:5x KST 실측에서 L1 approve / L2 danger 였다: L1 의 `safeOverrides` 가 **명령 전체**를 상대로 대조돼(guard-registry.js#checkDangerousCommand) lease 토큰 한 개가 규칙을 통째로 면제시켰다. 면제를 패턴 안의 부정 예측으로 옮겨 닫는다.',
  },
  {
    command: 'git push origin main -f',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-force-push-short',
    status: 'agreed',
    note: '`-f` 가 리모트·브랜치 뒤에 오는 형태 — git 이 실제로 받아들이는 표기다. 종전 L1 규칙은 `git\\s+push\\s+-f` 로 push 바로 뒤만 봐서 놓쳤다(2026-09-11 15:5x KST 실측 L1 approve / L2 danger). 인자 순서를 바꿔 우회하는 경로를 막는다.',
  },
  {
    command: 'git reset --hard',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-reset-hard',
    status: 'agreed',
    note: '커밋되지 않은 작업 폐기 — 두 층 모두 이미 최고 등급.',
  },
  {
    command: 'git branch -D topic',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-branch-delete',
    status: 'agreed',
    note: '병합되지 않은 브랜치 강제 삭제 — 두 층 모두 최고 등급.',
  },
  {
    command: 'git branch -d topic',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '오너 결정 2026-09-11 확정: 두 층 모두 `/i` 를 떼어 -D(강제)와 -d(안전)를 가른다. 종전에는 양쪽 규칙의 /i 때문에 이 안전한 명령이 PreToolUse 에서 차단됐다(실측). 음성 대조 — 대소문자 구분이 어느 층에서든 되돌아가면 이 행이 먼저 깨진다.',
  },
  {
    command: 'git branch --delete --force topic',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-branch-delete',
    status: 'agreed',
    note: '롱옵션 강제 삭제 — -D 와 같은 파괴력인데 2026-09-11 이전에는 두 층 다 통과시켰다(실측). 플래그 표기를 바꿔 우회하는 경로를 막는다.',
  },
  {
    command: 'git branch -d old\necho -f done',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '맨 줄바꿈은 셸 명령 구분자다 — 두 줄 모두 안전하므로 어느 층도 잡으면 안 된다. 2026-09-11 guard-normalize 줄기 전까지는 L1 만 차단했다: 두 층의 정규식은 바이트 동일하고 옵션 런을 줄바꿈에서 끊는데, L1 은 checkDangerousCommand 가 normalizeCommand 변형도 대조했고 그 함수가 `/\\s+/g` 로 줄바꿈까지 공백 하나로 접어 패턴이 보기 전에 경계를 지웠다. 그래서 뒷줄의 -f 가 강제 플래그로 읽혔다. 같은 줄기에서 normalizeCommand 를 줄바꿈 보존형으로 바꿔(백슬래시 줄연결 결합 → CRLF→LF → 줄 안 공백만 접기) 두 층이 같은 줄바꿈 경계를 쓰게 됐다. executeChain 핀은 tests/core/guard-registry.test.js 의 `dangerous-command guard — newline semantics`; 전 규칙 영향은 셀 단위로 실측했고 회귀 0 이다 — 표·분모·측정 시각은 docs/investigations/guard-normalize-20260911.md 가 정본이다(셀 수는 BLOCKED_PATTERNS 가 바뀌면 같이 움직이므로 여기에 적지 않는다).',
  },
  {
    command: 'git branch -d old\r\necho -f done',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: 'CRLF 대조 — 윈도우 줄바꿈에서도 같은 경계여야 한다. normalizeCommand 가 CRLF 를 LF 로 정규화한 뒤 줄바꿈을 보존하므로 LF 형과 같은 판정이다(2026-09-11 14:22 KST 실측). CRLF 처리가 빠지면 LF 행은 그린인데 이 행만 깨진다.',
  },
  {
    command: 'git branch -d topic \\\n-f',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-branch-delete',
    status: 'agreed',
    note: '백슬래시 줄연결은 줄바꿈과 반대다 — `\\` + LF 는 하나의 명령이므로 뒷줄의 -f 는 진짜 강제 플래그이고 두 층 모두 잡아야 한다. 위 두 행과 짝을 이루는 양성 대조: 줄바꿈을 보존하되 줄연결까지 끊어버리면 이 행이 깨진다(2026-09-11 14:22 KST 실측 L1 block / L2 danger).',
  },
  {
    command: 'TRUNCATE users;',
    l1: 'pass',
    l2: 'danger',
    l2Id: 'sql-truncate',
    status: 'owner-decision',
    note: '오너 결정 2026-09-11 확정: L2 는 문 형태를 요구하도록 좁혔고(단어 스침 오탐 제거) bare 문 자체는 danger 를 유지한다. L1 은 TRUNCATE TABLE/DATABASE 형만 차단(label "TRUNCATE TABLE"·"SQL destructive operation") — L1 강화는 채택되지 않았다. 따라서 L1 pass / L2 danger 불일치가 남고 이 행이 그것을 핀한다. 근거: 2026-09-11 00:2x KST 조사 — 리포 추적 파일·Artibot 트랜스크립트 Bash 10,293건에 SQL TRUNCATE 문 0건, L2 sql-truncate 발화 10건 전부 grep 인자·인용.',
  },
  {
    command: 'TRUNCATE TABLE users',
    l1: 'block',
    l2: 'danger',
    l2Id: 'sql-truncate',
    status: 'agreed',
    note: '문 형태 양성 대조 — 좁힌 뒤에도 정식 DDL 은 두 층 모두 최고 등급이어야 한다.',
  },
  {
    command: 'grep -n -i "truncate\\|force-with-lease" lib/autopilot/safety.js',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '음성 대조 — 이 명령은 2026-09-11 실제로 PreToolUse 에서 차단됐다(L2 sql-truncate 단어 스침). 두 규칙 이름을 한 줄에 담은 grep 이 다시 막히면 이 행이 먼저 깨진다.',
  },
  {
    command: 'dd if=/dev/zero of=/dev/sda',
    l1: 'block',
    l2: 'danger',
    l2Id: 'dd-device-write',
    status: 'agreed',
    note: '오너 결정 2026-09-11 확정: L2 에 dd-device-write 추가. 원시 디바이스 쓰기는 되돌릴 수 없다. 파일 대 파일 dd(`of=` 가 /dev/ 아님)는 여전히 L1 block / L2 safe 이며 이 행이 덮지 않는다.',
  },
  {
    command: 'dd of=/dev/sda',
    l1: 'block',
    l2: 'danger',
    l2Id: 'dd-device-write',
    status: 'agreed',
    note: '`if=` 없는 최소형 — 위 행은 L1 에서 `dd\\s+if=` 규칙만으로도 잡히므로 `of=` 경로를 증명하지 못한다. 이 행은 L1 의 dd write to block device 규칙(blocked-patterns.js)을 실제로 통과해야만 그린이 된다(2026-09-11 14:22 KST 실측).',
  },
  {
    command: 'sudo dd bs=4M if=img of=/dev/sdb',
    l1: 'block',
    l2: 'danger',
    l2Id: 'dd-device-write',
    status: 'agreed',
    note: '`if=` 와 `of=` 사이에 다른 옵션이 끼고 대상이 sdb 인 형태. 인자 순서나 디바이스 이름을 바꿔 우회하는 경로를 막는다(2026-09-11 14:22 KST 실측).',
  },
  {
    command: ':(){ :|:& };:',
    l1: 'block',
    l2: 'danger',
    l2Id: 'fork-bomb',
    status: 'agreed',
    note: '오너 결정 2026-09-11 확정: L2 에 fork-bomb 규칙 추가, L1 \'fork bomb\' 규칙과 바이트 동일(source 동일성은 tests/autopilot/safety.test.js 가 핀). 경위 — 같은 날 guard-normalize 줄기에서 L1 규칙의 빈 캡처그룹 결함을 수리해 표준형이 비로소 L1 block 이 됐고(종전에는 `()` 가 빈 그룹이라 실제로 요구하는 문자열이 `:{ :|:& };:` 였으므로 표준형은 approve 였다), 그 시점 L2 에는 대응 규칙이 0건이라(14:28 KST 실측) 이 행은 L1 block / L2 safe 불일치를 핀하는 owner-decision 이었다. L2 규칙이 착지하면서 방향 규칙을 채웠다.',
  },
  {
    command: 'npm publish',
    l1: 'block',
    l2: 'danger',
    l2Id: 'npm-publish',
    status: 'agreed',
    note: '릴리스급 행위 — 두 층 모두 이미 최고 등급.',
  },
  {
    command: 'npm test',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '음성 대조 — 어느 층도 일상 명령을 잡으면 안 된다.',
  },
  {
    command: 'git push origin main',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '음성 대조 — 강제 푸시 규칙이 평범한 푸시로 번지면 안 된다.',
  },
  {
    command: 'git stash clear',
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-stash-drop',
    status: 'agreed',
    note: 'drop 보다 파괴적(스택 전체 삭제)인데 00:15 KST 실측에서 양쪽 다 통과 → 양쪽 강화 대상.',
  },
  {
    command: 'rm -r -f dist',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'agreed',
    note: '플래그 분리형 — 합쳐진 -rf 만 잡는 규칙은 이 형태를 놓친다.',
  },
  {
    command: 'rm --recursive --force out',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'agreed',
    note: '롱옵션형 — 위와 같은 회피 경로이며 두 층 모두 대상.',
  },
  {
    command: 'rm -r -f /',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '분리 플래그형 루트 삭제 — 00:2x KST 실측에서 양쪽 통과였던 구멍, 양쪽 강화 대상.',
  },
  {
    command: 'rm -rfv *',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-broad',
    status: 'agreed',
    note: 'L2 만 강화 — L1 은 와일드카드 룰로 이미 차단한다(00:22 KST 실측). 플래그 묶음에 v 가 끼면 -rf 만 보는 L2 룰을 비껴간다.',
  },
  {
    command: 'rm -r -f /tmp/x',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '분리 플래그+절대경로 — 00:22 KST 실측 양쪽 통과. 구멍이 루트 하나가 아니라 절대경로 전반임을 고정한다.',
  },

  // ── 프린터 세그먼트 면제의 거부권 4종 (2026-09-14 추가) ────────────────────
  // 위 `echo "git checkout . is dangerous"` 행이 pass/safe 로 올라간 것이
  // **강등이 아니라 정확해진 것**임을 증명하는 양성 대조다. 이 네 행이 빠지면
  // 그 행은 "언급을 통과시킨다"는 말만 남고 fail-open 과 구별되지 않는다.
  {
    command: 'echo "rm -rf /tmp" | sh',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '면제 조건 (ii) — 프린터의 출력이 파이프로 다른 프로그램에 들어가면 그것은 인쇄가 아니라 실행이다. 세그먼트 뒤에 `|` 가 있으면 면제가 거부되고 텍스트는 두 층에 바이트 그대로 도달한다(2026-09-14 실측 L1 block / L2 danger, `blankPrinterSegments` 출력이 입력과 동일).',
  },
  {
    command: 'echo "$(rm -rf /tmp)"',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '면제 조건 (iii) — 명령 치환은 따옴표 안에서도 실행된다. 세그먼트에 `$(`·백틱·`<(`·`>(` 가 하나라도 있으면 면제가 거부된다(2026-09-14 실측). 홑따옴표 안의 `$(…)` 는 셸이 실행하지 않지만 거부 쪽으로 통일했다 — fail-closed.',
  },
  {
    command: 'echo "safe" ; rm -rf /',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '**세그먼트 단위가 핵심인 이유.** "명령이 `/^echo /` 로 시작하면 통째로 건너뛴다" 식의 형태 정규식이었다면 이 입력은 fail-open 이었다. 면제는 `echo "safe"` 세그먼트에만 적용되고 `;` 뒤의 파괴적 세그먼트는 그대로 남는다(2026-09-14 실측: 전처리 출력이 `@@@@@@@@@@@@; rm -rf /`).',
  },
  {
    command: 'echo x > /dev/sda',
    l1: 'block',
    l2: 'safe',
    l2Id: null,
    status: 'owner-decision',
    note: '면제 조건 (iv) — unquoted 리다이렉트가 있으면 프린터가 아니다. L1 은 "write to disk device" 규칙으로 차단하고(2026-09-14 실측) 면제도 거부된다. **L2 는 대응 규칙이 없어 safe 다** — dd 파일-대-파일(`dd if=a.img of=b.img`)과 같은 종류의 open divergence 이고, 이 줄기가 만든 것이 아니라 원래 있던 것이다(전처리는 이 입력에서 no-op). 방향 규칙상 L1 block 은 L2 caution 이상을 요구하므로 agreed 가 아니다. 닫으려면 L2 에 리다이렉트-투-디바이스 규칙을 새로 넣어야 하고, 그것은 이 줄기의 범위 밖이라 오너 결정으로 남긴다.',
  },
  {
    command: 'echo "rm -rf /" | sh',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '**리더 인용 교정**(2026-09-14). 이 행은 block/danger 로 지시됐으나 실측은 block/**safe** 였다. 원인은 전처리가 아니다 — `blankPrinterSegments` 출력이 입력과 바이트 동일함을 확인했고(조건 ii 가 면제를 거부), 위 `/tmp` 행이 같은 모양에서 danger 다. 원인은 **L2 rm-rf-root 의 선재 결함**이다: 루트 타깃 분기가 `\\/(?:\\s|$|\\*|\\w)` 라 `/` 바로 뒤에 닫는 따옴표가 오면 어느 분기도 맞지 않는다. 규칙 단독 실측 — `rm -rf /` true · `rm -rf /"` false · `rm -rf /)` false · `rm -rf /tmp"` true. 즉 정확히 **루트 타깃 + 직후 인용부호** 한 형태이고 `echo "$(rm -rf /)"` 도 같은 원인이다. **해소 2026-09-14 (guard-l2-followups ①)**: 예고한 그대로 타깃 터미네이터를 고쳤다 — 루트 분기는 터미네이터 그룹을 버리고(`/` 로 시작하는 단어는 언제나 절대경로다), `~`·`$HOME` 분기는 셸 분리자 7종을 받는다. 창과 앵커는 무접촉. 실측 후 block/danger 로 방향 규칙을 충족해 owner-decision → agreed. 같은 편집이 `sh -c`·`eval`·서브셸·백틱 래퍼 9형을 함께 닫았다(아래 `sh -c` 행이 대표).',
  },
  {
    command: 'cat <<\'EOF\'\nrm -rf /\nEOF',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'owner-decision',
    note: '**의도된 잔여 오탐.** heredoc 본문의 언급은 계속 차단된다. 전처리는 heredoc 을 해석하지 않는데, 이것은 누락이 아니라 결정이다 — 본문을 "인쇄되는 텍스트"로 보기 시작하면 `bash <<EOF` 가 통째로 사각이 된다(본문이 곧 실행되는 스크립트다). 언급 8래퍼 중 heredoc 만 종전 발화율을 유지한다(브리프 표 c 열: L1 37/39 · L2 22/22). 오너가 이 비용을 받을지가 결정 사항이라 owner-decision 이다.',
  },
  {
    command: '# rm -rf /tmp/x',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: 'unquoted `#` 이후는 셸에서 주석이므로 실행량이 0 이다. 종전에는 두 층 모두 차단했고, 주석형은 정규화가 손댈 것이 없는데도 34/34 발화했다 — 원인이 따옴표 제거가 아니라 **앵커 부재**라는 것을 이 래퍼가 가장 깨끗하게 보여 준다(브리프 §배경 원인 순위 1차).',
  },
  {
    command: "printf '%s' 'TRUNCATE users;'",
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '`printf` 래퍼. 아래 `TRUNCATE users;` 행과 짝이다 — 그 행은 bare 문이라 여전히 L2 danger 이고(오너 결정 ②), 이 행은 같은 문자열이 인쇄 인자일 때 통과함을 고정한다. 두 행이 함께 있어야 "전처리가 SQL 규칙을 무력화한 것 아니냐"는 물음에 답이 된다.',
  },
  {
    command: 'grep -rn "DROP TABLE" .',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '`grep` 래퍼. 위 `grep -n -i "truncate\\|force-with-lease" …` 행과 같은 실패 양식이었으나 그 행은 규칙을 좁혀 고쳤고 이 행은 전처리가 고친다. 규칙을 좁히는 수리는 규칙마다 반복해야 하지만 전처리는 카탈로그 전체에 한 번 적용된다 — 그 차이를 이 행이 기록한다.',
  },
  {
    command: 'git commit -m "rm -rf build"',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '`git commit -m` 메시지 형. 허용목록이 `git` 전체가 아니라 `commit|tag|notes` 의 `-m` 형에 한정되고 `-e`/`--exec`/`--edit` 가 있으면 거부된다는 점이 중요하다 — `git` 을 통째로 프린터로 두면 `git push --force` 가 면제된다.',
  },
  {
    command: 'rm --recursive a/b/c',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-recursive-path',
    status: 'agreed',
    note: '리더 추가 목표 A. force 플래그 없는 재귀 삭제는 종전 L1 block / L2 **safe** 로 방향 규칙 위반이었다(2026-09-14 실측). L1 은 `rm -rf with path` 규칙의 `--recursive` 분기가 창(512) 안의 `/` 와 함께일 때 잡는다. L2 신규 규칙 `rm-recursive-path`(caution)가 그 짝을 채운다. 아래 513자 행이 창 밖 짝이다.',
  },
  {
    command: `rm --recursive ${'a'.repeat(513)}/x`,
    l1: 'pass',
    l2: 'caution',
    l2Id: 'rm-recursive-path',
    status: 'owner-decision',
    note: '리더 추가 목표 A, 창 밖 짝. 513 은 L1 `rm -rf with path` 창(`[^\\n]{0,512}`)의 첫 바깥 값이라 L1 이 approve 로 뒤집힌다 — 그 폭의 정본은 tests/core/blocked-patterns.test.js 의 경계 쌍이고 여기서 복제하지 않는다. 종전에는 L1 approve + L2 safe = **full-stack 사각**이었고 blocked-patterns.js 가 "THE ONE RESIDUAL BLIND SPOT" 으로 문서화해 둔 자리다. L2 규칙이 caution 을 채워 사각이 닫혔다. L1 pass 가 남아 있으므로 헤더 방향 규칙상 agreed 가 아니다 — 닫는 방법은 L1 창을 더 넓히는 것이 아니라(오너가 이미 그 경로를 기각했다) L2 가 받는 것이고, 이 행이 그 상태를 핀한다.',
  },
  // ── guard-l2-followups ① rm-rf-root 터미네이터 (2026-09-14) ───────────────
  {
    command: 'sh -c "rm -rf /"',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '**실행형 래퍼의 대표 행.** 위 `echo … | sh` 행이 인용 교정의 역사를 담고, 이 행은 그 수리가 파이프 하나가 아니라 래퍼 부류 전체를 닫았다는 것을 핀한다. 종전 실측(2026-09-14, 규칙 단독): `sh -c "…"` · `sh -c \'…\'` · `bash -c "… $HOME"` · `eval "…"` · 백틱 · `(rm … /)` · `{ rm … /; }` · `echo "$(…)"` 8형이 전부 L2 **safe** 였다(래퍼 10형 중 heredoc 만 danger — 줄바꿈이 옛 터미네이터 집합에 우연히 있었다). 전부 언급이 아니라 **실행되는 형태**이고 L1 은 10형 모두 block 이었으므로 방향 규칙 위반 9건이었다. 현재 10/10 danger.',
  },
  {
    command: 'rm -rf "/"',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '따옴표 감싼 루트 타깃. 종전에는 rm-rf-root 가 안 잡아 rm-rf-path 로 흘러 **caution 으로 강등**됐다 — L1 은 정규화가 따옴표를 지워 block 하는데 L2 만 "범위가 정해진 경로"로 읽은 유일한 자리였다. 타깃 앞 `["\']?` 가 그 한 자리를 메운다. 같은 편집의 수용된 비용: `rm -rf "~"` 도 danger 가 된다(큰따옴표 안 `~` 는 확장되지 않으므로 실제로는 문자 그대로의 `./~` 삭제다). 방향이 차단 쪽이라 받되 tests/autopilot/safety.test.js 의 전용 it 이 그것을 알고 있다고 기록한다.',
  },
  {
    command: 'rm -rf //',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '옛 루트 분기 `\\/(?:\\s|$|\\*|\\w)` 가 **두 번째 `/` 를 거부**했다. `rm -rf //` 와 `rm -rf /.` `rm -rf /..` 는 전부 루트를 지우는데 L2 safe 였다 — 터미네이터 목록이 "토큰이 끝나는 방법"을 열거하려다 빠뜨린 형이 아니라, 애초에 열거가 불필요한 자리였다는 증거다(`/` 로 시작하는 단어는 언제나 절대경로다). 그래서 수리는 클래스를 늘리는 것이 아니라 루트 분기에서 터미네이터 그룹을 **삭제**하는 것이었다.',
  },
  // ── guard-l2-residual rm-rf-root ${HOME}·~name (2026-09-21) ───────────────
  // 2026-09-14 주석이 "범위 밖(오너 결정)"으로 남긴 잔여 2형. 리더가 2026-09-21
  // 에 재개했고, 규칙을 더하지 않고 rm-rf-root 의 타깃 분기 둘만 넓혀 닫았다.
  {
    command: 'rm -rf ${HOME}',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '**같은 타깃, 다른 표기.** 평문 `$HOME` 은 종전에도 danger 였는데 중괄호 표기는 rm-rf-root 의 `\\$HOME` 리터럴에 안 걸려 rm-rf-path 로 흘러 **caution 으로 강등**됐다(실측 2026-09-21: 중괄호 5형 전부 caution, L1 은 force 가 있으면 block). 방향 규칙 위반은 아니었고 — block ⇒ ≥caution 은 충족했다 — **과소 판정**이었다. 수리는 `\\$HOME` 을 `\\$(?:HOME|\\{HOME\\})` 로 넓힌 것뿐이고, 터미네이터 집합은 평문 분기와 **같은 것을 재사용**한다. 그래서 `${HOME}x`(홈의 형제 `/home/userx`)는 danger 가 아니다 — 평문 쪽 `$HOMEDIR` 와 같은 판단이고 아래 두 음성 대조 행이 그것을 핀한다.',
  },
  {
    command: 'rm -rf ${HOMEDIR}',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'agreed',
    note: '음성 대조 — **다른 변수**가 사고로 danger 가 되지 않는지. 위 행과 짝이고, 한쪽만 있으면 "중괄호면 무조건 danger" 와 구별되지 않는다. 같은 원인의 형 넷을 tests/autopilot/safety.test.js 가 함께 핀한다(`${HOME_DIR}` · `${HOMEPAGE}/x` · `${HOMEBREW_PREFIX}` · `${PROJECT_HOME}`).',
  },
  {
    command: 'rm -rf ${HOME:-/tmp}',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'owner-decision',
    note: '**치환·기본값 연산자 형 — 의도된 잔여 과소 판정.** 이 명령은 실제로 홈을 지우는데 L2 는 caution 이다. danger 로 올리지 않은 이유 둘: ⑴ 일관성 — 평문 분기도 `rm -rf $HOME:-/tmp` 를 danger 로 보지 않는다(터미네이터 집합에 `:` 가 없다). 리더 조건 ③ 이 요구한 "평문과 같은 터미네이터 규칙"을 지키면 이 형은 자동으로 빠진다. ⑵ 비용 — 잡으려면 `${…}` 본문 문법에 새 수량자를 들여야 하고, 그러면 `${HOMEBREW_PREFIX:-/usr}` 같은 이웃을 가르는 일이 그 수량자에 얹힌다. L1 이 force 형을 block 하므로 full-stack 사각은 아니고, force 없는 `rm -r ${HOME:-/tmp}` 도 rm-recursive-path 가 caution 으로 받는다. **미측정**: 실사용 발생률. 오너가 커버리지 확대를 결정하면 이 행이 그 자리다.',
  },
  {
    command: 'rm -rf ~user',
    l1: 'block',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'agreed',
    note: '**방향 규칙 위반의 해소.** 종전 L1 block / L2 **safe** 였다 — `~` 분기가 틸드 **바로 뒤**에 터미네이터를 요구했고, rm-rf-path·rm-recursive-path 는 둘 다 `~` 로 시작하는 타깃을 "rm-rf-root 의 일"이라며 제외했다(그 제외 자체가 2026-09-22 guard-rm-flag-redos 에서 걷혔다 — 아래 차집합 행 참조). 세 규칙 사이로 떨어진 자리다(실측 2026-09-21: `~name` 3형 + `~+`·`~-`·`~1` 전부 L2 safe). 수리는 틸드 뒤에 **경계 있는 이름 클래스**(`\\w[\\w.-]*`)를 선택적으로 둔 것이고, 터미네이터 집합은 그대로다. 수용된 과대 판정: 그런 사용자가 없어 셸이 확장하지 않는 리터럴 경로(`rm -rf ~backup`)도 danger 다 — 방향이 차단 쪽이라 받되 safety.test.js 의 전용 it 이 그것을 알고 있다고 기록한다. 발생률은 **미측정**.',
  },
  {
    command: 'rm -r ~user',
    l1: 'pass',
    l2: 'danger',
    l2Id: 'rm-rf-root',
    status: 'owner-decision',
    note: '**이 줄기의 본체 — full-stack 사각이었다.** force 플래그가 없으면 L1 의 세 rm 규칙이 전부 비껴간다(`rm -rf with path`·`rm -fr with path` 는 결합 토큰에 force 를 요구하고, `rm recursive+force (any target)` 도 force 를 요구한다). 그래서 종전 L1 approve + L2 safe 로 **어느 층도 보지 않았다**(실측 2026-09-21, executeChain 2열: `rm -r ~user` · `rm --recursive ~user` · `rm -R ~user` 3형). L2 가 danger 로 받아 사각이 닫혔다. L1 pass 가 남아 있으므로 헤더 방향 규칙상 agreed 가 아니다 — 위 `rm --recursive <513자>/x` 행과 **같은 종류의 owner-decision** 이고, 닫는 방법도 같다: L1 을 넓히는 것이 아니라 L2 가 받는 것. L1 규칙은 이 줄기의 소유 밖이다.',
  },
  // ── guard-rm-flag-redos 차집합 (2026-09-22) ───────────────────────────────
  // rm-rf-root 가 **받지 않는** 틸드·$HOME 선두 타깃. 두 경로 규칙이 그것을
  // 통째로 "rm-rf-root 의 일"이라며 제외한 탓에 어느 규칙에도 닿지 않았다.
  {
    command: 'rm -r ~$USER',
    l1: 'pass',
    l2: 'caution',
    l2Id: 'rm-recursive-path',
    status: 'owner-decision',
    note: '**full-stack 사각의 종결.** `~$USER` 는 틸드 뒤가 이름이 아니라 변수라 rm-rf-root 의 이름 클래스에 안 걸리는데, 두 경로 규칙은 `(?![-/~*]|\\$HOME\\b)` 로 틸드 선두를 통째로 넘겼다. force 도 없으니 L1 세 rm 규칙도 전부 비껴간다 — 실측 2026-09-22 L1 approve / L2 **safe**. 위 `rm -r ~user` 행과 같은 종류의 owner-decision 이고 닫는 방법도 같다(L2 가 받는다). 등급이 danger 가 아니라 caution 인 이유: 셸이 `$USER` 를 확장하면 홈의 **형제 디렉터리**가 되지 홈 자체가 아니다.',
  },
  {
    command: 'rm -rf $HOME*',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'owner-decision',
    note: '**glob 형 — 방향 규칙 위반의 해소.** 종전 L1 block / L2 **safe** 였다. rm-rf-root 는 `$HOME` 뒤에 터미네이터를 요구하고 `*` 는 그 집합 밖이며(위 `${HOME}` 행이 말하는 "터미네이터 집합 재사용"의 대가), 두 경로 규칙은 `\\$HOME\\b` 로 제외했다 — `*` 가 비단어 문자라 `\\b` 가 성립한다. 제외를 지우면 rm-rf-path 가 받는다. **터미네이터 집합에 `*` 를 더하지 않은 것은 의도**다: 그러면 `rm -rf ~*` 리터럴이 danger 가 되는데 그것은 홈이 아니라 현재 디렉터리의 `~` 시작 파일들이다. danger 승격은 오너 몫으로 남긴다.',
  },
  {
    command: 'rm -rf ~+',
    l1: 'block',
    l2: 'caution',
    l2Id: 'rm-rf-path',
    status: 'agreed',
    note: '**의도된 정렬.** `~+` 는 $PWD 다 — 홈이 아니라 **현재 디렉터리**이고, 이 카탈로그는 같은 부류 `.`·`./`·`$PWD` 를 언제나 caution 으로 매겨 왔다. 28e37002 이 잠깐 danger 로 올린 것은 틸드 이름 클래스를 `\\w` 선두로 둔 부작용이었다(`~1` 도 같이 걸렸다). 그 커밋 기준으로는 danger→caution 하향이고, 줄기 이전 기준선 b7924207 기준으로는 safe→caution **상승**이다(실측 2026-09-22, 두 커밋의 safety.js 를 각각 임포트해 2열 비교). 방향 규칙 block ⇒ ≥caution 을 충족하므로 agreed.',
  },
  // ── guard-l2-followups ② sql-delete-no-where (2026-09-14) ─────────────────
  {
    command: 'DELETE FROM t WHERE id=1',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '**오탐 해소.** 종전 L1 approve / L2 **danger** 로 방향 규칙 위반이었고(L1 `DELETE FROM without WHERE` 는 `delete\\s+from\\s+\\w+\\s*;?\\s*$` 라 WHERE 절이 붙으면 approve), 위반이 이 한 형이 아니라 **단일행 WHERE 8형 전부**였다(실측 8/8). 원인은 L2 몸통 클래스 `[\\w."` ]+` 의 공백이다 — `t WHERE id` 까지 삼킨 뒤 `=` 에서 멈추면 꼬리 lookahead 가 성립해 버렸다. 클래스에서 공백을 빼는 것이 수리 전부다.',
  },
  {
    command: 'DELETE FROM t;',
    l1: 'block',
    l2: 'danger',
    l2Id: 'sql-delete-no-where',
    status: 'agreed',
    note: '진양성 대조. 위 행과 짝이다 — 오탐을 없애면서 진성 판정을 깎지 않았다는 것을 두 행이 함께 증명한다(한쪽만 있으면 "규칙을 꺼서 그린"과 구별되지 않는다). 무-WHERE 9형 전부 danger 유지를 실측했고 그 목록은 tests/autopilot/safety.test.js 에 있다.',
  },
  {
    command: 'psql -c "DELETE FROM t WHERE id=1"',
    l1: 'pass',
    l2: 'safe',
    l2Id: null,
    status: 'agreed',
    note: '같은 오탐의 래퍼 형. `psql` 은 프린터 허용목록에 없으므로 **전처리가 no-op 이다** — 즉 이 행이 safe 인 것은 전처리 덕이 아니라 규칙 수리 덕이고, 그 구분이 이 행의 존재 이유다. 짝이 되는 `psql -c "DELETE FROM t"`(WHERE 없음)는 계속 danger 다.',
  },
  {
    command: 'DELETE FROM db.t',
    l1: 'pass',
    l2: 'danger',
    l2Id: 'sql-delete-no-where',
    status: 'owner-decision',
    note: '**L1 이 좁은 쪽.** 스키마 한정 이름에서 L1 `DELETE FROM without WHERE` 의 `\\w+` 가 점을 거부해 approve 이고, L2 는 몸통 클래스에 `.` 이 있어 danger 다. 방향 규칙(L1 pass ⇒ L2 safe) 위반이지만 **닫는 방법이 L2 를 낮추는 것이 아니라 L1 을 넓히는 것**이다 — `DELETE FROM db.t` 는 진짜로 WHERE 없는 전체 삭제다. L1 규칙(lib/core/blocked-patterns.js)은 이 줄기의 소유 밖이고 "없는 것을 고치지 않는다" 원칙상 건드리지 않았다. 같은 원인의 미핀 형이 둘 더 있다: `DELETE FROM t RETURNING *` · `DELETE FROM t ORDER BY id LIMIT 1` 도 L1 approve / L2 danger(실측 2026-09-14). 오너가 L1 확대를 결정하면 세 형이 함께 agreed 가 된다.',
  },
]);

describe('L1/L2 parity matrix', () => {
  it.each(PARITY_MATRIX)(
    'pins $command as L1 $l1 / L2 $l2',
    ({ command, l1, l2, l2Id }) => {
      const l1Decision = judge(command).decision;
      if (l1 === 'block') {
        expect(l1Decision).toBe('block');
      } else {
        expect(l1Decision).not.toBe('block');
      }

      const risk = classifyRisk(command);
      expect(risk.level).toBe(l2);
      if (l2Id) {
        expect(risk.matchedId).toBe(l2Id);
      }
    },
  );

  // Self-verification: the table has to be coherent as DATA, without running
  // either layer. A matrix that contradicts its own status labels would make
  // every row above unreadable.
  it('keeps the table itself coherent', () => {
    expect(PARITY_MATRIX.length).toBeGreaterThanOrEqual(11);

    const statuses = new Set(PARITY_MATRIX.map((r) => r.status));
    expect([...statuses].sort()).toEqual(['agreed', 'owner-decision']);

    for (const row of PARITY_MATRIX) {
      if (row.status === 'owner-decision') {
        expect(row.note.length).toBeGreaterThan(0);
      } else if (row.l1 === 'block') {
        // agreed + blocked upstream must not be 'safe' downstream
        expect(row.l2).not.toBe('safe');
      } else {
        expect(row.l2).toBe('safe');
      }
    }
  });

  it('lists every command exactly once', () => {
    const commands = PARITY_MATRIX.map((r) => r.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});
