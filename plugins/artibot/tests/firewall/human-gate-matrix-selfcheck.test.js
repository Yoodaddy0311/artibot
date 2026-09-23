/**
 * Firewall — `lib/security/human-gates.js` 의 `HUMAN_GATE_MATRIX` 자기검증.
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────────────────
 *  A. **13행이 실재한다.** 매트릭스가 비어 있지 않고, id 가 HG-01…HG-13 로 빠짐없이
 *     이어진다. 행 구성 근거는 v5 `11_SAFE_AUTONOMY_HUMAN_GATES.md` 게이트 표 10행 +
 *     vNext `09_SECURITY_GOVERNANCE.md` Action Risk Matrix 의 3행이다(레인 5 §3-C).
 *  B. **모든 행이 판정 가능하다.** 각 행은 `patterns`·`policyRef`·`undetectable`
 *     선언 중 하나 이상을 갖는다. `undetectable` 은 **최대 1행**만 허용한다 —
 *     면제가 번지면 표 자체가 무의미해진다.
 *  C. **어휘 allowlist.** `default`·`enforcement`·`probe` 는 열거값 밖을 거부한다.
 *     이 검사는 `validateMatrix` 한 곳에 있고, 여기서 **일부러 깨뜨린 합성 행**으로
 *     그 거부가 실제로 동작하는지 확인한다(스캐너 자기검증 — 검증 규율 §10).
 *  D. **행마다 양성·음성 예시 1개씩.** 패턴이 실제로 그 행동을 잡고, 이웃 행동을
 *     잡지 않는지 본다. 예시가 빠진 행이 생기면 RED 다(행 추가 시 예시 강제).
 *  E. **중복 정의 0.** `lib/core/blocked-patterns.js` 와 `lib/autopilot/safety.js`
 *     의 정규식 원문과 교집합이 없어야 한다(레인 5 §3-C "중복 정의 금지").
 *     이미 잡는 것은 `existingCoverage[]` 인용으로만 남긴다.
 *  F. **Observe = 기록만.** `classify` 가 돌려주는 것은 `{id, reason}` 뿐이고
 *     `decision`·`block` 같은 필드를 만들지 않는다. 이 파일이 그 모양을 고정한다.
 *  G. **무제한 런 0.** 룩어헤드 밖의 `[^\n]*`·`[^\n]+`·`.*`·`.+` 를 가진 패턴은
 *     명시 등록된 예외뿐이다. 값싼 **구조 핀**이고, 전체 스캐너는
 *     `tests/autopilot/safety.test.js` 쪽에 있다(HUMAN_GATE_MATRIX 를 세 번째
 *     카탈로그로 그리 배선하는 것은 별도 작업 소유).
 *
 * ── 이 게이트가 못 보는 것 (검증 규율 §9 · PRD R-05) ────────────────────────
 *
 *  1. **강제(enforcement).** 이 파일은 표가 **선언하는** 현행 강제 지점 문자열만
 *     본다. `pre-bash.js` 가 실제로 무엇을 막는지는 검사하지 않는다 — 훅 배선은
 *     T-39 소유이고 그 불변성은 `hook-decision-invariance.test.js` 가 본다.
 *     그린이라는 것은 "표가 형태를 지킨다" 이지 "게이트가 작동한다" 가 아니다.
 *     존재 ≠ 등록 ≠ 실행 ≠ 성공(규율 §2).
 *  2. **`enforcement` 값의 진위.** `'hook'`·`'prose'`·`'none'` 은 레인 5 §1-D 의
 *     2026-09-02 실측을 사람이 옮겨 적은 값이다. 코드에서 재측정하지 않는다.
 *     훅이 바뀌면 이 표는 **그린인 채로 낡는다**. 갱신 책임은 훅을 바꾸는 작업에 있다.
 *  3. **`policyRef` 가 가리키는 키의 실재.** 여기서는 `policy:` 접두사 형태만 본다.
 *     `artibot.config.json` 에 그 경로가 실제로 있는지는 `v5-config-firewall.test.js`
 *     계열의 `*Ref` 해석이 하는 일이고, 이 두 키(`ago.selfControl.autoPR.enabled` ·
 *     `autopilot.safety.blockExternalSend`)는 **아직 그 게이트의 사정권 밖**이다.
 *  4. **패턴의 재현율.** D 는 행마다 예시 **1쌍**만 본다. 실제 명령 분포에 대한
 *     오탐·미탐률은 측정하지 않았다 — 미확인이다. 특히 HG-02 의 확장자 패턴은
 *     넓고, HG-04 의 `git branch` 는 파괴 형까지 함께 잡는다(의도된 다중 hit).
 *  5. **중복의 의미론.** E 는 정규식 **원문 문자열**만 대조한다. 원문이 달라도
 *     같은 명령을 잡는 의미상 중복은 잡지 못한다. 반대로 원문이 같아도 다른
 *     의도일 수 있다. 문자열 대조는 필요조건이지 충분조건이 아니다.
 *  6. **HG-10.** 제품·비즈니스 선택은 패턴화 불가로 선언돼 D 에서 면제된다.
 *     그 행이 실제로 사람에게 도달하는지는 이 게이트가 전혀 보지 못한다.
 */

import { describe, expect, it } from 'vitest';
import {
  classify,
  GATE_DEFAULTS,
  GATE_ENFORCEMENTS,
  GATE_PROBES,
  HUMAN_GATE_MATRIX,
  validateMatrix,
} from '../../lib/security/human-gates.js';
import { BLOCKED_PATTERNS } from '../../lib/core/blocked-patterns.js';
import { DANGEROUS_PATTERNS } from '../../lib/autopilot/safety.js';
// 섹션 G 의 스캐너(2026-09-14 통합). 종전 사설 판은 삭제됐고,
// 구현과 HG 예외 목록이 여기 하나로 모였다 — 아래 G 서문 참조.
import {
  ceilingFor,
  findOverlappingStarPairs,
  findUnboundedRuns,
  HG_SCAN_ALLOWLIST,
} from '../helpers/regex-scan.js';

/**
 * 행마다 양성 1건 · 음성 1건. 행이 늘면 여기도 늘어야 한다(D 가 강제).
 * `undetectable` 행은 EXEMPT 로 명시한다 — 조용한 누락과 구분하기 위해서다.
 * @type {Record<string, {positive: object, negative: object} | 'EXEMPT'>}
 */
const EXAMPLES = {
  'HG-01': {
    positive: { tool: 'Bash', command: 'grep -rn needle src/' },
    negative: { tool: 'Bash', command: 'docker push acme/app:1.0' },
  },
  'HG-02': {
    positive: { tool: 'Write', path: 'plugins/artibot/lib/foo/bar.js' },
    negative: { tool: 'Write', path: 'assets/logo.png' },
  },
  'HG-03': {
    positive: { tool: 'Bash', command: 'npx vitest run tests/security' },
    negative: { tool: 'Bash', command: 'git status --porcelain' },
  },
  'HG-04': {
    positive: { tool: 'Bash', command: 'git worktree add ../wt-1 feature/x' },
    negative: { tool: 'Bash', command: 'npm run build' },
  },
  'HG-05': {
    positive: { tool: 'Bash', command: 'git commit -m "feat: add matrix"' },
    negative: { tool: 'Bash', command: 'git log --oneline -1' },
  },
  'HG-06': {
    positive: { tool: 'Bash', command: 'gh pr create --fill' },
    negative: { tool: 'Bash', command: 'gh pr view 12' },
  },
  'HG-07': {
    positive: { tool: 'Bash', command: 'gh pr merge 12 --squash' },
    negative: { tool: 'Bash', command: 'curl https://example.com/health' },
  },
  'HG-08': {
    positive: { tool: 'Bash', command: 'terraform apply -auto-approve' },
    negative: { tool: 'Bash', command: 'terraform plan' },
  },
  'HG-09': {
    positive: { tool: 'Bash', command: 'prisma migrate deploy' },
    negative: { tool: 'Bash', command: 'prisma migrate dev --name init' },
  },
  'HG-10': 'EXEMPT',
  'HG-11': {
    positive: { tool: 'Bash', command: 'cat .env.production' },
    negative: { tool: 'Bash', command: 'cat README.md' },
  },
  'HG-12': {
    positive: { tool: 'Write', path: '.claude/settings.json' },
    negative: { tool: 'Write', path: 'package.json' },
  },
  'HG-13': {
    positive: { tool: 'Write', path: 'plugins/artibot/artibot.config.json' },
    negative: { tool: 'Write', path: 'plugins/artibot/package.json' },
  },
};

describe('human-gate matrix — 구성 (A)', () => {
  it('매트릭스가 비어 있지 않다', () => {
    expect(Array.isArray(HUMAN_GATE_MATRIX)).toBe(true);
    expect(HUMAN_GATE_MATRIX.length).toBeGreaterThan(0);
  });

  it('HG-01…HG-13 13행이 빠짐없이 이어진다', () => {
    const ids = HUMAN_GATE_MATRIX.map((row) => row.id);
    const expected = Array.from({ length: 13 }, (_, i) => `HG-${String(i + 1).padStart(2, '0')}`);
    expect(ids).toEqual(expected);
  });

  it('매트릭스와 각 행이 동결돼 있다', () => {
    expect(Object.isFrozen(HUMAN_GATE_MATRIX)).toBe(true);
    for (const row of HUMAN_GATE_MATRIX) {
      expect(Object.isFrozen(row), `${row.id} must be frozen`).toBe(true);
    }
  });
});

describe('human-gate matrix — 판정 가능성 (B)', () => {
  it('모든 행이 patterns · policyRef · undetectable 중 하나 이상을 갖는다', () => {
    for (const row of HUMAN_GATE_MATRIX) {
      const has = row.patterns.length > 0 || row.policyRef !== null || !!row.undetectable;
      expect(has, `${row.id} carries no patterns, policyRef, or undetectable declaration`).toBe(true);
    }
  });

  it('policy 기본값 행은 policy:<config key> 를 갖는다', () => {
    for (const row of HUMAN_GATE_MATRIX.filter((r) => r.default === 'policy')) {
      expect(row.policyRef, `${row.id}`).toMatch(/^policy:[\w.]+$/);
    }
  });

  // 정본 표(v5 §11)와 실제 default 가 어긋난 자리는 note 로 근거를 남긴다.
  // HG-07 이 그 자리다 — v5 표는 policy, OD-1 이 human 으로 승격했다.
  it('policyRef 를 가진 비-policy 행은 어긋난 근거를 note 로 남긴다', () => {
    const diverged = HUMAN_GATE_MATRIX.filter(
      (row) => row.policyRef !== null && row.default !== 'policy',
    );
    expect(diverged.map((row) => row.id)).toEqual(['HG-07']);
    for (const row of diverged) {
      expect(row.note, `${row.id}`).toMatch(/OD-1/);
    }
  });

  it('undetectable 면제는 최대 1행이다', () => {
    const exempt = HUMAN_GATE_MATRIX.filter((row) => !!row.undetectable);
    expect(exempt.length).toBeLessThanOrEqual(1);
    for (const row of exempt) {
      expect(row.undetectable.reason.trim().length, `${row.id} reason`).toBeGreaterThan(0);
      expect(row.undetectable.evidence.trim().length, `${row.id} evidence`).toBeGreaterThan(0);
      expect(row.patterns.length, `${row.id} must not carry patterns`).toBe(0);
    }
  });

  it('모든 행이 비어 있지 않은 evidence 를 갖는다', () => {
    for (const row of HUMAN_GATE_MATRIX) {
      expect(typeof row.evidence, `${row.id}`).toBe('string');
      expect(row.evidence.trim().length, `${row.id}`).toBeGreaterThan(0);
    }
  });
});

describe('human-gate matrix — 어휘 allowlist (C)', () => {
  it('정본 매트릭스는 validateMatrix 를 위반 0으로 통과한다', () => {
    expect(validateMatrix()).toEqual([]);
  });

  it('default·enforcement·probe 는 열거값 안에 있다', () => {
    for (const row of HUMAN_GATE_MATRIX) {
      expect(GATE_DEFAULTS, `${row.id} default`).toContain(row.default);
      expect(GATE_ENFORCEMENTS, `${row.id} enforcement`).toContain(row.enforcement);
      expect(GATE_PROBES, `${row.id} probe`).toContain(row.probe);
    }
  });

  // 스캐너 자기검증: 게이트가 거짓 그린이 되지 않게, 일부러 깨뜨린 행을 넣어
  // validateMatrix 가 실제로 거부하는지 본다(검증 규율 §10).
  const BROKEN = [
    ['알 수 없는 default', { default: 'maybe' }, /unknown default/],
    ['알 수 없는 enforcement', { enforcement: 'lib' }, /unknown enforcement/],
    ['알 수 없는 probe', { probe: 'payload' }, /unknown probe/],
    ['policy 인데 policyRef 없음', { default: 'policy', policyRef: null }, /requires a policyRef/],
    ['policy 아닌 행이 policyRef 만 있고 note 없음', {
      default: 'human',
      policyRef: 'policy:autopilot.safety.blockExternalSend',
    }, /requires a note explaining the divergence/],
    ['policy: 접두사 없는 policyRef', { policyRef: 'ago.selfControl.autoPR.enabled' }, /policyRef must be null/],
    ['id 형식 위반', { id: 'HG-1' }, /id must match/],
    ['evidence 공백', { evidence: '   ' }, /evidence must be a non-empty string/],
    ['판정 근거 전무', { patterns: [], policyRef: null, undetectable: undefined }, /needs patterns, a policyRef/],
    ['undetectable 인데 patterns 도 있음', {
      patterns: [/x/],
      undetectable: { reason: 'r', evidence: 'e' },
    }, /must not carry patterns/],
  ];

  it.each(BROKEN)('깨뜨린 행을 거부한다 — %s', (_label, override, expectedMessage) => {
    const base = {
      id: 'HG-01',
      action: 'probe row',
      default: 'auto',
      enforcement: 'none',
      policyRef: null,
      probe: 'command',
      tools: ['Bash'],
      patterns: [/^\s*ls\b/i],
      existingCoverage: [],
      evidence: 'synthetic row for scanner self-verification',
    };
    const errors = validateMatrix([{ ...base, ...override }]);
    expect(errors.join(' | ')).toMatch(expectedMessage);
  });

  it('빈 매트릭스를 거부한다', () => {
    expect(validateMatrix([]).join(' | ')).toMatch(/empty/);
  });

  it('중복 id 를 거부한다', () => {
    const row = HUMAN_GATE_MATRIX[0];
    expect(validateMatrix([row, row]).join(' | ')).toMatch(/duplicate id/);
  });
});

describe('human-gate matrix — 행별 양성·음성 예시 (D)', () => {
  it('모든 행에 예시가 선언돼 있다', () => {
    const declared = Object.keys(EXAMPLES).sort();
    const ids = HUMAN_GATE_MATRIX.map((row) => row.id).sort();
    expect(declared).toEqual(ids);
  });

  it('면제 선언은 undetectable 행에만 붙는다', () => {
    for (const [id, example] of Object.entries(EXAMPLES)) {
      if (example !== 'EXEMPT') continue;
      const row = HUMAN_GATE_MATRIX.find((r) => r.id === id);
      expect(row.undetectable, `${id} is EXEMPT without an undetectable declaration`).toBeTruthy();
    }
  });

  const cases = HUMAN_GATE_MATRIX
    .filter((row) => EXAMPLES[row.id] !== 'EXEMPT')
    .map((row) => [row.id]);

  it.each(cases)('%s — 양성 예시를 잡고 음성 예시를 잡지 않는다', (id) => {
    const { positive, negative } = EXAMPLES[id];
    expect(classify(positive).hits.map((h) => h.id), `${id} positive`).toContain(id);
    expect(classify(negative).hits.map((h) => h.id), `${id} negative`).not.toContain(id);
  });
});

describe('human-gate matrix — 중복 정의 0 (E)', () => {
  const existingSources = new Set([
    ...BLOCKED_PATTERNS.map((p) => p.pattern.source),
    ...DANGEROUS_PATTERNS.map((p) => p.test.source),
  ]);

  it('기존 두 파일과 정규식 원문 교집합이 없다', () => {
    const collisions = [];
    for (const row of HUMAN_GATE_MATRIX) {
      for (const pattern of row.patterns) {
        if (existingSources.has(pattern.source)) {
          collisions.push(`${row.id}: ${pattern.source}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('대조 대상 두 목록이 실제로 비어 있지 않다 (스캐너 자기검증)', () => {
    // 대조 대상이 비면 위 검사는 아무것도 증명하지 않은 채 그린이 된다.
    expect(BLOCKED_PATTERNS.length).toBeGreaterThan(0);
    expect(DANGEROUS_PATTERNS.length).toBeGreaterThan(0);
    expect(existingSources.size).toBeGreaterThan(0);
  });

  it('기존 강제 지점이 있는 행은 existingCoverage 로 인용한다', () => {
    for (const row of HUMAN_GATE_MATRIX.filter((r) => r.enforcement === 'hook')) {
      expect(row.existingCoverage.length, `${row.id} claims hook enforcement without a citation`)
        .toBeGreaterThan(0);
    }
  });
});

describe('human-gate matrix — Observe = 기록만 (F)', () => {
  it('classify 는 {id, reason} 만 돌려준다 — decision·block 필드를 만들지 않는다', () => {
    const { hits } = classify({ tool: 'Bash', command: 'terraform apply' });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(Object.keys(hit).sort()).toEqual(['id', 'reason']);
      expect(hit.reason).toBe(`human-gate:${hit.id}`);
    }
  });

  it('반환 봉투는 hits 키 하나뿐이다', () => {
    expect(Object.keys(classify({ tool: 'Bash', command: 'ls' }))).toEqual(['hits']);
  });
});

/**
 * 섹션 G 는 2026-09-14 부터 **사설 스캐너를 두지 않는다.**
 *
 * 종전에는 이 파일의 `unboundedRunsOutsideLookahead`(룩어헤드를 `[^)]*` 로 지운
 * 뒤 네 가지 표기형을 문자열 대조하는 단순판)와 tests/autopilot/safety.test.js 의
 * `findUnboundedRuns`(소스를 이스케이프 인식하며 걷는 구문 스캐너)가 **같은 HG
 * 29패턴을 서로 다른 규칙으로 두 번** 훑었고, HG-11 예외도 두 곳(여기 원문 배열 ·
 * 거기 키 집합)에 있었다. 구현이 둘이면 한쪽만 고쳐지고, 예외가 둘이면 한쪽만
 * 지워진다. 둘 다 `tests/helpers/regex-scan.js` 하나로 합쳤다.
 *
 * **버린 것 — "룩어헤드 안이면 면제" 일반 규칙.** 종전 근거는 "부정 룩어헤드 안의
 * 런은 매치 위치를 늘리지 않고 한 번만 평가된다"였다. 그 일반화는 거짓이고,
 * 반증은 HG-09 patterns[2] 의 **바운드 이전** 모양이다 — 룩어헤드 안에서 2차식
 * 이었다. 규칙 단독 실측(2026-09-14 정찰, node v24.15.0, Windows, 회차마다 다른
 * payload 3회 중앙값, 122,880B): F1(반복 단위마다 WHERE) 179.64ms growth 17.68 ·
 * F3(꼬리에 WHERE 하나) 223.19ms growth 18.39 · F5(다행 SQL) 173.17ms growth
 * 19.93. 절대값은 부하 의존이고 판정(2차식)은 동일하다. 헬퍼에서 그 원문이
 * 조용했던 이유는 면제가 아니라 런의 원자가 **긍정 클래스**여서였다.
 *
 * **그 규칙은 2026-09-15 에 바운드됐다** — 룩어헤드 몸통이 `[^;]{0,192}` 라
 * 부정 클래스 + 바운드 창이고, 헬퍼는 이제 그 창을 **실제로 검사**한다(사각이
 * 아니라 통과다). 반증은 그대로 선다: 면제 일반화는 여전히 거짓이고, 긍정 클래스
 * 사각 자체도 헬퍼 헤더 "못 보는 것" 7(h) 에 남아 있다. 규율 §8 — 일반 면제는
 * 미래 항목에 fail-open 이다.
 * 경계 쌍(186/187)과 성장 게이트는 tests/security/human-gates.test.js 의 HG-09
 * describe 가, 스캐너가 매트릭스를 읽는지는 tests/helpers/regex-scan.test.js 가
 * 각각 핀한다.
 *
 * 옛 스캐너의 자기검증 단언 4건(+ 반대 방향 3건)은 삭제하지 않고
 * `tests/helpers/regex-scan.test.js` 의 describe '옛 섹션 G 의 자기검증' 으로
 * 옮겼다. 여기 남은 것은 **HG 표에 대한 구조 핀**뿐이다: 예외를 뺀 전 패턴이
 * 무제한 런 0 · 예외 목록에 유령 항목 0 · HG-07 은 예외가 아니라 바운드로 통과.
 * 2026-09-23 부터 하나 더: 전 패턴(예외 없이) 1-b 형 0 — 검출기와 그 사각은
 * 헬퍼 헤더 "못 보는 것" 1-b 에 나란히 있다.
 */
describe('human-gate matrix — 무제한 런 0 (G)', () => {
  /** `<행 id>[<패턴 인덱스>]` → 정규식. 예외 키를 실물과 대조하는 데 쓴다. */
  const byKey = new Map(
    HUMAN_GATE_MATRIX.flatMap((row) => row.patterns.map((pattern, i) => [`${row.id}[${i}]`, pattern])),
  );

  it('등록된 예외를 빼면 무제한 런을 가진 패턴이 없다', () => {
    const offenders = [];
    for (const [key, pattern] of byKey) {
      if (HG_SCAN_ALLOWLIST.has(key)) continue;
      const hits = findUnboundedRuns(pattern.source, pattern.flags, ceilingFor('HG', key));
      if (hits.length > 0) {
        offenders.push(`${key}: ${hits.map((h) => h.snippet).join(',')} in ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 1-b 형(같은 클래스 run 쌍이 필수 글자를 낀 모양)은 findUnboundedRuns 가
  // 구조적으로 못 본다 — 검출기는 헬퍼의 findOverlappingStarPairs 다(2026-09-23).
  // HG_SCAN_ALLOWLIST 를 적용하지 않는다: 그 면제 근거("`^` 앵커 → 시작점 하나")는
  // 시작점 수를 줄일 뿐이고, 1-b 는 시작점 하나 안에서 이미 2차식이다.
  it('1-b 같은 클래스 run 쌍이 없다 — 예외 없이 전 패턴', () => {
    const offenders = [];
    for (const [key, pattern] of byKey) {
      const hits = findOverlappingStarPairs(pattern.source, pattern.flags, ceilingFor('HG', key));
      if (hits.length > 0) {
        offenders.push(`${key}: ${hits.map((h) => h.snippet).join(',')} in ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(byKey.size).toBe(29);
  });

  it('예외 목록은 실재하고, 전부 ^ 앵커이며, 유령 항목이 없다', () => {
    for (const key of HG_SCAN_ALLOWLIST) {
      // 매트릭스에서 사라진 예외를 남겨 두면 다음 사람이 그 자리를 재사용한다.
      const pattern = byKey.get(key);
      expect(pattern, `stale exemption: ${key}`).toBeDefined();
      expect(pattern.source.startsWith('^'), `exemption must be anchored: ${key}`).toBe(true);
      expect(pattern.flags, `anchored exemption must not be multiline: ${key}`).not.toContain('m');
      // 면제가 사소하지 않다는 반증 — 면제가 없으면 스캐너가 실제로 잡는다.
      expect(findUnboundedRuns(pattern.source, pattern.flags, ceilingFor('HG', key)).length)
        .toBeGreaterThan(0);
    }
  });

  it('HG-07 의 두 규칙은 예외가 아니라 바운드로 통과한다', () => {
    for (const key of ['HG-07[0]', 'HG-07[2]']) {
      const pattern = byKey.get(key);
      expect(pattern, `missing pattern: ${key}`).toBeDefined();
      expect(HG_SCAN_ALLOWLIST.has(key)).toBe(false);
      expect(pattern.source).toContain('[^\\n]{0,192}');
    }
  });

  it('예외는 HG-11 두 건뿐이다 — 등록처는 헬퍼 하나다', () => {
    expect([...HG_SCAN_ALLOWLIST].sort()).toEqual(['HG-11[0]', 'HG-11[1]']);
    // 분모 고정. 위 it.each 아닌 루프들이 "0개를 돌고 통과"하지 않도록.
    expect(byKey.size).toBe(29);
    expect(HUMAN_GATE_MATRIX).toHaveLength(13);
  });
});
