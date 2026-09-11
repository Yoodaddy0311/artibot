/**
 * 이 파일은 `badge-stall-yaml-tools.js` 의 **헬퍼 계약 핀**이다 — release.yml 에
 * 무엇이 있어야 하는가를 판정하는 **실제 게이트는 `badge-stall-*.test.js` 3파일**
 * (issue-lifecycle · sync-order · landing-lockstep)이고, 여기는 그 셋이 공유하는
 * 로더·절단기의 시그니처와 반환 계약만 고정한다.
 *
 * ── 못 보는 것 (rules §9) ────────────────────────────────────────────────────
 *   그 3파일과 동일하다(정적 문자열 스캔 — 스텝이 실행되는지·성공하는지는 안 본다).
 *
 * @module tests/firewall/badge-stall-yaml-tools.test
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executableShell, REPO_ROOT, sliceStep, source } from './badge-stall-yaml-tools.js';

/** 3파일이 모두 자르는 실존 스텝. 이름이 바뀌면 여기도 같이 RED 다. */
const REAL_STEP = 'Close resolved badge-sync escalation issues';

describe('badge-stall-yaml-tools 헬퍼 계약', () => {
  it('export 4종이 존재하고 타입이 맞다', () => {
    expect(typeof REPO_ROOT).toBe('string');
    expect(typeof source).toBe('string');
    expect(typeof sliceStep).toBe('function');
    expect(typeof executableShell).toBe('function');
  });

  it('source 가 REPO_ROOT 아래 release.yml 과 바이트 동일하다 (로더 정본 1개)', () => {
    // 경로가 어긋나면 빈 문자열을 스캔하고도 "리터럴 0건"으로 green 이 된다.
    // 이 단언이 고정하는 것은 **어떤 바이트를 들고 있는가**와 그 파일의 실재다.
    // `readFileSync` 가 프로세스당 정확히 1회 돌았다는 것은 여기서 증명하지 않는다
    // (그건 ESM 모듈 캐시의 성질이지 이 단언의 내용이 아니다).
    const ymlPath = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
    expect(source).toBe(readFileSync(ymlPath, 'utf-8'));
    expect(source.length).toBeGreaterThan(1000);
  });

  it('sliceStep 이 실존 스텝에 비지 않은 본문을, 없는 스텝에 null 을 준다', () => {
    const body = sliceStep(source, REAL_STEP);
    expect(typeof body).toBe('string');
    expect(body.trim().length).toBeGreaterThan(0);
    // 계약은 throw 가 아니라 null 이다 — 호출부가 `?? ''` 로 받는 전제가 이것이다.
    expect(sliceStep(source, 'No Such Step Name Anywhere')).toBeNull();
  });

  it('executableShell 이 주석 줄을 벗겨내고 줄 연속을 잇는다', () => {
    const body = [
      '            # gh pr list --state merged 라고 말하는 주석',
      '            gh pr list --state closed \\',
      '              --limit 1',
    ].join('\n');
    const shell = executableShell(body);
    expect(shell).not.toContain('--state merged');
    // 공백 **2개**가 맞다: `closed ` 뒤의 원래 공백이 남고, `\`+개행+들여쓰기가
    // 공백 1개로 치환된다. 실측으로 고친 값이다 — 처음엔 1개로 썼다가 RED 였다.
    // 실제 게이트가 이걸 견디는 근거: `ghPrListStates` 의 `/--state[= ]+(\S+)/`.
    expect(shell).toBe('            gh pr list --state closed  --limit 1');
  });
});
