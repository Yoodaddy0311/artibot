/**
 * 후속 12 안 B — 세션 없는 recorder-stats 는 파일에 쓰지 않는다 (2026-09-04).
 *
 * 배경(실측): 부모 리포의 실 스토어 `.artibot/runtime/decisions/` 에
 * `_unattributed.events.ndjson` 이 있었다(2026-09-04 11:5x, 파일 3개 중 1개). 세션 id 가
 * 없는 프롬프트(테스트·수동 실행)가 flush 때마다 그 파일에 한 줄씩 남긴 것이다 — 세션이
 * 없다는 사실을 "파일이 살아 있다" 로 읽히게 만드는 노이즈다. 안 B: 세션이 없으면
 * `record()` 를 부르지 않고 stderr 1줄로만 알린다.
 *
 * 케이스:
 *   1. 세션 없는 flush → 반환 null · storeDir 파일 0개 · stderr 정확히 1회(카운트만, 값·경로 없음)
 *   2. 세션 있는 flush → 변경 전(7cbb37b9) 코드가 같은 입력으로 쓴 ndjson 줄과 **바이트 동일**
 *   3. (기존 파일 유지) getDecisionRecorderStats / resetDecisionRecorderStats 계약 —
 *      `decision-events-t37.test.js` 가 GREEN 인 것으로 증명, 여기서는 반복하지 않는다.
 *
 * 못 보는 것: 훅 프로세스에서의 실제 발화는 `tests/hooks/runtime-prompt-decision-wiring.test.js`.
 * 여기는 모듈 함수 직접 호출뿐이다. stderr 줄의 "1프로세스 1줄" 규칙은 이 함수가 프로세스당
 * 한 번 불린다는 훅 쪽 약속에 기대며, 여기서는 호출 1회당 1줄만 본다.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushRecorderStats,
  getDecisionRecorderStats,
  RECORDER_STATS,
  recordMemoryInjection,
  resetDecisionRecorderStats,
  UNATTRIBUTED_RUN_ID,
} from '../../lib/observability/decision-events.js';

/**
 * 변경 전 코드(master @ 7cbb37b9, 2026-09-04 12:13 KST)가 같은 입력으로 쓴 줄. 생성 명령:
 *
 *   resetDecisionRecorderStats();
 *   recordMemoryInjection(null, { injected: false }, { storeDir });   // ×2 → skipped 2
 *   flushRecorderStats('sess-fixture-attributed', { storeDir, ts: '2026-09-04T03:00:00.000Z' });
 *   readFileSync(path.join(storeDir, 'sess-fixture-attributed.events.ndjson'), 'utf-8');
 *
 * (스크래치 `gen-fixture.mjs` 로 실행, 출력 `RAW_LINE_JSON` 을 그대로 동결.) 갱신 금지 — 이
 * 줄이 달라지면 세션 있는 경로의 바이트가 바뀐 것이고, 그것이 이 테스트가 잡는 회귀다.
 */
const FROZEN_ATTRIBUTED_LINE = '{"ts":"2026-09-04T03:00:00.000Z","sessionId":"sess-fixture-attributed",'
  + '"phase":"END","type":"recorder-stats","level":"info","message":"recorder stats — 2 skipped, 0 failed",'
  + '"data":{"skipped":2,"failed":0,"lastError":null,"runId":"sess-fixture-attributed"}}\n';

const ATTRIBUTED_RUN_ID = 'sess-fixture-attributed';
const FIXED_TS = '2026-09-04T03:00:00.000Z';

let storeDir = '';
let stderrSpy;

beforeEach(() => {
  storeDir = mkdtempSync(path.join(tmpdir(), 'artibot-recorder-stats-'));
  resetDecisionRecorderStats();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  resetDecisionRecorderStats();
});

/** 세션 없는 record 호출 2회 → skipped 2, failed 0. */
function twoUnattributedCalls() {
  recordMemoryInjection(null, { injected: false }, { storeDir });
  recordMemoryInjection(null, { injected: false }, { storeDir });
  expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, skipped: 2, failed: 0 });
}

describe('flushRecorderStats — 세션 없음 (안 B)', () => {
  it('파일을 쓰지 않고 null 을 돌려주며 stderr 1줄로만 알린다', () => {
    twoUnattributedCalls();

    const result = flushRecorderStats(null, { storeDir });

    expect(result).toBeNull();
    expect(readdirSync(storeDir)).toEqual([]);
    expect(existsSync(path.join(storeDir, `${UNATTRIBUTED_RUN_ID}.events.ndjson`))).toBe(false);
    // 쓰지 않았으니 recorded 도 그대로 — 스스로를 세지 않는다.
    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, skipped: 2, failed: 0 });

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = String(stderrSpy.mock.calls[0][0]);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(line).toContain('[artibot:decision-events]');
    expect(line).toContain('2 skipped');
    expect(line).toContain('0 failed');
    expect(line).toContain(RECORDER_STATS.replace('-', ' '));
    // 값·프롬프트·경로는 싣지 않는다.
    expect(line).not.toContain(storeDir);
    expect(line).not.toContain('injected');
    expect(line).not.toContain(UNATTRIBUTED_RUN_ID);
  });

  it('undefined · 빈 문자열 세션도 같은 취급이고, failed 카운트도 줄에 실린다', () => {
    recordMemoryInjection(null, { injected: false }, { storeDir });
    // 깨진 storeDir 로 failed 1.
    recordMemoryInjection('sess-x', { injected: false }, { storeDir: path.join(storeDir, 'nested\0invalid') });
    expect(getDecisionRecorderStats()).toMatchObject({ skipped: 1, failed: 1 });

    expect(flushRecorderStats(undefined, { storeDir })).toBeNull();
    expect(flushRecorderStats('', { storeDir })).toBeNull();

    expect(readdirSync(storeDir)).toEqual([]);
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    for (const [chunk] of stderrSpy.mock.calls) {
      expect(String(chunk)).toContain('1 skipped, 1 failed');
      expect(String(chunk)).not.toContain('invalid');
    }
  });

  it('카운터가 깨끗하면 stderr 도 침묵한다', () => {
    expect(flushRecorderStats(null, { storeDir })).toBeNull();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(readdirSync(storeDir)).toEqual([]);
  });
});

describe('flushRecorderStats — 세션 있음 (바이트 동일 회귀)', () => {
  it('변경 전 코드가 쓴 줄과 바이트가 같다', () => {
    twoUnattributedCalls();

    const persisted = flushRecorderStats(ATTRIBUTED_RUN_ID, { storeDir, ts: FIXED_TS });

    expect(persisted).not.toBeNull();
    expect(readdirSync(storeDir)).toEqual([`${ATTRIBUTED_RUN_ID}.events.ndjson`]);
    const raw = readFileSync(path.join(storeDir, `${ATTRIBUTED_RUN_ID}.events.ndjson`), 'utf-8');
    expect(raw).toBe(FROZEN_ATTRIBUTED_LINE);
    // 세션이 있으면 stderr 는 쓰지 않는다 — 파일이 곧 가시성이다.
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(getDecisionRecorderStats().recorded).toBe(1);
  });
});
