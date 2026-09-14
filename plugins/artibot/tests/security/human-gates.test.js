/**
 * `lib/security/human-gates.js` 단위 테스트 — `classify` 의 계약과 경계.
 *
 * 매트릭스 자체의 형태·행 구성·중복 0 은 `tests/firewall/human-gate-matrix-selfcheck.test.js`
 * 가 소유한다. 여기서는 **함수 동작**만 본다: 도구 allowlist, probe 선택, 다중 hit,
 * 잘못된 입력에 대한 방어.
 *
 * 이 파일이 못 보는 것: 훅이 실제로 무엇을 하는지(T-39 소유), 실제 명령 분포에 대한
 * 오탐·미탐률(미측정), `policyRef` 가 가리키는 config 키의 실재.
 */

import { describe, expect, it } from 'vitest';
import {
  classify,
  getGateRow,
  HUMAN_GATE_MATRIX,
} from '../../lib/security/human-gates.js';

/** @param {object} input */
const ids = (input) => classify(input).hits.map((h) => h.id);

describe('classify — 도구 allowlist', () => {
  it('tool 이 행의 allowlist 밖이면 그 행은 보지 않는다', () => {
    // HG-08 은 Bash 행이다. 같은 문자열을 Write 의 path 로 줘도 걸리지 않는다.
    expect(ids({ tool: 'Bash', command: 'terraform apply' })).toContain('HG-08');
    expect(ids({ tool: 'Write', path: 'terraform apply' })).not.toContain('HG-08');
  });

  it('tool 을 생략하면 도구 필터 없이 payload 만으로 분류한다', () => {
    expect(ids({ command: 'docker push acme/app' })).toContain('HG-08');
  });

  it('알 수 없는 tool 은 어떤 행도 열지 않는다 (allowlist 형)', () => {
    expect(ids({ tool: 'UnknownTool', command: 'terraform apply' })).toEqual([]);
  });
});

describe('classify — probe 선택', () => {
  it('command 행은 path 만 줬을 때 걸리지 않는다', () => {
    expect(ids({ tool: 'Bash', command: 'gh pr create --fill' })).toContain('HG-06');
    expect(ids({ tool: 'Bash', path: 'gh pr create --fill' })).not.toContain('HG-06');
  });

  it('path 행은 command 만 줬을 때 걸리지 않는다', () => {
    expect(ids({ tool: 'Write', path: 'lib/foo.js' })).toContain('HG-02');
    expect(ids({ tool: 'Write', command: 'lib/foo.js' })).not.toContain('HG-02');
  });

  it('probe="both" 행은 command 와 path 양쪽에서 걸린다', () => {
    expect(ids({ tool: 'Bash', command: 'cat .env' })).toContain('HG-11');
    expect(ids({ tool: 'Write', path: 'plugins/artibot/artibot.config.json' })).toContain('HG-13');
  });
});

describe('classify — 다중 hit', () => {
  it('한 행동이 여러 행에 걸리면 매트릭스 순서대로 전부 돌려준다', () => {
    // artibot.config.json 쓰기 = 로컬 편집(HG-02, auto) ∧ 보안 정책 비활성화(HG-13, human)
    const hit = ids({ tool: 'Write', path: 'plugins/artibot/artibot.config.json' });
    expect(hit).toEqual(['HG-02', 'HG-13']);
  });

  it('축약하지 않는다 — auto 행이 human 행에 가려지지 않는다', () => {
    // cat .env = 읽기(HG-01, auto) ∧ 시크릿 접근(HG-11, human)
    expect(ids({ tool: 'Bash', command: 'cat .env' })).toEqual(['HG-01', 'HG-11']);
  });
});

describe('classify — 신규 패턴이 실측 구멍을 덮는다 (레인 5 §1-D)', () => {
  it.each([
    ['gh release create v1.0.0', 'HG-08'],
    ['docker push registry.example.com/app:1', 'HG-08'],
    ['vercel deploy --prod', 'HG-08'],
    ['netlify deploy --prod', 'HG-08'],
    ['kubectl apply -f deploy.yaml', 'HG-08'],
    ['curl -X DELETE https://api.example.com/v1/items/9', 'HG-07'],
    ['gh pr merge 42 --admin', 'HG-07'],
    ['git push origin main', 'HG-07'],
    ['prisma migrate deploy', 'HG-09'],
    ['alembic upgrade head', 'HG-09'],
    ['UPDATE accounts SET balance = 0', 'HG-09'],
  ])('%s → %s', (command, expected) => {
    expect(ids({ tool: 'Bash', command })).toContain(expected);
  });

  it('WHERE 가 있는 UPDATE 는 HG-09 가 아니다', () => {
    expect(ids({ tool: 'Bash', command: 'UPDATE accounts SET balance = 0 WHERE id = 7' }))
      .not.toContain('HG-09');
  });

  it.each([
    ['.claude/settings.json', 'HG-12'],
    ['.claude/settings.local.json', 'HG-12'],
    ['plugins/artibot/hooks.json', 'HG-12'],
    ['plugins/artibot/dispatch-table.json', 'HG-12'],
  ])('설정 자기수정 %s → %s', (writePath, expected) => {
    expect(ids({ tool: 'Write', path: writePath })).toContain(expected);
  });
});

describe('classify — 잘못된 입력', () => {
  it.each([
    ['인자 없음', undefined],
    ['빈 객체', {}],
    ['null', null],
    ['문자열', 'terraform apply'],
    ['숫자', 7],
    ['command 가 빈 문자열', { tool: 'Bash', command: '' }],
    ['command 가 문자열이 아님', { tool: 'Bash', command: { a: 1 } }],
  ])('%s → hits 빈 배열, 예외 없음', (_label, input) => {
    const result = classify(input);
    expect(result).toEqual({ hits: [] });
  });
});

describe('getGateRow', () => {
  it('id 로 행을 찾는다', () => {
    expect(getGateRow('HG-01').id).toBe('HG-01');
    expect(getGateRow('HG-13').default).toBe('human');
  });

  it('없는 id 는 null', () => {
    expect(getGateRow('HG-99')).toBeNull();
    expect(getGateRow('')).toBeNull();
  });

  it('돌려준 행은 동결돼 있다 — 소비자가 표를 못 바꾼다', () => {
    const row = getGateRow('HG-08');
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.patterns)).toBe(true);
  });
});

describe('HUMAN_GATE_MATRIX — 소비자가 쓰는 축', () => {
  // HG-07 외부 시스템 쓰기는 v5 §11 표에서 policy 였으나 OD-1(파괴·배포·외부쓰기·
  // 제품결정 = 단계 무관 항상 사람)이 이겨 human 으로 승격됐다. 그래서 policy 는 1행.
  it('기본값 분포가 설계와 일치한다 (auto 5 · policy 1 · human 7)', () => {
    const counts = HUMAN_GATE_MATRIX.reduce((acc, row) => {
      acc[row.default] = (acc[row.default] || 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ auto: 5, policy: 1, human: 7 });
  });

  it('HG-07 은 OD-1 승격 행이다 — policyRef 를 유지한 채 human', () => {
    const row = getGateRow('HG-07');
    expect(row.default).toBe('human');
    expect(row.policyRef).toBe('policy:autopilot.safety.blockExternalSend');
    expect(row.note).toBe('v5 §11 = policy, OD-1 로 human 승격');
  });

  it('부분 강제 행은 무엇까지만 강제되는지 적어 둔다', () => {
    for (const row of HUMAN_GATE_MATRIX.filter((r) => r.enforcement === 'hook')) {
      expect(typeof row.enforcementNote, `${row.id}`).toBe('string');
      expect(row.enforcementNote.trim().length, `${row.id}`).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HG-07 무제한 런 수리 — 창 폭 핀 · 경계 쌍 · 타이밍 게이트
// ───────────────────────────────────────────────────────────────────────────
//
// 아래 헬퍼 3종은 `tests/autopilot/safety.test.js` 와 **형식만** 같은 자급형
// 복사본이다. 테스트 파일끼리 import 하지 않는다 — 한쪽을 지우거나 옮기면
// 다른 쪽이 조용히 죽고, 그 죽음은 그린으로 보인다.

/**
 * 반복 단위로 정확히 bytes 길이의 근접-비매치 payload 를 만든다.
 * @param {string} unit @param {number} bytes @returns {string}
 */
function fill(unit, bytes) {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/**
 * fn 을 runs 회 돌려 경과 시간의 중앙값(ms). 단발 벽시계는 GC·스케줄러에 흔들린다.
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

/** 성장 게이트의 바닥값(ms). 빠르고 선형인 규칙에서 생 비율이 튀는 것을 막는다. */
const RATIO_FLOOR_MS = 4;

/**
 * 6배 구간의 성장 비율. 인접 2배 구간은 분해능이 없어 쓰지 않는다
 * (근거는 safety.test.js `growth` 의 JSDoc 실측표).
 * @param {number} numerator @param {number} denominator @returns {number}
 */
function growth(numerator, denominator) {
  return (numerator + RATIO_FLOOR_MS) / (denominator + RATIO_FLOOR_MS);
}

/** HG-07 patterns[] 의 문서화된 순서. 인덱스로 집는 근거다. */
const HG07_PATTERN_ORDER = ['curl -X', 'gh pr merge', 'git push master|main'];

describe('HG-07 — 창 폭 (i) 정적 소스 핀', () => {
  it('patterns[] 는 문서화된 3개 순서를 유지한다', () => {
    expect(getGateRow('HG-07').patterns).toHaveLength(HG07_PATTERN_ORDER.length);
  });

  it('curl -X 규칙의 원문이 바운드된 창을 갖는다', () => {
    const source = getGateRow('HG-07').patterns[0].source;
    expect(source).toBe(/\bcurl\b[^\n]{0,192}\s-X\s*['"]?(?:POST|PUT|PATCH|DELETE)\b/i.source);
    expect(source).toContain('{0,192}');
    expect(source).not.toContain('[^\\n]*');
  });

  it('git push master|main 규칙의 원문이 바운드된 창을 갖는다', () => {
    const source = getGateRow('HG-07').patterns[2].source;
    expect(source).toBe(/\bgit\s+push\b[^\n]{0,192}\b(?:master|main)\b/i.source);
    expect(source).toContain('{0,192}');
    expect(source).not.toContain('[^\\n]*');
  });
});

describe('HG-07 — 창 폭 경계 쌍 (192 매치 / 193 miss)', () => {
  // curl 규칙은 토큰 앞에 자기 `\s` 를 갖는다(`[^\n]{0,192}\s-X`). 그래서 창이
  // 덮어야 하는 것은 **공백으로 끝나지 않는** n 바이트다 — 끝이 공백이면 창과
  // 규칙의 `\s` 가 겹쳐 경계가 한 칸 밀린다.
  /** @param {number} n @returns {string} */
  const filler = (n) => ` ${'x'.repeat(n - 1)}`;

  // git push 규칙은 자기 `\s` 가 없고 `\b(?:master|main)\b` 가 곧바로 온다.
  // 그래서 창이 덮는 구간이 **공백으로 끝나야** `\b` 가 선다.
  /** @param {number} n @returns {string} */
  const span = (n) => ` ${'x'.repeat(n - 2)} `;

  it('curl: 창 192 는 HG-07, 193 은 미분류', () => {
    expect(filler(192)).toHaveLength(192);
    expect(ids({ tool: 'Bash', command: `curl${filler(192)} -X POST https://e.example/v1` }))
      .toContain('HG-07');
    expect(ids({ tool: 'Bash', command: `curl${filler(193)} -X POST https://e.example/v1` }))
      .not.toContain('HG-07');
  });

  it('git push: 창 192 는 HG-07, 193 은 미분류', () => {
    expect(span(192)).toHaveLength(192);
    expect(ids({ tool: 'Bash', command: `git push${span(192)}main` })).toContain('HG-07');
    expect(ids({ tool: 'Bash', command: `git push${span(193)}main` })).not.toContain('HG-07');
  });

  it('짧은 실제 명령은 창 폭과 무관하게 계속 걸린다 (회귀 방지)', () => {
    expect(ids({ tool: 'Bash', command: 'curl -X POST https://api.example.com/v1/items' }))
      .toContain('HG-07');
    expect(ids({ tool: 'Bash', command: 'git push origin master' })).toContain('HG-07');
  });
});

describe('HG-07 — classify 는 크기를 키워도 성장 비율이 선형 범위 안이다', () => {
  // 3층 중 (ii)(iii). (i) 은 위 정적 소스 핀이고 그쪽이 정본이다.
  //
  // 실측(node v24.15.0, 이 창, median-of-3):
  //   수리 전  classify  fill('curl ')      20,480B  64.3ms / 40,962B 260.0ms / 122,880B 1,839.8ms
  //            classify  fill('git push ')  20,480B  20.8ms / 40,962B  72.6ms / 122,880B   684.8ms
  //   수리 후  classify  fill('curl ')      20,480B   0.9ms / 40,962B   1.8ms / 122,880B     5.6ms
  //            classify  fill('git push ')  20,480B   0.6ms / 40,962B   1.2ms / 122,880B     3.5ms
  // 수리 전 성장비는 curl 26.98 · git push 27.79 로 임계 18 을 넘는다(2차식).
  // 절대값은 넉넉한 smoke 로만 두고 판정은 비율에 맡긴다 — 비율은 머신 속도에
  // 거의 불변이다(safety.test.js `growth` JSDoc 의 잡음·신호 실측 참조).
  /** @type {[string, (n: number) => string][]} */
  const SCALED_PAYLOADS = [
    ['curl', (n) => fill('curl ', n)],
    ['git push', (n) => fill('git push ', n)],
  ];

  it.each(SCALED_PAYLOADS)(
    '%s: t(122,880) < 18 × t(20,480)',
    (_name, build) => {
      /** @param {number} n @returns {number} */
      const run = (n) => {
        const payload = build(n);
        return medianMs(() => classify({ tool: 'Bash', command: payload }), 3);
      };
      const t20480 = run(20_480);
      const t40962 = run(40_962);
      // 회귀 시 120KB 측정으로 넘어가기 전에 여기서 빨리 실패시킨다.
      expect(t40962).toBeLessThan(200);
      const t122880 = run(122_880);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    },
    30_000,
  );

  it('payload 가 주장하는 바이트 크기로 만들어진다', () => {
    for (const [, build] of SCALED_PAYLOADS) {
      expect(build(20_480)).toHaveLength(20_480);
      expect(build(40_962)).toHaveLength(40_962);
      expect(build(122_880)).toHaveLength(122_880);
    }
  });
});
