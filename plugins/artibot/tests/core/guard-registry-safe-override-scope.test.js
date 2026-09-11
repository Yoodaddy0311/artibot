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
 * Expected values are the TARGET state after two sibling changes land:
 *   - L1 gains a pathless recursive-delete rule (`rm -rf build`).
 *   - L2 gains git-checkout-discard / git-restore-discard / git-stash-drop
 *     (danger) and rm-rf-path (caution).
 * Until then some rows are RED by design — that is the TDD red phase, not a
 * broken suite.
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
    l1: 'block',
    l2: 'danger',
    l2Id: 'git-checkout-discard',
    status: 'owner-decision',
    note: '오탐 ① — 현재 값을 핀할 뿐 목표 값이 아니다. 명령을 **언급만** 해도 두 층 모두 차단한다(2026-09-11 실측 L1 block / L2 danger). 원인 둘이 겹친다: (1) 두 discard 규칙이 `\\s*$` 앵커를 버려 줄 안 어디서든 매치하고, (2) normalizeCommand 가 따옴표를 먼저 벗기므로 인용이 보호가 되지 않는다. 오너 결정 ②가 정리한 `grep -i "truncate"` 차단과 **같은 실패 양식**이다. 후보 설계 둘: 두 층에 명령 시작 앵커 `(?:^|[;&|]\\s*)` 를 달거나, 따옴표 구간을 매칭에서 제외하거나. 어느 쪽이든 한 층만 고치면 파리티가 깨지므로 동시 변경이어야 한다. Wave 7 `guard-command-position` 으로 큐에 올라가 있다. L1 을 느슨하게 해서 맞추지 말 것 — 이 행이 그 유혹을 막는다.',
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
    note: '오너 결정 2026-09-11 확정: L2 danger → caution. L1 정본은 lease 허용(blocked-patterns.js:64-77 rationale·safeOverrides). 여전히 agreed 가 아니다 — 헤더 방향 규칙상 L1 pass 는 L2 safe 를 요구하는데, lease 도 원격 히스토리를 다시 쓰므로 safe 로 내리지 않는다. 이 행은 그 잔여 불일치를 핀한다.',
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
