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
 * 무제한 런의 표기형. 라벨은 사람이 읽는 이름이고, 정규식이 판정한다.
 * `.` 앞의 역슬래시를 배제해 `\.` + 별도 수량자 같은 자리를 거짓 양성으로 잡지 않는다.
 * @type {ReadonlyArray<[string, RegExp]>}
 */
const UNBOUNDED_RUN_FORMS = Object.freeze([
  ['[^\\n]*', /\[\^\\n\]\*/],
  ['[^\\n]+', /\[\^\\n\]\+/],
  ['.*', /(?<!\\)\.\*/],
  ['.+', /(?<!\\)\.\+/],
]);

/**
 * 룩어헤드 **밖**의 무제한 런을 찾는다.
 *
 * 룩어헤드를 제외하는 이유: 부정 룩어헤드 안의 런은 매치 위치를 늘리지 않고
 * 한 번만 평가된다(HG-09 의 `(?![\s\S]*\bWHERE\b)`). 위험한 것은 매치 시작
 * 위치마다 줄 끝까지 훑고 되돌아오는 **본문** 런이다.
 *
 * 한계(적어 두지 않으면 이 게이트가 다음 착시의 근거가 된다 — 검증 규율 §9):
 * 룩어헤드 제거는 `[^)]*` 로 하므로 **괄호를 품은 룩어헤드**는 온전히 지워지지
 * 않는다. 현재 매트릭스에 그런 룩어헤드는 0건이고, 남으면 거짓 양성 쪽으로
 * 기운다(그린을 만들지 않는다). 정밀 파서가 필요해지면 그때 옮긴다.
 *
 * @param {string} source 정규식 원문
 * @returns {string[]} 발견된 런의 라벨 목록. 빈 배열이면 통과
 */
function unboundedRunsOutsideLookahead(source) {
  const body = source.replace(/\(\?[=!][^)]*\)/g, '');
  return UNBOUNDED_RUN_FORMS.filter(([, probe]) => probe.test(body)).map(([label]) => label);
}

/**
 * 명시 등록된 예외 — **allowlist 다(부정 목록이 아니다)**. 여기 없는 무제한 런은
 * 전부 RED 이므로, 새 패턴이 런을 달고 들어오면 등록 없이는 통과하지 못한다.
 *
 * 등록 근거(2026-09-13 16:3x UTC, node v24.15.0, 이 워크트리 실측):
 *  HG-11 의 두 패턴은 `^` 앵커라 매치 시작 위치가 **1곳뿐**이다. 그래서 뒤따르는
 *  `[^\n]*` 는 2차식을 만들지 않는다. `classify` median-of-3 실측:
 *    `fill('cat ', n)`   20,480B 0.12ms · 122,880B 0.54ms  (6배 구간 성장 1.10)
 *    `fill('cat x ', n)` 20,480B 0.08ms · 122,880B 0.49ms  (6배 구간 성장 1.10)
 *  비교: 바운드 전 HG-07 의 무앵커 런은 같은 척도에서 122,880B 1,839.8ms 였다.
 *
 * 포기하는 것: 앵커가 있어도 `\s*` 뒤에 대안 분기가 늘면 앞머리에서 모호해질 수
 * 있다. 이 예외는 "앵커면 안전" 을 일반화하지 않는다 — **이 두 원문**만 면제한다.
 * @type {ReadonlyArray<string>}
 */
const ANCHORED_LINEAR_EXEMPTIONS = Object.freeze([
  String.raw`^\s*(?:cat|less|head|tail|more|type)\b[^\n]*\.env(?:\.[\w-]+)?\b`,
  String.raw`^\s*(?:cat|less|head|tail|more|type)\b[^\n]*\b(?:id_rsa|id_ed25519|credentials\.json|kubeconfig)\b`,
]);

describe('human-gate matrix — 무제한 런 0 (G)', () => {
  it('등록된 예외를 빼면 무제한 런을 가진 패턴이 없다', () => {
    const offenders = [];
    for (const row of HUMAN_GATE_MATRIX) {
      for (const pattern of row.patterns) {
        if (ANCHORED_LINEAR_EXEMPTIONS.includes(pattern.source)) continue;
        const runs = unboundedRunsOutsideLookahead(pattern.source);
        if (runs.length > 0) {
          offenders.push(`${row.id}: ${runs.join(',')} in ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('예외 목록은 실재하고, 전부 ^ 앵커이며, 유령 항목이 없다', () => {
    const live = new Set(
      HUMAN_GATE_MATRIX.flatMap((row) => row.patterns.map((p) => p.source)),
    );
    for (const source of ANCHORED_LINEAR_EXEMPTIONS) {
      // 매트릭스에서 사라진 예외를 남겨 두면 다음 사람이 그 자리를 재사용한다.
      expect(live.has(source), `stale exemption: ${source}`).toBe(true);
      expect(source.startsWith('^'), `exemption must be anchored: ${source}`).toBe(true);
      expect(unboundedRunsOutsideLookahead(source).length).toBeGreaterThan(0);
    }
  });

  it('HG-07 의 두 규칙은 예외가 아니라 바운드로 통과한다', () => {
    const hg07 = HUMAN_GATE_MATRIX.find((row) => row.id === 'HG-07');
    for (const index of [0, 2]) {
      const { source } = hg07.patterns[index];
      expect(ANCHORED_LINEAR_EXEMPTIONS).not.toContain(source);
      expect(source).toContain('[^\\n]{0,192}');
    }
  });

  it('일부러 심은 무앵커 런을 이 검사가 보고한다 (스캐너 자기검증)', () => {
    // 검사가 조용히 그린이 되지 않는지 — 규율 §10.
    expect(unboundedRunsOutsideLookahead(/\bcurl\b[^\n]*x/i.source)).toEqual(['[^\\n]*']);
    expect(unboundedRunsOutsideLookahead(/\bcurl\b[^\n]+x/i.source)).toEqual(['[^\\n]+']);
    expect(unboundedRunsOutsideLookahead(/\bcurl\b.*x/i.source)).toEqual(['.*']);
    expect(unboundedRunsOutsideLookahead(/\bcurl\b.+x/i.source)).toEqual(['.+']);
    // 반대 방향: 바운드된 창과 이스케이프된 점은 보고하지 않는다.
    expect(unboundedRunsOutsideLookahead(/\bcurl\b[^\n]{0,192}x/i.source)).toEqual([]);
    expect(unboundedRunsOutsideLookahead(/a\.env\b/i.source)).toEqual([]);
    // 룩어헤드 안의 런은 면제된다 — HG-09 의 실제 원문으로 확인한다.
    expect(unboundedRunsOutsideLookahead(/\bUPDATE\s+\w+\s+SET\b(?![\s\S]*\bWHERE\b)/i.source))
      .toEqual([]);
  });
});
