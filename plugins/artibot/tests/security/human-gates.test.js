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
  // 2026-11-19: HG-14 에이전트 프로세스 스폰(/orca 설계 §4.6-3, human)이 더해져 human 7 → 8.
  it('기본값 분포가 설계와 일치한다 (auto 5 · policy 1 · human 8)', () => {
    const counts = HUMAN_GATE_MATRIX.reduce((acc, row) => {
      acc[row.default] = (acc[row.default] || 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ auto: 5, policy: 1, human: 8 });
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

/**
 * 길이를 그대로 둔 채 payload 머리에 회차 표식을 박는다. 바이트 수는 build 가
 * 주장하는 값 그대로이고 꼬리(HG-09 F3 의 ` WHERE x`)도 보존된다.
 *
 * **왜 필요한가**: V8 은 같은 (regex, string) 쌍의 결과를 캐시한다. 사이즈당
 * payload 를 하나만 쓰고 그것을 N회 돌리면 2회차부터 상수 시간이 돌아오고,
 * 그러면 옛 규칙의 2차식이 성장 게이트에서 숨는다. HG-07 · HG-09 두 성장 블록이
 * 이 정의 하나를 공유한다 — 복제하지 말 것.
 * @param {(n: number) => string} build @param {number} n @param {number} i
 * @returns {string}
 */
const tagged = (build, n, i) => {
  const tag = `/*${i}*/`;
  return tag + build(n).slice(tag.length);
};

/**
 * build 를 사이즈 n 에서 회차마다 다른 payload 로 runs 회 돌린 median(ms).
 * payload 는 측정 대상 밖에서 미리 만든다 — 122KB 문자열 생성비가 타이밍에
 * 섞이면 선형 바닥이 깔려 2차식 비율이 희석된다.
 * @param {(n: number) => string} build @param {number} n @param {number} [runs]
 * @returns {number}
 */
function medianOverTagged(build, n, runs = 3) {
  const payloads = Array.from({ length: runs }, (_, i) => tagged(build, n, i));
  let cursor = 0;
  return medianMs(() => {
    classify({ tool: 'Bash', command: payloads[cursor] });
    cursor += 1;
  }, payloads.length);
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
  // ── 실측 (node v24.15.0, Windows 11, 이 워크트리, `classify` median-of-3) ──
  // 재현: 이 describe 를 그대로 돌리면 된다. 아래 표는 별도 프로브의 같은 호출.
  //
  //   수리 전 (a81ee154 `[^\n]*`, 2026-09-13T16:31Z)
  //     fill('curl ',     n)  20,480B  64.3ms · 40,962B 260.0ms · 122,880B 1,839.8ms
  //     fill('git push ', n)  20,480B  20.8ms · 40,962B  72.6ms · 122,880B   684.8ms
  //     6배 구간 성장비 curl 26.99 · git push 27.78  → 임계 18 초과(2차식)
  //   수리 후 (`[^\n]{0,192}`, 2026-09-14T00:16Z)
  //     fill('curl ',     n)  20,480B   2.8ms · 40,962B   4.8ms · 122,880B    19.5ms
  //     fill('git push ', n)  20,480B   2.3ms · 40,962B   3.9ms · 122,880B    10.0ms
  //     6배 구간 성장비 curl  3.46 · git push  2.22  → 임계 18 아래
  //
  // 이 게이트 자신이 바운드 전 코드에서 관측한 값은 curl 31.74 · git push 28.49
  // 였다(2026-09-13 RED 실행). 프로브 표와 숫자가 다른 것은 같은 양(2차식)을
  // 부하가 다른 두 시점에 잰 것이기 때문이다 — 판정은 양쪽 다 같다.
  //
  // 절대값은 넉넉한 smoke 로만 두고 판정은 비율에 맡긴다 — 비율은 머신 속도에
  // 거의 불변이다(safety.test.js `growth` JSDoc 의 잡음·신호 실측 참조).
  //
  // **payload 는 회차마다 간다**(모듈 레벨 `tagged` · `medianOverTagged`, HG-09
  // 블록과 정의 1개를 공유). 사이즈당 payload 를 하나만 쓰면 V8 이 같은
  // (regex, string) 쌍을 캐시해 2·3회차가 바닥값으로 떨어지고, 그러면 옛 규칙의
  // 2차식이 이 게이트에서 숨을 수 있다. 위 실측표는 표식 도입(2026-09-17) 전
  // 단일-payload 형식으로 잰 값이다. 같은 날 표식 도입 후 재측정(3회):
  //     curl     growth 3.70 · 2.91 · 3.41   (전: 3.00 · 3.06 · 3.41)
  //     git push growth 2.75 · 2.41 · 2.68   (전: 2.50 · 2.66 · 2.76)
  // 수리된 규칙은 캐시에 의존하지 않았으므로 값이 움직이지 않았다 — 바뀐 것은
  // 옛 규칙이 회귀했을 때 RED 가 신뢰 가능해졌다는 점이다. 임계 18 은 무변경.
  //
  // 못 보는 것: 이 블록은 **크기에 따라 스케일되는** 입력만 본다. 그리고 이 수치는
  // human-gates `classify` 단독이다 — PreToolUse 훅 **전체** 경로(L1 executeChain +
  // L2 classifyRisk + 여기)의 40,962B 총비용은 별도 실측이고, 그 값은 이 파일이
  // 고정하지 않는다(2026-09-14T00:16Z 실측 sum: curl 24.4ms · git push 26.0ms ·
  // dd 35.0ms · rm --opt 4.3ms, lib/core/command-segments.js 전처리 포함).
  /** @type {[string, (n: number) => string][]} */
  const SCALED_PAYLOADS = [
    ['curl', (n) => fill('curl ', n)],
    ['git push', (n) => fill('git push ', n)],
  ];

  it.each(SCALED_PAYLOADS)(
    '%s: t(122,880) < 18 × t(20,480)',
    (_name, build) => {
      /** @param {number} n @returns {number} */
      const run = (n) => medianOverTagged(build, n);
      const t20480 = run(20_480);
      const t40962 = run(40_962);
      // 회귀 시 120KB 측정으로 넘어가기 전에 여기서 빨리 실패시킨다.
      expect(t40962).toBeLessThan(200);
      const t122880 = run(122_880);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    },
    30_000,
  );

  it('payload 가 주장하는 바이트 크기로 만들어진다 — 회차 표식을 박은 뒤에도', () => {
    for (const [, build] of SCALED_PAYLOADS) {
      for (const n of [20_480, 40_962, 122_880]) {
        expect(build(n)).toHaveLength(n);
        expect(tagged(build, n, 0)).toHaveLength(n);
        // 회차마다 실제로 다른 문자열이어야 V8 의 (regex, string) 캐시를 피한다.
        expect(tagged(build, n, 0)).not.toBe(tagged(build, n, 1));
      }
    }
  });

  it('회차 표식은 규칙 매치 결과를 바꾸지 않는다 (짧은 실제 명령 대조)', () => {
    // 표식은 머리 5바이트를 덮어쓴다. 스케일 payload 는 근접-비매치라 hit 0 이고,
    // 표식을 박아도 0 이어야 한다 — 측정이 다른 규칙을 타고 있지 않다는 증거다.
    for (const [, build] of SCALED_PAYLOADS) {
      expect(ids({ tool: 'Bash', command: build(20_480) })).toHaveLength(0);
      expect(ids({ tool: 'Bash', command: tagged(build, 20_480, 0) })).toHaveLength(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HG-09 patterns[2] 룩어헤드 창 — 창 폭 핀 · 경계 쌍 · 타이밍 게이트 · 행동
// ───────────────────────────────────────────────────────────────────────────
//
// 위 HG-07 블록과 같은 3층이고 헬퍼(fill · medianMs · growth · ids · tagged ·
// medianOverTagged — 모두 모듈 레벨 정의 1개를 공유한다)도 그대로
// 쓴다. 다른 것은 **트레이드오프 부호**다: HG-07 의 `{0,192}` 는 관측을 잃고
// (192자 뒤의 `-X POST` 가 미분류), HG-09 의 `{0,192}` 는 오탐을 더한다
// (SET 뒤 187자 이후의 진짜 WHERE 는 창 밖 → 부정 룩어헤드가 성립 → 파괴적이지
// 않은 문장에 fire). 근거와 실측표의 정본은 lib/security/human-gates.js 의
// HG-09 주석이고, 여기서는 그 계약을 핀한다.

/** HG-09 patterns[] 의 문서화된 순서. 인덱스로 집는 근거다. */
const HG09_PATTERN_ORDER = ['prisma migrate deploy', 'alembic upgrade', 'UPDATE SET no-WHERE'];

describe('HG-09 — 창 폭 (i) 정적 소스 핀', () => {
  it('patterns[] 는 문서화된 3개 순서를 유지한다', () => {
    expect(getGateRow('HG-09').patterns).toHaveLength(HG09_PATTERN_ORDER.length);
  });

  it('UPDATE SET no-WHERE 규칙의 룩어헤드가 바운드된 창을 갖는다', () => {
    const source = getGateRow('HG-09').patterns[2].source;
    expect(source).toBe(/\bUPDATE\s+[\w."`[\]]+\s+SET\b(?![^;]{0,192}\bWHERE\b)/i.source);
    expect(source).toContain('[^;]{0,192}');
    expect(source).not.toContain('[\\s\\S]*');
  });
});

describe('HG-09 — 창 폭 경계 쌍 (186 비hit / 187 hit)', () => {
  // 룩어헤드는 `SET` **뒤**에서 시작한다. WHERE 앞 문자 수 = `' a=1 '`(5) + w +
  // `' '`(1) = w + 6. 이것이 192 이하면 창이 WHERE 를 보고 → 부정 룩어헤드 실패
  // → 비hit. w = 186 이 마지막으로 보이는 폭이고 w = 187 부터 창 밖이라 hit 한다.
  // **HG-07 의 192/193 기하와 값이 다르다 — 복사해 쓰지 말 것.**
  /** @param {number} w @returns {string} */
  const gap = (w) => `UPDATE t SET a=1 ${'x'.repeat(w)} WHERE x`;

  it('창 186 은 WHERE 를 보므로 걸리지 않는다', () => {
    expect(ids({ tool: 'Bash', command: gap(186) })).not.toContain('HG-09');
  });

  it('창 187 은 WHERE 가 창 밖이라 HG-09 로 걸린다', () => {
    expect(ids({ tool: 'Bash', command: gap(187) })).toContain('HG-09');
  });

  it('짧은 실제 명령은 창 폭과 무관하게 계속 걸린다 (회귀 방지)', () => {
    expect(ids({ tool: 'Bash', command: 'UPDATE accounts SET balance = 0' })).toContain('HG-09');
    expect(ids({ tool: 'Bash', command: 'UPDATE accounts SET balance = 0 WHERE id = 7' }))
      .not.toContain('HG-09');
  });
});

describe('HG-09 — classify 는 크기를 키워도 성장 비율이 선형 범위 안이다', () => {
  // 3층 중 (ii)(iii). (i) 은 위 정적 소스 핀이고 그쪽이 정본이다.
  //
  // ── 실측 (node v24.15.0, Windows 11, 이 워크트리, **규칙 단독** median-of-3,
  //    회차마다 다른 payload — V8 는 같은 (regex, string) 쌍의 결과를 캐시한다.
  //    2026-09-15 10:5x KST — human-gates.js HG-09 MEASURED 표와 같은 프로브) ──
  //                              20,480B    40,962B   122,880B   growth(6배)
  //   수리 전 `[\s\S]*`      F3     3.66ms    18.58ms   140.66ms      18.88
  //   수리 전 `[\s\S]*`      F5     1.79ms     8.19ms   110.93ms      19.85
  //   수리 후 `[^;]{0,192}`  F3     0.00ms     0.00ms     0.00ms       1.00
  //   수리 후 `[^;]{0,192}`  F5     0.39ms     0.85ms     1.81ms       1.32
  //
  // F3 가 수리 후 0.00ms 인 것은 빨라서가 아니라 **첫 후보에서 매치가 끝나서**다
  // (창 안에 WHERE 가 없으니 부정 룩어헤드가 성립 → 즉시 hit). 전 구간을 실제로
  // 훑는 선형 대조는 F5 쪽이다. 두 픽스처를 다 두는 이유가 그것이다.
  //
  // **F1(`'UPDATE t SET a=1 WHERE '` 반복)은 쓰지 않는다.** 옛 규칙에서 F1 의
  // growth 가 임계 18 을 5회 중 3회만 넘었다(t20480 이 바닥값 4ms 근처라 비율이
  // 흔들린다. 이 창 재측정도 18.09 로 임계 바로 위였다). RED 대조가 동전던지기면
  // 게이트가 아니다.
  //
  // **payload 는 회차마다 간다**(모듈 레벨 `tagged` · `medianOverTagged`. 2026-09-17
  // 부터 HG-07 블록도 같은 정의를 쓴다 — 예전에는 여기만 그랬다).
  // 사이즈당 payload 를 하나만 쓰면 V8 이 같은 (regex, string) 쌍의 결과를 캐시해
  // 2회차부터 상수 시간을 돌려주고, 그러면 **옛 규칙의 2차식이 이 게이트에서
  // 숨는다** — 2026-09-15 실측으로 옛 규칙 F3 의 growth 가 같은 형식에서 12.79
  // (node 직접)와 19.10(vitest) 사이를 오갔고 F5 는 16.05 로 임계를 못 넘었다.
  // 회차마다 갈면 F3 20.94 · F5 20.10 으로 안정적으로 초과한다.
  // RED 마진은 얇다 — 임계 18 대비 +2~3(11~16%), HG-07 의 RED(28~31)보다 좁고
  // 바닥값 4ms 가 t20480(≈3.7ms)을 눌러 비율을 깎는 구조라 부하 심한 러너에서
  // 옛 규칙이 그린으로 새어 나갈 여지가 있다(검수 2026-09-15 11:3x KST). 게이트를
  // 완화하지 말고, 마진이 필요하면 픽스처 쪽(후보 수)을 키워라.
  //
  // 이 블록이 못 보는 것: HG-07 블록과 같다 — **크기에 따라 스케일되는** 입력만
  // 보고, 수치는 `classify` 단독이다. PreToolUse 전체 경로 비용은 human-gates.js
  // HG-09 주석의 표가 갖는다.
  /** @type {[string, (n: number) => string][]} */
  const HG09_SCALED_PAYLOADS = [
    // F3 — 후보를 반복하고 WHERE 는 꼬리에 하나. 옛 규칙의 2차식이 가장 크게 나온 모양.
    ['F3 꼬리 WHERE 1개', (n) => fill('UPDATE t SET a=1 ', n - ' WHERE x'.length) + ' WHERE x'],
    // F5 — 반복 단위마다 WHERE. 새 규칙에서 전 구간을 실제로 훑는 선형 대조다.
    ['F5 단위마다 WHERE', (n) => fill('UPDATE t\nSET a=1\nWHERE id=1\n', n)],
  ];

  it.each(HG09_SCALED_PAYLOADS)(
    '%s: t(122,880) < 18 × t(20,480)',
    (_name, build) => {
      /** @param {number} n @returns {number} */
      const run = (n) => medianOverTagged(build, n);
      const t20480 = run(20_480);
      const t40962 = run(40_962);
      // 회귀 시 120KB 측정으로 넘어가기 전에 여기서 빨리 실패시킨다.
      expect(t40962).toBeLessThan(200);
      const t122880 = run(122_880);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    },
    30_000,
  );

  it('payload 가 주장하는 바이트 크기로 만들어진다 — 회차 표식을 박은 뒤에도', () => {
    for (const [, build] of HG09_SCALED_PAYLOADS) {
      for (const n of [20_480, 40_962, 122_880]) {
        expect(build(n)).toHaveLength(n);
        expect(tagged(build, n, 0)).toHaveLength(n);
        // 회차마다 실제로 다른 문자열이어야 캐시를 피한다.
        expect(tagged(build, n, 0)).not.toBe(tagged(build, n, 1));
      }
    }
  });
});

describe('HG-09 — 창 교체가 바꾼 것과 바꾸지 않은 것 (행동 7형)', () => {
  // 표의 a·b·c·d·g 는 브리프 설계표의 C1 열 그대로다. **f·h 는 구현 창 정의**
  // (브리프 요약표에 없던 행) — f 는 새 창이 더하는 오탐을 비용으로 못박고,
  // h 는 SQL 주석을 모델링하지 않는 현행 동작을 데이터로 남긴다.
  it.each([
    // a: 이 규칙의 존재 이유. 무-WHERE 파괴적 UPDATE.
    ['a 무-WHERE → 걸린다', 'UPDATE accounts SET balance = 0', true],
    // b: WHERE 가 창 안에 있으면 안 걸린다.
    ['b 창 안 WHERE → 안 걸린다', 'UPDATE accounts SET balance = 0 WHERE id = 7', false],
    // c: 옛 규칙이 놓치던 `;` 문장 경계 우회. `[^;]` 가 닫았다.
    ['c 세미콜론 우회 → 걸린다', 'UPDATE t SET a=1; SELECT 1 WHERE x', true],
    // d: heredoc 다행 SQL. `[^;\n]` 였다면 여기서 오탐한다 — 그래서 `[^;]` 다.
    ['d 다행 SQL → 안 걸린다', 'UPDATE t SET a=1\nWHERE id=1', false],
    // f: 창 밖(300자)의 진짜 WHERE. **새 창이 더하는 오탐**이고, 기록 전용
    //    매트릭스이므로 비용은 원장 잡음이지 차단이 아니다.
    [
      'f 창 밖 WHERE → 걸린다 — 의도된 오탐 핀, 창을 넓혀 "고치지" 말 것',
      `UPDATE t SET a=1 ${'x'.repeat(300)} WHERE x`,
      true,
    ],
    // g: 대괄호 식별자. 창 교체와 무관하게 유지.
    ['g 대괄호 식별자 → 걸린다', 'UPDATE [dbo].[t] SET a=1', true],
    // h: SQL 주석은 모델링하지 않는다. 주석 안의 WHERE 도 WHERE 로 읽어 안 걸린다.
    [
      'h 주석 안 WHERE → 안 걸린다 — 의도된 트레이드오프, SQL 주석 미모델링의 현행 동작 핀',
      'UPDATE t SET a=1 -- WHERE x',
      false,
    ],
  ])('%s', (_label, command, expected) => {
    const hit = ids({ tool: 'Bash', command }).includes('HG-09');
    expect(hit).toBe(expected);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HG-14 에이전트 프로세스 스폰 — 행 정의 · 형태별 양성 · 음성 · 창 경계 · 알려진 사각
// ───────────────────────────────────────────────────────────────────────────
//
// /orca 설계 §4.6-3 의 **분류 전용** 행이다(default human · enforcement none). 강제 대상
// 집합(ENFORCEABLE_GATE_IDS)은 이 행이 편입되지 않았음을 tests/security/human-gate-enforce.test.js
// 가 따로 고정한다. 적중은 원장에 행을 남기지 않는다 — 훅은 block 때만 human.asked 를
// 쓴다. 그래서 이 행이 "launch 승인 없이 스폰했다"를 잡아 주는 것이 아니다. 그 검출은 /orca
// status 의 confirm-launch 쌍 점검이 맡는다(설계 §4.6-3).
//
// 명령 형태의 출처는 `orca agent-context --json` 스키마의 usage 줄이다(Orca 1.4.259 ·
// commandCount 334, 2026-11-19 실측): worker-start `(--agent <agent> | --terminal
// <handle>)`, worktree create `[--agent <id>] [--prompt <text>]`, agent launch `--agent <id>`,
// automations create `--provider <agent> --prompt <text>`, automations run `<id>`.
// **동작 실측이 아니라 스키마 실측이다** — 동작은 worker-start 와 `--agent` 없는 worktree
// create 만 P0 에서 실행해 봤다. `--agent` 를 단 worktree create · agent launch ·
// automations create|run 이 실제로 에이전트를 띄우는지는 미실측이다.
//
// 이 블록이 못 보는 것: 실제 명령 분포에 대한 오탐·미탐률(미측정), 훅이 이 행을 어떻게
// 소비하는지(소비처는 auto-activate 의 프롬프트 스크린과 block 뒤 human.asked 기록뿐).

describe('HG-14 — 행 정의 (설계 §4.6-3 · 리더 결정)', () => {
  it('분류 전용 human 행이다 — 강제 0 · 정책 키 0 · Bash command 만 본다', () => {
    const row = getGateRow('HG-14');
    expect(row).toMatchObject({
      id: 'HG-14',
      action: '에이전트 프로세스 스폰',
      default: 'human',
      enforcement: 'none',
      policyRef: null,
      probe: 'command',
    });
    expect([...row.tools]).toEqual(['Bash']);
    expect([...row.existingCoverage]).toEqual([]);
    expect(row.undetectable).toBeUndefined();
  });

  it('패턴 4개가 문서화된 순서(worker-start · worktree create --agent · agent launch · automations)다', () => {
    const sources = getGateRow('HG-14').patterns.map((pattern) => pattern.source);
    expect(sources).toHaveLength(4);
    expect(sources[0]).toContain('worker-start');
    expect(sources[1]).toContain('worktree');
    expect(sources[2]).toContain('launch');
    expect(sources[3]).toContain('automations');
    for (const pattern of getGateRow('HG-14').patterns) {
      expect(pattern.flags, pattern.source).toBe('i');
    }
  });

  it('worktree create 규칙의 원문이 바운드된 창을 갖는다 — 창을 넓히거나 무제한으로 되돌리지 말 것', () => {
    const source = getGateRow('HG-14').patterns[1].source;
    expect(source).toBe(
      /\borca(?:\.(?:exe|cmd))?\s+worktree\s+create\b[^\n]{0,192}\s--agent(?=[\s=]|$)/i.source,
    );
    expect(source).toContain('[^\\n]{0,192}');
    expect(source).not.toContain('[^\\n]*');
  });
});

describe('HG-14 — 형태별 양성', () => {
  it.each([
    ['worker-start (설계 §4.4-7 의 실제 줄)',
      'orca orchestration worker-start --task task_1 --worktree wt-1 --agent claude --model claude-sonnet-5-5 --json'],
    ['worker-start --terminal (기존 터미널에 붙이는 형)',
      'orca orchestration worker-start --spec-file brief.md --terminal term_1'],
    ['worktree create --agent',
      'orca worktree create --name limb-a --branch orca/limb-a-ab12cd --agent claude --prompt "go" --json'],
    ['worktree create --agent=값', 'orca worktree create --name limb-a --agent=claude'],
    ['worktree create 의 --agent 가 줄 끝', 'orca worktree create --name limb-a --agent'],
    ['agent launch', 'orca agent launch --agent claude --worktree wt-1 --prompt "go" --json'],
    ['automations create',
      'orca automations create --name nightly --trigger daily --prompt "go" --provider claude'],
    ['automations run', 'orca automations run auto_1 --json'],
    ['실행 파일 접미 .exe', 'orca.exe orchestration worker-start --task task_1 --agent claude'],
    ['실행 파일 접미 .cmd', 'orca.cmd agent launch --agent claude'],
    ['경로 접두(POSIX)', '/opt/orca/bin/orca agent launch --agent claude'],
    ['경로 접두(Windows)', 'C:\\tools\\orca\\bin\\orca.exe agent launch --agent claude'],
    ['체인 뒤쪽', 'cd repo && orca orchestration worker-start --task task_1 --agent claude'],
    ['대소문자 무관', 'ORCA Orchestration Worker-Start --task t --agent claude'],
    ['공백·탭 여러 개', 'orca   orchestration \t worker-start --task t'],
  ])('%s', (_label, command) => {
    expect(ids({ tool: 'Bash', command })).toContain('HG-14');
  });

  it('스폰 형은 다른 행을 열지 않는다 — 정본 4형은 HG-14 단독 적중이다', () => {
    for (const command of [
      'orca orchestration worker-start --task task_1 --worktree wt-1 --agent claude --json',
      'orca worktree create --name limb-a --agent claude --json',
      'orca agent launch --agent claude --worktree wt-1 --json',
      'orca automations run auto_1 --json',
    ]) {
      expect(ids({ tool: 'Bash', command }), command).toEqual(['HG-14']);
    }
  });
});

describe('HG-14 — 음성 (읽기 verb · 스폰이 아닌 쓰기 · 이웃 단어)', () => {
  it.each([
    ['status', 'orca status --json'],
    ['worktree list', 'orca worktree list --json'],
    ['worktree show', 'orca worktree show --worktree wt-1 --json'],
    ['설계의 worktree create — --agent 가 없다(스폰은 다음 줄의 worker-start)',
      'orca worktree create --name limb-a --branch orca/limb-a-ab12cd --base-branch origin/master --parent-worktree active --setup skip --json'],
    ['worktree create 의 --agent- 접두 플래그', 'orca worktree create --name limb-a --agent-x y'],
    ['worker-list', 'orca orchestration worker-list --run run_1 --json'],
    ['task-create', 'orca orchestration task-create --spec "x" --json'],
    ['check --peek', 'orca orchestration check --run run_1 --peek --json'],
    ['inbox', 'orca orchestration inbox --terminal run:run_1 --json'],
    ['agent hooks status', 'orca agent hooks status --json'],
    ['agent-context', 'orca agent-context --json'],
    ['automations list', 'orca automations list --json'],
    ['automations show', 'orca automations show auto_1 --json'],
    ['automations runs — run 의 복수형', 'orca automations runs auto_1 --json'],
    ['worker-startup — worker-start 의 접두어', 'orca orchestration worker-startup'],
    ['sorca — orca 가 아닌 단어', 'sorca orchestration worker-start --task t --agent claude'],
    ['orca 가 아닌 프로그램의 같은 verb', 'claude agent launch --agent x'],
    ['무관한 명령', 'git status --porcelain'],
  ])('%s → HG-14 아님', (_label, command) => {
    expect(ids({ tool: 'Bash', command })).not.toContain('HG-14');
  });

  it('도구 allowlist — Write·Edit 의 path 나 PowerShell 도구는 이 행을 열지 않는다', () => {
    expect(ids({ tool: 'Write', path: 'orca orchestration worker-start' })).not.toContain('HG-14');
    expect(ids({ tool: 'Edit', path: 'orca agent launch --agent claude' })).not.toContain('HG-14');
    // probe 가 command 뿐이라 Bash 라도 path 만 주면 보지 않는다.
    expect(ids({ tool: 'Bash', path: 'orca agent launch --agent claude' })).not.toContain('HG-14');
  });
});

describe('HG-14 — worktree create … --agent 창 경계 (192 매치 / 193 miss)', () => {
  // 창은 `create` 직후부터 `--agent` 앞의 공백 **직전**까지다. `create\b` 가 서려면 창이
  // 비단어 문자(공백)로 시작해야 하므로 filler 는 공백 하나 + x 로 n 글자를 채운다.
  /** @param {number} n @returns {string} */
  const filler = (n) => ` ${'x'.repeat(n - 1)}`;

  it('창 192 는 HG-14, 193 은 미분류', () => {
    expect(filler(192)).toHaveLength(192);
    expect(ids({ tool: 'Bash', command: `orca worktree create${filler(192)} --agent claude` }))
      .toContain('HG-14');
    expect(ids({ tool: 'Bash', command: `orca worktree create${filler(193)} --agent claude` }))
      .not.toContain('HG-14');
  });

  it('짧은 실제 명령은 창 폭과 무관하게 계속 걸린다 (회귀 방지)', () => {
    expect(ids({ tool: 'Bash', command: 'orca worktree create --name limb-a --agent claude' }))
      .toContain('HG-14');
  });
});

describe('HG-14 — 알려진 사각 (분류되지 않는다 — 고치려면 lib 의 행 주석과 이 핀을 함께 갱신)', () => {
  // 이 핀들은 "안전하다"는 주장이 아니라 "여기는 안 본다"는 기록이다. 분류 전용 행이라
  // 놓쳐도 막혀야 할 것이 풀리는 것은 아니고 관측을 잃는다(설계 §4.6-3).
  it.each([
    ['동사 앞의 전역 플래그 — `orca --json status` 는 유효한 호출이다',
      'orca --json orchestration worker-start --task t --agent claude'],
    ['--agent 가 줄 연속(\\ + 개행) 다음 줄에 들여써 있다 — 창이 개행을 못 넘는다',
      'orca worktree create --name w \\\n  --agent claude'],
    ['--agent 가 여러 줄 --prompt 뒤에 있다 — 같은 이유',
      'orca worktree create --name w --prompt "a\nb" --agent claude'],
    ['따옴표로 닫힌 실행 파일 경로', '"C:/tools/orca/bin/orca.exe" agent launch --agent claude'],
  ])('%s', (_label, command) => {
    expect(ids({ tool: 'Bash', command })).not.toContain('HG-14');
  });

  it('PowerShell 도구는 보지 않는다 — tools 는 Bash 하나다', () => {
    expect(ids({ tool: 'PowerShell', command: 'orca agent launch --agent claude' })).toEqual([]);
  });
});

describe('HG-14 — classify 는 quantifier 위치마다 긴 단일 런에서도 성장 비율이 선형 범위 안이다', () => {
  // 정적 스캐너(regex-scan.js)는 부정 클래스·`.` 만 보고 **긍정 클래스 무제한 런 `\s+` 는 못 본다**
  // (그 파일 "못 보는 것" 1번). 이 행에는 `\s+` 가 패턴마다 2개씩 있어서, 그 선형성의 근거는
  // 이 스윕뿐이다. 촘촘한 반복만 쓰면 인접 quantifier 의 백트래킹이 짧아 2차식이 숨으므로
  // 동사 사이마다 **긴 단일 런**(공백·탭·CRLF)과 창 안 런, 창 반복 시작점을 각각 둔다.
  //
  // ── 실측 (node v24.15.0, Windows 11, 2026-11-19 14:1x KST, 다른 줄기 부하 있음, 3회 중앙값,
  //    회차마다 다른 payload — 별도 프로브의 같은 호출이라 코드는 남기지 않았다) ──
  //   규칙 단독, 20,480 / 40,962 / 122,880B:
  //     worktree create 규칙, 창 반복 시작점 `'orca worktree create '`
  //                                       0.65 / 1.08 / 2.84ms    growth(6배) 4.38
  //     같은 규칙의 창 없는 `[^\n]*` 변이(출하 안 함 — 게이트가 RED 를 내야 하는 모양)
  //                                       10.11 / 42.82 / 392.91ms  growth 38.88
  //     4개 패턴 중 최댓값, 동사 사이·orca 뒤 단일 런(공백·탭·LF·CRLF) × 6개 머리 = 24형
  //                                       최대 0.32ms @122,880B, growth ≤ 1.07
  //   바닥 4ms 를 넣은 growth(아래 게이트와 같은 식)는 위 프로브 9형(4개 패턴 최댓값)에서
  //   1.01~1.60 이다. 임계 18 은 선형(≈6)과 2차식(≈36) 사이다. 창을 없애면 위 변이처럼
  //   바닥 포함 28, 바닥 없이 39 로 넘는다.
  //
  // 못 보는 것: 이 블록은 **크기에 따라 스케일되는** 입력만 본다. 반복 그룹 `(?:…)*` 은 이 행에
  // 0개라서 겹치는 선택지의 지수식 백트래킹은 이 스윕의 모양으로 보지 않는다(생기면 따로 본다).
  // 게이트로 박은 양성 대조(창 넓힌 변이가 RED 가 되는가)는 없다 — 위 변이는 프로브에서 한 번
  // 쟀을 뿐이다. 창이 넓어지는 회귀는 정적 스캐너와 위 정확한 원문 핀이 먼저 잡는다.
  const PAD = '12345 '; // 6바이트: 회차 표식(5바이트)이 덮어쓰는 자리. 규칙에 걸리는 부분은 그 뒤다.

  /** @type {[string, (n: number) => string][]} */
  const HG14_SCALED_PAYLOADS = [
    ['orca 뒤 공백 런', (n) => `${PAD}orca${' '.repeat(n - PAD.length - 4)}`],
    ['동사 사이 CRLF 런', (n) => `${PAD}orca orchestration${fill('\r\n', n - PAD.length - 18)}`],
    ['worktree 뒤 탭 런', (n) => `${PAD}orca worktree${'\t'.repeat(n - PAD.length - 13)}`],
    ['창 안 단일 런(공백+x)', (n) => `${PAD}orca worktree create${fill(' x', n - PAD.length - 20)}`],
    ['창 반복 시작점', (n) => PAD + fill('orca worktree create ', n - PAD.length)],
    // 끝을 z 로 닫는다 — 잘린 꼬리가 `--agent` 로 끝나면 `$` 룩어헤드가 맞아 버린다.
    ['--agent- 룩어헤드 miss 반복', (n) => `${PAD}${fill('orca worktree create --agent-x ', n - PAD.length - 1)}z`],
    ['agent·automations 반복', (n) => PAD + fill('orca agent orca automations ', n - PAD.length)],
  ];

  it.each(HG14_SCALED_PAYLOADS)(
    '%s: t(122,880) < 18 × t(20,480)',
    (_name, build) => {
      /** @param {number} n @returns {number} */
      const run = (n) => medianOverTagged(build, n);
      const t20480 = run(20_480);
      const t40962 = run(40_962);
      // 회귀 시 120KB 측정으로 넘어가기 전에 여기서 빨리 실패시킨다.
      expect(t40962).toBeLessThan(200);
      const t122880 = run(122_880);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    },
    30_000,
  );

  it('payload 가 주장하는 바이트 크기로 만들어지고 규칙에 걸리지 않는다 — 회차 표식을 박은 뒤에도', () => {
    for (const [name, build] of HG14_SCALED_PAYLOADS) {
      for (const n of [20_480, 40_962, 122_880]) {
        expect(build(n), name).toHaveLength(n);
        expect(tagged(build, n, 0), name).toHaveLength(n);
        // 회차마다 실제로 다른 문자열이어야 V8 의 (regex, string) 캐시를 피한다.
        expect(tagged(build, n, 0), name).not.toBe(tagged(build, n, 1));
        // 비매치여야 전 구간을 실제로 훑는 측정이다 — 첫 후보에서 매치가 끝나면 빨라 보일 뿐이다.
        expect(ids({ tool: 'Bash', command: tagged(build, n, 0) }), name).not.toContain('HG-14');
      }
    }
  });
});
