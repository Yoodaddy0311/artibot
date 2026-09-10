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
 * The exemption is therefore attached to the two `git push` rules that need it
 * (`lib/core/blocked-patterns.js`) rather than living as a global list. Category
 * alone would not have been enough: `--force-with-lease` is equally meaningless
 * to `git reset --hard`, which is also in the `git` category.
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
    l2: 'danger',
    l2Id: 'git-force-push',
    status: 'owner-decision',
    note: 'L1 정본은 lease 허용(blocked-patterns.js:12-19 rationale·:54 lookahead). L2 를 caution 으로 내리는 것은 완화 → 오너 결정. 권고: L2 caution',
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
    command: 'TRUNCATE users;',
    l1: 'pass',
    l2: 'danger',
    l2Id: 'sql-truncate',
    status: 'owner-decision',
    note: 'L1 은 TRUNCATE TABLE/DATABASE 형만 차단(label "TRUNCATE TABLE"·"SQL destructive operation"). bare 형 L1 차단 근거 없음(2026-09-11 00:2x KST 조사: 리포 추적 파일·Artibot 트랜스크립트 Bash 10,293건에 SQL TRUNCATE 문 0건, L2 sql-truncate 발화 10건 전부 grep 인자·인용) → 현재값 핀. 대안은 오너 결정: L1 강화 또는 L2 오탐 완화(문 형태 요구).',
  },
  {
    command: 'dd if=/dev/zero of=/dev/sda',
    l1: 'block',
    l2: 'safe',
    l2Id: null,
    status: 'owner-decision',
    note: 'L2 강화 후보(dd 규칙 없음). 이번 줄기 범위 밖, 현재값 핀',
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
