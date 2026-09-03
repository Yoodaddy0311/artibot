/**
 * Firewall — 헌법 단계 A 중 rules 소유분(A-4·A-8)이 리포 정본에 남아 있는지.
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────────
 *  A-4  `rules/dev-protocol.md` Step 1 DECOMPOSE 에 "상류 원인·하류 회귀 후보"
 *       한 줄(D03 — 요청된 대상과 인과적 상류·시스템적 기여자를 함께 본다).
 *  A-8  `rules/verification-discipline.md` **말미**의 "§13 충돌 기록 우선순위" —
 *       v1.1 `02_CANONICAL_PROJECT_STATE.md` "State precedence" 8단을 인용하되,
 *       `state` 가 **마지막 실측값의 캐시**라 실측을 대체하지 못한다는 각주 포함.
 *
 *  그리고 **추가만 했다는 것**을 지킨다. 두 파일 모두 기존 조항을 삭제·완화하지
 *  않았어야 하므로, 기존 헤딩(§0~§12 · Step 1~3 · Zero-Skip)이 전부 살아 있는지를
 *  같이 단언한다. 새 절이 생겼다는 사실만으로는 무손실을 주장할 수 없다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 못 보는 것을 적어라) ─────
 *
 *  1. **런타임 반영.** 이 스캔은 **리포 정본 파일**만 읽는다. 실제로 세션에 로드되는
 *     규칙은 `~/.claude/rules/artibot/` 이고, `install.sh#install_rules` 는 사용자
 *     편집을 덮어쓰지 않고 `.artibot-new` 로 떨군다. 즉 이 테스트가 그린이어도
 *     **"실행 중 세션의 규칙이 바뀌었다" 는 여전히 미확인**이다(설계 §0 E-02 / R-07).
 *     그린이 주장할 수 있는 범위는 "리포 정본에 문장이 있다" 까지다.
 *  2. **문장이 지켜지는지.** 규칙 본문의 존재는 준수의 증거가 아니다. Step 1 에 줄이
 *     있다고 해서 분해 때 상하류를 실제로 적었는지는 이 스캔 밖이다 — 존재 ≠ 작동(§2).
 *  3. **헤딩 밖 본문의 삭제.** 무손실 검사는 **헤딩 문자열**과 몇몇 앵커 문장만 본다.
 *     어떤 절의 헤딩을 남긴 채 그 아래 규칙 문장을 지우면 통과한다. 문단 단위 완전성을
 *     보려면 해시 고정이 필요한데, 그러면 정당한 문구 다듬기마다 RED 가 되어
 *     게이트를 깎게 된다(§10) — 의도적으로 헤딩·앵커 수준에서 멈춘 것이다.
 *  4. **다른 철자.** A-4 줄은 "상류 원인"·"하류 회귀" 두 어구로 찾는다. 같은 뜻을
 *     다른 말로 바꿔 쓰면 RED 가 된다(거짓 양성) — 반대로 어구만 남기고 뜻을 비틀면
 *     통과한다(거짓 음성). 리터럴 스캔의 한계이지 우회 방지 장치가 아니다.
 *  5. **설치본 드리프트.** 리포 정본과 `~/.claude/rules/artibot/` 사본이 어긋나 있어도
 *     이 게이트는 조용하다. 사본 대조 게이트는 현재 **없음**(미확인).
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'rules',
);

const DEV_PROTOCOL = path.join(RULES_DIR, 'dev-protocol.md');
const VERIFICATION = path.join(RULES_DIR, 'verification-discipline.md');

/** 헤딩 문자열만 뽑는다 — 본문 문구 다듬기에는 반응하지 않게. */
function headings(source) {
  return source.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s/.test(line));
}

function read(file) {
  return fsSync.readFileSync(file, 'utf-8');
}

/** `## 0.` ~ `## 12.` — 기존 검증 규율 12절 + 최상위 원칙. */
const LEGACY_SECTIONS = Array.from({ length: 13 }, (_, n) => n);

describe('constitution stage A — rules 소유분(A-4·A-8)', () => {
  it('스캔 대상 두 파일이 실재하고 비어 있지 않다 (self-check)', () => {
    // 파일이 사라지면 아래 단언이 전부 "찾지 못함" 으로 RED 가 되지만,
    // 스캐너가 빈 문자열을 읽고 조용히 통과하는 경로를 먼저 닫는다.
    for (const file of [DEV_PROTOCOL, VERIFICATION]) {
      expect(fsSync.existsSync(file), `missing: ${file}`).toBe(true);
      expect(read(file).length).toBeGreaterThan(500);
    }
  });

  it('헤딩 추출기가 실제로 헤딩을 집는다 (self-check)', () => {
    // 추출기가 항상 빈 배열을 돌려주면 무손실 검사가 영원히 통과한다.
    const sample = headings('# A\n본문\n## B\n### C\n텍스트 ## 아님');
    expect(sample).toEqual(['# A', '## B', '### C']);
  });

  describe('A-4 — dev-protocol.md Step 1 상하류 한 줄', () => {
    it('Step 1 DECOMPOSE 절 안에 상류·하류 항목 지시가 있다', () => {
      const source = read(DEV_PROTOCOL);
      const step1 = source.split('## Step 2')[0];
      expect(step1).toContain('## Step 1: DECOMPOSE');
      expect(step1).toContain('상류 원인');
      expect(step1).toContain('하류 회귀');
      // "없으면 '없음'" — null-result 를 정당한 결과로 못박은 부분.
      expect(step1).toMatch(/없으면\s*["'"'"]?없음/);
    });

    it('기존 3단계 + Zero-Skip 조항이 그대로 남아 있다 (삭제 0)', () => {
      const source = read(DEV_PROTOCOL);
      for (const heading of [
        '# Artibot DEV Protocol (Decompose-Execute-Verify)',
        '## Step 1: DECOMPOSE',
        '## Step 2: EXECUTE',
        '## Step 3: VERIFY',
        '## Zero-Skip Policy',
      ]) {
        expect(headings(source), `lost heading: ${heading}`).toContain(heading);
      }
      expect(source).toContain('READ the target file first');
      expect(source).toContain('NEVER claim ✅ without re-reading the modified file');
    });
  });

  describe('A-8 — verification-discipline.md §13 충돌 기록 우선순위', () => {
    it('§13 절이 존재하고 파일 말미에 있다', () => {
      const source = read(VERIFICATION);
      const all = headings(source);
      expect(all).toContain('## 13. 충돌 기록 우선순위');
      // 말미 — §13 이 마지막 헤딩이어야 한다. 뒤에 다른 절이 붙으면
      // "말미에 추가" 라는 배치 요구가 깨진 것이다.
      expect(all[all.length - 1]).toBe('## 13. 충돌 기록 우선순위');
    });

    it('v1.1 State precedence 8단을 순서대로 인용한다', () => {
      const section = read(VERIFICATION).split('## 13. 충돌 기록 우선순위')[1];
      expect(section).toBeDefined();
      const chain = [
        '현재 검증된 리포·환경 상태',
        'state.yaml',
        'intent.md',
        'plan.md',
        'ADR',
        '과거 outcome',
        'memory',
        '오래된 런타임 로그',
      ];
      let cursor = -1;
      for (const step of chain) {
        const at = section.indexOf(step, cursor + 1);
        expect(at, `out of order or missing: ${step}`).toBeGreaterThan(cursor);
        cursor = at;
      }
      // 출처 표기 — 어디서 온 서열인지 지우지 마라.
      expect(section).toContain('02_CANONICAL_PROJECT_STATE.md');
    });

    it('state 가 캐시라 실측을 대체하지 못한다는 각주가 있다', () => {
      const section = read(VERIFICATION).split('## 13. 충돌 기록 우선순위')[1];
      expect(section).toContain('마지막 실측값의 캐시');
      expect(section).toContain('실측을 대체한다는 뜻이 아니다');
    });

    it('기존 §0~§12 헤딩이 전부 살아 있다 (삭제·완화 0)', () => {
      const all = headings(read(VERIFICATION));
      for (const n of LEGACY_SECTIONS) {
        const found = all.some((h) => h.startsWith(`## ${n}. `));
        expect(found, `lost section heading: ## ${n}.`).toBe(true);
      }
      expect(all).toContain('# 검증 규율 (always-on)');
    });

    it('기존 조항의 앵커 문장이 완화되지 않았다', () => {
      const source = read(VERIFICATION);
      for (const anchor of [
        '확인할 수 있는 것을 확인하지 않은 채 사실로 말하지 않는다',
        '수렴은 검증이 아니다',
        'git add -A',
        '금지 목록이 아니라 허용 목록(allowlist)으로 지시하라',
        '게이트를 통과시키려 게이트를 깎지 않는다',
      ]) {
        expect(source, `weakened or removed: ${anchor}`).toContain(anchor);
      }
    });
  });
});
