/**
 * 검사 목적: `sync-readmes` 잡의 **스텝 순서 계약** 고정.
 *
 * `badge-stall-issue-lifecycle.test.js` 에서 2026-09-11 에 분할됐다(순수 이동 —
 * 테스트 이름과 단언 줄은 한 바이트도 안 바뀌었다). 순서가 틀어지면 그 파일이 고정하는
 * escalation 이슈가 열리기 때문에 한 파일에 같이 있었다. 그 인과와 실측 로그,
 * 그리고 **이 블록이 못 보는 것**(rules §9)은 아래 블록 주석에 그대로 있다.
 *
 * 공유 로더·절단기는 `badge-stall-yaml-tools.js`(테스트 아님).
 *
 * @module tests/firewall/badge-stall-sync-order
 */
import { describe, expect, it } from 'vitest';
import { executableShell, sliceStep, source } from './badge-stall-yaml-tools.js';

// ── sync-readmes 자가치유 스텝 순서 계약 ──────────────────────────────────────
//
// 이 블록이 여기 있는 이유: 순서가 틀리면 **이 파일이 다루는 escalation 이슈가
// 열린다**. v4.58.0(#117)·v4.59.0(#118) 두 릴리스 연속으로 배지 ff 가 실패하고
// stall 이슈가 열렸는데, 원인은 자격증명도 API 도 아니라 `sync-readmes` 잡의
// **스텝 순서**였다.
//
// 데이터 흐름(실측 2026-09-11):
//   `Count test cases` → vitest numTotalTests → `tests=` output
//   `Sync marketplace.json metadata` → `--tests=N` → marketplace.json#/qualityMetrics/tests
//     (scripts/ci/sync-marketplace-meta.mjs#resolveTestCount:85-93)
//   `Sync README count prose` → readme-claims-registry.js#collectActuals:229 가
//     **그 qualityMetrics.tests 를 읽어서** 산문 4곳에 쓴다.
// 즉 산문 동기화는 사슬의 **마지막 소비자**다. 그보다 앞서 돌면 옛 값으로
// "already in sync" 를 찍고, 뒤이어 marketplace 만 새 값이 되어 `ci/sync-badges-*`
// 브랜치의 validate-readme-claims --full 이 드리프트 4건으로 RED → 배지 ff 실패 →
// 이 파일이 고정하는 stall 이슈가 열린다.
// v4.59.0 런 로그 실측: prose "already in sync"(01:59:15Z) → tests 15684(02:00:36Z)
// → marketplace "rewrote 15200->15684".
//
// ── 이 블록이 못 보는 것 (rules §9) ──────────────────────────────────────────
//   - **정적 순서만 본다.** 스텝이 실제로 실행됐는지, `Count test cases` 가
//     continue-on-error 로 죽고 `tests=` 가 비었을 때 산문이 종전 값을 유지하는지는
//     여기서 증명하지 못한다(그 경로는 로컬 재현으로만 확인했다).
//   - **다음 릴리스 런이 유일한 실측이다**: v4.60.0 의 sync-readmes 로그에서 산문
//     동기화 출력이 marketplace 출력 **뒤**에 오고 `ci/sync-badges-v4.60.0` CI 가
//     초록인 것. 이 그린 테스트를 라이브 증거로 쓰지 마라.
//   - `git diff` 변경 감지 파일 목록에 산문 4곳이 들어 있는지는 보지 않는다(별건).
const COUNT_STEP = 'Count test cases';
const MARKETPLACE_STEP = 'Sync marketplace.json metadata';
const PROSE_STEP = 'Sync README count prose';
const STRATEGY_STEP = 'Decide landing strategy';
const ORDERED_SYNC_STEPS = [COUNT_STEP, MARKETPLACE_STEP, PROSE_STEP, STRATEGY_STEP];

/**
 * `- name: <step>` 줄의 줄 인덱스. 없으면 -1.
 *
 * sliceStep 과 같은 정확 일치 규칙을 쓴다 — 스텝 이름을 바꾸면 여기도 -1 이 되어
 * fail-closed 다.
 *
 * @param {string} yaml 워크플로 전체 텍스트
 * @param {string} stepName 찾을 스텝 이름
 * @returns {number} 줄 인덱스
 */
function stepLineIndex(yaml, stepName) {
  return yaml.split(/\r?\n/).findIndex((l) => l.trim() === `- name: ${stepName}`);
}

/**
 * 네 스텝이 ORDERED_SYNC_STEPS 순서대로 등장하는가 (전부 존재 + 단조 증가).
 *
 * 판정을 함수로 뽑은 이유는 아래 자기검증이 **같은 판정기**를 순서가 뒤집힌
 * 사본에 먹여 RED 가 나오는 것을 보여야 하기 때문이다. 단언문을 눈으로 뒤집는
 * 것은 증거가 아니다.
 *
 * @param {string} yaml 워크플로 전체 텍스트
 * @returns {boolean}
 */
function syncOrderHolds(yaml) {
  const idx = ORDERED_SYNC_STEPS.map((name) => stepLineIndex(yaml, name));
  if (idx.some((i) => i === -1)) return false;
  return idx.every((v, i) => i === 0 || idx[i - 1] < v);
}

/**
 * 스텝 블록을 통째로 들어 다른 스텝 **앞**으로 옮긴 사본을 만든다(실파일 무변경).
 *
 * 자기검증 전용. 회귀를 실제로 재현해야 판정기가 일하는지 알 수 있다.
 *
 * @param {string} yaml 워크플로 전체 텍스트
 * @param {string} stepName 옮길 스텝
 * @param {string} anchorName 이 스텝 앞에 놓는다
 * @returns {string} 편집된 사본
 */
function moveStepBefore(yaml, stepName, anchorName) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (start === -1) return yaml;
  const offset = lines.slice(start + 1).findIndex((l) => /^\s*- name: /.test(l));
  const end = offset === -1 ? lines.length : start + 1 + offset;
  const block = lines.slice(start, end);
  const without = [...lines.slice(0, start), ...lines.slice(end)];
  const anchor = without.findIndex((l) => l.trim() === `- name: ${anchorName}`);
  if (anchor === -1) return yaml;
  return [...without.slice(0, anchor), ...block, ...without.slice(anchor)].join('\n');
}

describe('sync-readmes 산문 동기화 순서 계약', () => {
  it('네 스텝 이름이 파일에 정확히 1회씩만 등장한다 (절단기 전제)', () => {
    // 2개면 sliceStep 이 첫 번째만 자른다 — "추가" 가 아니라 "이동" 이어야 하는 이유.
    for (const name of ORDERED_SYNC_STEPS) {
      const hits = source.split(/\r?\n/).filter((l) => l.trim() === `- name: ${name}`).length;
      expect(hits, `"${name}" 이 ${hits} 회 등장한다`).toBe(1);
    }
  });

  it('산문 동기화가 marketplace 동기화 뒤, 랜딩 판정 앞에 온다', () => {
    const marketplaceIdx = stepLineIndex(source, MARKETPLACE_STEP);
    const proseIdx = stepLineIndex(source, PROSE_STEP);
    const strategyIdx = stepLineIndex(source, STRATEGY_STEP);
    expect(marketplaceIdx).toBeGreaterThan(-1);
    expect(proseIdx).toBeGreaterThan(-1);
    expect(strategyIdx).toBeGreaterThan(-1);
    // 산문은 qualityMetrics.tests 의 소비자다 → 그 값이 갱신된 뒤에 돌아야 한다.
    expect(proseIdx).toBeGreaterThan(marketplaceIdx);
    // 그리고 `git diff` 로 변경 여부를 판정하기 전에 끝나야 착지 대상에 포함된다.
    expect(proseIdx).toBeLessThan(strategyIdx);
  });

  it('테스트 수 집계가 marketplace 동기화보다 앞에 온다', () => {
    expect(stepLineIndex(source, COUNT_STEP)).toBeLessThan(
      stepLineIndex(source, MARKETPLACE_STEP)
    );
  });

  it('산문 동기화 스텝의 실행 셸이 sync-readme-claims.js 를 호출한다', () => {
    const body = sliceStep(source, PROSE_STEP);
    expect(body, `"${PROSE_STEP}" 스텝을 찾지 못했다`).not.toBeNull();
    // 주석을 걷어낸 실행 셸에서만 찾는다 — 산문이 단언을 채우는 거짓 그린 차단.
    expect(executableShell(body)).toContain(
      'node plugins/artibot/scripts/ci/sync-readme-claims.js'
    );
  });

  it('네 스텝 전체 순서가 성립한다', () => {
    expect(syncOrderHolds(source)).toBe(true);
  });

  describe('스캐너 자기검증', () => {
    it('순서를 뒤집은 사본에서 판정기가 RED 를 낸다 (거짓 그린 차단)', () => {
      // 회귀 재현: 산문 동기화를 집계 스텝 앞으로 되돌린다 = 수정 전 상태.
      const regressed = moveStepBefore(source, PROSE_STEP, COUNT_STEP);
      expect(regressed).not.toBe(source); // 변이기가 실제로 일했다
      // 스텝은 네 개 다 그대로 있다 → RED 의 원인이 "스텝 실종" 이 아니라 순서다.
      for (const name of ORDERED_SYNC_STEPS) {
        expect(
          regressed.split(/\r?\n/).filter((l) => l.trim() === `- name: ${name}`).length
        ).toBe(1);
      }
      expect(stepLineIndex(regressed, PROSE_STEP)).toBeLessThan(
        stepLineIndex(regressed, MARKETPLACE_STEP)
      );
      expect(syncOrderHolds(regressed)).toBe(false);
    });

    it('스텝이 사라지면 판정기가 통과시키지 않는다 (fail-closed)', () => {
      const removed = source
        .split(/\r?\n/)
        .filter((l) => l.trim() !== `- name: ${PROSE_STEP}`)
        .join('\n');
      expect(stepLineIndex(removed, PROSE_STEP)).toBe(-1);
      expect(syncOrderHolds(removed)).toBe(false);
    });

    it('이동기가 스텝 본문을 통째로 옮긴다 (본문 유실 아님)', () => {
      const regressed = moveStepBefore(source, PROSE_STEP, COUNT_STEP);
      expect(executableShell(sliceStep(regressed, PROSE_STEP))).toContain(
        'node plugins/artibot/scripts/ci/sync-readme-claims.js'
      );
      // 줄 수 보존: 이동은 삽입/삭제가 아니다.
      expect(regressed.split(/\r?\n/).length).toBe(source.split(/\r?\n/).length);
    });
  });
});
